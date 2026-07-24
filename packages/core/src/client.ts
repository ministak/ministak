import type { RpcFailure, RpcResponse, RpcSuccess } from './types.js'

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

export function setServerActionHooks(
  hooks?: ServerActionHooks,
): void {
  serverActionHooks = hooks
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

export async function callServerAction(
  actionPath: string,
  transportId: string,
  args: unknown[],
  action: ClientServerAction = callServerAction as ClientServerAction,
): Promise<unknown> {
  const hooks = serverActionHooks
  const request: ServerActionRequestContext = {
    action,
    args,
    headers: new Headers({
      'content-type': 'application/json',
      'x-action-id': transportId,
    }),
  }
  let response: Response | undefined

  try {
    await hooks?.onRequest?.(request)
    response = await fetch(actionPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: request.headers,
      body: JSON.stringify({ args: request.args }),
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

export function createServerReference<T extends (...args: never[]) => unknown>(
  actionPath: string,
  transportId: string,
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const action = (...args: Parameters<T>) =>
    callServerAction(
      actionPath,
      transportId,
      args,
      action as ClientServerAction,
    ) as Promise<
      Awaited<ReturnType<T>>
    >
  return action
}
