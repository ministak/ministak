import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import fg from 'fast-glob'
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
import {
  resolveEnvironment,
  type EnvironmentMode,
} from './env.js'
import {
  writeActionTypeDeclarations,
} from './action-scanner.js'

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
  output: Rollup.RollupOutput | Rollup.RollupOutput[]
}

interface ClientBuildResult {
  basePath: string
  appType: PageAppType
  assetsDir: string
  publicDir: string
  copyPublicDir: boolean
  sourcemap: boolean
  output: Rollup.RollupOutput | Rollup.RollupOutput[]
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
  if (config.mode !== undefined) {
    throw new Error('运行模式由 Ministak 管理，请不要在 Vite 配置中设置 mode')
  }
  if (config.envDir !== undefined) {
    throw new Error(
      '环境变量目录由 Ministak 管理，请不要在 Vite 配置中设置 envDir',
    )
  }
  if (config.envPrefix !== undefined) {
    throw new Error(
      '客户端环境变量前缀由 Ministak 管理，请不要在 Vite 配置中设置 envPrefix',
    )
  }
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
  mode: EnvironmentMode,
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
  mode: EnvironmentMode
  write?: boolean
}): Promise<ClientBuildResult> {
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
  await writeActionTypeDeclarations(
    options.root,
    await frameworkPlugin.ministak.refreshManifest(),
  )
  const plugins = await createProjectPlugins(
    loaded.config,
    frameworkPlugin,
    'client',
  )
  let basePath = '/'
  let appType: PageAppType = 'spa'
  let assetsDir = 'assets'
  let publicDir = path.join(options.root, 'public')
  let copyPublicDir = true
  let sourcemap = false
  plugins.push({
    name: 'ministak-client-config',
    configResolved(config) {
      basePath = basePathFromResolvedViteBase(config.base)
      appType = resolvePageAppType(config.appType)
      assetsDir = config.build.assetsDir
      publicDir = config.publicDir
      copyPublicDir = config.build.copyPublicDir
      sourcemap = Boolean(config.build.sourcemap)
    },
  })

  const output = (await viteBuild({
    ...loaded.config,
    root: options.root,
    mode: options.mode,
    configFile: false,
    logLevel:
      options.write === false ? 'silent' : loaded.config.logLevel,
    plugins,
    build: {
      ...loaded.config.build,
      outDir: options.outDir,
      emptyOutDir: true,
      sourcemap: loaded.config.build?.sourcemap ?? false,
      write: options.write ?? loaded.config.build?.write,
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  return {
    basePath,
    appType,
    assetsDir,
    publicDir,
    copyPublicDir,
    sourcemap,
    output,
  }
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
  clientAssetsDir?: string
  command: ConfigEnv['command']
  mode: EnvironmentMode
  write?: boolean
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
    serverOutputDirectory: options.outDir,
    appType: options.appType,
    clientAssetsDir: options.clientAssetsDir,
  })
  const plugins = await createProjectPlugins(
    loaded.config,
    frameworkPlugin,
    'server',
  )

  const output = (await viteBuild({
    ...loaded.config,
    root: options.root,
    mode: options.mode,
    configFile: false,
    logLevel:
      options.write === false
        ? 'silent'
        : options.development
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
      write: options.write ?? loaded.config.build?.write,
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
    output,
  }
}

export interface BuildApplicationOptions {
  root: string
}

async function buildProductionApplication(
  options: BuildApplicationOptions,
  write?: boolean,
) {
  const root = path.resolve(options.root)
  const mode = 'production'
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
    write,
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
    clientAssetsDir: client.assetsDir,
    command: 'build',
    mode,
    write,
  })

  return { root, frameworkConfig, client, server }
}

export async function buildApplication(
  options: BuildApplicationOptions,
): Promise<{
  manifest: ActionManifest
  outDir: string
  actionPath: string
  basePath: string
}> {
  const { frameworkConfig, client, server } =
    await buildProductionApplication(options)

  return {
    manifest: server.manifest,
    outDir: frameworkConfig.outDir,
    actionPath: frameworkConfig.actionPath,
    basePath: client.basePath,
  }
}

function outputList(
  output: Rollup.RollupOutput | Rollup.RollupOutput[],
): Rollup.RollupOutput[] {
  return Array.isArray(output) ? output : [output]
}

function physicalModuleFile(id: string): string | undefined {
  if (id.includes('\0')) {
    return undefined
  }

  let file = id.split('?')[0]
  if (file.startsWith('/@fs/')) {
    file = file.slice('/@fs/'.length)
  } else if (/^\/[A-Za-z]:\//.test(file)) {
    file = file.slice(1)
  }
  return path.isAbsolute(file) ? path.resolve(file) : undefined
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

async function collectOutputFiles(
  root: string,
  output: Rollup.RollupOutput | Rollup.RollupOutput[],
): Promise<Set<string>> {
  const candidates = new Set<string>()

  for (const current of outputList(output)) {
    for (const item of current.output) {
      if (item.type === 'chunk') {
        for (const [id, module] of Object.entries(item.modules)) {
          const file = physicalModuleFile(id)
          if (
            file &&
            (module.renderedLength > 0 ||
              /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss)$/i.test(
                file,
              ))
          ) {
            candidates.add(file)
          }
        }
        continue
      }

      for (const original of item.originalFileNames) {
        candidates.add(
          path.isAbsolute(original)
            ? path.resolve(original)
            : path.resolve(root, original),
        )
      }
      if (item.fileName.endsWith('.html')) {
        candidates.add(path.resolve(root, item.fileName))
      }
    }
  }

  const files = new Set<string>()
  for (const file of candidates) {
    if (await isFile(file)) {
      files.add(path.resolve(file))
    }
  }
  return files
}

async function collectPublicFiles(
  publicDir: string,
  enabled: boolean,
): Promise<Set<string>> {
  if (!enabled || !publicDir) {
    return new Set()
  }

  try {
    if (!(await stat(publicDir)).isDirectory()) {
      return new Set()
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return new Set()
    }
    throw error
  }

  return new Set(
    (
      await fg('**/*', {
        cwd: publicDir,
        absolute: true,
        dot: true,
        onlyFiles: true,
      })
    ).map((file) => path.resolve(file)),
  )
}

function packageName(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/')
  const marker = '/node_modules/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) {
    return undefined
  }

  const [first, second] = normalized
    .slice(index + marker.length)
    .split('/')
  return first.startsWith('@') ? `${first}/${second}` : first
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

interface TreeNode {
  children: Map<string, TreeNode>
}

function renderTree(paths: string[]): string[] {
  if (paths.length === 0) {
    return ['└─ （无）']
  }

  const root: TreeNode = { children: new Map() }
  for (const entry of paths) {
    let node = root
    for (const part of entry.split('/').filter(Boolean)) {
      let child = node.children.get(part)
      if (!child) {
        child = { children: new Map() }
        node.children.set(part, child)
      }
      node = child
    }
  }

  const lines: string[] = []
  const visit = (node: TreeNode, prefix: string) => {
    const children = [...node.children].sort(([left], [right]) => {
      const weight = (name: string) =>
        name === '项目外文件' ? 1 : name === '第三方包' ? 2 : 0
      return weight(left) - weight(right) || left.localeCompare(right)
    })
    children.forEach(([name, child], index) => {
      const last = index === children.length - 1
      lines.push(`${prefix}${last ? '└─' : '├─'} ${name}`)
      visit(child, `${prefix}${last ? '   ' : '│  '}`)
    })
  }
  visit(root, '')
  return lines
}

function formatTarget(
  title: string,
  root: string,
  files: Set<string>,
): string[] {
  const entries = new Set<string>()
  for (const file of files) {
    const dependency = packageName(file)
    if (dependency) {
      entries.add(`第三方包/${dependency}`)
    } else if (isInside(root, file)) {
      entries.add(path.relative(root, file).replaceAll('\\', '/'))
    } else {
      entries.add(`项目外文件/${file.replaceAll('\\', '/')}`)
    }
  }
  return [title, ...renderTree([...entries])]
}

const SOURCE_FILE_PATTERN =
  /\.(?:[cm]?[jt]sx?|vue)$/i

async function collectEnvironmentReferences(
  root: string,
  files: Set<string>,
  target: 'client' | 'server',
): Promise<Set<string>> {
  const names = new Set<string>()
  const patterns =
    target === 'client'
      ? [
          /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
          /\bimport\.meta\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
        ]
      : [
          /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
          /\bprocess\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
        ]

  for (const file of files) {
    if (!isInside(root, file) || !SOURCE_FILE_PATTERN.test(file)) {
      continue
    }
    const source = await readFile(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        names.add(match[1])
      }
    }
  }
  return names
}

function formatEnvironment(
  root: string,
  mode: EnvironmentMode,
  clientReferences: Set<string>,
  serverReferences: Set<string>,
): string[] {
  const environment = resolveEnvironment(root, mode)
  const names = new Set<string>()

  for (const name of environment.variables.keys()) {
    const variable = environment.variables.get(name)
    if (
      variable?.sources.some(
        (source) => source !== '系统环境变量',
      ) ||
      name.startsWith('VITE_')
    ) {
      names.add(name)
    }
  }
  for (const name of clientReferences) {
    if (name.startsWith('VITE_')) {
      names.add(name)
    }
  }
  for (const name of serverReferences) {
    names.add(name)
  }

  const lines = [`环境变量（${mode}，值已隐藏）`]
  const sortedNames = [...names].sort((left, right) =>
    left.localeCompare(right),
  )
  if (sortedNames.length === 0) {
    lines.push('└─ （无）')
    return lines
  }

  sortedNames.forEach((name, index) => {
    const last = index === sortedNames.length - 1
    const branch = last ? '└─' : '├─'
    const indent = last ? '   ' : '│  '
    const variable = environment.variables.get(name)
    lines.push(`${branch} ${name}`)
    lines.push(`${indent}├─ 来源：${variable?.source ?? '未设置'}`)
    lines.push(
      `${indent}└─ 范围：${
        name.startsWith('VITE_') ? '客户端和服务端' : '仅服务端'
      }`,
    )
    if (variable && variable.sources.length > 1) {
      lines.splice(
        lines.length - 1,
        0,
        `${indent}├─ 覆盖：${variable.sources.join(' → ')}`,
      )
    }
  })
  return lines
}

export async function inspectApplication(
  options: BuildApplicationOptions,
): Promise<string> {
  const built = await buildProductionApplication(options, false)
  const clientFiles = await collectOutputFiles(
    built.root,
    built.client.output,
  )
  const publicFiles = await collectPublicFiles(
    built.client.publicDir,
    built.client.copyPublicDir,
  )
  for (const file of publicFiles) {
    clientFiles.add(file)
  }
  const serverFiles = await collectOutputFiles(
    built.root,
    built.server.output,
  )
  const clientEnvironmentReferences =
    await collectEnvironmentReferences(
      built.root,
      clientFiles,
      'client',
    )
  const serverEnvironmentReferences =
    await collectEnvironmentReferences(
      built.root,
      serverFiles,
      'server',
    )

  const lines = [
    ...formatTarget(
      '客户端（会发送给浏览器）',
      built.root,
      clientFiles,
    ),
  ]
  if (built.client.sourcemap) {
    lines.push(
      '',
      '警告：客户端 sourcemap 已开启，部署时可能同时公开源码。',
    )
  }
  lines.push(
    '',
    ...formatTarget(
      '服务端',
      built.root,
      serverFiles,
    ),
    '',
    ...formatEnvironment(
      built.root,
      'production',
      clientEnvironmentReferences,
      serverEnvironmentReferences,
    ),
    '',
    '说明：文件树不检查 Action 返回值和 Vite define 注入的内容。',
  )
  return lines.join('\n')
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
    let timeoutError: Error | undefined
    let forceTimeout: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timeoutError = new Error('Fastify 子进程启动超时')
      child.kill()
      forceTimeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, 15_000)

    const cleanup = () => {
      clearTimeout(timeout)
      clearTimeout(forceTimeout)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('message', onMessage)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onExit = (code: number | null) => {
      cleanup()
      reject(
        timeoutError ??
          new Error(`Fastify 子进程启动失败，退出码：${code}`),
      )
    }

    const onMessage = (message: unknown) => {
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
      cleanup()
      resolve({ child, port: address.port, outputDirectory })
    }

    child.once('error', onError)
    child.once('exit', onExit)
    child.on('message', onMessage)
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
  const mode = 'development'
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
    let built: ServerBuildResult
    let nextBackend: BackendProcess
    try {
      built = await buildServer({
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
      nextBackend = await startBackend(built.entry, outputDirectory, root)
    } catch (error) {
      try {
        await rm(outputDirectory, { recursive: true, force: true })
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Fastify 子进程启动失败且无法清理构建产物',
        )
      }
      throw error
    }
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
  await writeActionTypeDeclarations(
    root,
    await clientPlugin.ministak.refreshManifest(),
  )
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
    mode,
    configFile: false,
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

  const watchServerFiles = () => {
    vite.watcher.add([
      ...serverModules,
      ...manifest.actions.map((action) => action.file),
      ...configDependencies,
    ])
  }

  let address: AddressInfo
  try {
    appType = resolvePageAppType(vite.config.appType)
    await rm(devRoot, { recursive: true, force: true })
    await launchBackend()
    await vite.listen()
    watchServerFiles()
    const listeningAddress = vite.httpServer?.address() as AddressInfo | null
    if (!listeningAddress) {
      throw new Error('Vite 开发服务器没有监听地址')
    }
    address = listeningAddress
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (backend) {
      try {
        await stopBackend(backend)
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    try {
      await vite.close()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    try {
      await rm(devRoot, { recursive: true, force: true })
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        '开发服务器启动失败且无法完整清理',
      )
    }
    throw error
  }

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
    configDependencies.has(normalizePath(file)) ||
    isProjectConfigFile(file)

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
