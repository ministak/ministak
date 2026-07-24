import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import {
  build as viteBuild,
  createServer as createViteServer,
  type ConfigEnv,
  type Plugin,
  type PluginOption,
  type Rollup,
  type UserConfig,
  type ViteDevServer,
} from 'vite'
import {
  loadUserViteConfig,
  loadMinistakConfig,
  PROJECT_CONFIG_FILES,
} from './config-loader.js'
import type { ActionManifest } from './types.js'
import {
  DEV_ROUTE_MISS_HEADER,
  isSpaFallbackRequest,
  resolvePageAppType,
  type PageAppType,
} from './routing.js'
import {
  createMinistakPlugin,
  SERVER_ENTRY_MODULE_ID,
} from './vite.js'

function normalizePath(file: string): string {
  return path.resolve(file.split('?')[0]).replaceAll('\\', '/')
}

function createTransportKey(): string {
  return randomBytes(32).toString('hex')
}

interface ServerBuildResult {
  entry: string
  modules: Set<string>
  manifest: ActionManifest
  configDependencies: string[]
}

function basePathFromResolvedViteBase(base: string): string {
  if (base === '' || base === './') {
    return '/'
  }
  const url = base.startsWith('//')
    ? new URL(`http:${base}`)
    : new URL(base, 'http://ministak.local')
  const pathname = url.pathname.startsWith('/')
    ? url.pathname
    : `/${url.pathname}`
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

function validateUserViteConfig(
  config: UserConfig,
  target: 'client' | 'server',
): void {
  if (config.root !== undefined) {
    throw new Error(
      '项目根目录由 Ministak 管理，请不要在 Vite 配置中设置 root',
    )
  }

  const build = config.build
  if (build?.outDir !== undefined) {
    throw new Error(
      '构建输出目录由 Ministak 管理，请使用 ministak.config.* 的 outDir',
    )
  }
  if (build?.emptyOutDir === false) {
    throw new Error(
      '构建输出目录必须由 Ministak 清理，请不要将 build.emptyOutDir 设为 false',
    )
  }

  if (target === 'client') {
    if (build?.ssr !== undefined) {
      throw new Error('客户端构建由 Ministak 管理，请不要设置 build.ssr')
    }
    return
  }

  if (build?.ssr !== undefined && build.ssr !== true) {
    throw new Error(
      '服务端构建入口由 Ministak 管理，build.ssr 只能省略或设为 true',
    )
  }
  if (build?.target !== undefined && build.target !== 'node24') {
    throw new Error(
      '服务端构建目标由 Ministak 管理，build.target 只能省略或设为 "node24"',
    )
  }
  if (build?.rollupOptions?.input !== undefined) {
    throw new Error(
      '服务端构建入口由 Ministak 管理，请不要设置 build.rollupOptions.input',
    )
  }

  const output = build?.rollupOptions?.output
  if (Array.isArray(output)) {
    throw new Error('服务端构建不支持 rollupOptions.output 数组配置')
  }
  if (output?.dir !== undefined || output?.file !== undefined) {
    throw new Error(
      '服务端输出目录由 Ministak 管理，请不要设置 rollupOptions.output.dir 或 file',
    )
  }
  if (
    output?.entryFileNames !== undefined &&
    output.entryFileNames !== 'index.mjs'
  ) {
    throw new Error(
      '服务端入口文件名由 Ministak 管理，entryFileNames 只能省略或设为 "index.mjs"',
    )
  }
  if (
    output?.chunkFileNames !== undefined &&
    output.chunkFileNames !== 'chunks/[name]-[hash].mjs'
  ) {
    throw new Error(
      '服务端分块文件名由 Ministak 管理，chunkFileNames 只能省略或使用 Ministak 默认值',
    )
  }
}

async function collectPluginOption(
  option: PluginOption,
  plugins: Plugin[],
): Promise<void> {
  const resolved = await option
  if (!resolved) {
    return
  }
  if (Array.isArray(resolved)) {
    for (const child of resolved) {
      await collectPluginOption(child, plugins)
    }
    return
  }
  plugins.push(resolved)
}

async function createProjectPlugins(
  config: UserConfig,
  frameworkPlugin: Plugin,
  target: 'client' | 'server',
): Promise<Plugin[]> {
  const userPlugins: Plugin[] = []
  for (const option of config.plugins ?? []) {
    await collectPluginOption(option, userPlugins)
  }
  if (userPlugins.some((plugin) => plugin.name === 'ministak')) {
    throw new Error('Ministak Vite 插件由框架自动注册，请不要重复添加')
  }

  const plugins = [frameworkPlugin, ...userPlugins]
  if (
    target === 'client' &&
    !plugins.some((plugin) => plugin.name === 'vite:vue')
  ) {
    plugins.push(vue())
  }
  return plugins
}

function configEnvironment(
  command: ConfigEnv['command'],
  mode: string,
  isSsrBuild: boolean,
): ConfigEnv {
  return { command, mode, isSsrBuild, isPreview: false }
}

function mergeNoExternal(
  value: NonNullable<UserConfig['ssr']>['noExternal'],
): NonNullable<UserConfig['ssr']>['noExternal'] {
  if (value === true) {
    return true
  }
  const entries =
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  return ['ministak', ...entries]
}

function createServerOutputOptions(config: UserConfig): Rollup.OutputOptions {
  const output = config.build?.rollupOptions?.output
  if (Array.isArray(output)) {
    throw new Error('服务端构建不支持 rollupOptions.output 数组配置')
  }
  return {
    ...output,
    entryFileNames: 'index.mjs',
    chunkFileNames: 'chunks/[name]-[hash].mjs',
  }
}

function collectServerModules(
  output: Rollup.RollupOutput | Rollup.RollupOutput[],
): Set<string> {
  const outputs = Array.isArray(output) ? output : [output]
  const modules = new Set<string>()
  for (const current of outputs) {
    for (const item of current.output) {
      if (item.type !== 'chunk') {
        continue
      }
      for (const id of Object.keys(item.modules)) {
        if (!id.startsWith('\0')) {
          modules.add(normalizePath(id))
        }
      }
    }
  }
  return modules
}

async function buildClient(options: {
  root: string
  transportKey: string
  actionPath: string
  outDir: string
  mode: string
}): Promise<{
  basePath: string
  appType: PageAppType
}> {
  const loaded = await loadUserViteConfig(
    options.root,
    configEnvironment('build', options.mode, false),
  )
  validateUserViteConfig(loaded.config, 'client')
  const frameworkPlugin = createMinistakPlugin({
    root: options.root,
    target: 'client',
    transportKey: options.transportKey,
    actionPath: options.actionPath,
  })
  const plugins = await createProjectPlugins(
    loaded.config,
    frameworkPlugin,
    'client',
  )
  let basePath = '/'
  let appType: PageAppType = 'spa'
  plugins.push({
    name: 'ministak-client-config',
    configResolved(config) {
      basePath = basePathFromResolvedViteBase(config.base)
      appType = resolvePageAppType(config.appType)
    },
  })

  await viteBuild({
    ...loaded.config,
    root: options.root,
    configFile: false,
    plugins,
    build: {
      ...loaded.config.build,
      outDir: options.outDir,
      emptyOutDir: true,
      sourcemap: loaded.config.build?.sourcemap ?? false,
    },
  })
  return { basePath, appType }
}

async function buildServer(options: {
  root: string
  transportKey: string
  actionPath: string
  basePath: string
  serverEntry: string
  outDir: string
  development: boolean
  appType: PageAppType
  command: ConfigEnv['command']
  mode: string
}): Promise<ServerBuildResult> {
  const loaded = await loadUserViteConfig(
    options.root,
    configEnvironment(options.command, options.mode, true),
  )
  validateUserViteConfig(loaded.config, 'server')
  const frameworkPlugin = createMinistakPlugin({
    root: options.root,
    target: 'server',
    transportKey: options.transportKey,
    actionPath: options.actionPath,
    basePath: options.basePath,
    development: options.development,
    serverEntry: options.serverEntry,
    appType: options.appType,
  })
  const plugins = await createProjectPlugins(
    loaded.config,
    frameworkPlugin,
    'server',
  )

  const output = (await viteBuild({
    ...loaded.config,
    root: options.root,
    configFile: false,
    logLevel: options.development
      ? (loaded.config.logLevel ?? 'warn')
      : loaded.config.logLevel,
    plugins,
    build: {
      ...loaded.config.build,
      ssr: true,
      target: 'node24',
      outDir: options.outDir,
      emptyOutDir: true,
      sourcemap:
        loaded.config.build?.sourcemap ??
        (options.development ? 'inline' : false),
      rollupOptions: {
        ...loaded.config.build?.rollupOptions,
        input: SERVER_ENTRY_MODULE_ID,
        output: createServerOutputOptions(loaded.config),
      },
    },
    ssr: {
      ...loaded.config.ssr,
      noExternal: mergeNoExternal(loaded.config.ssr?.noExternal),
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]

  return {
    entry: path.join(options.outDir, 'index.mjs'),
    modules: collectServerModules(output),
    manifest: frameworkPlugin.ministak.getManifest(),
    configDependencies: loaded.dependencies,
  }
}

export interface BuildApplicationOptions {
  root: string
  mode?: string
}

export async function buildApplication(
  options: BuildApplicationOptions,
): Promise<{
  manifest: ActionManifest
  outDir: string
  actionPath: string
  basePath: string
}> {
  const root = path.resolve(options.root)
  const mode = options.mode ?? 'production'
  const frameworkConfig = await loadMinistakConfig(
    root,
    configEnvironment('build', mode, false),
  )
  const transportKey = createTransportKey()
  const client = await buildClient({
    root,
    transportKey,
    actionPath: frameworkConfig.actionPath,
    outDir: path.join(frameworkConfig.outDir, 'client'),
    mode,
  })
  const server = await buildServer({
    root,
    transportKey,
    actionPath: frameworkConfig.actionPath,
    basePath: client.basePath,
    serverEntry: frameworkConfig.serverEntry,
    outDir: path.join(frameworkConfig.outDir, 'server'),
    development: false,
    appType: client.appType,
    command: 'build',
    mode,
  })

  return {
    manifest: server.manifest,
    outDir: frameworkConfig.outDir,
    actionPath: frameworkConfig.actionPath,
    basePath: client.basePath,
  }
}

interface BackendProcess {
  child: ChildProcess
  port: number
  outputDirectory: string
}

async function startBackend(
  entry: string,
  outputDirectory: string,
  root: string,
): Promise<BackendProcess> {
  const child = fork(entry, [], {
    cwd: root,
    env: {
      ...process.env,
      MINISTAK_PORT: '0',
      MINISTAK_HOST: '127.0.0.1',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Fastify 子进程启动超时'))
    }, 15_000)

    const onExit = (code: number | null) => {
      clearTimeout(timeout)
      reject(new Error(`Fastify 子进程启动失败，退出码：${code}`))
    }

    child.once('exit', onExit)
    child.on('message', (message) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'ready' ||
        !('address' in message)
      ) {
        return
      }

      const address = message.address as AddressInfo
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolve({ child, port: address.port, outputDirectory })
    })
  })
}

async function stopBackend(backend: BackendProcess): Promise<void> {
  if (backend.child.exitCode === null) {
    backend.child.send({ type: 'shutdown' })
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        backend.child.kill('SIGKILL')
      }, 5_000)
      backend.child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
  await rm(backend.outputDirectory, { recursive: true, force: true })
}

