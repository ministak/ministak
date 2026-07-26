import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import type {
  ActionContext,
  ActionRegistry,
  RpcFailure,
} from './types.js'
import {
  ActionRequestError,
  type ActionFileSession,
  readActionMultipart,
} from './action-files.js'
import {
  DEV_ROUTE_MISS_HEADER,
  isSpaFallbackRequest,
  type PageAppType,
} from './routing.js'

export { loadServerEnvironment } from './env.js'

const actionStorage = new AsyncLocalStorage<ActionContext>()
const IMMUTABLE_CACHE_CONTROL =
  'public, max-age=31536000, immutable'
const HTML_CACHE_CONTROL = 'no-cache'

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
  if (error instanceof ActionRequestError) {
    return reply
      .code(error.statusCode)
      .send(failure(error.code, error.message, requestId))
  }

  switch (fastifyErrorCode(error)) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
    case 'FST_REQ_FILE_TOO_LARGE':
    case 'FST_PARTS_LIMIT':
    case 'FST_FILES_LIMIT':
    case 'FST_FIELDS_LIMIT':
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
  actionRegistry: ActionRegistry
}

async function finishFileSession(
  session: ActionFileSession | undefined,
  actionFailed: boolean,
  request: FastifyRequest,
): Promise<void> {
  if (!session) {
    return
  }
  try {
    await session.finish()
  } catch (error) {
    if (!actionFailed) {
      throw error
    }
    request.log.error(
      { err: error, actionName: request.serverAction?.name },
      'Server Action 文件流清理失败',
    )
  }
}

function registerActionRoute(
  app: FastifyInstance,
  options: RegisterActionRouteOptions,
): void {
  app.register(async (actionApp) => {
    if (!actionApp.hasRequestDecorator('parts')) {
      await actionApp.register(fastifyMultipart)
    }
    actionApp.post(
      options.actionPath,
      {
        errorHandler(error, request, reply) {
          sendActionError(error, request, reply)
        },
      },
      async (request, reply) => {
        reply.header('cache-control', 'no-cache, no-store, max-age=0')
        const requestId = String(request.id)
        let fileSession: ActionFileSession | undefined

        try {
          const contentType = getHeader(
            request,
            'content-type',
          )?.toLowerCase()
          if (
            !contentType?.startsWith('application/json') &&
            !contentType?.startsWith('multipart/form-data')
          ) {
            throw new ActionError('Server Action 请求类型不受支持', {
              code: 'UNSUPPORTED_CONTENT_TYPE',
              status: 415,
            })
          }

          const transportId = getHeader(request, 'x-action-id')
          if (!transportId) {
            throw new ActionError('缺少 Action ID', {
              code: 'ACTION_ID_REQUIRED',
            })
          }

          const action = options.actionRegistry[transportId]
          if (!action) {
            throw new ActionError('Server Action 不存在', {
              code: 'ACTION_NOT_FOUND',
              status: 404,
            })
          }

          let args: unknown
          if (contentType.startsWith('multipart/form-data')) {
            fileSession = await readActionMultipart(request)
            args = fileSession.args
          } else {
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
            args = (body as { args: unknown }).args
          }

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

          let result: unknown
          let actionError: unknown
          let actionFailed = false
          try {
            result = await actionStorage.run(context, () =>
              handler(...args),
            )
          } catch (error) {
            actionFailed = true
            actionError = error
          }
          await finishFileSession(fileSession, actionFailed, request)
          if (actionFailed) {
            throw actionError
          }
          return { ok: true, data: result }
        } catch (error) {
          return sendActionError(error, request, reply)
        }
      },
    )
  })
}

export interface CreateFrameworkAppOptions {
  app: FastifyInstance
  actionPath: string
  actionRegistry: ActionRegistry
  development: boolean
  clientRoot?: string
  assetsDir?: string
  basePath?: string
  appType?: PageAppType
}

export async function createFrameworkApp(
  options: CreateFrameworkAppOptions,
) {
  const app = options.app
  if (
    !app ||
    typeof app.decorateRequest !== 'function' ||
    typeof app.post !== 'function'
  ) {
    throw new Error('服务端入口必须默认导出 Fastify 实例')
  }

  app.decorateRequest('serverAction', {
    getter(this: FastifyRequest) {
      if (
        this.method !== 'POST' ||
        this.routeOptions.url !== options.actionPath
      ) {
        return null
      }
      const transportId = getHeader(this, 'x-action-id')
      const action = transportId
        ? options.actionRegistry[transportId]
        : undefined
      return action ? { name: action.name } : null
    },
  })

  registerActionRoute(app, {
    actionPath: options.actionPath,
    actionRegistry: options.actionRegistry,
  })

  if (options.development) {
    const routeMisses = new WeakSet<FastifyRequest>()
    app.addHook('preHandler', async (request) => {
      if (request.is404) {
        routeMisses.add(request)
      }
    })
    app.addHook('onSend', async (request, reply, payload) => {
      if (routeMisses.has(request)) {
        reply.header(DEV_ROUTE_MISS_HEADER, '1')
      }
      return payload
    })
  }

  let indexHtml: string | undefined
  const basePath = options.basePath ?? '/'
  if (!options.development) {
    if (!options.clientRoot) {
      throw new Error('生产服务缺少客户端产物目录')
    }
    indexHtml = await readFile(
      path.join(options.clientRoot, 'index.html'),
      'utf8',
    )
    const assetsRoot = path.resolve(
      options.clientRoot,
      options.assetsDir ?? 'assets',
    )
    await app.register(fastifyStatic, {
      root: options.clientRoot,
      prefix: basePath,
      cacheControl: false,
      setHeaders(response, file) {
        const relative = path.relative(assetsRoot, file)
        const immutable =
          path.extname(file) !== '.html' &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        response.setHeader(
          'cache-control',
          immutable ? IMMUTABLE_CACHE_CONTROL : HTML_CACHE_CONTROL,
        )
      },
    })
  }
  if ((options.appType ?? 'spa') === 'spa') {
    try {
      app.setNotFoundHandler((request, reply) => {
        const pathname = new URL(request.url, 'http://localhost').pathname
        if (
          indexHtml !== undefined &&
          isSpaFallbackRequest(
            request.method,
            request.headers.accept,
            pathname,
            basePath,
          )
        ) {
          return reply
            .header('cache-control', HTML_CACHE_CONTROL)
            .type('text/html; charset=utf-8')
            .send(indexHtml)
        }
        return reply.code(404).send({ error: 'Not Found' })
      })
    } catch (error) {
      throw new Error(
        'Vite appType "spa" 与用户设置的 NotFoundHandler 冲突，请将 appType 设为 "mpa"',
        { cause: error },
      )
    }
  }

  return app
}

export type {
  ActionContext,
  ServerActionInfo,
} from './types.js'
