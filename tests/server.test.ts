import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ActionError,
  createFrameworkApp,
  getActionContext,
} from '../packages/core/src/server.js'

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
  setup?: Parameters<typeof createFrameworkApp>[0]['definition']['setup']
  handler?: () => Promise<unknown>
} = {}): Promise<FrameworkApp> {
  const app = await createFrameworkApp({
    definition: {
      setup: options.setup,
      actions: { bodyLimit: options.bodyLimit },
    },
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

describe('Server Action Fastify 请求链路', () => {
  test('公开 ID 在请求入口转换为内部 Action 名称', async () => {
    let hookActionName: string | undefined
    let contextActionName: string | undefined
    const app = await createActionApp({
      setup(instance) {
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

  test('统一处理内容解析、请求体限制和 Hook 错误', async () => {
    const app = await createActionApp({
      bodyLimit: 64,
      setup(instance) {
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
    const app = await createFrameworkApp({
      definition: {},
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

  test('关闭 spaFallback 后保留用户的 NotFoundHandler', async () => {
    const clientRoot = await createClientRoot()
    const app = await createFrameworkApp({
      definition: {
        spaFallback: false,
        setup(instance) {
          instance.setNotFoundHandler((_request, reply) =>
            reply.code(418).send({ custom: true }),
          )
        },
      },
      actionPath: '/_actions',
      actionRegistry: {},
      development: false,
      clientRoot,
    })
    apps.push(app)

    const missing = await app.inject({ method: 'GET', url: '/missing' })
    expect(missing.statusCode).toBe(418)
    expect(missing.json()).toEqual({ custom: true })
  })
})
