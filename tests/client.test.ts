import { afterEach, describe, expect, test, vi } from 'vitest'
import { effect, stop } from 'vue'
import {
  callServerAction,
  createServerReference,
  ServerActionError,
  setServerActionHooks,
} from '../packages/core/src/client.js'

afterEach(() => {
  setServerActionHooks()
  vi.unstubAllGlobals()
})

describe('Server Action 客户端协议', () => {
  test('请求在首次等待时执行并响应式更新 loading', async () => {
    let resolveResponse!: (response: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const action = createServerReference<
      () => Promise<number>
    >('/_actions', 'action')

    const request = action()
    const loading: boolean[] = []
    const runner = effect(() => {
      loading.push(request.loading)
    })

    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(request.loading).toBe(false)

    const result = request.then((value) => value)
    expect(request.loading).toBe(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    resolveResponse(
      new Response(JSON.stringify({ ok: true, data: 1 })),
    )
    await expect(result).resolves.toBe(1)
    expect(request.loading).toBe(false)
    expect(loading).toEqual([false, true, false])
    stop(runner)
  })

  test('同一个请求并发和重复等待只执行一次', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: 1 })),
    )
    vi.stubGlobal('fetch', fetch)
    const onRequest = vi.fn()
    const onResponse = vi.fn(({ data }) => data)
    setServerActionHooks({ onRequest, onResponse })
    const action = createServerReference<
      () => Promise<number>
    >('/_actions', 'action')

    const request = action()
    expect(request.loading).toBe(false)
    expect(onRequest).not.toHaveBeenCalled()
    const results = await Promise.all([request, request])

    expect(results).toEqual([1, 1])
    expect(await request).toBe(1)
    expect(request.loading).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(onRequest).toHaveBeenCalledOnce()
    expect(onResponse).toHaveBeenCalledOnce()
  })

  test('失败请求结束 loading 并复用同一个异常', async () => {
    const expected = new Error('网络失败')
    const fetch = vi.fn().mockRejectedValue(expected)
    vi.stubGlobal('fetch', fetch)
    const action = createServerReference<
      () => Promise<number>
    >('/_actions', 'action')

    const request = action()
    await expect(request).rejects.toBe(expected)
    expect(request.loading).toBe(false)
    await expect(request).rejects.toBe(expected)
    expect(fetch).toHaveBeenCalledOnce()
  })

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

  test('请求 Hook 可以修改参数和请求头并取得 Action 函数', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: 'response' }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetch)

    const action = createServerReference<
      (value: string) => Promise<string>
    >('/_actions', 'action')
    let receivedAction: unknown
    setServerActionHooks({
      async onRequest(context) {
        await Promise.resolve()
        receivedAction = context.action
        context.args = ['changed']
        context.headers.set('authorization', 'Bearer token')
      },
    })

    await expect(action('original')).resolves.toBe('response')
    expect(receivedAction).toBe(action)
    const [, init] = fetch.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer token',
    )
    expect(JSON.parse(String(init.body))).toEqual({
      args: ['changed'],
    })
  })

  test('响应 Hook 的返回值替换 Action 结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, data: 2 }),
          {
            status: 200,
            headers: { 'x-trace-id': 'trace-1' },
          },
        ),
      ),
    )
    const action = createServerReference<
      () => Promise<number>
    >('/_actions', 'action')
    setServerActionHooks({
      async onResponse({ action: current, response, data }) {
        expect(current).toBe(action)
        expect(response.headers.get('x-trace-id')).toBe('trace-1')
        await Promise.resolve()
        return Number(data) * 2
      },
    })

    await expect(action()).resolves.toBe(4)
  })

  test('错误 Hook 可以恢复结果或继续抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'NOT_FOUND',
              message: '没有数据',
            },
          }),
          { status: 404 },
        ),
      ),
    )
    const action = createServerReference<
      () => Promise<unknown[]>
    >('/_actions', 'action')
    setServerActionHooks({
      onError({ action: current, response, error }) {
        expect(current).toBe(action)
        expect(response?.status).toBe(404)
        if (
          error instanceof ServerActionError &&
          error.code === 'NOT_FOUND'
        ) {
          return []
        }
        throw error
      },
    })

    await expect(action()).resolves.toEqual([])

    const expected = new Error('Hook 继续抛出')
    setServerActionHooks({
      onError() {
        throw expected
      },
    })
    await expect(action()).rejects.toBe(expected)
  })

  test('请求和响应 Hook 按顺序等待且重复设置直接替换', async () => {
    const events: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        events.push('fetch')
        return new Response(
          JSON.stringify({ ok: true, data: 'data' }),
        )
      }),
    )
    const firstRequest = vi.fn()
    setServerActionHooks({ onRequest: firstRequest })
    setServerActionHooks({
      async onRequest() {
        events.push('request:start')
        await Promise.resolve()
        events.push('request:end')
      },
      async onResponse({ data }) {
        events.push('response:start')
        await Promise.resolve()
        events.push('response:end')
        return data
      },
    })

    await callServerAction('/_actions', 'action', [])

    expect(firstRequest).not.toHaveBeenCalled()
    expect(events).toEqual([
      'request:start',
      'request:end',
      'fetch',
      'response:start',
      'response:end',
    ])
  })

  test('请求、网络和响应 Hook 异常进入错误 Hook', async () => {
    const requestError = new Error('请求 Hook 失败')
    const networkError = new Error('网络失败')
    const responseError = new Error('响应 Hook 失败')
    const errors: unknown[] = []

    setServerActionHooks({
      onRequest() {
        throw requestError
      },
      onError({ error, response }) {
        errors.push([error, response])
        return 'request recovered'
      },
    })
    await expect(
      callServerAction('/_actions', 'action', []),
    ).resolves.toBe('request recovered')

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError))
    setServerActionHooks({
      onError({ error, response }) {
        errors.push([error, response])
        return 'network recovered'
      },
    })
    await expect(
      callServerAction('/_actions', 'action', []),
    ).resolves.toBe('network recovered')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: 'data' })),
      ),
    )
    setServerActionHooks({
      onResponse() {
        throw responseError
      },
      onError({ error, response }) {
        errors.push([error, response])
        return 'response recovered'
      },
    })
    await expect(
      callServerAction('/_actions', 'action', []),
    ).resolves.toBe('response recovered')

    expect(errors).toEqual([
      [requestError, undefined],
      [networkError, undefined],
      [responseError, expect.any(Response)],
    ])
  })
})
