import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import type {
  ActionContext,
  ActionRegistration,
  ActionRegistry,
  RpcFailure,
  ServerDefinition,
} from './types.js'

const actionStorage = new AsyncLocalStorage<ActionContext>()

export interface ActionErrorOptions {
  code?: string
  status?: number
}

export class ActionError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(message: string, options: ActionErrorOptions = {}) {
    super(message)
    this.name = 'ActionError'
    this.code = options.code ?? 'ACTION_ERROR'
    this.statusCode = options.status ?? 400
  }
}

export function defineServer(definition: ServerDefinition): ServerDefinition {
  return definition
}

export function getActionContext(): ActionContext {
  const context = actionStorage.getStore()
  if (!context) {
    throw new Error('当前代码不在 Server Action 请求上下文中')
  }
  return context
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function failure(
  code: string,
  message: string,
  requestId?: string,
): RpcFailure {
  return {
    ok: false,
    error: { code, message, requestId },
  }
}

function fastifyErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }
  return typeof error.code === 'string' ? error.code : undefined
}

function sendActionError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const requestId = String(request.id)
  if (error instanceof ActionError) {
    return reply
      .code(error.statusCode)
      .send(failure(error.code, error.message, requestId))
  }

  switch (fastifyErrorCode(error)) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return reply
        .code(413)
        .send(failure('PAYLOAD_TOO_LARGE', '请求体过大', requestId))
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return reply
        .code(400)
        .send(failure('INVALID_ARGUMENTS', '请求体不是有效 JSON', requestId))
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return reply
        .code(415)
        .send(failure('UNSUPPORTED_CONTENT_TYPE', '不支持的请求类型', requestId))
  }

  request.log.error(
    { err: error, requestId, actionName: request.serverAction?.name },
    'Server Action 执行失败',
  )
  return reply
    .code(500)
    .send(failure('INTERNAL_ERROR', '服务端内部错误', requestId))
}

interface RegisterActionRouteOptions {
  actionPath: string
  resolvedActions: WeakMap<FastifyRequest, ActionRegistration>
  bodyLimit?: number
}

function registerActionRoute(
  app: FastifyInstance,
  options: RegisterActionRouteOptions,
): void {
  app.post(
    options.actionPath,
    {
      bodyLimit: options.bodyLimit ?? 1024 * 1024,
      errorHandler(error, request, reply) {
        sendActionError(error, request, reply)
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-cache, no-store, max-age=0')
      const requestId = String(request.id)

      try {
        const contentType = getHeader(request, 'content-type')
        if (!contentType?.toLowerCase().startsWith('application/json')) {
          throw new ActionError('Server Action 只接受 JSON 请求', {
            code: 'UNSUPPORTED_CONTENT_TYPE',
            status: 415,
          })
        }

        const action = options.resolvedActions.get(request)
        if (!action) {
          throw new Error('Server Action 请求没有完成内部解析')
        }

        const body = request.body
        if (
          typeof body !== 'object' ||
          body === null ||
          !('args' in body)
        ) {
          throw new ActionError('Action 参数格式错误', {
            code: 'INVALID_ARGUMENTS',
          })
        }

        const args = (body as { args: unknown }).args
        if (!Array.isArray(args)) {
          throw new ActionError('Action 参数必须是数组', {
            code: 'INVALID_ARGUMENTS',
          })
        }

        const handler = await action.load()
        if (typeof handler !== 'function') {
          throw new Error(`Action ${action.name} 没有导出函数`)
        }

        const context: ActionContext = {
          request,
          reply,
          actionName: action.name,
          requestId,
        }

        const result = await actionStorage.run(context, () =>
          handler(...args),
        )
        return { ok: true, data: result }
      } catch (error) {
        return sendActionError(error, request, reply)
      }
    },
  )
}

export interface CreateFrameworkAppOptions {
  definition: ServerDefinition
  actionPath: string
  actionRegistry: ActionRegistry
  development: boolean
  clientRoot?: string
  basePath?: string
}

export async function createFrameworkApp(
  options: CreateFrameworkAppOptions,
) {
  const definition = options.definition
  const app = Fastify(definition.fastify ?? {})
  const resolvedActions = new WeakMap<FastifyRequest, ActionRegistration>()

  app.decorateRequest('serverAction', null)
  app.addHook('onRequest', (request, _reply, done) => {
    if (
      request.method !== 'POST' ||
      request.routeOptions.url !== options.actionPath
    ) {
      done()
      return
    }

    const transportId = getHeader(request, 'x-action-id')
    if (!transportId) {
      done(
        new ActionError('缺少 Action ID', { code: 'ACTION_ID_REQUIRED' }),
      )
      return
    }

    const action = options.actionRegistry[transportId]
    if (!action) {
      done(
        new ActionError('Server Action 不存在', {
          code: 'ACTION_NOT_FOUND',
          status: 404,
        }),
      )
      return
    }

    request.serverAction = { name: action.name }
    resolvedActions.set(request, action)
    done()
  })

  if (definition.setup) {
    await definition.setup(app)
  }

  registerActionRoute(app, {
    actionPath: options.actionPath,
    resolvedActions,
    bodyLimit: definition.actions?.bodyLimit,
  })

  if (!options.development) {
    if (!options.clientRoot) {
      throw new Error('生产服务缺少客户端产物目录')
    }
    const indexHtml = await readFile(
      path.join(options.clientRoot, 'index.html'),
      'utf8',
    )
    const basePath = options.basePath ?? '/'
    await app.register(fastifyStatic, {
      root: options.clientRoot,
      prefix: basePath,
    })
    if (definition.spaFallback !== false) {
      try {
        app.setNotFoundHandler((request, reply) => {
          const pathname = new URL(request.url, 'http://localhost').pathname
          const insideBase =
            basePath === '/' ||
            pathname === basePath.slice(0, -1) ||
            pathname.startsWith(basePath)
          const acceptsHtml = request.headers.accept?.includes('text/html')
          if (request.method === 'GET' && acceptsHtml && insideBase) {
            return reply.type('text/html; charset=utf-8').send(indexHtml)
          }
          return reply.code(404).send({ error: 'Not Found' })
        })
      } catch (error) {
        throw new Error(
          'spaFallback 与用户设置的 NotFoundHandler 冲突，请将 spaFallback 设为 false',
          { cause: error },
        )
      }
    }
  }

  return app
}

export type {
  ActionContext,
  ServerActionInfo,
  ServerDefinition,
} from './types.js'
