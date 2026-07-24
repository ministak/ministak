import type {
  FastifyReply,
  FastifyRequest,
} from 'fastify'

export interface ActionDefinition {
  name: string
  file: string
  relativeFile: string
  exportName: string
}

export interface ActionManifest {
  actions: ActionDefinition[]
}

export type ActionHandler = (...args: unknown[]) => Promise<unknown>

export type ActionLoader = () => Promise<ActionHandler>

export interface ActionRegistration {
  name: string
  load: ActionLoader
}

export type ActionRegistry = Record<string, ActionRegistration>

export interface ServerActionInfo {
  name: string
}

declare module 'fastify' {
  interface FastifyRequest {
    serverAction: ServerActionInfo | null
  }
}

export interface ActionContext {
  request: FastifyRequest
  reply: FastifyReply
  actionName: string
  requestId: string
}

export interface RpcSuccess {
  ok: true
  data?: unknown
}

export interface RpcFailure {
  ok: false
  error: {
    code: string
    message: string
    requestId?: string
  }
}

export type RpcResponse = RpcSuccess | RpcFailure
