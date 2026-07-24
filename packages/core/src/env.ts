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

export function resolveEnvironment(
  root: string,
  mode: EnvironmentMode,
  systemEnvironment: NodeJS.ProcessEnv = process.env,
): ResolvedEnvironment {
  const values: NodeJS.ProcessEnv = {}
  const variables = new Map<string, EnvironmentVariable>()

  for (const name of environmentFileNames(mode)) {
    const file = path.join(root, name)
    if (!existsSync(file)) {
      continue
    }

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

  return { values, variables }
}

export function loadServerEnvironment(
  root: string,
  mode: EnvironmentMode,
): void {
  Object.assign(process.env, resolveEnvironment(root, mode).values)
}
