import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import {
  createActionTransportId,
  parseServerActionExports,
  scanServerActions,
  writeActionTypeDeclarations,
} from './action-scanner.js'
import type { PageAppType } from './routing.js'
import type { ActionDefinition, ActionManifest } from './types.js'

export const ACTIONS_MODULE_ID = 'virtual:ministak/actions'
export const SERVER_ENTRY_MODULE_ID = 'virtual:ministak/server-entry'

const RESOLVED_ACTIONS_MODULE_ID = `\0${ACTIONS_MODULE_ID}`
const RESOLVED_SERVER_ENTRY_MODULE_ID = `\0${SERVER_ENTRY_MODULE_ID}`
const ACTION_PROXY_MODULE_PREFIX = '\0ministak:action-proxy:'
const EMPTY_SERVER_ONLY_ID = '\0ministak:server-only-empty'
const FORBIDDEN_ID_PREFIX = '\0ministak:forbidden:'
const ACTION_MODULE_PATTERN = /\.(?:[cm]?[jt]sx?)$/

function normalizePath(file: string): string {
  return file.replaceAll('\\', '/')
}

const runtimeFile = fileURLToPath(import.meta.url)
const runtimeDirectory = path.dirname(runtimeFile)
const runtimeExtension = path.extname(runtimeFile)
const runtimeModules = new Map([
  ['ministak', path.join(runtimeDirectory, `index${runtimeExtension}`)],
  [
    'ministak/client',
    path.join(runtimeDirectory, `client${runtimeExtension}`),
  ],
  [
    'ministak/server',
    path.join(runtimeDirectory, `server${runtimeExtension}`),
  ],
])

function cleanModuleId(id: string): string {
  return path.resolve(id.split('?')[0])
}

