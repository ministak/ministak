import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'
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

  const plugins = [
    frameworkPlugin,
    ...userPlugins.filter((plugin) => plugin.name !== 'ministak'),
  ]
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
}): Promise<string> {
  const loaded = await loadUserViteConfig(
    options.root,
    configEnvironment('build', options.mode, false),
  )
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
  plugins.push({
    name: 'ministak-client-base',
    configResolved(config) {
      basePath = basePathFromResolvedViteBase(config.base)
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
  return basePath
}

async function buildServer(options: {
  root: string
  transportKey: string
  actionPath: string
  basePath: string
  serverEntry: string
  outDir: string
  development: boolean
  bodyLimit?: number
  spaFallback: boolean
  command: ConfigEnv['command']
  mode: string
}): Promise<ServerBuildResult> {
  const loaded = await loadUserViteConfig(
    options.root,
    configEnvironment(options.command, options.mode, true),
  )
  const frameworkPlugin = createMinistakPlugin({
    root: options.root,
    target: 'server',
    transportKey: options.transportKey,
    actionPath: options.actionPath,
    basePath: options.basePath,
    development: options.development,
    serverEntry: options.serverEntry,
    bodyLimit: options.bodyLimit,
    spaFallback: options.spaFallback,
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
      sourcemap: options.development ? 'inline' : false,
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
  const basePath = await buildClient({
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
    basePath,
    serverEntry: frameworkConfig.serverEntry,
    outDir: path.join(frameworkConfig.outDir, 'server'),
    development: false,
    bodyLimit: frameworkConfig.bodyLimit,
    spaFallback: frameworkConfig.spaFallback,
    command: 'build',
    mode,
  })

  return {
    manifest: server.manifest,
    outDir: frameworkConfig.outDir,
    actionPath: frameworkConfig.actionPath,
    basePath,
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

function createActionProxyPlugin(
  actionPath: string,
  getPort: () => number | undefined,
): Plugin {
  return {
    name: 'ministak-action-proxy',
    configureServer(server) {
      server.middlewares.use((incoming, outgoing, next) => {
        const requestUrl = new URL(incoming.url ?? '/', 'http://localhost')
        if (requestUrl.pathname !== actionPath) {
          next()
          return
        }

        const port = getPort()
        if (!port) {
          outgoing.statusCode = 503
          outgoing.setHeader('content-type', 'application/json; charset=utf-8')
          outgoing.end(
            JSON.stringify({
              ok: false,
              error: {
                code: 'SERVER_UNAVAILABLE',
                message: '服务端暂时不可用',
              },
            }),
          )
          return
        }

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
            outgoing.statusCode = response.statusCode ?? 502
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) {
                outgoing.setHeader(name, value)
              }
            }
            response.pipe(outgoing)
          },
        )

        proxy.on('error', (error) => {
          server.config.logger.error(error.message)
          if (!outgoing.headersSent) {
            outgoing.statusCode = 502
            outgoing.setHeader(
              'content-type',
              'application/json; charset=utf-8',
            )
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
        })
        incoming.pipe(proxy)
      })
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
  const transportKey = createTransportKey()
  const devRoot = path.join(root, '.ministak', 'dev')
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
      bodyLimit: frameworkConfig.bodyLimit,
      spaFallback: frameworkConfig.spaFallback,
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

  await rm(devRoot, { recursive: true, force: true })
  await launchBackend()

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
      createActionProxyPlugin(
        frameworkConfig.actionPath,
        () => backend?.port,
      ),
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
      await vite.close()
      if (backend) {
        await stopBackend(backend)
      }
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
