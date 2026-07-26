import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { text } from 'node:stream/consumers'
import fastifyMultipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createServerReference,
  fileStream,
  fileStreams,
} from '../packages/core/src/client.js'
import {
  ActionError,
  createFrameworkApp,
  getActionContext,
} from '../packages/core/src/server.js'
import type {
  ActionHandler,
  FileStream,
  FileStreams,
} from '../packages/core/src/types.js'
import {
  ACTION_MULTIPART_FILE_PREFIX,
  ACTION_MULTIPART_METADATA_FIELD,
} from '../packages/core/src/action-protocol.js'

type FrameworkApp = Awaited<ReturnType<typeof createFrameworkApp>>

const apps: FrameworkApp[] = []
const temporaryDirectories: string[] = []
const actionName = 'src/action.ts#run'
const transportId = 'a_test_transport_id'
const actionHeaders = {
  'content-type': 'application/json',
  'x-action-id': transportId,
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function createActionApp(options: {
  bodyLimit?: number
  configure?: (app: FastifyInstance) => Promise<void> | void
  handler?: ActionHandler
} = {}): Promise<FrameworkApp> {
  const userApp = Fastify({
    bodyLimit: options.bodyLimit,
  })
  await options.configure?.(userApp)
  const app = await createFrameworkApp({
    app: userApp,
    actionPath: '/_actions',
    actionRegistry: {
      [transportId]: {
        name: actionName,
        load: async () => options.handler ?? (async () => true),
      },
    },
    development: true,
  })
  apps.push(app)
  return app
}

async function actionUrl(app: FrameworkApp): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('测试服务器没有取得端口')
  }
  return `http://127.0.0.1:${address.port}/_actions`
}

function createMultipartBody(
  metadata: unknown,
  files: Array<{ id: string; file: File }> = [],
): FormData {
  const body = new FormData()
  body.append(
    ACTION_MULTIPART_METADATA_FIELD,
    typeof metadata === 'string'
      ? metadata
      : JSON.stringify(metadata),
  )
  for (const { id, file } of files) {
    body.append(
      `${ACTION_MULTIPART_FILE_PREFIX}${id}`,
      file,
      file.name,
    )
  }
  return body
}

