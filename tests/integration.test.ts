import { fork, spawn, type ChildProcess } from 'node:child_process'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import vue from '@vitejs/plugin-vue'
import { createLogger, optimizeDeps, resolveConfig } from 'vite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildApplication,
  createDevServer,
  inspectApplication,
} from '../packages/core/src/dev.js'
import type { RpcResponse } from '../packages/core/src/types.js'
import { createMinistakPlugin } from '../packages/core/src/vite.js'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const exampleRoot = path.join(repositoryRoot, 'examples/basic')
const testProjectsRoot = path.join(repositoryRoot, '.test-projects')
const children: ChildProcess[] = []
const incrementActionName = 'src/actions.ts#incrementCounter'
const getCounterActionName = 'src/actions.ts#getCounter'
const loginActionName = 'src/actions.ts#login'
const logoutActionName = 'src/actions.ts#logout'

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve()
            return
          }
          child.once('exit', () => resolve())
          if (child.connected) {
            child.send({ type: 'shutdown' })
          } else {
            child.kill('SIGTERM')
          }
        }),
    ),
  )
  await rm(testProjectsRoot, { recursive: true, force: true })
})

async function startBuiltServer(
  root: string,
  outDir = path.join(root, 'dist'),
): Promise<{
  child: ChildProcess
  url: string
}> {
  const entry = path.join(outDir, 'server/index.mjs')
  const child = fork(entry, [], {
    cwd: root,
    env: {
      ...process.env,
      MINISTAK_PORT: '0',
      MINISTAK_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  children.push(child)

  const address = await new Promise<AddressInfo>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务端启动超时')), 10_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`服务端提前退出：${code}`))
    })
    child.on('message', (message) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'ready' &&
        'address' in message
      ) {
        clearTimeout(timer)
        resolve(message.address as AddressInfo)
      }
    })
  })

  return { child, url: `http://127.0.0.1:${address.port}` }
}

async function startProductionCommand(root: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [path.join(repositoryRoot, 'packages/core/dist/cli.js'), 'start', root],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MINISTAK_PORT: '0',
        MINISTAK_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('生产服务器启动超时'))
    }, 10_000)
    let output = ''

    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`生产服务器提前退出：${code}`))
    })
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
      const url = output.match(
        /生产服务器已启动：(http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1]
      if (url) {
        clearTimeout(timer)
        resolve(url)
      }
    })
  })
}

