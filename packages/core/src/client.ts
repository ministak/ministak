import { shallowRef, type Ref } from 'vue'
import {
  ACTION_MULTIPART_FILE_PREFIX,
  ACTION_MULTIPART_METADATA_FIELD,
  type ActionFileDescriptor,
  type ActionFilePart,
} from './action-protocol.js'
import type {
  FileStream,
  FileStreams,
  RpcFailure,
  RpcResponse,
  RpcSuccess,
} from './types.js'

export class ServerActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ServerActionError'
  }
}

export type ClientServerAction = (...args: never[]) => unknown

export interface ServerActionRequest<T> extends Promise<T> {
  readonly loading: boolean
  bindLoading(loading: Ref<boolean>): this
}

export interface ServerActionRequestContext {
  readonly action: ClientServerAction
  args: unknown[]
  headers: Headers
}

export interface ServerActionResponseContext
  extends ServerActionRequestContext {
  readonly response: Response
  readonly data: unknown
}

export interface ServerActionErrorContext
  extends ServerActionRequestContext {
  readonly response?: Response
  readonly error: unknown
}

export interface ServerActionHooks {
  onRequest?(
    context: ServerActionRequestContext,
  ): void | Promise<void>
  onResponse?(
    context: ServerActionResponseContext,
  ): unknown | Promise<unknown>
  onError?(
    context: ServerActionErrorContext,
  ): unknown | Promise<unknown>
}

let serverActionHooks: ServerActionHooks | undefined
const loadingBindingCounts = new WeakMap<Ref<boolean>, number>()

class ClientFileStream implements FileStream {
  readonly name: string
  readonly type: string

  constructor(readonly source: File) {
    this.name = source.name
    this.type = source.type
  }

  get stream(): ReadableStream<Uint8Array> {
    return this.source.stream()
  }

  async skip(): Promise<void> {
    await this.stream.cancel()
  }
}