describe('Server Action Fastify 请求链路', () => {
  test.each([
    {
      name: '不支持的请求类型',
      headers: {
        'content-type': 'text/plain',
        'x-action-id': transportId,
      },
      payload: 'body',
      status: 415,
      code: 'UNSUPPORTED_CONTENT_TYPE',
    },
    {
      name: '缺少 Action ID',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ args: [] }),
      status: 400,
      code: 'ACTION_ID_REQUIRED',
    },
    {
      name: 'Action ID 不存在',
      headers: {
        'content-type': 'application/json',
        'x-action-id': 'missing',
      },
      payload: JSON.stringify({ args: [] }),
      status: 404,
      code: 'ACTION_NOT_FOUND',
    },
    {
      name: '请求体缺少 args',
      headers: actionHeaders,
      payload: JSON.stringify({}),
      status: 400,
      code: 'INVALID_ARGUMENTS',
    },
    {
      name: 'args 不是数组',
      headers: actionHeaders,
      payload: JSON.stringify({ args: {} }),
      status: 400,
      code: 'INVALID_ARGUMENTS',
    },
  ])('$name', async ({ headers, payload, status, code }) => {
    const app = await createActionApp()
    const response = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers,
      payload,
    })

    expect(response.statusCode).toBe(status)
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code,
        requestId: expect.any(String),
      },
    })
    expect(response.headers['cache-control']).toBe(
      'no-cache, no-store, max-age=0',
    )
  })

  test('公开 ID 在请求入口转换为内部 Action 名称', async () => {
    let hookActionName: string | undefined
    let contextActionName: string | undefined
    const app = await createActionApp({
      configure(instance) {
        instance.addHook('onRequest', async (request) => {
          hookActionName = request.serverAction?.name
        })
      },
      handler: async () => {
        contextActionName = getActionContext().actionName
        return true
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: actionHeaders,
      payload: JSON.stringify({ args: [] }),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, data: true })
    expect(response.headers['cache-control']).toBe(
      'no-cache, no-store, max-age=0',
    )
    expect(hookActionName).toBe(actionName)
    expect(contextActionName).toBe(actionName)

    const internalNameRequest = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: {
        'content-type': 'application/json',
        'x-action-id': actionName,
      },
      payload: JSON.stringify({ args: [] }),
    })
    expect(internalNameRequest.statusCode).toBe(404)
    expect(internalNameRequest.body).not.toContain(actionName)
  })

  test('统一处理内容解析、Fastify 请求体限制和 Hook 错误', async () => {
    const app = await createActionApp({
      bodyLimit: 64,
      configure(instance) {
        instance.addHook('onRequest', async (request) => {
          if (request.headers['x-hook-error']) {
            throw new Error('AUTH_SECRET_DETAIL')
          }
        })
      },
    })

    const malformed = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: actionHeaders,
      payload: '{"args":',
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    })

    const oversized = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: actionHeaders,
      payload: JSON.stringify({ args: ['x'.repeat(100)] }),
    })
    expect(oversized.statusCode).toBe(413)
    expect(oversized.json()).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    })

    const hookError = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: { ...actionHeaders, 'x-hook-error': 'true' },
      payload: JSON.stringify({ args: [] }),
    })
    expect(hookError.statusCode).toBe(500)
    expect(hookError.json()).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务端内部错误',
      },
    })
    expect(hookError.body).not.toContain('AUTH_SECRET_DETAIL')
  })

  test('ActionError 默认公开消息并允许自定义错误信息', async () => {
    const defaultApp = await createActionApp({
      handler: async () => {
        throw new ActionError('操作失败')
      },
    })
    const defaultResponse = await defaultApp.inject({
      method: 'POST',
      url: '/_actions',
      headers: actionHeaders,
      payload: JSON.stringify({ args: [] }),
    })
    expect(defaultResponse.statusCode).toBe(400)
    expect(defaultResponse.json()).toMatchObject({
      ok: false,
      error: { code: 'ACTION_ERROR', message: '操作失败' },
    })

    const customApp = await createActionApp({
      handler: async () => {
        throw new ActionError('请先登录', {
          code: 'UNAUTHORIZED',
          status: 401,
        })
      },
    })
    const customResponse = await customApp.inject({
      method: 'POST',
      url: '/_actions',
      headers: actionHeaders,
      payload: JSON.stringify({ args: [] }),
    })
    expect(customResponse.statusCode).toBe(401)
    expect(customResponse.json()).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    })
  })

  test('隐藏 Action 内部异常并在响应中保留请求 ID', async () => {
    const app = await createActionApp({
      handler: async () => {
        throw new Error('DATABASE_PASSWORD')
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: actionHeaders,
      payload: JSON.stringify({ args: [] }),
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务端内部错误',
        requestId: expect.any(String),
      },
    })
    expect(response.body).not.toContain('DATABASE_PASSWORD')
  })

  test('Action 返回值无法序列化时返回统一内部错误', async () => {
    const app = await createActionApp({
      handler: async () => 1n,
    })
    const response = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: actionHeaders,
      payload: JSON.stringify({ args: [] }),
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务端内部错误',
        requestId: expect.any(String),
      },
    })
  })

  test('并发请求的 Action 上下文彼此隔离', async () => {
    let entered = 0
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = await createActionApp({
      handler: async (label) => {
        const before = getActionContext()
        entered += 1
        if (entered === 2) {
          release()
        }
        await ready
        const after = getActionContext()
        return {
          label,
          before: before.request.headers['x-label'],
          after: after.request.headers['x-label'],
          sameRequestId: before.requestId === after.requestId,
          requestId: after.requestId,
        }
      },
    })
    const url = await actionUrl(app)

    const call = async (label: string) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...actionHeaders,
          'x-label': label,
        },
        body: JSON.stringify({ args: [label] }),
      })
      return response.json()
    }
    const [first, second] = await Promise.all([
      call('first'),
      call('second'),
    ])

    expect(first).toMatchObject({
      ok: true,
      data: {
        label: 'first',
        before: 'first',
        after: 'first',
        sameRequestId: true,
      },
    })
    expect(second).toMatchObject({
      ok: true,
      data: {
        label: 'second',
        before: 'second',
        after: 'second',
        sameRequestId: true,
      },
    })
    expect(first.data.requestId).not.toBe(second.data.requestId)
  })

  test('Action 请求之外不能读取上下文', () => {
    expect(() => getActionContext()).toThrow(
      '当前代码不在 Server Action 请求上下文中',
    )
  })

  test('同时恢复内存文件和按顺序读取流文件', async () => {
    let received:
      | {
          memory: Array<{
            content: string
            name: string
            type: string
            lastModified: number
          }>
          stream: {
            content: string
            name: string
            type: string
          }
          streams: Array<{
            content: string
            name: string
            type: string
          }>
        }
      | undefined
    const app = await createActionApp({
      bodyLimit: 1024 * 1024,
      handler: (async (
        memory: File[],
        stream: FileStream,
        streams: FileStreams,
      ) => {
        const streamed = await text(stream.stream)
        const values: Array<{
          content: string
          name: string
          type: string
        }> = []
        for await (const file of streams) {
          values.push({
            content: await text(file.stream),
            name: file.name,
            type: file.type,
          })
        }
        received = {
          memory: await Promise.all(
            memory.map(async (file) => ({
              content: await file.text(),
              name: file.name,
              type: file.type,
              lastModified: file.lastModified,
            })),
          ),
          stream: {
            content: streamed,
            name: stream.name,
            type: stream.type,
          },
          streams: values,
        }
        return received
      }) as ActionHandler,
    })
    const action = createServerReference<
      (
        memory: File[],
        stream: FileStream,
        streams: FileStreams,
      ) => Promise<typeof received>
    >(await actionUrl(app), transportId)

    const result = await action(
      [
        new File(['a'], 'a.txt', {
          type: 'text/plain',
          lastModified: 1,
        }),
        new File(['b'], 'b.json', {
          type: 'application/json',
          lastModified: 2,
        }),
      ],
      fileStream(
        new File(['c'], 'c.txt', {
          type: 'text/plain',
          lastModified: 3,
        }),
      ),
      fileStreams([
        new File(['d'], 'd.txt', { type: 'text/plain' }),
        new File(['e'], 'e.json', { type: 'application/json' }),
      ]),
    )

    expect(result).toEqual({
      memory: [
        {
          content: 'a',
          name: 'a.txt',
          type: 'text/plain',
          lastModified: 1,
        },
        {
          content: 'b',
          name: 'b.json',
          type: 'application/json',
          lastModified: 2,
        },
      ],
      stream: {
        content: 'c',
        name: 'c.txt',
        type: 'text/plain',
      },
      streams: [
        {
          content: 'd',
          name: 'd.txt',
          type: 'text/plain',
        },
        {
          content: 'e',
          name: 'e.json',
          type: 'application/json',
        },
      ],
    })
    expect(received).toEqual(result)
  })

  test('鉴权 Hook 拒绝请求时不会解析 multipart', async () => {
    let called = false
    const app = await createActionApp({
      configure(instance) {
        instance.addHook('onRequest', async (request) => {
          if (request.serverAction) {
            throw new ActionError('无权上传', {
              code: 'FORBIDDEN',
              status: 403,
            })
          }
        })
      },
      handler: async () => {
        called = true
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/_actions',
      headers: {
        'content-type': 'multipart/form-data; boundary=invalid',
        'x-action-id': transportId,
      },
      payload: '无效的 multipart 内容',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', message: '无权上传' },
    })
    expect(called).toBe(false)
  })

  test('multipart 文件遵循 Fastify 请求体大小限制', async () => {
    const app = await createActionApp({ bodyLimit: 256 })
    const action = createServerReference<
      (file: File) => Promise<void>
    >(await actionUrl(app), transportId)

    await expect(
      action(new File(['x'.repeat(512)], 'large.txt')),
    ).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    })
  })

  test('拒绝损坏、缺失、重复和多余的 multipart 数据', async () => {
    const app = await createActionApp()
    const url = await actionUrl(app)
    const filePart = {
      id: '0',
      name: 'file.txt',
      type: 'text/plain',
      lastModified: 1,
    }
    const requests: Array<BodyInit> = [
      createMultipartBody('{'),
      createMultipartBody({
        args: [null, null],
        files: [
          { kind: 'file', path: [0], parts: [filePart] },
          { kind: 'file', path: [1], parts: [filePart] },
        ],
      }),
      createMultipartBody({
        args: [null],
        files: [{ kind: 'file', path: [0], parts: [filePart] }],
      }),
      createMultipartBody({
        args: [null],
        files: [{ kind: 'stream', path: [0], parts: [filePart] }],
      }),
      createMultipartBody(
        {
          args: [1],
          files: [{ kind: 'file', path: [0], parts: [filePart] }],
        },
        [{ id: '0', file: new File(['content'], 'file.txt') }],
      ),
      createMultipartBody(
        { args: [], files: [] },
        [{ id: '0', file: new File(['extra'], 'extra.txt') }],
      ),
    ]
    const fileBeforeMetadata = new FormData()
    fileBeforeMetadata.append(
      `${ACTION_MULTIPART_FILE_PREFIX}0`,
      new File(['content'], 'file.txt'),
      'file.txt',
    )
    fileBeforeMetadata.append(
      ACTION_MULTIPART_METADATA_FIELD,
      JSON.stringify({
        args: [null],
        files: [{ kind: 'file', path: [0], parts: [filePart] }],
      }),
    )
    requests.push(fileBeforeMetadata)

    for (const body of requests) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'x-action-id': transportId },
        body,
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_ARGUMENTS' },
      })
    }

    const missingBoundary = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data',
        'x-action-id': transportId,
      },
      body: 'invalid',
    })
    expect(missingBoundary.status).toBe(400)
    await expect(missingBoundary.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    })
  })

  test('读取缺失的文件流时返回参数错误且不产生未处理异常', async () => {
    const app = await createActionApp({
      handler: (async (file: FileStream) =>
        text(file.stream)) as ActionHandler,
    })
    const url = await actionUrl(app)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-action-id': transportId },
      body: createMultipartBody({
        args: [null],
        files: [
          {
            kind: 'stream',
            path: [0],
            parts: [
              {
                id: '0',
                name: 'missing.txt',
                type: 'text/plain',
                lastModified: 1,
              },
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENTS' },
    })
  })

  test('复用应用已经注册的 multipart 插件', async () => {
    const app = await createActionApp({
      async configure(instance) {
        await instance.register(fastifyMultipart)
      },
      handler: (async (file: File) => file.text()) as ActionHandler,
    })
    const action = createServerReference<
      (file: File) => Promise<string>
    >(await actionUrl(app), transportId)

    await expect(
      action(new File(['content'], 'file.txt')),
    ).resolves.toBe('content')
  })

  test('Action 未读取文件流时自动跳过并正常结束请求', async () => {
    const app = await createActionApp({
      handler: async () => 'done',
    })
    const action = createServerReference<
      (
        file: FileStream,
        files: FileStreams,
      ) => Promise<string>
    >(await actionUrl(app), transportId)

    await expect(
      action(
        fileStream(new File(['one'], 'one.txt')),
        fileStreams([
          new File(['two'], 'two.txt'),
          new File(['three'], 'three.txt'),
        ]),
      ),
    ).resolves.toBe('done')
  })

  test('Action 失败时清理未读取文件流并保留原始业务异常', async () => {
    const app = await createActionApp({
      handler: async () => {
        throw new ActionError('上传被拒绝', {
          code: 'UPLOAD_REJECTED',
          status: 422,
        })
      },
    })
    const action = createServerReference<
      (file: FileStream) => Promise<void>
    >(await actionUrl(app), transportId)

    await expect(
      action(fileStream(new File(['content'], 'file.txt'))),
    ).rejects.toMatchObject({
      code: 'UPLOAD_REJECTED',
      message: '上传被拒绝',
      status: 422,
    })
  })

  test('Action 已失败时文件流清理错误不会覆盖业务异常', async () => {
    const app = await createActionApp({
      handler: async () => {
        throw new ActionError('业务失败', {
          code: 'BUSINESS_ERROR',
          status: 409,
        })
      },
    })
    const url = await actionUrl(app)
    const first = {
      id: '0',
      name: 'first.txt',
      type: 'text/plain',
      lastModified: 1,
    }
    const missing = {
      id: '1',
      name: 'missing.txt',
      type: 'text/plain',
      lastModified: 2,
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-action-id': transportId },
      body: createMultipartBody(
        {
          args: [null, null],
          files: [
            { kind: 'stream', path: [0], parts: [first] },
            { kind: 'stream', path: [1], parts: [missing] },
          ],
        },
        [{ id: '0', file: new File(['first'], 'first.txt') }],
      ),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'BUSINESS_ERROR',
        message: '业务失败',
      },
    })
  })

  test('FileStream 和 FileStreams 可以跳过并继续后续文件', async () => {
    const app = await createActionApp({
      bodyLimit: 1024 * 1024,
      handler: (async (
        skipped: FileStream,
        skippedMany: FileStreams,
        used: FileStream,
      ) => {
        await skipped.skip()
        await skippedMany.skip()
        return text(used.stream)
      }) as ActionHandler,
    })
    const action = createServerReference<
      (
        skipped: FileStream,
        skippedMany: FileStreams,
        used: FileStream,
      ) => Promise<string>
    >(await actionUrl(app), transportId)

    await expect(
      action(
        fileStream(new File(['skip'], 'skip.txt')),
        fileStreams([
          new File(['skip-1'], 'skip-1.txt'),
          new File(['skip-2'], 'skip-2.txt'),
        ]),
        fileStream(new File(['used'], 'used.txt')),
      ),
    ).resolves.toBe('used')
  })

  test('FileStream 开始读取后仍可跳过并继续下一个文件', async () => {
    const app = await createActionApp({
      bodyLimit: 2 * 1024 * 1024,
      handler: (async (
        first: FileStream,
        second: FileStream,
      ) => {
        const reader = first.stream.getReader()
        const chunk = await reader.read()
        await reader.cancel()
        await first.skip()
        return {
          read: chunk.value?.byteLength ?? 0,
          second: await text(second.stream),
        }
      }) as ActionHandler,
    })
    const action = createServerReference<
      (
        first: FileStream,
        second: FileStream,
      ) => Promise<{ read: number; second: string }>
    >(await actionUrl(app), transportId)

    const result = await action(
      fileStream(new File(['x'.repeat(512 * 1024)], 'large.txt')),
      fileStream(new File(['second'], 'second.txt')),
    )
    expect(result.read).toBeGreaterThan(0)
    expect(result.second).toBe('second')
  })

  test('空 FileStreams 不阻塞后续文件', async () => {
    const app = await createActionApp({
      handler: (async (
        files: FileStreams,
        following: FileStream,
      ) => {
        const received: string[] = []
        for await (const file of files) {
          received.push(await text(file.stream))
        }
        received.push(await text(following.stream))
        return received
      }) as ActionHandler,
    })
    const action = createServerReference<
      (
        files: FileStreams,
        following: FileStream,
      ) => Promise<string[]>
    >(await actionUrl(app), transportId)

    await expect(
      action(
        fileStreams([]),
        fileStream(new File(['following'], 'following.txt')),
      ),
    ).resolves.toEqual(['following'])
  })

  test('读取后续文件时前一个流未处理会立即报错', async () => {
    const app = await createActionApp({
      bodyLimit: 1024 * 1024,
      handler: (async (
        _first: FileStream,
        following: FileStreams,
      ) => {
        for await (const file of following) {
          await text(file.stream)
        }
      }) as ActionHandler,
    })
    const action = createServerReference<
      (
        first: FileStream,
        following: FileStreams,
      ) => Promise<void>
    >(await actionUrl(app), transportId)

    await expect(
      action(
        fileStream(new File(['first'], 'first.txt')),
        fileStreams([
          new File(['following'], 'following.txt'),
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'FILE_STREAM_ORDER',
      status: 500,
    })
  })

  test('提前结束 FileStreams 迭代时自动跳过剩余文件', async () => {
    const app = await createActionApp({
      bodyLimit: 1024 * 1024,
      handler: (async (
        files: FileStreams,
        following: FileStream,
      ) => {
        const values: string[] = []
        for await (const file of files) {
          values.push(await text(file.stream))
          break
        }
        values.push(await text(following.stream))
        return values
      }) as ActionHandler,
    })
    const action = createServerReference<
      (
        files: FileStreams,
        following: FileStream,
      ) => Promise<string[]>
    >(await actionUrl(app), transportId)

    await expect(
      action(
        fileStreams([
          new File(['first'], 'first.txt'),
          new File(['skipped'], 'skipped.txt'),
        ]),
        fileStream(new File(['following'], 'following.txt')),
      ),
    ).resolves.toEqual(['first', 'following'])
  })

  test('保留用户创建的 Fastify 实例和原生路由', async () => {
    const userApp = Fastify()
    let serverAction: unknown
    userApp.addHook('onRequest', async (request) => {
      serverAction = request.serverAction
    })
    userApp.get('/health', async () => ({ ok: true }))

    const app = await createFrameworkApp({
      app: userApp,
      actionPath: '/_actions',
      actionRegistry: {},
      development: true,
    })
    apps.push(app)

    expect(app).toBe(userApp)
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.json()).toEqual({ ok: true })
    expect(serverAction).toBeNull()
  })
})

