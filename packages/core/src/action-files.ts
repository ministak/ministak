import { File as NodeFile } from 'node:buffer'
import { PassThrough, Readable, Writable } from 'node:stream'
import type { Multipart, MultipartFile } from '@fastify/multipart'
import type { FastifyRequest } from 'fastify'
import {
  ACTION_MULTIPART_FILE_PREFIX,
  ACTION_MULTIPART_METADATA_FIELD,
  type ActionFileDescriptor,
  type ActionFilePart,
  type ActionFilePath,
  type ActionMultipartMetadata,
} from './action-protocol.js'
import type { FileStream, FileStreams } from './types.js'

export class ActionRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'ActionRequestError'
  }
}

function invalidArguments(message = 'Action 文件参数格式错误') {
  return new ActionRequestError(message, 'INVALID_ARGUMENTS', 400)
}

function payloadTooLarge() {
  return new ActionRequestError(
    '请求体过大',
    'PAYLOAD_TOO_LARGE',
    413,
  )
}

function streamOrderError() {
  return new ActionRequestError(
    '无法读取后续文件：前一个 FileStream 尚未处理，请先读取该文件或调用 skip() 跳过',
    'FILE_STREAM_ORDER',
    500,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFilePart(value: unknown): ActionFilePart {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^\d+$/.test(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.lastModified !== 'number' ||
    !Number.isFinite(value.lastModified)
  ) {
    throw invalidArguments()
  }
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    lastModified: value.lastModified,
  }
}

function parseFilePath(value: unknown): ActionFilePath {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (part) =>
        typeof part === 'string' ||
        (typeof part === 'number' &&
          Number.isSafeInteger(part) &&
          part >= 0),
    )
  ) {
    throw invalidArguments()
  }
  return value
}

function parseFileDescriptor(value: unknown): ActionFileDescriptor {
  if (
    !isRecord(value) ||
    (value.kind !== 'file' &&
      value.kind !== 'stream' &&
      value.kind !== 'streams') ||
    !Array.isArray(value.parts)
  ) {
    throw invalidArguments()
  }
  const parts = value.parts.map(parseFilePart)
  if (value.kind !== 'streams' && parts.length !== 1) {
    throw invalidArguments()
  }
  return {
    kind: value.kind,
    path: parseFilePath(value.path),
    parts,
  }
}

function parseMetadata(value: unknown): ActionMultipartMetadata {
  if (
    !isRecord(value) ||
    !Array.isArray(value.args) ||
    !Array.isArray(value.files)
  ) {
    throw invalidArguments()
  }
  const files = value.files.map(parseFileDescriptor)
  const ids = new Set<string>()
  for (const descriptor of files) {
    for (const part of descriptor.parts) {
      if (ids.has(part.id)) {
        throw invalidArguments()
      }
      ids.add(part.id)
    }
  }
  return { args: value.args, files }
}

class PayloadBudget {
  private received = 0

  constructor(private readonly limit: number) {}

  add(size: number): void {
    this.received += size
    if (this.received > this.limit) {
      throw payloadTooLarge()
    }
  }
}

function isFilePart(part: Multipart): part is MultipartFile {
  return part.type === 'file'
}

async function nextFilePart(
  iterator: AsyncIterableIterator<Multipart>,
  expected: ActionFilePart,
): Promise<MultipartFile> {
  const result = await iterator.next()
  if (result.done || !isFilePart(result.value)) {
    throw invalidArguments()
  }
  if (
    result.value.fieldname !==
    `${ACTION_MULTIPART_FILE_PREFIX}${expected.id}`
  ) {
    result.value.file.resume()
    throw invalidArguments()
  }
  return result.value
}

async function readMemoryFile(
  iterator: AsyncIterableIterator<Multipart>,
  expected: ActionFilePart,
  budget: PayloadBudget,
): Promise<File> {
  const part = await nextFilePart(iterator, expected)
  const chunks: Uint8Array[] = []
  let limitError: Error | undefined
  for await (const chunk of part.file) {
    const bytes = chunk as Uint8Array
    if (!limitError) {
      try {
        budget.add(bytes.byteLength)
        chunks.push(bytes)
      } catch (error) {
        limitError = error as Error
        chunks.length = 0
      }
    }
  }
  if (limitError) {
    throw limitError
  }
  if (part.file.truncated) {
    throw payloadTooLarge()
  }
  return new NodeFile(chunks, expected.name, {
    type: expected.type,
    lastModified: expected.lastModified,
  }) as File
}

interface TransferHandle {
  readonly done: Promise<void>
  skip(): void
}

class TransferSink extends Writable {
  private skipped: boolean
  private failure: Error | undefined
  private waiting:
    | {
        callback: (error?: Error | null) => void
        onDrain: () => void
      }
    | undefined

