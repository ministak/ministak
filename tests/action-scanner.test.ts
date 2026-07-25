import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ActionCompileError,
  createActionName,
  createActionTransportId,
  createActionTypeSource,
  parseServerActionExports,
  scanServerActions,
} from '../packages/core/src/action-scanner.js'
import {
  createActionProxyModule,
  createMinistakPlugin,
} from '../packages/core/src/vite.js'

const temporaryDirectories: string[] = []
const transportKey = 'test-transport-key'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('Server Action 编译扫描', () => {
  test('只收集 use server 文件中的具名异步函数', () => {
    const code = `
      'use server'
      export interface Input { name: string }
      export type Result = { ok: true }
      export async function createUser(input: Input): Promise<Result> {
        return { ok: true }
      }
    `

    expect(parseServerActionExports(code, 'user.ts')).toEqual(['createUser'])
  })

  test.each([
    ["'use server'; export default async function run() {}", '默认导出'],
    ["'use server'; export const run = async () => {}", '具名异步函数'],
    ["'use server'; export function run() {}", '具名异步函数'],
    ["'use server'; export { run } from './run'", '重导出'],
  ])('拒绝不受支持的导出：%s', (code, message) => {
    expect(() => parseServerActionExports(code, 'invalid.ts')).toThrowError(
      new RegExp(message),
    )
  })

  test('扫描结果分离内部名称和公开传输 ID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ministak-actions-'))
    temporaryDirectories.push(root)
    const sourceDirectory = path.join(root, 'src')
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(
      path.join(sourceDirectory, 'user.ts'),
      "'use server'\nexport async function createUser() { return true }\n",
      'utf8',
    )

    const manifest = await scanServerActions(root)
    expect(manifest.actions).toHaveLength(1)
    const action = manifest.actions[0]
    expect(action.name).toBe(
      createActionName('src/user.ts', 'createUser'),
    )
    const transportId = createActionTransportId(transportKey, action.name)
    expect(transportId).toMatch(/^a_[A-Za-z0-9_-]{22}$/)
    expect(transportId).not.toContain(action.name)

    const proxy = createActionProxyModule(
      manifest.actions,
      '/_actions',
      transportKey,
    )
    expect(proxy).toContain(transportId)
    expect(proxy).not.toContain(action.name)
    expect(proxy).toContain('createServerReference')
    expect(proxy).not.toContain('return true')
  })

  test('开发环境直接使用内部名称作为传输 ID', () => {
    const action = {
      name: createActionName('src/user.ts', 'createUser'),
      file: 'src/user.ts',
      relativeFile: 'src/user.ts',
      exportName: 'createUser',
    }
    const proxy = createActionProxyModule(
      [action],
      '/_actions',
      transportKey,
      true,
    )

    expect(proxy).toContain(JSON.stringify(action.name))
    expect(proxy).not.toContain(
      createActionTransportId(transportKey, action.name),
    )
  })

  test('生成保留泛型和相对导入的 Action 请求类型', () => {
    const root = path.resolve('project')
    const sourceFile = path.join(root, 'src/actions.ts')
    const generatedFile = path.join(
      root,
      '.ministak/action-types/src/actions.ts.ts',
    )
    const source = `
import type { Input } from './types'

type Allowed = string | number

export async function save<T extends Allowed>(input: Input<T>) {
  return input.value
}
`
    const output = createActionTypeSource({
      source,
      sourceFile,
      generatedFile,
      actions: [
        {
          name: 'src/actions.ts#save',
          file: sourceFile,
          relativeFile: 'src/actions.ts',
          exportName: 'save',
        },
      ],
    })

    expect(output).toContain("from './types'")
    expect(output).toContain(
      'declare module "../../../src/actions"',
    )
    expect(output).toContain(
      'function save<T extends Allowed>(',
    )
    expect(output).toContain(
      'Parameters<typeof __MinistakOriginalAction0<T>>',
    )
  })

  test('解析错误包含源文件信息', () => {
    expect(() =>
      parseServerActionExports("'use server'; export const =", 'broken.ts'),
    ).toThrow(ActionCompileError)
  })

  test('只扫描 src 目录中的 Action', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ministak-scope-'))
    temporaryDirectories.push(root)
    await mkdir(path.join(root, 'src'), { recursive: true })
    const action =
      "'use server'\nexport async function run() { return true }\n"
    await writeFile(path.join(root, 'src/action.ts'), action, 'utf8')
    await writeFile(path.join(root, 'fixture.ts'), action, 'utf8')

    const manifest = await scanServerActions(root)
    expect(manifest.actions).toHaveLength(1)
    expect(manifest.actions[0].relativeFile).toBe('src/action.ts')
  })

  test('内部名称由相对路径和导出名称组成', () => {
    expect(createActionName('src/user.ts', 'createUser')).toBe(
      'src/user.ts#createUser',
    )
    expect(createActionName('src/用户.ts', '创建用户')).toBe(
      'src/用户.ts#创建用户',
    )
  })

  test('不同传输密钥生成不同的公开 ID', () => {
    const name = createActionName('src/user.ts', 'createUser')
    expect(createActionTransportId('first', name)).not.toBe(
      createActionTransportId('second', name),
    )
  })

  test.each(['create', 'update', 'delete'] as const)(
    'Action 导出未变化时过滤 Vite 8 的 %s 热更新事件',
    async (type) => {
      const root = await mkdtemp(path.join(tmpdir(), 'ministak-hmr-'))
      temporaryDirectories.push(root)
      await mkdir(path.join(root, 'src'), { recursive: true })
      const file = path.join(root, 'src/action.ts')
      const code =
        "'use server'\nexport async function run() { return true }\n"
      await writeFile(file, code, 'utf8')

      const plugin = createMinistakPlugin({
        root,
        target: 'client',
        transportKey,
        actionPath: '/_actions',
        development: true,
      })
      await plugin.ministak.refreshManifest()

      expect(plugin.handleHotUpdate).toBeUndefined()
      const hotUpdate = plugin.hotUpdate
      if (typeof hotUpdate !== 'function') {
        throw new Error('客户端插件没有注册 Vite 8 hotUpdate 钩子')
      }

      const send = vi.fn()
      const result = await hotUpdate.call(
        { environment: { name: 'client', hot: { send } } } as never,
        {
          type,
          file: file.replaceAll('\\', '/'),
          timestamp: Date.now(),
          modules: [],
          read: () => code,
          server: {},
        } as never,
      )

      expect(result).toEqual([])
      expect(send).not.toHaveBeenCalled()
    },
  )
})
