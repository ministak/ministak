import { shallowRef, type Ref } from 'vue'
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