  constructor(
    private readonly output: PassThrough,
    private readonly budget: PayloadBudget,
    skipped: boolean,
    private readonly complete: (error?: Error) => void,
  ) {
    super()
    this.skipped = skipped
    if (skipped) {
      output.destroy()
    }
    output.on('error', () => this.skip())
    output.on('close', () => {
      if (!output.readableEnded) {
        this.skip()
      }
    })
  }

  skip(): void {
    if (this.skipped) {
      return
    }
    this.skipped = true
    this.output.destroy()
    if (this.waiting) {
      this.output.off('drain', this.waiting.onDrain)
      const { callback } = this.waiting
      this.waiting = undefined
      callback()
    }
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.budget.add(chunk.byteLength)
    } catch (error) {
      this.failure = error as Error
      this.skip()
      callback()
      return
    }

    if (this.skipped || this.output.write(chunk)) {
      callback()
      return
    }

    const onDrain = () => {
      this.waiting = undefined
      callback()
    }
    this.waiting = { callback, onDrain }
    this.output.once('drain', onDrain)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.complete(this.failure)
    if (!this.skipped) {
      this.output.end()
    }
    callback()
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.complete(error ?? undefined)
    this.output.destroy(error ?? undefined)
    callback(error)
  }
}

class StreamCoordinator {
  private nextIndex = 0
  private active:
    | {
        id: string
        handle: TransferHandle
      }
    | undefined
  private terminalError: Error | undefined
  private ended = false

  constructor(
    private readonly iterator: AsyncIterableIterator<Multipart>,
    private readonly parts: ActionFilePart[],
    private readonly budget: PayloadBudget,
  ) {}

  isComplete(id: string): boolean {
    return this.parts.findIndex((part) => part.id === id) < this.nextIndex
  }

  assertNext(id: string): void {
    if (
      this.terminalError ||
      this.active ||
      this.parts[this.nextIndex]?.id !== id
    ) {
      throw streamOrderError()
    }
  }

  start(
    expected: ActionFilePart,
    output: PassThrough,
    skipped: boolean,
  ): TransferHandle {
    this.assertNext(expected.id)

    let sink: TransferSink | undefined
    let skipRequested = skipped
    let resolveDone!: () => void
    let rejectDone!: (error: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    done.catch(() => {})

    let completed = false
    const complete = (error?: Error) => {
      if (completed) {
        return
      }
      completed = true
      if (error) {
        this.terminalError = error
        rejectDone(error)
      } else {
        this.nextIndex += 1
        resolveDone()
      }
      this.active = undefined
    }

    const handle: TransferHandle = {
      done,
      skip() {
        skipRequested = true
        sink?.skip()
      },
    }
    this.active = { id: expected.id, handle }

    void (async () => {
      try {
        const part = await nextFilePart(this.iterator, expected)
        sink = new TransferSink(
          output,
          this.budget,
          skipRequested,
          (error) => {
            if (!error && part.file.truncated) {
              complete(payloadTooLarge())
              return
            }
            complete(error)
          },
        )
        part.file.on('error', (error) => sink?.destroy(error))
        part.file.pipe(sink)
      } catch (error) {
        complete(error as Error)
        output.destroy(error as Error)
      }
    })()

    return handle
  }

  async skipAll(): Promise<void> {
    if (this.active) {
      this.active.handle.skip()
      await this.active.handle.done
    }
    while (this.nextIndex < this.parts.length) {
      const output = new PassThrough()
      output.resume()
      const handle = this.start(
        this.parts[this.nextIndex],
        output,
        true,
      )
      await handle.done
    }
  }

  async finish(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError
    }
    await this.skipAll()
    if (this.terminalError) {
      throw this.terminalError
    }
    if (!this.ended) {
      this.ended = true
      const extra = await this.iterator.next()
      if (!extra.done) {
        if (isFilePart(extra.value)) {
          extra.value.file.resume()
        }
        throw invalidArguments()
      }
    }
  }
}

class ServerFileStream implements FileStream {
  private output: PassThrough | undefined
  private readable: ReadableStream<Uint8Array> | undefined
  private transfer: TransferHandle | undefined
  private skipped = false

  constructor(
    readonly name: string,
    readonly type: string,
    private readonly part: ActionFilePart,
    private readonly coordinator: StreamCoordinator,
  ) {}

  get stream(): ReadableStream<Uint8Array> {
    if (this.skipped) {
      throw new ActionRequestError(
        'FileStream 已经被跳过',
        'FILE_STREAM_SKIPPED',
        500,
      )
    }
    if (!this.readable) {
      this.output = new PassThrough()
      this.transfer = this.coordinator.start(
        this.part,
        this.output,
        false,
      )
      this.readable = Readable.toWeb(
        this.output,
      ) as ReadableStream<Uint8Array>
    }
    return this.readable
  }

  get complete(): boolean {
    return this.coordinator.isComplete(this.part.id)
  }