async function callAction(options: {
  url: string
  transportId: string
  args?: unknown[]
  actionPath?: string
  cookie?: string
}): Promise<{ response: Response; payload: RpcResponse }> {
  const response = await fetch(
    `${options.url}${options.actionPath ?? '/_actions'}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-id': options.transportId,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify({
        args: options.args ?? [],
      }),
    },
  )
  return { response, payload: (await response.json()) as RpcResponse }
}

async function createSession(options: {
  url: string
  transportId: string
  actionPath?: string
}): Promise<string> {
  const { response, payload } = await callAction(options)
  if (!response.ok || !payload.ok) {
    throw new Error(`登录 Action 失败：${response.status}`)
  }
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) {
    throw new Error('登录 Action 没有返回会话 Cookie')
  }
  return cookie
}

async function readBuiltTransportId(
  outDir: string,
  actionName: string,
): Promise<string> {
  const serverCode = await readFile(
    path.join(outDir, 'server/index.mjs'),
    'utf8',
  )
  const marker = `name: ${JSON.stringify(actionName)}`
  const markerIndex = serverCode.indexOf(marker)
  if (markerIndex < 0) {
    throw new Error(`服务端产物缺少 Action：${actionName}`)
  }
  const prefix = serverCode.slice(Math.max(0, markerIndex - 100), markerIndex)
  const ids = Array.from(
    prefix.matchAll(/a_[A-Za-z0-9_-]{22}/g),
    (match) => match[0],
  )
  const transportId = ids.at(-1)
  if (!transportId) {
    throw new Error(`服务端产物缺少 Action ID：${actionName}`)
  }
  return transportId
}

async function readClientOutput(
  root: string,
  outDir = path.join(root, 'dist'),
): Promise<string> {
  const assetDirectory = path.join(outDir, 'client/assets')
  const files = await readdir(assetDirectory)
  const javascript = files.filter((file) => file.endsWith('.js'))
  return (
    await Promise.all(
      javascript.map((file) => readFile(path.join(assetDirectory, file), 'utf8')),
    )
  ).join('\n')
}

describe('生产构建和 HTTP 调用', () => {
  test('生产启动命令输出可访问地址', async () => {
    await buildApplication({ root: exampleRoot })
    const url = await startProductionCommand(exampleRoot)

    const response = await fetch(url)
    expect(response.status).toBe(200)
  })

  test('构建产物隔离并能执行 Server Action', async () => {
    const built = await buildApplication({ root: exampleRoot })
    expect(built.manifest.actions).toHaveLength(4)

    const clientOutput = await readClientOutput(exampleRoot)
    const transportId = await readBuiltTransportId(
      built.outDir,
      incrementActionName,
    )
    const loginTransportId = await readBuiltTransportId(
      built.outDir,
      loginActionName,
    )
    const getCounterTransportId = await readBuiltTransportId(
      built.outDir,
      getCounterActionName,
    )
    const logoutTransportId = await readBuiltTransportId(
      built.outDir,
      logoutActionName,
    )
    expect(clientOutput).toContain('/_actions')
    expect(clientOutput).toContain(transportId)
    expect(clientOutput).toContain(loginTransportId)
    expect(clientOutput).toContain(getCounterTransportId)
    expect(clientOutput).toContain(logoutTransportId)
    for (const action of built.manifest.actions) {
      expect(clientOutput).not.toContain(action.name)
    }
    expect(clientOutput).not.toContain('ministak_demo_session')
    expect(clientOutput).not.toContain('count += 1')

    const server = await startBuiltServer(exampleRoot)
    const index = await fetch(server.url, {
      headers: { accept: 'text/html' },
    })
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('Ministak 示例')

    const initialCounter = await callAction({
      url: server.url,
      transportId: getCounterTransportId,
    })
    expect(initialCounter.response.status).toBe(200)
    expect(initialCounter.payload).toEqual({
      ok: true,
      data: 0,
    })

    const denied = await callAction({
      url: server.url,
      transportId,
    })
    expect(denied.response.status).toBe(401)
    expect(denied.payload).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    })

    const cookie = await createSession({
      url: server.url,
      transportId: loginTransportId,
    })
    const { response, payload } = await callAction({
      url: server.url,
      transportId,
      cookie,
    })
    expect(response.status).toBe(200)
    expect(payload.ok).toBe(true)
    if (payload.ok) {
      expect(payload.data).toBe(1)
    }

    const counterAfterRefresh = await callAction({
      url: server.url,
      transportId: getCounterTransportId,
    })
    expect(counterAfterRefresh.response.status).toBe(200)
    expect(counterAfterRefresh.payload).toEqual({
      ok: true,
      data: 1,
    })

    const loggedOut = await callAction({
      url: server.url,
      transportId: logoutTransportId,
      cookie,
    })
    expect(loggedOut.response.status).toBe(200)
    const clearedCookie = loggedOut.response.headers
      .get('set-cookie')
      ?.split(';')[0]
    expect(clearedCookie).toBe('ministak_demo_session=')

    const deniedAfterLogout = await callAction({
      url: server.url,
      transportId,
      cookie: clearedCookie,
    })
    expect(deniedAfterLogout.response.status).toBe(401)
  })

  test('客户端依赖链触及 server-only 时构建失败', async () => {
    const projectRoot = path.join(testProjectsRoot, 'server-only-leak')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    await writeFile(
      path.join(projectRoot, 'src/secret.ts'),
      "import 'server-only'\nexport const secret = 'secret'\n",
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'src/main.ts'),
      "import './secret'\n",
      'utf8',
    )

    await expect(
      buildApplication({ root: projectRoot }),
    ).rejects.toThrow('客户端代码不能导入服务端模块')
    await expect(
      inspectApplication({ root: projectRoot }),
    ).rejects.toThrow('客户端代码不能导入服务端模块')
  })

  test('检查真实构建文件边界且不写入产物', async () => {
    const projectRoot = path.join(testProjectsRoot, 'inspect-files')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    await mkdir(path.join(projectRoot, 'public'))
    await writeFile(
      path.join(projectRoot, 'public/robots.txt'),
      'User-agent: *\n',
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'vite.config.ts'),
      "export default { build: { sourcemap: true } }\n",
      'utf8',
    )

    const report = await inspectApplication({ root: projectRoot })
    const serverStart = report.indexOf('\n服务端\n')
    expect(serverStart).toBeGreaterThan(0)
    const clientReport = report.slice(0, serverStart)
    const serverReport = report.slice(serverStart)

    expect(clientReport).toContain('客户端（会发送给浏览器）')
    expect(clientReport).toContain('App.vue')
    expect(clientReport).toContain('main.ts')
    expect(clientReport).toContain('public')
    expect(clientReport).toContain('robots.txt')
    expect(clientReport).not.toContain('actions.ts')
    expect(clientReport).not.toContain('server.ts')
    expect(clientReport).toContain('客户端 sourcemap 已开启')

    expect(serverReport).toContain('服务端')
    expect(serverReport).toContain('actions.ts')
    expect(serverReport).toContain('server.ts')
    expect(await readdir(projectRoot)).not.toContain('dist')
  })

  test('加载框架配置、Vite 插件和两端共享的路径别名', async () => {
    const projectRoot = path.join(testProjectsRoot, 'project-config')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })

    await writeFile(
      path.join(projectRoot, 'ministak.config.ts'),
      `import { defineConfig } from 'ministak'
      export default defineConfig({
        outDir: 'output',
        actionPath: '/rpc/actions',
      })\n`,
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'src/shared.ts'),
      "export const sharedMarker = '__SHARED_ALIAS__'\n",
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'vite.config.ts'),
      `import path from 'node:path'
      import vue from '@vitejs/plugin-vue'
      export default {
        base: '/app/',
        resolve: {
          alias: {
            '@shared': path.resolve(import.meta.dirname, 'src/shared.ts'),
          },
        },
        build: {
          sourcemap: true,
        },
        plugins: [vue(), {
          name: 'integration-user-plugin',
          transform(code, id) {
            if (id.replaceAll('\\\\', '/').endsWith('/src/main.ts')) {
              return code + "\\nconsole.log('__USER_VITE_PLUGIN__')"
            }
          },
        }],
      }\n`,
      'utf8',
    )

    const mainFile = path.join(projectRoot, 'src/main.ts')
    const mainSource = await readFile(mainFile, 'utf8')
    await writeFile(
      mainFile,
      `${mainSource}\nimport { sharedMarker } from '@shared'\nconsole.log(sharedMarker)\n`,
      'utf8',
    )
    const serverFile = path.join(projectRoot, 'src/server.ts')
    const serverSource = await readFile(serverFile, 'utf8')
    await writeFile(
      serverFile,
      `import { sharedMarker } from '@shared'\n${serverSource}\nconsole.log(sharedMarker)\n`,
      'utf8',
    )

    const built = await buildApplication({ root: projectRoot })
    const outputRoot = path.join(projectRoot, 'output')
    expect(built.outDir).toBe(outputRoot)
    expect(built.actionPath).toBe('/rpc/actions')
    expect(built.basePath).toBe('/app/')
    expect(
      await readdir(path.join(outputRoot, 'server')),
    ).toContain('index.mjs.map')

    const clientOutput = await readClientOutput(projectRoot, outputRoot)
    const transportId = await readBuiltTransportId(
      outputRoot,
      incrementActionName,
    )
    const loginTransportId = await readBuiltTransportId(
      outputRoot,
      loginActionName,
    )
    expect(clientOutput).toContain('__USER_VITE_PLUGIN__')
    expect(clientOutput).toContain('/rpc/actions')
    expect(clientOutput).toContain(transportId)
    expect(clientOutput).toContain(loginTransportId)

    const server = await startBuiltServer(projectRoot, outputRoot)
    const nestedPage = await fetch(`${server.url}/app/users/1`, {
      headers: { accept: 'text/html' },
    })
    expect(nestedPage.status).toBe(200)
    expect(await nestedPage.text()).toContain('Ministak 示例')
    const outsideBase = await fetch(`${server.url}/users/1`, {
      headers: { accept: 'text/html' },
    })
    expect(outsideBase.status).toBe(404)
    const cookie = await createSession({
      url: server.url,
      transportId: loginTransportId,
      actionPath: built.actionPath,
    })
    const action = await callAction({
      url: server.url,
      transportId,
      actionPath: built.actionPath,
      cookie,
    })
    expect(action.response.status).toBe(200)
    expect(action.payload).toMatchObject({ ok: true })
  })

  test.each([
    {
      id: 'root',
      name: '项目根目录',
      config: "export default { root: 'src' }\n",
      message: '项目根目录由 Ministak 管理',
    },
    {
      id: 'out-dir',
      name: '构建输出目录',
      config: "export default { build: { outDir: 'build' } }\n",
      message: '构建输出目录由 Ministak 管理',
    },
    {
      id: 'plugin',
      name: '重复框架插件',
      config:
        "export default { plugins: [{ name: 'ministak' }] }\n",
      message: 'Ministak Vite 插件由框架自动注册',
    },
    {
      id: 'server-input',
      name: '服务端构建入口',
      config:
        "export default ({ isSsrBuild }) => isSsrBuild ? { build: { rollupOptions: { input: 'src/server.ts' } } } : {}\n",
      message: '服务端构建入口由 Ministak 管理',
    },
    {
      id: 'app-type',
      name: 'custom 页面模式',
      config: "export default { appType: 'custom' }\n",
      message: 'Vite appType 仅支持 "spa" 和 "mpa"',
    },
  ])('明确拒绝冲突的 Vite 配置：$name', async ({ id, config, message }) => {
    const projectRoot = path.join(
      testProjectsRoot,
      `vite-conflict-${id}`,
    )
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    await writeFile(
      path.join(projectRoot, 'vite.config.ts'),
      config,
      'utf8',
    )

    await expect(
      buildApplication({ root: projectRoot }),
    ).rejects.toThrow(message)
  })
})

describe('开发服务器热更新', () => {
  test('依赖扫描不会进入 Action 的服务端依赖', async () => {
    const projectRoot = path.join(testProjectsRoot, 'action-dependency-scan')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })

    const actionFile = path.join(projectRoot, 'src/actions.ts')
    const actionSource = await readFile(actionFile, 'utf8')
    await writeFile(
      actionFile,
      actionSource
        .replace(
          "'use server'",
          "'use server'\n\nimport path from 'node:path'",
        )
        .replace('return count', 'return count + path.sep.length - 1'),
      'utf8',
    )
    const warnings: string[] = []
    const logger = createLogger()
    logger.warn = (message) => warnings.push(message)
    logger.warnOnce = (message) => warnings.push(message)

    const config = await resolveConfig(
      {
        root: projectRoot,
        cacheDir: path.join(projectRoot, '.vite-test'),
        customLogger: logger,
        plugins: [
          createMinistakPlugin({
            root: projectRoot,
            target: 'client',
            transportKey: 'test-transport-key',
            actionPath: '/_actions',
            development: true,
          }),
          vue(),
        ],
      },
      'serve',
    )
    const metadata = await optimizeDeps(config, true)

    expect(warnings.join('\n')).not.toContain('node:path')
    expect(Object.keys(metadata.optimized)).toContain('vue')
  })

  test('开发和生产使用相同的 Fastify 优先路由顺序', async () => {
    const projectRoot = path.join(testProjectsRoot, 'fastify-routes')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    await writeFile(
      path.join(projectRoot, 'vite.config.ts'),
      "export default { base: '/app/' }\n",
      'utf8',
    )
    const serverFile = path.join(projectRoot, 'src/server.ts')
    const serverSource = await readFile(serverFile, 'utf8')
    await writeFile(
      serverFile,
      serverSource.replace(
        'export default app',
        `app.addHook('preHandler', async (request, reply) => {
  if (request.url === '/app/blocked') {
    return reply.code(404).send({ blocked: true })
  }
})
app.get('/api/message', async () => ({ source: 'fastify' }))
app.post('/api/echo', async (request) => request.body)
app.get('/app/api/not-found', async (_request, reply) => {
  return reply.code(404).send({ source: 'fastify-route' })
})

export default app`,
      ),
      'utf8',
    )

    const assertRoutes = async (url: string) => {
      const route = await fetch(`${url}/api/message`)
      expect(route.status).toBe(200)
      expect(await route.json()).toEqual({ source: 'fastify' })

      const echo = await fetch(`${url}/api/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      })
      expect(echo.status).toBe(200)
      expect(await echo.json()).toEqual({ message: 'hello' })

      const routeNotFound = await fetch(`${url}/app/api/not-found`)
      expect(routeNotFound.status).toBe(404)
      expect(await routeNotFound.json()).toEqual({
        source: 'fastify-route',
      })
      expect(
        routeNotFound.headers.get('x-ministak-route-miss'),
      ).toBeNull()

      const blocked = await fetch(`${url}/app/blocked`, {
        headers: { accept: 'text/html' },
      })
      expect(blocked.status).toBe(404)
      expect(await blocked.json()).toEqual({ blocked: true })

      const page = await fetch(`${url}/app/users/1`, {
        headers: { accept: 'text/html' },
      })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('Ministak 示例')

      const index = await fetch(`${url}/app/`, {
        headers: { accept: 'application/json' },
      })
      expect(index.status).toBe(200)
      expect(await index.text()).toContain('Ministak 示例')

      const baseRoot = await fetch(`${url}/app`, {
        headers: { accept: 'text/html' },
      })
      expect(baseRoot.status).toBe(200)
      expect(await baseRoot.text()).toContain('Ministak 示例')

      const unknownApi = await fetch(`${url}/app/api/missing`, {
        headers: { accept: 'application/json' },
      })
      expect(unknownApi.status).toBe(404)
      expect(await unknownApi.json()).toEqual({ error: 'Not Found' })

      const outsideBase = await fetch(`${url}/users/1`, {
        headers: { accept: 'text/html' },
      })
      expect(outsideBase.status).toBe(404)
      expect(await outsideBase.json()).toEqual({ error: 'Not Found' })
    }

    const development = await createDevServer({
      root: projectRoot,
      port: 0,
    })
    try {
      await assertRoutes(development.url)
    } finally {
      await development.close()
    }

    await buildApplication({ root: projectRoot })
    const production = await startBuiltServer(projectRoot)
    await assertRoutes(production.url)
  })

  test('appType 为 mpa 时只提供实际页面并保留 Fastify 404', async () => {
    const projectRoot = path.join(testProjectsRoot, 'mpa-routes')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    await writeFile(
      path.join(projectRoot, 'vite.config.ts'),
      "export default { base: '/app/', appType: 'mpa' }\n",
      'utf8',
    )
    const serverFile = path.join(projectRoot, 'src/server.ts')
    const serverSource = await readFile(serverFile, 'utf8')
    await writeFile(
      serverFile,
      serverSource.replace(
        'export default app',
        `app.get('/api/message', async () => ({ source: 'fastify' }))
app.setNotFoundHandler((_request, reply) => {
  return reply.code(418).send({ custom: true })
})

export default app`,
      ),
      'utf8',
    )

    const assertMpa = async (url: string) => {
      const route = await fetch(`${url}/api/message`)
      expect(route.status).toBe(200)
      expect(await route.json()).toEqual({ source: 'fastify' })

      const index = await fetch(`${url}/app/`, {
        headers: { accept: 'text/html' },
      })
      expect(index.status).toBe(200)
      expect(await index.text()).toContain('Ministak 示例')

      const nested = await fetch(`${url}/app/users/1`, {
        headers: { accept: 'text/html' },
      })
      expect(nested.status).toBe(418)
      expect(await nested.json()).toEqual({ custom: true })
    }

    const development = await createDevServer({
      root: projectRoot,
      port: 0,
    })
    try {
      await assertMpa(development.url)
    } finally {
      await development.close()
    }

    await buildApplication({ root: projectRoot })
    const production = await startBuiltServer(projectRoot)
    await assertMpa(production.url)
  })

  test('单端口转发请求，并在服务端源码变化后切换子进程', async () => {
    const projectRoot = path.join(testProjectsRoot, 'basic')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    const actionFile = path.join(projectRoot, 'src/actions.ts')

    const server = await createDevServer({ root: projectRoot, port: 0 })
    try {
      const page = await fetch(server.url, {
        headers: { accept: 'text/html' },
      })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('/src/main.ts')

      const clientModules = await Promise.all([
        fetch(`${server.url}/src/main.ts`),
        fetch(`${server.url}/src/App.vue`),
        fetch(`${server.url}/src/actions.ts`),
      ])
      for (const response of clientModules) {
        expect(response.status).toBe(200)
      }
      const actionProxy = await clientModules[2].text()
      expect(actionProxy).toContain('createServerReference')
      expect(actionProxy).toContain(JSON.stringify(incrementActionName))
      expect(actionProxy).toContain(JSON.stringify(loginActionName))
      expect(actionProxy).not.toMatch(/a_[A-Za-z0-9_-]{22}/)

      const clientHotMessages: Array<Record<string, unknown>> = []
      const clientHot = server.vite.environments.client.hot
      const originalHotSend = clientHot.send.bind(clientHot) as (
        ...args: unknown[]
      ) => void
      clientHot.send = ((...args: unknown[]) => {
        const payload = args[0]
        if (payload && typeof payload === 'object') {
          clientHotMessages.push(payload as Record<string, unknown>)
        }
        originalHotSend(...args)
      }) as typeof clientHot.send

      const cookie = await createSession({
        url: server.url,
        transportId: loginActionName,
      })
      const first = await callAction({
        url: server.url,
        transportId: incrementActionName,
        cookie,
      })
      expect(first.payload).toMatchObject({ ok: true })
      if (first.payload.ok) {
        expect(first.payload.data).toBe(1)
      }

      const previousGeneration = server.getGeneration()
      const source = await readFile(actionFile, 'utf8')
      await writeFile(
        actionFile,
        source.replace('count += 1', 'count += 101'),
        'utf8',
      )
      await server.waitForGeneration(previousGeneration)

      const updatedActionProxy = await fetch(
        `${server.url}/src/actions.ts`,
      ).then((response) => response.text())
      expect(updatedActionProxy).toContain(
        JSON.stringify(incrementActionName),
      )

      expect(
        clientHotMessages.some(
          (payload) =>
            payload.type === 'update' || payload.type === 'full-reload',
        ),
      ).toBe(false)

      const second = await callAction({
        url: server.url,
        transportId: incrementActionName,
        cookie,
      })
      expect(second.payload).toMatchObject({ ok: true })
      if (second.payload.ok) {
        expect(second.payload.data).toBe(101)
      }

      const restart = server.waitForRestart()
      await writeFile(
        path.join(projectRoot, 'vite.config.ts'),
        'export default {}\n',
        'utf8',
      )
      await restart
    } finally {
      await server.close()
    }
  })
})
