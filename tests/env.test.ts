import {
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  environmentFileNames,
  findEnvironmentFiles,
  printLoadedEnvironmentFiles,
  resolveEnvironment,
} from '../packages/core/src/env.js'

const testRoot = path.resolve('.test-environment')

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(testRoot, { recursive: true, force: true })
})

describe('环境变量', () => {
  test('只提供开发和生产两组文件', () => {
    expect(environmentFileNames('development')).toEqual([
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
    ])
    expect(environmentFileNames('production')).toEqual([
      '.env',
      '.env.local',
      '.env.production',
      '.env.production.local',
    ])
  })

  test('按文件顺序加载且系统环境变量优先', async () => {
    await mkdir(testRoot, { recursive: true })
    await writeFile(
      path.join(testRoot, '.env'),
      'SHARED=base\nBASE_ONLY=base\n',
      'utf8',
    )
    await writeFile(
      path.join(testRoot, '.env.local'),
      'SHARED=local\n',
      'utf8',
    )
    await writeFile(
      path.join(testRoot, '.env.production'),
      'SHARED=production\n',
      'utf8',
    )
    await writeFile(
      path.join(testRoot, '.env.production.local'),
      'SHARED=production-local\n',
      'utf8',
    )

    const environment = resolveEnvironment(
      testRoot,
      'production',
      {
        SHARED: 'system',
        SYSTEM_ONLY: 'system',
      },
    )

    expect(environment.values).toMatchObject({
      SHARED: 'system',
      BASE_ONLY: 'base',
      SYSTEM_ONLY: 'system',
    })
    expect(environment.variables.get('SHARED')).toEqual({
      value: 'system',
      source: '系统环境变量',
      sources: [
        '.env',
        '.env.local',
        '.env.production',
        '.env.production.local',
        '系统环境变量',
      ],
    })
    expect(environment.files).toEqual([
      '.env',
      '.env.local',
      '.env.production',
      '.env.production.local',
    ])
  })

  test('打印实际加载的环境变量文件', async () => {
    await mkdir(testRoot, { recursive: true })
    await writeFile(path.join(testRoot, '.env'), 'BASE=base\n', 'utf8')
    await writeFile(
      path.join(testRoot, '.env.development.local'),
      'LOCAL=local\n',
      'utf8',
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const files = findEnvironmentFiles(testRoot, 'development')

    printLoadedEnvironmentFiles('development', files)

    expect(files).toEqual(['.env', '.env.development.local'])
    expect(log).toHaveBeenCalledWith(
      '已加载环境变量文件（development）：.env → .env.development.local',
    )

    printLoadedEnvironmentFiles('production', [])
    expect(log).toHaveBeenLastCalledWith(
      '未找到可加载的环境变量文件（production）',
    )
  })
})
