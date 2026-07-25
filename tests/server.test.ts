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

describe('Server Action Fastify 请求链路', () => {
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

  test('同时恢复内存文件和按顺序读取流文件', async () => {
    let received:
      | {
          memory: string[]
          stream: string
          streams: string[]
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
        const values: string[] = []
        for await (const file of streams) {
          values.push(await text(file.stream))
        }
        received = {
          memory: await Promise.all(
            memory.map((file) => file.text()),
          ),
          stream: streamed,
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
        new File(['a'], 'a.txt', { type: 'text/plain' }),
        new File(['b'], 'b.txt', { type: 'text/plain' }),
      ],
      fileStream(
        new File(['c'], 'c.txt', { type: 'text/plain' }),
      ),
      fileStreams([
        new File(['d'], 'd.txt', { type: 'text/plain' }),
        new File(['e'], 'e.txt', { type: 'text/plain' }),
      ]),
    )

    expect(result).toEqual({
      memory: ['a', 'b'],
      stream: 'c',
      streams: ['d', 'e'],
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

    const nested = await app.inject({
      method: 'GET',
      url: '/app/users/1',
      headers: { accept: 'text/html' },
    })
    expect(nested.statusCode).toBe(200)
    expect(nested.body).toContain('SPA INDEX')

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