class ClientFileStreams implements FileStreams {
  constructor(readonly source: Iterable<File>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<FileStream> {
    for (const file of this.source) {
      assertFile(file)
      yield new ClientFileStream(file)
    }
  }

  async skip(): Promise<void> {
    for await (const file of this) {
      await file.skip()
    }
  }
}

export function fileStream(file: File): FileStream {
  assertFile(file)
  return new ClientFileStream(file)
}

export function fileStreams(files: Iterable<File>): FileStreams {
  if (
    !files ||
    typeof files !== 'object' ||
    typeof files[Symbol.iterator] !== 'function'
  ) {
    throw new TypeError('fileStreams() 只接受可迭代的 File 集合')
  }
  return new ClientFileStreams(files)
}

export function setServerActionHooks(
  hooks?: ServerActionHooks,
): void {
  serverActionHooks = hooks
}

function startLoading(binding: Ref<boolean>): void {
  loadingBindingCounts.set(
    binding,
    (loadingBindingCounts.get(binding) ?? 0) + 1,
  )
  binding.value = true
}

function finishLoading(binding: Ref<boolean>): void {
  const count = loadingBindingCounts.get(binding)!
  if (count === 1) {
    loadingBindingCounts.delete(binding)
    binding.value = false
    return
  }
  loadingBindingCounts.set(binding, count - 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRpcSuccess(value: unknown): value is RpcSuccess {
  return isRecord(value) && value.ok === true
}

function isRpcFailure(value: unknown): value is RpcFailure {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) {
    return false
  }
  return (
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string' &&
    (value.error.requestId === undefined ||
      typeof value.error.requestId === 'string')
  )
}

function assertFile(value: unknown): asserts value is File {
  if (typeof File === 'undefined' || !(value instanceof File)) {
    throw new TypeError('文件参数必须是 File')
  }
}

interface EncodedFilePart {
  metadata: ActionFilePart
  file: File
}

function encodeActionArguments(args: unknown[]): string | FormData {
  const descriptors: ActionFileDescriptor[] = []
  const memoryParts: EncodedFilePart[] = []
  const streamParts: EncodedFilePart[] = []
  const paths = new WeakMap<object, Array<string | number>>()
  let partIndex = 0
  let root = true

  const createPart = (file: File): EncodedFilePart => ({
    metadata: {
      id: String(partIndex++),
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
    },
    file,
  })

  const argsJson = JSON.stringify(args, function (key, value) {
    if (root) {
      root = false
      if (typeof value === 'object' && value !== null) {
        paths.set(value, [])
      }
      return value
    }

    const parentPath = paths.get(this as object)
    if (!parentPath) {
      return value
    }
    const path = [
      ...parentPath,
      Array.isArray(this) ? Number(key) : key,
    ]

    if (value instanceof ClientFileStream) {
      const part = createPart(value.source)
      streamParts.push(part)
      descriptors.push({
        kind: 'stream',
        path,
        parts: [part.metadata],
      })
      return null
    }

    if (value instanceof ClientFileStreams) {
      const parts: EncodedFilePart[] = []
      for (const file of value.source) {
        assertFile(file)
        parts.push(createPart(file))
      }
      streamParts.push(...parts)
      descriptors.push({
        kind: 'streams',
        path,
        parts: parts.map((part) => part.metadata),
      })
      return null
    }

    if (typeof File !== 'undefined' && value instanceof File) {
      const part = createPart(value)
      memoryParts.push(part)
      descriptors.push({
        kind: 'file',
        path,
        parts: [part.metadata],
      })
      return null
    }

    if (typeof value === 'object' && value !== null) {
      paths.set(value, path)
    }
    return value
  })

  if (descriptors.length === 0) {
    return argsJson
  }

  const metadata = `{"args":${argsJson},"files":${JSON.stringify(descriptors)}}`
  const body = new FormData()
  body.append(ACTION_MULTIPART_METADATA_FIELD, metadata)
  for (const part of [...memoryParts, ...streamParts]) {
    body.append(
      `${ACTION_MULTIPART_FILE_PREFIX}${part.metadata.id}`,
      part.file,
      part.metadata.name,
    )
  }
  return body
}

async function readRpcResponse(response: Response): Promise<RpcResponse> {
  let value: unknown
  try {
    value = JSON.parse(await response.text())
  } catch {
    throw new ServerActionError(
      'INVALID_RESPONSE',
      'Server Action 返回了无效响应',
      response.status,
    )
  }

  if (!isRpcSuccess(value) && !isRpcFailure(value)) {
    throw new ServerActionError(
      'INVALID_RESPONSE',
      'Server Action 返回了无效响应',
      response.status,
    )
  }
  return value
}

async function executeServerAction(
  actionPath: string,
  transportId: string,
  args: unknown[],
  action: ClientServerAction,
): Promise<unknown> {
  const hooks = serverActionHooks
  const request: ServerActionRequestContext = {
    action,
    args,
    headers: new Headers({
      'x-action-id': transportId,
    }),
  }
  let response: Response | undefined

  try {
    await hooks?.onRequest?.(request)
    const body = encodeActionArguments(request.args)
    if (body instanceof FormData) {
      request.headers.delete('content-type')
    } else {
      request.headers.set('content-type', 'application/json')
    }
    response = await fetch(actionPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: request.headers,
      body:
        typeof body === 'string'
          ? `{"args":${body}}`
          : body,
    })

    const payload = await readRpcResponse(response)
    if (!payload.ok) {
      throw new ServerActionError(
        payload.error.code,
        payload.error.message,
        response.status,
        payload.error.requestId,
      )
    }

    if (hooks?.onResponse) {
      return await hooks.onResponse({
        ...request,
        response,
        data: payload.data,
      })
    }
    return payload.data
  } catch (error) {
    if (hooks?.onError) {
      return await hooks.onError({
        ...request,
        response,
        error,
      })
    }
    throw error
  }
}

function createServerActionRequest<T>(
  execute: () => Promise<T>,
): ServerActionRequest<T> {
  const loading = shallowRef(false)
  const bindings = new Set<Ref<boolean>>()
  const activeBindings = new Set<Ref<boolean>>()
  let execution: Promise<T> | undefined

  const activateBinding = (binding: Ref<boolean>) => {
    if (activeBindings.has(binding)) {
      return
    }
    activeBindings.add(binding)
    startLoading(binding)
  }

  const start = () => {
    if (!execution) {
      loading.value = true
      bindings.forEach(activateBinding)
      execution = execute().finally(() => {
        loading.value = false
        activeBindings.forEach(finishLoading)
        activeBindings.clear()
      })
    }
    return execution
  }

  const request: ServerActionRequest<T> = {
    [Symbol.toStringTag]: 'ServerActionRequest',
    get loading() {
      return loading.value
    },
    bindLoading(binding) {
      bindings.add(binding)
      if (loading.value) {
        activateBinding(binding)
      }
      return request
    },
    then(onfulfilled, onrejected) {
      return start().then(onfulfilled, onrejected)
    },
    catch(onrejected) {
      return start().catch(onrejected)
    },
    finally(onfinally) {
      return start().finally(onfinally)
    },
  }
  return request
}

export function callServerAction(
  actionPath: string,
  transportId: string,
  args: unknown[],
  action: ClientServerAction = callServerAction as ClientServerAction,
): ServerActionRequest<unknown> {
  return createServerActionRequest(() =>
    executeServerAction(actionPath, transportId, args, action),
  )
}

export function createServerReference<T extends (...args: never[]) => unknown>(
  actionPath: string,
  transportId: string,
): (
  ...args: Parameters<T>
) => ServerActionRequest<Awaited<ReturnType<T>>> {
  const action = (...args: Parameters<T>) =>
    callServerAction(
      actionPath,
      transportId,
      args,
      action as ClientServerAction,
    ) as ServerActionRequest<
      Awaited<ReturnType<T>>
    >
  return action
}
