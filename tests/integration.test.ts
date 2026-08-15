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
import {
  createServerReference,
  fileStream,
  fileStreams,
} from '../packages/core/src/client.js'
import type {
  FileStream,
  FileStreams,
  RpcResponse,
} from '../packages/core/src/types.js'
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
  environment: NodeJS.ProcessEnv = {},
  cwd = root,
): Promise<{
  child: ChildProcess
  url: string
}> {
  const entry = path.join(outDir, 'server/index.mjs')
  const child = fork(entry, [], {
    cwd,
    env: {
      ...process.env,
      ...environment,
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

async function startProductionCommand(
  root: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<{
  url: string
  output: string
}> {
  const child = spawn(
    process.execPath,
    [path.join(repositoryRoot, 'packages/core/dist/cli.js'), 'start', root],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...environment,
        MINISTAK_PORT: '0',
        MINISTAK_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)

  return new Promise<{ url: string; output: string }>((resolve, reject) => {
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
        resolve({ url, output })
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
  assetsDir = 'assets',
): Promise<string> {
  const assetDirectory = path.join(outDir, 'client', assetsDir)
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
    const { url, output } = await startProductionCommand(exampleRoot)

    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(output).toContain('未找到可加载的环境变量文件（production）')
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

  test('生产构建后的 Server Action 支持内存文件和文件流', async () => {
    const projectRoot = path.join(testProjectsRoot, 'file-action')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    const actionName = 'src/upload.ts#inspectUpload'
    await writeFile(
      path.join(projectRoot, 'src/upload.ts'),
      `'use server'
import type { FileStream, FileStreams } from 'ministak'

export async function inspectUpload(
  memory: File[],
  single: FileStream,
  many: FileStreams,
) {
  const singleContent = await new Response(single.stream).text()
  const streamed = []
  for await (const file of many) {
    streamed.push({
      name: file.name,
      type: file.type,
      content: await new Response(file.stream).text(),
    })
  }
  return {
    marker: 'SERVER_FILE_ACTION',
    memory: await Promise.all(memory.map(async (file) => ({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      content: await file.text(),
    }))),
    single: {
      name: single.name,
      type: single.type,
      content: singleContent,
    },
    many: streamed,
  }
}
`,
      'utf8',
    )
    const mainFile = path.join(projectRoot, 'src/main.ts')
    await writeFile(
      mainFile,
      `${await readFile(mainFile, 'utf8')}
import { inspectUpload } from './upload'
console.log(inspectUpload)
`,
      'utf8',
    )

    const built = await buildApplication({ root: projectRoot })
    expect(
      built.manifest.actions.some((action) => action.name === actionName),
    ).toBe(true)
    const transportId = await readBuiltTransportId(
      built.outDir,
      actionName,
    )
    const clientOutput = await readClientOutput(projectRoot)
    expect(clientOutput).toContain(transportId)
    expect(clientOutput).not.toContain(actionName)
    expect(clientOutput).not.toContain('SERVER_FILE_ACTION')

    const server = await startBuiltServer(projectRoot)
    const action = createServerReference<
      (
        memory: File[],
        single: FileStream,
        many: FileStreams,
      ) => Promise<{
        marker: string
        memory: unknown[]
        single: unknown
        many: unknown[]
      }>
    >(`${server.url}${built.actionPath}`, transportId)
    const result = await action(
      [
        new File(['memory'], 'memory.json', {
          type: 'application/json',
          lastModified: 123,
        }),
      ],
      fileStream(
        new File(['single'], 'single.txt', {
          type: 'text/plain',
        }),
      ),
      fileStreams([
        new File(['first'], 'first.txt', {
          type: 'text/plain',
        }),
        new File(['second'], 'second.json', {
          type: 'application/json',
        }),
      ]),
    )

    expect(result).toEqual({
      marker: 'SERVER_FILE_ACTION',
      memory: [
        {
          name: 'memory.json',
          type: 'application/json',
          lastModified: 123,
          content: 'memory',
        },
      ],
      single: {
        name: 'single.txt',
        type: 'text/plain',
        content: 'single',
      },
      many: [
        {
          name: 'first.txt',
          type: 'text/plain',
          content: 'first',
        },
        {
          name: 'second.json',
          type: 'application/json',
          content: 'second',
        },
      ],
    })
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

  test('服务端加载环境变量且检查结果不显示变量值', async () => {
    const projectRoot = path.join(testProjectsRoot, 'environment')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    await writeFile(
      path.join(projectRoot, '.env'),
      [
        'MINISTAK_TEST_PRIVATE=base-private',
        'VITE_MINISTAK_TEST_PUBLIC=base-public',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, '.env.local'),
      'MINISTAK_TEST_PRIVATE=local-private\n',
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, '.env.development'),
      'MINISTAK_TEST_PRIVATE=development-private\n',
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, '.env.development.local'),
      'MINISTAK_TEST_PRIVATE=development-local-private\n',
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, '.env.production'),
      'MINISTAK_TEST_PRIVATE=production-private\n',
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, '.env.production.local'),
      'MINISTAK_TEST_PRIVATE=production-local-private\n',
      'utf8',
    )
    const modeConfig = `export default ({ command }: { command: string }) => {
  const expected = command === 'serve' ? 'development' : 'production'
  if (process.env.NODE_ENV !== expected) {
    throw new Error(\`NODE_ENV 应为 \${expected}，实际为 \${process.env.NODE_ENV}\`)
  }
  return {}
}
`
    await writeFile(
      path.join(projectRoot, 'ministak.config.ts'),
      modeConfig,
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'vite.config.ts'),
      modeConfig,
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'src/server.ts'),
      `import Fastify from 'fastify'

const environment = process.env.MINISTAK_TEST_PRIVATE
const missing = process.env.MINISTAK_TEST_MISSING
const nodeEnvironment = process.env.NODE_ENV
const app = Fastify()

app.get('/environment', async () => ({
  environment,
  missing,
  nodeEnvironment,
}))

export default app
`,
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'src/client-environment.ts'),
      `console.log(import.meta.env.VITE_MINISTAK_TEST_PUBLIC)\n`,
      'utf8',
    )
    await writeFile(
      path.join(projectRoot, 'src/main.ts'),
      `import { createApp } from 'vue'
import App from './App.vue'
import './client-environment'

createApp(App).mount('#app')
`,
      'utf8',
    )

    const report = await inspectApplication({ root: projectRoot })
    expect(report).toContain('环境变量（production，值已隐藏）')
    expect(report).toContain('MINISTAK_TEST_PRIVATE')
    expect(report).toContain('来源：.env.production.local')
    expect(report).toContain(
      '覆盖：.env → .env.local → .env.production → .env.production.local',
    )
    expect(report).toContain('VITE_MINISTAK_TEST_PUBLIC')
    expect(report).toContain('范围：客户端和服务端')
    expect(report).toContain('MINISTAK_TEST_MISSING')
    expect(report).toContain('来源：未设置')
    expect(report).not.toContain('production-local-private')
    expect(report).not.toContain('base-public')

    await buildApplication({ root: projectRoot })
    const serverDirectory = path.join(projectRoot, 'dist/server')
    const serverCode = (
      await Promise.all(
        (
          await readdir(serverDirectory, {
            recursive: true,
          })
        )
          .filter((file) => file.endsWith('.mjs'))
          .map((file) =>
            readFile(path.join(serverDirectory, file), 'utf8'),
          ),
      )
    ).join('\n')
    expect(serverCode).not.toContain('production-local-private')
    expect(serverCode).not.toMatch(/from\s+['"]vite['"]/)

    const production = await startProductionCommand(
      projectRoot,
      { NODE_ENV: 'wrong' },
    )
    expect(
      await fetch(`${production.url}/environment`).then((response) =>
        response.json(),
      ),
    ).toEqual({
      environment: 'production-local-private',
      nodeEnvironment: 'production',
    })

    const overridden = await startBuiltServer(
      projectRoot,
      path.join(projectRoot, 'dist'),
      {
        MINISTAK_TEST_PRIVATE: 'system-private',
        NODE_ENV: 'wrong',
      },
    )
    expect(
      await fetch(`${overridden.url}/environment`).then((response) =>
        response.json(),
      ),
    ).toEqual({
      environment: 'system-private',
      nodeEnvironment: 'production',
    })

    process.env.NODE_ENV = 'wrong'
    const development = await createDevServer({
      root: projectRoot,
      port: 0,
    })
    try {
      expect(
        await fetch(`${development.url}/environment`).then(
          (response) => response.json(),
        ),
      ).toEqual({
        environment: 'development-local-private',
        nodeEnvironment: 'development',
      })
    } finally {
      await development.close()
    }
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
          assetsDir: 'static',
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

    const clientOutput = await readClientOutput(
      projectRoot,
      outputRoot,
      'static',
    )
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
    expect(nestedPage.headers.get('cache-control')).toBe('no-cache')
    expect(await nestedPage.text()).toContain('Ministak 示例')
    const clientFiles = await readdir(
      path.join(outputRoot, 'client/static'),
    )
    const clientScript = clientFiles.find((file) => file.endsWith('.js'))
    expect(clientScript).toBeDefined()
    const clientAsset = await fetch(
      `${server.url}/app/static/${clientScript}`,
    )
    expect(clientAsset.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
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
      id: 'mode',
      name: '运行模式',
      config: "export default { mode: 'staging' }\n",
      message: '运行模式由 Ministak 管理',
    },
    {
      id: 'env-dir',
      name: '环境变量目录',
      config: "export default { envDir: 'config' }\n",
      message: '环境变量目录由 Ministak 管理',
    },
    {
      id: 'env-prefix',
      name: '客户端环境变量前缀',
      config: "export default { envPrefix: 'PUBLIC_' }\n",
      message: '客户端环境变量前缀由 Ministak 管理',
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
  test('后端首次启动失败时清理开发产物并允许重新启动', async () => {
    const projectRoot = path.join(testProjectsRoot, 'failed-dev-start')
    await mkdir(testProjectsRoot, { recursive: true })
    await cp(exampleRoot, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${path.sep}node_modules`) &&
        !source.includes(`${path.sep}dist`) &&
        !source.includes(`${path.sep}.ministak`),
    })
    const serverFile = path.join(projectRoot, 'src/server.ts')
    const original = await readFile(serverFile, 'utf8')
    await writeFile(
      serverFile,
      `
        import Fastify from 'fastify'
        const app = Fastify()
        throw new Error('测试启动失败')
        export default app
      `,
      'utf8',
    )

    await expect(
      createDevServer({ root: projectRoot, port: 0 }),
    ).rejects.toThrow('Fastify 子进程启动失败')
    await expect(
      readdir(path.join(projectRoot, '.ministak/dev')),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(serverFile, original, 'utf8')
    const server = await createDevServer({ root: projectRoot, port: 0 })
    await server.close()
  })

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
