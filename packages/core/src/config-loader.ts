import { access } from 'node:fs/promises'
import path from 'node:path'
import {
  loadConfigFromFile,
  type ConfigEnv,
  type UserConfig,
} from 'vite'
import type { MinistakConfig } from './config.js'

const CONFIG_FILES = [
  'ministak.config.js',
  'ministak.config.mjs',
  'ministak.config.ts',
  'ministak.config.cjs',
  'ministak.config.mts',
  'ministak.config.cts',
]

export const PROJECT_CONFIG_FILES = new Set([
  ...CONFIG_FILES,
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
])

export interface ResolvedMinistakConfig {
  root: string
  configFile?: string
  dependencies: string[]
  serverEntry: string
  outDir: string
  actionPath: string
  bodyLimit?: number
  spaFallback: boolean
}

export interface LoadedViteConfig {
  config: UserConfig
  configFile?: string
  dependencies: string[]
}

async function findFrameworkConfig(root: string): Promise<string | undefined> {
  for (const name of CONFIG_FILES) {
    const file = path.join(root, name)
    try {
      await access(file)
      return file
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
    }
  }
  return undefined
}

function assertInsideRoot(root: string, file: string, name: string): void {
  const relative = path.relative(root, file)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${name} 必须位于项目根目录内部`)
  }
}

function resolveActionPath(value: string | undefined): string {
  const actionPath = value ?? '/_actions'
  if (
    !actionPath.startsWith('/') ||
    actionPath === '/' ||
    actionPath.endsWith('/') ||
    actionPath.includes('?') ||
    actionPath.includes('#')
  ) {
    throw new Error(
      'actionPath 必须是以 / 开头且不以 / 结尾的绝对 URL 路径',
    )
  }
  return actionPath
}

export async function loadMinistakConfig(
  root: string,
  env: ConfigEnv,
): Promise<ResolvedMinistakConfig> {
  const absoluteRoot = path.resolve(root)
  const configFile = await findFrameworkConfig(absoluteRoot)
  let config: MinistakConfig = {}
  let dependencies: string[] = []

  if (configFile) {
    const loaded = await loadConfigFromFile(env, configFile, absoluteRoot)
    if (!loaded || !loaded.config || typeof loaded.config !== 'object') {
      throw new Error(`无法加载框架配置：${configFile}`)
    }
    config = loaded.config as MinistakConfig
    dependencies = loaded.dependencies
  }

  const serverEntry = path.resolve(
    absoluteRoot,
    config.serverEntry ?? 'src/server.ts',
  )
  const outDir = path.resolve(absoluteRoot, config.outDir ?? 'dist')
  assertInsideRoot(absoluteRoot, serverEntry, 'serverEntry')
  assertInsideRoot(absoluteRoot, outDir, 'outDir')

  return {
    root: absoluteRoot,
    configFile,
    dependencies: [...new Set([...(configFile ? [configFile] : []), ...dependencies])],
    serverEntry,
    outDir,
    actionPath: resolveActionPath(config.actionPath),
    bodyLimit: config.actions?.bodyLimit,
    spaFallback: config.spaFallback ?? true,
  }
}

export async function loadUserViteConfig(
  root: string,
  env: ConfigEnv,
): Promise<LoadedViteConfig> {
  const loaded = await loadConfigFromFile(env, undefined, root)
  if (!loaded) {
    return { config: {}, dependencies: [] }
  }
  return {
    config: loaded.config,
    configFile: loaded.path,
    dependencies: [...new Set([loaded.path, ...loaded.dependencies])],
  }
}
