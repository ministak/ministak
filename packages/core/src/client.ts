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
): Promise<unknown> {
  const response = await fetch(actionPath, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-action-id': transportId,
    },
    body: JSON.stringify({ args }),
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

  return payload.data
}

export function createServerReference<T extends (...args: never[]) => unknown>(
  actionPath: string,
  transportId: string,
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  return (...args) =>
    callServerAction(actionPath, transportId, args) as Promise<
      Awaited<ReturnType<T>>
    >
}