describe('生产 SPA 静态服务', () => {
  async function createClientRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'ministak-client-'))
    temporaryDirectories.push(root)
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'index.html'), '<h1>SPA INDEX</h1>', 'utf8')
    await writeFile(path.join(root, 'assets/app.js'), 'export {}', 'utf8')
    return root
  }

  test('按照 Vite base 提供静态资源和页面回退', async () => {
    const clientRoot = await createClientRoot()
    const userApp = Fastify()
    const app = await createFrameworkApp({
      app: userApp,
      actionPath: '/_actions',
      actionRegistry: {},
      development: false,
      clientRoot,
      basePath: '/app/',
    })
    apps.push(app)

    const asset = await app.inject({ method: 'GET', url: '/app/assets/app.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.body).toBe('export {}')
    expect(asset.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )

    const index = await app.inject({ method: 'GET', url: '/app/' })
    expect(index.headers['cache-control']).toBe('no-cache')

    const nested = await app.inject({
      method: 'GET',
      url: '/app/users/1',
      headers: { accept: 'text/html' },
    })
    expect(nested.statusCode).toBe(200)
    expect(nested.body).toContain('SPA INDEX')
    expect(nested.headers['cache-control']).toBe('no-cache')

    const outside = await app.inject({
      method: 'GET',
      url: '/users/1',
      headers: { accept: 'text/html' },
    })
    expect(outside.statusCode).toBe(404)
  })

  test('appType 为 mpa 时保留用户的 NotFoundHandler', async () => {
    const clientRoot = await createClientRoot()
    const userApp = Fastify()
    userApp.setNotFoundHandler((_request, reply) =>
      reply.code(418).send({ custom: true }),
    )
    const app = await createFrameworkApp({
      app: userApp,
      actionPath: '/_actions',
      actionRegistry: {},
      development: false,
      clientRoot,
      appType: 'mpa',
    })
    apps.push(app)

    const missing = await app.inject({ method: 'GET', url: '/missing' })
    expect(missing.statusCode).toBe(418)
    expect(missing.json()).toEqual({ custom: true })
  })
})
