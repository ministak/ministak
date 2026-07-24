import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  callServerAction,
  ServerActionError,
} from '../packages/core/src/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Server Action 客户端协议', () => {
  test('拒绝 Fastify 原生错误结构', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 413,
            code: 'FST_ERR_CTP_BODY_TOO_LARGE',
            error: 'Payload Too Large',
            message: 'Request body is too large',
          }),
          { status: 413 },
        ),
      ),
    )

    await expect(
      callServerAction('/_actions', 'action', []),
    ).rejects.toMatchObject({
      name: 'ServerActionError',
      code: 'INVALID_RESPONSE',
      status: 413,
    })
  })

  test('拒绝非 JSON 响应', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>error</html>', { status: 502 }),
      ),
    )

    await expect(
      callServerAction('/_actions', 'action', []),
    ).rejects.toBeInstanceOf(ServerActionError)
  })

  test('保留合法 RPC 错误的信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: '需要管理员权限',
              requestId: 'request-1',
            },
          }),
          { status: 403 },
        ),
      ),
    )

    await expect(
      callServerAction('/_actions', 'action', []),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: '需要管理员权限',
      requestId: 'request-1',
      status: 403,
    })
  })
})