function isFileInsideRoot(root: string, file: string): boolean {
  const relative = path.relative(root, path.resolve(file))
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function createActionProxyModuleId(file: string): string {
  return `${ACTION_PROXY_MODULE_PREFIX}${encodeURIComponent(normalizePath(file))}`
}

export function createActionProxyModule(
  actions: readonly ActionDefinition[],
  actionPath: string,
  transportKey: string,
  development = false,
): string {
  const lines = [
    "import { createServerReference } from 'ministak/client'",
  ]
  for (const action of actions) {
    const transportId = development
      ? action.name
      : createActionTransportId(transportKey, action.name)
    lines.push(
      `export const ${action.exportName} = createServerReference(${JSON.stringify(actionPath)}, ${JSON.stringify(transportId)})`,
    )
  }
  return `${lines.join('\n')}\n`
}

function rootImport(root: string, file: string): string {
  return `/${normalizePath(path.relative(root, file))}`
}

function createActionRegistryModule(
  root: string,
  manifest: ActionManifest,
  transportKey: string,
  development: boolean,
): string {
  const entries = manifest.actions.map((action) => {
    const importPath = rootImport(root, action.file)
    const transportId = development
      ? action.name
      : createActionTransportId(transportKey, action.name)
    return `${JSON.stringify(transportId)}: {
      name: ${JSON.stringify(action.name)},
      load: async () => {
        const module = await import(${JSON.stringify(importPath)})
        const handler = module[${JSON.stringify(action.exportName)}]
        if (typeof handler !== 'function') {
          throw new Error(${JSON.stringify(`Action ${action.name} 没有导出函数`)})
        }
        return handler
      }
    }`
  })

  return `export const actionRegistry = {\n${entries.join(',\n')}\n}\n`
}

function createServerEntryModule(options: {
  root: string
  serverEntry: string
  serverOutputDirectory: string
  actionPath: string
  basePath: string
  development: boolean
  appType: PageAppType
  clientAssetsDir?: string
}): string {
  const serverEntryImport = rootImport(options.root, options.serverEntry)
  const applicationRoot = path
    .relative(options.serverOutputDirectory, options.root)
    .replaceAll('\\', '/')
  return `
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFrameworkApp,
  loadServerEnvironment,
} from 'ministak/server'
import { actionRegistry } from ${JSON.stringify(ACTIONS_MODULE_ID)}

const development = ${JSON.stringify(options.development)}
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const applicationRoot = path.resolve(
  currentDirectory,
  ${JSON.stringify(applicationRoot)},
)
const clientRoot = development
  ? undefined
  : path.resolve(currentDirectory, '../client')

process.env.NODE_ENV = development ? 'development' : 'production'
loadServerEnvironment(
  applicationRoot,
  development ? 'development' : 'production',
)
const { default: userApp } = await import(
  ${JSON.stringify(serverEntryImport)}
)

export const app = await createFrameworkApp({
  app: userApp,
  actionPath: ${JSON.stringify(options.actionPath)},
  basePath: ${JSON.stringify(options.basePath)},
  actionRegistry,
  development,
  clientRoot,
  assetsDir: development
    ? undefined
    : ${JSON.stringify(options.clientAssetsDir ?? 'assets')},
  appType: ${JSON.stringify(options.appType)},
})

let closing = false
async function close() {
  if (closing) return
  closing = true
  await app.close()
}

export async function start() {
  const port = Number(process.env.MINISTAK_PORT ?? process.env.PORT ?? 3000)
  const host = process.env.MINISTAK_HOST ?? '127.0.0.1'
  await app.listen({ port, host })
  const address = app.server.address()
  if (process.send) {
    process.send({ type: 'ready', address })
  } else {
    const displayHost = host.includes(':') ? \`[\${host}]\` : host
    const displayPort =
      address && typeof address === 'object' ? address.port : port
    console.log(
      \`生产服务器已启动：http://\${displayHost}:\${displayPort}\`,
    )
  }
  return address
}

process.on('message', (message) => {
  if (message && typeof message === 'object' && message.type === 'shutdown') {
    void close().then(() => process.exit(0))
  }
})
process.once('SIGTERM', () => void close().then(() => process.exit(0)))
process.once('SIGINT', () => void close().then(() => process.exit(0)))

await start()
`
}

interface CommonMinistakPluginOptions {
  root?: string
  transportKey: string
  actionPath: string
  basePath?: string
  development?: boolean
  serverEntry?: string
  appType?: PageAppType
  clientAssetsDir?: string
}

export type MinistakPluginOptions =
  | (CommonMinistakPluginOptions & {
      target: 'client'
    })
  | (CommonMinistakPluginOptions & {
      target: 'server'
      serverOutputDirectory: string
    })

export interface MinistakPluginApi {
  getManifest(): ActionManifest
  refreshManifest(): Promise<ActionManifest>
}

export type MinistakPlugin = Plugin & { ministak: MinistakPluginApi }

export function createMinistakPlugin(
  options: MinistakPluginOptions,
): MinistakPlugin {
  let root = path.resolve(options.root ?? process.cwd())
  let sourceRoot = path.join(root, 'src')
  let serverEntry = path.resolve(root, options.serverEntry ?? 'src/server.ts')
  let manifest: ActionManifest = { actions: [] }
  let actionsByFile = new Map<string, ActionDefinition[]>()
  let manifestRoot: string | undefined

  const refreshManifest = async (): Promise<ActionManifest> => {
    manifest = await scanServerActions(root)
    manifestRoot = root
    actionsByFile = new Map()
    for (const action of manifest.actions) {
      const file = path.resolve(action.file)
      const actions = actionsByFile.get(file)
      if (actions) {
        actions.push(action)
      } else {
        actionsByFile.set(file, [action])
      }
    }
    return manifest
  }

  const plugin: Plugin = {
    name: 'ministak',
    enforce: 'pre',

    async configResolved(resolved) {
      root = path.resolve(options.root ?? resolved.root)
      sourceRoot = path.join(root, 'src')
      serverEntry = path.resolve(root, options.serverEntry ?? 'src/server.ts')
      if (manifestRoot !== root) {
        await refreshManifest()
      }
    },

    async resolveId(source, importer, resolveOptions) {
      if (source === ACTIONS_MODULE_ID) {
        return RESOLVED_ACTIONS_MODULE_ID
      }
      if (source === SERVER_ENTRY_MODULE_ID) {
        return RESOLVED_SERVER_ENTRY_MODULE_ID
      }

      const isServerOnlyImport =
        source === 'server-only' || source === 'ministak/server'

      if (options.target === 'server' && source === 'server-only') {
        return EMPTY_SERVER_ONLY_ID
      }

      if (
        options.target === 'client' &&
        isServerOnlyImport
      ) {
        return `${FORBIDDEN_ID_PREFIX}${encodeURIComponent(source)}?importer=${encodeURIComponent(importer ?? '<entry>')}`
      }

      const runtimeModule = runtimeModules.get(source)
      if (runtimeModule) {
        return runtimeModule
      }

      if (options.target !== 'client') {
        return null
      }

      const resolved = await this.resolve(source, importer, {
        ...resolveOptions,
        skipSelf: true,
      })
      if (!resolved) {
        return null
      }

      const file = cleanModuleId(resolved.id)
      if (actionsByFile.has(file)) {
        return createActionProxyModuleId(file)
      }
      return resolved
    },

    load(id) {
      if (id === EMPTY_SERVER_ONLY_ID) {
        return 'export {}'
      }

      if (id.startsWith(FORBIDDEN_ID_PREFIX)) {
        const encodedSource = id
          .slice(FORBIDDEN_ID_PREFIX.length)
          .split('?')[0]
        this.error(
          `客户端代码不能导入服务端模块：${decodeURIComponent(encodedSource)}`,
        )
      }

      if (id.startsWith(ACTION_PROXY_MODULE_PREFIX)) {
        const file = path.resolve(
          decodeURIComponent(id.slice(ACTION_PROXY_MODULE_PREFIX.length)),
        )
        const actions = actionsByFile.get(file)
        if (!actions) {
          this.error(`Action 模块不存在：${normalizePath(file)}`)
        }
        return createActionProxyModule(
          actions,
          options.actionPath,
          options.transportKey,
          options.development ?? false,
        )
      }

      if (id === RESOLVED_ACTIONS_MODULE_ID) {
        if (options.target !== 'server') {
          this.error('Action 注册表只能在服务端构建中使用')
        }
        return createActionRegistryModule(
          root,
          manifest,
          options.transportKey,
          options.development ?? false,
        )
      }

      if (id === RESOLVED_SERVER_ENTRY_MODULE_ID) {
        if (options.target !== 'server') {
          this.error('服务端入口只能在服务端构建中使用')
        }
        return createServerEntryModule({
          root,
          serverEntry,
          serverOutputDirectory: options.serverOutputDirectory,
          actionPath: options.actionPath,
          basePath: options.basePath ?? '/',
          development: options.development ?? false,
          appType: options.appType ?? 'spa',
          clientAssetsDir: options.clientAssetsDir,
        })
      }

      return null
    },

    transform(code, id) {
      const file = cleanModuleId(id)
      if (options.target === 'server' && file.endsWith('.vue')) {
        this.error('服务端代码不能导入 .vue 文件')
      }

      if (options.target === 'client' && file === serverEntry) {
        this.error('客户端代码不能导入服务端入口')
      }

      if (
        options.target !== 'client' ||
        !ACTION_MODULE_PATTERN.test(file) ||
        !code.includes('use server')
      ) {
        return null
      }

      if (parseServerActionExports(code, file).length === 0) {
        return null
      }
      if (!isFileInsideRoot(sourceRoot, file)) {
        this.error("'use server' 文件必须位于 src 目录")
      }
      this.error("'use server' 文件必须通过 Action 模块解析")
    },

    async hotUpdate(context) {
      if (
        options.target !== 'client' ||
        this.environment.name !== 'client' ||
        !ACTION_MODULE_PATTERN.test(context.file) ||
        !isFileInsideRoot(sourceRoot, context.file)
      ) {
        return
      }

      const previous = manifest.actions
        .map((action) => action.name)
        .sort()
      await refreshManifest()
      await writeActionTypeDeclarations(root, manifest)
      const current = manifest.actions
        .map((action) => action.name)
        .sort()

      if (previous.join('\0') !== current.join('\0')) {
        this.environment.hot.send({
          type: 'full-reload',
          path: '*',
          triggeredBy: context.file,
        })
        return []
      }

      const actionFile = manifest.actions.some(
        (action) => path.resolve(action.file) === path.resolve(context.file),
      )
      if (actionFile) {
        return []
      }
      return undefined
    },

  }

  return Object.assign(plugin, {
    ministak: {
      getManifest: () => manifest,
      refreshManifest,
    },
  })
}