  async skip(): Promise<void> {
    if (this.complete || this.skipped) {
      return
    }
    this.skipped = true
    if (!this.transfer) {
      this.output = new PassThrough()
      this.output.resume()
      this.transfer = this.coordinator.start(
        this.part,
        this.output,
        true,
      )
    } else {
      this.transfer.skip()
    }
    await this.transfer.done
  }
}

class ServerFileStreams
  implements FileStreams, AsyncIterator<FileStream>
{
  private index = 0
  private current: ServerFileStream | undefined
  private iterating = false
  private finished = false

  constructor(
    private readonly parts: ActionFilePart[],
    private readonly coordinator: StreamCoordinator,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<FileStream> {
    if (this.iterating && !this.finished) {
      throw new ActionRequestError(
        'FileStreams 只能迭代一次',
        'FILE_STREAMS_CONSUMED',
        500,
      )
    }
    this.iterating = true
    return this
  }

  async next(): Promise<IteratorResult<FileStream>> {
    if (this.finished) {
      return { done: true, value: undefined }
    }
    if (this.current && !this.current.complete) {
      throw streamOrderError()
    }
    if (this.index >= this.parts.length) {
      this.finished = true
      return { done: true, value: undefined }
    }

    const part = this.parts[this.index++]
    this.coordinator.assertNext(part.id)
    this.current = new ServerFileStream(
      part.name,
      part.type,
      part,
      this.coordinator,
    )
    return { done: false, value: this.current }
  }

  async return(): Promise<IteratorResult<FileStream>> {
    await this.skip()
    return { done: true, value: undefined }
  }

  async skip(): Promise<void> {
    if (this.finished) {
      return
    }
    if (this.current && !this.current.complete) {
      await this.current.skip()
    }
    while (this.index < this.parts.length) {
      const part = this.parts[this.index++]
      const file = new ServerFileStream(
        part.name,
        part.type,
        part,
        this.coordinator,
      )
      await file.skip()
    }
    this.finished = true
  }
}

function setPath(
  args: unknown[],
  path: ActionFilePath,
  value: unknown,
): void {
  let target: unknown = args
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (
      (typeof target !== 'object' || target === null) ||
      !Object.hasOwn(target, key)
    ) {
      throw invalidArguments()
    }
    target = (target as Record<string | number, unknown>)[key]
  }

  const key = path[path.length - 1]
  if (
    typeof target !== 'object' ||
    target === null ||
    !Object.hasOwn(target, key) ||
    (target as Record<string | number, unknown>)[key] !== null
  ) {
    throw invalidArguments()
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

export interface ActionFileSession {
  args: unknown[]
  finish(): Promise<void>
}

export async function readActionMultipart(
  request: FastifyRequest,
): Promise<ActionFileSession> {
  const bodyLimit = request.routeOptions.bodyLimit
  const contentLength = Number(request.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
    throw payloadTooLarge()
  }

  const iterator = request.parts({
    limits: {
      fieldSize: bodyLimit,
      fileSize: bodyLimit,
    },
  })
  const first = await iterator.next()
  if (
    first.done ||
    first.value.type !== 'field' ||
    first.value.fieldname !== ACTION_MULTIPART_METADATA_FIELD ||
    first.value.valueTruncated ||
    typeof first.value.value !== 'string'
  ) {
    throw invalidArguments()
  }

  const budget = new PayloadBudget(bodyLimit)
  budget.add(Buffer.byteLength(first.value.value))

  let parsed: unknown
  try {
    parsed = JSON.parse(first.value.value)
  } catch {
    throw invalidArguments()
  }
  const metadata = parseMetadata(parsed)

  const memoryDescriptors = metadata.files.filter(
    (descriptor) => descriptor.kind === 'file',
  )
  for (const descriptor of memoryDescriptors) {
    const file = await readMemoryFile(
      iterator,
      descriptor.parts[0],
      budget,
    )
    setPath(metadata.args, descriptor.path, file)
  }

  const streamDescriptors = metadata.files.filter(
    (descriptor) => descriptor.kind !== 'file',
  )
  const streamParts = streamDescriptors.flatMap(
    (descriptor) => descriptor.parts,
  )
  const coordinator = new StreamCoordinator(
    iterator,
    streamParts,
    budget,
  )

  for (const descriptor of streamDescriptors) {
    if (descriptor.kind === 'stream') {
      const part = descriptor.parts[0]
      setPath(
        metadata.args,
        descriptor.path,
        new ServerFileStream(
          part.name,
          part.type,
          part,
          coordinator,
        ),
      )
    } else {
      setPath(
        metadata.args,
        descriptor.path,
        new ServerFileStreams(descriptor.parts, coordinator),
      )
    }
  }

  return {
    args: metadata.args,
    finish: () => coordinator.finish(),
  }
}