interface BackendRouteMiss {
  statusCode: number
  statusMessage?: string
  headers: IncomingHttpHeaders
  body: Buffer
  url: string
}

function copyBackendResponse(
  outgoing: ServerResponse,
  response: {
    statusCode?: number
    statusMessage?: string
    headers: IncomingHttpHeaders
  },
): void {
  outgoing.statusCode = response.statusCode ?? 502
  if (response.statusMessage) {
    outgoing.statusMessage = response.statusMessage
  }
  for (const [name, value] of Object.entries(response.headers)) {
    if (name !== DEV_ROUTE_MISS_HEADER && value !== undefined) {
      outgoing.setHeader(name, value)
    }
  }
}

function sendBackendUnavailable(
  outgoing: ServerResponse,
  statusCode: number,
): void {
  if (outgoing.writableEnded) {
    return
  }
  if (!outgoing.headersSent) {
    outgoing.statusCode = statusCode
    outgoing.setHeader('content-type', 'application/json; charset=utf-8')
  }
  outgoing.end(
    JSON.stringify({
      ok: false,
      error: {
        code: 'SERVER_UNAVAILABLE',
        message: '服务端暂时不可用',
      },
    }),
  )
}

function createBackendProxyPlugin(
  getPort: () => number | undefined,
): Plugin {
  return {
    name: 'ministak-backend-proxy',
    configureServer(server) {
      const routeMisses = new WeakMap<IncomingMessage, BackendRouteMiss>()
      const basePath = basePathFromResolvedViteBase(server.config.base)
      const appType = resolvePageAppType(server.config.appType)

      server.middlewares.use((incoming, outgoing, next) => {
        const port = getPort()
        if (!port) {
          sendBackendUnavailable(outgoing, 503)
          return
        }

        const originalUrl = incoming.url ?? '/'
        const requestUrl = new URL(originalUrl, 'http://localhost')
        const originalHost = incoming.headers.host
        const proxy = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: incoming.url,
            method: incoming.method,
            headers: {
              ...incoming.headers,
              host: originalHost ?? `127.0.0.1:${port}`,
            },
          },
          (response) => {
            const routeMiss =
              response.headers[DEV_ROUTE_MISS_HEADER] === '1'
            const insideBase =
              basePath === '/' ||
              requestUrl.pathname === basePath.slice(0, -1) ||
              requestUrl.pathname.startsWith(basePath)

            if (!routeMiss || !insideBase) {
              copyBackendResponse(outgoing, response)
              response.pipe(outgoing)
              return
            }

            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => {
              chunks.push(chunk)
            })
            response.on('error', (error) => {
              server.config.logger.error(error.message)
              sendBackendUnavailable(outgoing, 502)
            })
            response.on('end', () => {
              if (outgoing.writableEnded) {
                return
              }
              routeMisses.set(incoming, {
                statusCode: response.statusCode ?? 404,
                statusMessage: response.statusMessage,
                headers: response.headers,
                body: Buffer.concat(chunks),
                url: originalUrl,
              })
              if (
                basePath !== '/' &&
                requestUrl.pathname === basePath.slice(0, -1)
              ) {
                incoming.url = `${basePath}${requestUrl.search}`
              }
              next()
            })
          },
        )

        proxy.on('error', (error) => {
          server.config.logger.error(error.message)
          sendBackendUnavailable(outgoing, 502)
        })
        incoming.pipe(proxy)
      })

      return () => {
        server.middlewares.use((incoming, outgoing, next) => {
          const routeMiss = routeMisses.get(incoming)
          if (!routeMiss) {
            next()
            return
          }
          routeMisses.delete(incoming)

          const requestUrl = new URL(routeMiss.url, 'http://localhost')
          const indexRequest =
            (incoming.method === 'GET' || incoming.method === 'HEAD') &&
            (requestUrl.pathname === basePath ||
              requestUrl.pathname === `${basePath}index.html`)
          if (
            indexRequest ||
            (appType === 'spa' &&
              isSpaFallbackRequest(
                incoming.method,
                incoming.headers.accept,
                requestUrl.pathname,
                basePath,
              ))
          ) {
            if (indexRequest && !incoming.url?.startsWith('/index.html')) {
              incoming.url = `/index.html${requestUrl.search}`
            }
            next()
            return
          }

          copyBackendResponse(outgoing, routeMiss)
          outgoing.end(routeMiss.body)
        })
      }
    },
  }
}

