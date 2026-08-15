import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'

export type EnvironmentMode = 'development' | 'production'

export interface EnvironmentVariable {
  value: string
  source: string
  sources: string[]
}

export interface ResolvedEnvironment {
  values: NodeJS.ProcessEnv
  variables: Map<string, EnvironmentVariable>
  files: string[]
}

export function environmentFileNames(
  mode: EnvironmentMode,
): string[] {
  return [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`,
  ]
}

export function findEnvironmentFiles(
  root: string,
  mode: EnvironmentMode,
): string[] {
  return environmentFileNames(mode).filter((name) =>
    existsSync(path.join(root, name)),
  )
}

export function printLoadedEnvironmentFiles(
  mode: EnvironmentMode,
  files: string[],
): void {
  if (files.length === 0) {
    console.log(`未找到可加载的环境变量文件（${mode}）`)
    return
  }
  console.log(
    `已加载环境变量文件（${mode}）：${files.join(' → ')}`,
  )
}

export function resolveEnvironment(
  root: string,
  mode: EnvironmentMode,
  systemEnvironment: NodeJS.ProcessEnv = process.env,
): ResolvedEnvironment {
  const values: NodeJS.ProcessEnv = {}
  const variables = new Map<string, EnvironmentVariable>()
  const files = findEnvironmentFiles(root, mode)

  for (const name of files) {
    const file = path.join(root, name)
    const parsed = parseEnv(readFileSync(file, 'utf8'))
    for (const [variableName, value] of Object.entries(parsed)) {
      if (value === undefined) {
        continue
      }
      const previous = variables.get(variableName)
      values[variableName] = value
      variables.set(variableName, {
        value,
        source: name,
        sources: [...(previous?.sources ?? []), name],
      })
    }
  }

  for (const [name, value] of Object.entries(systemEnvironment)) {
    if (value === undefined) {
      continue
    }
    const previous = variables.get(name)
    values[name] = value
    variables.set(name, {
      value,
      source: '系统环境变量',
      sources: [...(previous?.sources ?? []), '系统环境变量'],
    })
  }

  return { values, variables, files }
}

export function loadServerEnvironment(
  root: string,
  mode: EnvironmentMode,
): void {
  const environment = resolveEnvironment(root, mode)
  Object.assign(process.env, environment.values)
  printLoadedEnvironmentFiles(mode, environment.files)
}