export interface CreateDevServerOptions {
  root: string
  port?: number
  host?: string
  mode?: string
}

export interface MinistakDevServer {
  url: string
  port: number
  vite: ViteDevServer
  getGeneration(): number
  getManifest(): ActionManifest
  waitForGeneration(after: number, timeout?: number): Promise<number>
  waitForRestart(): Promise<void>
  close(): Promise<void>
}

export async function createDevServer(
  options: CreateDevServerOptions,
): Promise<MinistakDevServer> {
  const root = path.resolve(options.root)
  const mode = options.mode ?? 'development'
  const frameworkConfig = await loadMinistakConfig(
    root,
    configEnvironment('serve', mode, false),
  )
  const clientViteConfig = await loadUserViteConfig(
    root,
    configEnvironment('serve', mode, false),
  )
  validateUserViteConfig(clientViteConfig.config, 'client')
  const transportKey = createTransportKey()
  const devRoot = path.join(root, '.ministak', 'dev')
  let appType: PageAppType = 'spa'
  let generation = 0
  let backend: BackendProcess | undefined
  let serverModules = new Set<string>()
  let manifest: ActionManifest = { actions: [] }
  let closed = false
  let restartRequested = false
  const configDependencies = new Set(
    [...frameworkConfig.dependencies, ...clientViteConfig.dependencies].map(
      normalizePath,
    ),
  )
  const events = new EventEmitter()

  const launchBackend = async (): Promise<void> => {
    const nextGeneration = generation + 1
    const outputDirectory = path.join(devRoot, `backend-${nextGeneration}`)
    const built = await buildServer({
      root,
      transportKey,
      actionPath: frameworkConfig.actionPath,
      basePath: '/',
      serverEntry: frameworkConfig.serverEntry,
      outDir: outputDirectory,
      development: true,
      appType,
      command: 'serve',
      mode,
    })
    const nextBackend = await startBackend(built.entry, outputDirectory, root)
    const previous = backend

    backend = nextBackend
    serverModules = built.modules
    manifest = built.manifest
    for (const file of built.configDependencies) {
      configDependencies.add(normalizePath(file))
    }
    generation = nextGeneration
    events.emit('generation', generation)

    if (previous) {
      await stopBackend(previous)
    }
  }

  const clientPlugin = createMinistakPlugin({
    root,
    target: 'client',
    transportKey,
    actionPath: frameworkConfig.actionPath,
    development: true,
    serverEntry: frameworkConfig.serverEntry,
  })
  const clientPlugins = await createProjectPlugins(
    clientViteConfig.config,
    clientPlugin,
    'client',
  )
  const configuredServer = clientViteConfig.config.server ?? {}
  const configuredWatch = configuredServer.watch ?? {}
  const configuredIgnored = configuredWatch.ignored
  const ignored = [
    ...(Array.isArray(configuredIgnored)
      ? configuredIgnored
      : configuredIgnored
        ? [configuredIgnored]
        : []),
    '**/.ministak/**',
    '**/dist/**',
  ]
  const publicHost = options.host ?? configuredServer.host ?? '127.0.0.1'
  const publicPort = options.port ?? configuredServer.port ?? 5173

  const vite = await createViteServer({
    ...clientViteConfig.config,
    root,
    configFile: false,
    mode,
    plugins: [
      createBackendProxyPlugin(() => backend?.port),
      ...clientPlugins,
    ],
    server: {
      ...configuredServer,
      host: publicHost,
      port: publicPort,
      strictPort:
        publicPort === 0 ? false : (configuredServer.strictPort ?? true),
      watch: {
        ...configuredWatch,
        ignored,
      },
    },
  })
  appType = resolvePageAppType(vite.config.appType)
  await rm(devRoot, { recursive: true, force: true })
  await launchBackend()
  await vite.listen()

  const watchServerFiles = () => {
    vite.watcher.add([
      ...serverModules,
      ...manifest.actions.map((action) => action.file),
      ...configDependencies,
    ])
  }
  watchServerFiles()

  let reloadTimer: NodeJS.Timeout | undefined
  let reloadQueue = Promise.resolve()

  const scheduleReload = () => {
    if (closed) {
      return
    }
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadQueue = reloadQueue
        .then(launchBackend)
        .then(watchServerFiles)
        .catch((error: unknown) =>
          vite.config.logger.error(
            error instanceof Error ? error.message : String(error),
          ),
        )
    }, 60)
  }

  const shouldReloadAddedFile = async (file: string): Promise<boolean> => {
    const sourceRoot = path.join(root, 'src')
    const relative = path.relative(sourceRoot, path.resolve(file))
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !/\.(?:[cm]?[jt]sx?)$/.test(file) ||
      file.endsWith('.d.ts')
    ) {
      return false
    }
    const code = await readFile(file, 'utf8')
    return code.includes('use server')
  }

  const isProjectConfigFile = (file: string): boolean => {
    const absoluteFile = path.resolve(file)
    return (
      path.dirname(absoluteFile) === root &&
      PROJECT_CONFIG_FILES.has(path.basename(absoluteFile))
    )
  }

  const shouldRestart = (file: string): boolean =>
    configDependencies.has(normalizePath(file)) || isProjectConfigFile(file)

  const requestRestart = () => {
    if (closed || restartRequested) {
      return
    }
    restartRequested = true
    events.emit('restart')
  }

  vite.watcher.on('change', (file) => {
    if (shouldRestart(file)) {
      requestRestart()
      return
    }
    const normalizedFile = normalizePath(file)
    if (
      serverModules.has(normalizedFile) ||
      manifest.actions.some(
        (action) => normalizePath(action.file) === normalizedFile,
      )
    ) {
      scheduleReload()
    }
  })
  vite.watcher.on('unlink', (file) => {
    if (shouldRestart(file)) {
      requestRestart()
      return
    }
    if (
      serverModules.has(normalizePath(file)) ||
      manifest.actions.some(
        (action) => normalizePath(action.file) === normalizePath(file),
      )
    ) {
      scheduleReload()
    }
  })
  vite.watcher.on('add', (file) => {
    if (shouldRestart(file)) {
      requestRestart()
      return
    }
    void shouldReloadAddedFile(file).then((shouldReload) => {
      if (shouldReload) {
        scheduleReload()
      }
    })
  })

  const address = vite.httpServer?.address() as AddressInfo | null
  if (!address) {
    throw new Error('Vite 开发服务器没有监听地址')
  }
  const urlHost = typeof publicHost === 'string' ? publicHost : '127.0.0.1'
  const url = `http://${urlHost}:${address.port}`

  return {
    url,
    port: address.port,
    vite,
    getGeneration: () => generation,
    getManifest: () => manifest,
    waitForRestart() {
      if (restartRequested) {
        return Promise.resolve()
      }
      return new Promise((resolve) => events.once('restart', resolve))
    },
    waitForGeneration(after, timeout = 15_000) {
      if (generation > after) {
        return Promise.resolve(generation)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          events.off('generation', onGeneration)
          reject(new Error('等待服务端热重载超时'))
        }, timeout)
        const onGeneration = (value: number) => {
          if (value <= after) {
            return
          }
          clearTimeout(timer)
          events.off('generation', onGeneration)
          resolve(value)
        }
        events.on('generation', onGeneration)
      })
    },
    async close() {
      closed = true
      clearTimeout(reloadTimer)
      await reloadQueue
      await vite.environments.client.waitForRequestsIdle()
      if (backend) {
        await stopBackend(backend)
      }
      await vite.close()
      await rm(devRoot, { recursive: true, force: true })
    },
  }
}

export async function startProduction(root: string): Promise<void> {
  const applicationRoot = path.resolve(root)
  process.chdir(applicationRoot)
  const config = await loadMinistakConfig(
    applicationRoot,
    configEnvironment('build', 'production', true),
  )
  const entry = path.join(config.outDir, 'server/index.mjs')
  await import(pathToFileURL(entry).href)
}
