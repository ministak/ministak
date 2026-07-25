import { fork, spawn, type ChildProcess } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createProject } from '../packages/create-ministak/src/create.js'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const coreRoot = path.join(repositoryRoot, 'packages/core')
const creatorRoot = path.join(repositoryRoot, 'packages/create-ministak')
const temporaryDirectories: string[] = []
const children: ChildProcess[] = []

async function expectMinifiedPackage(
  directory: string,
  internalNames: string[],
): Promise<void> {
  const files = await readdir(directory)
  expect(files.some((file) => file.endsWith('.map'))).toBe(false)

  const javascript = files.filter((file) => file.endsWith('.js'))
  expect(javascript.length).toBeGreaterThan(0)
  let output = ''
  for (const file of javascript) {
    const code = await readFile(path.join(directory, file), 'utf8')
    expect(code).not.toContain('sourceMappingURL')
    output += code
  }
  for (const name of internalNames) {
    expect(output).not.toContain(name)
  }
}

async function expectedCoreVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(coreRoot, 'package.json'), 'utf8'),
  ) as { name: string; version: string }
  return `^${packageJson.version}`
}

async function readBuiltTransportId(
  root: string,
  actionName: string,
): Promise<string> {
  const serverCode = await readFile(
    path.join(root, 'dist/server/index.mjs'),
    'utf8',
  )
  const marker = `name: ${JSON.stringify(actionName)}`
  const markerIndex = serverCode.indexOf(marker)
  if (markerIndex < 0) {
    throw new Error(`服务端产物缺少 Action：${actionName}`)
  }
  const prefix = serverCode.slice(Math.max(0, markerIndex - 100), markerIndex)
  const transportId = Array.from(
    prefix.matchAll(/a_[A-Za-z0-9_-]{22}/g),
    (match) => match[0],
  ).at(-1)
  if (!transportId) {
    throw new Error(`服务端产物缺少 Action ID：${actionName}`)
  }
  return transportId
}

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) {
    return value
  }
  return `"${value.replaceAll('"', '""')}"`
}

async function runPnpm(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === 'win32'
        ? (process.env.ComSpec ?? 'cmd.exe')
        : 'pnpm'
    const commandArgs =
      process.platform === 'win32'
        ? [
            '/d',
            '/s',
            '/c',
            ['pnpm', ...args].map(quoteCommandArgument).join(' '),
          ]
        : args
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(output)
        return
      }
      reject(
        new Error(
          `pnpm ${args.join(' ')} 失败，${
            signal ? `信号：${signal}` : `退出码：${code}`
          }\n${output}`,
        ),
      )
    })
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return
  }
  child.send({ type: 'shutdown' })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('创建项目', () => {
  test('npm 包使用压缩代码且不包含源码映射', async () => {
    await expectMinifiedPackage(path.join(coreRoot, 'dist'), [
      'encodeActionArguments',
      'readRpcResponse',
      'registerActionRoute',
      'createServerEntryModule',
    ])
    await expectMinifiedPackage(path.join(creatorRoot, 'dist'), [
      'validateProjectName',
      'copyTemplate',
    ])
  })

  test('复制模板、写入项目名并使用 ministak 依赖', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'create-ministak-'))
    temporaryDirectories.push(root)

    const created = await createProject({
      cwd: root,
      target: 'my-app',
      install: false,
    })
    const packageJson = JSON.parse(
      await readFile(path.join(created.root, 'package.json'), 'utf8'),
    ) as {
      name: string
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }

    expect(packageJson.name).toBe('my-app')
    expect(packageJson.dependencies.ministak).toBe(await expectedCoreVersion())
    expect(packageJson.dependencies['server-only']).toBe('0.0.1')
    expect(packageJson.scripts.inspect).toBe('ministak inspect')
    await expect(
      readFile(path.join(created.root, '.gitignore'), 'utf8'),
    ).resolves.toContain('node_modules/')
    const serverSource = await readFile(
      path.join(created.root, 'src/server.ts'),
      'utf8',
    )
    expect(serverSource).toContain("from 'fastify'")
    expect(serverSource).toContain("from 'ministak/server'")
    expect(serverSource).not.toContain('defineServer')
    expect(await readdir(created.root)).not.toContain('_gitignore')
  })

  test('拒绝覆盖非空目录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'create-ministak-'))
    temporaryDirectories.push(root)
    const target = path.join(root, 'existing')
    await mkdir(target)
    await writeFile(path.join(target, 'keep.txt'), 'keep', 'utf8')

    await expect(
      createProject({ cwd: root, target: 'existing', install: false }),
    ).rejects.toThrow('目标目录不是空目录')
    await expect(
      readFile(path.join(target, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep')
  })

  test('打包后的创建器能生成并构建仓库外项目', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ministak-packed-'))
    temporaryDirectories.push(root)
    const packs = path.join(root, 'packs')
    await mkdir(packs)

    await runPnpm(['pack', '--pack-destination', packs], coreRoot)
    await runPnpm(['pack', '--pack-destination', packs], creatorRoot)
    const tarballs = await readdir(packs)
    const coreTarball = tarballs.find((file) =>
      file.startsWith('ministak-'),
    )
    const creatorTarball = tarballs.find((file) =>
      file.startsWith('create-ministak-'),
    )
    expect(coreTarball).toBeDefined()
    expect(creatorTarball).toBeDefined()

    await runPnpm(
      [
        'dlx',
        path.join(packs, creatorTarball!),
        'packed-app',
        '--no-install',
      ],
      root,
    )

    const projectRoot = path.join(root, 'packed-app')
    const packageFile = path.join(projectRoot, 'package.json')
    const packageJson = JSON.parse(
      await readFile(packageFile, 'utf8'),
    ) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    expect(packageJson.dependencies.ministak).toBe(await expectedCoreVersion())
    expect(packageJson.dependencies['server-only']).toBe('0.0.1')
    expect(packageJson.scripts.inspect).toBe('ministak inspect')
    packageJson.dependencies.ministak = `file:${path.join(packs, coreTarball!).replaceAll('\\', '/')}`
    await writeFile(
      packageFile,
      `${JSON.stringify(packageJson, null, 2)}\n`,
      'utf8',
    )

    await runPnpm(['install'], projectRoot)
    const installedCore = JSON.parse(
      await readFile(
        path.join(projectRoot, 'node_modules/ministak/package.json'),
        'utf8',
      ),
    ) as { name: string }
    expect(installedCore.name).toBe('ministak')
    const installedFiles = await readdir(
      path.join(projectRoot, 'node_modules/ministak'),
    )
    expect(installedFiles).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'README.md',
        'dist',
        'package.json',
      ]),
    )
    expect(installedFiles).not.toEqual(
      expect.arrayContaining(['src', 'tests', 'tsup.config.ts']),
    )
    const installedServerOnly = JSON.parse(
      await readFile(
        path.join(projectRoot, 'node_modules/server-only/package.json'),
        'utf8',
      ),
    ) as { name: string; version: string }
    expect(installedServerOnly).toMatchObject({
      name: 'server-only',
      version: '0.0.1',
    })

    const inspection = await runPnpm(['inspect'], projectRoot)
    expect(inspection).toContain('客户端（会发送给浏览器）')
    expect(inspection).toContain('服务端')
    expect(await readdir(projectRoot)).not.toContain('dist')

    await runPnpm(['typecheck'], projectRoot)
    await runPnpm(['build'], projectRoot)

    const assetDirectory = path.join(projectRoot, 'dist/client/assets')
    const assets = await readdir(assetDirectory)
    const clientCode = (
      await Promise.all(
        assets
          .filter((file) => file.endsWith('.js'))
          .map((file) => readFile(path.join(assetDirectory, file), 'utf8')),
      )
    ).join('\n')
    const transportIds = [
      ...new Set(
        Array.from(
          clientCode.matchAll(/a_[A-Za-z0-9_-]{22}/g),
          (match) => match[0],
        ),
      ),
    ]
    expect(transportIds).toHaveLength(4)

    const entry = path.join(projectRoot, 'dist/server/index.mjs')
    const child = fork(entry, [], {
      cwd: projectRoot,
      env: {
        ...process.env,
        MINISTAK_PORT: '0',
        MINISTAK_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.push(child)
    const address = await new Promise<AddressInfo>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('仓库外项目服务端启动超时')),
        10_000,
      )
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`仓库外项目服务端提前退出：${code}`))
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
    const url = `http://127.0.0.1:${address.port}`

    const getCounterTransportId = await readBuiltTransportId(
      projectRoot,
      'src/actions.ts#getCounter',
    )
    const action = await fetch(`${url}/_actions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-id': getCounterTransportId,
      },
      body: JSON.stringify({ args: [] }),
    })
    expect(action.status).toBe(200)
    await expect(action.json()).resolves.toEqual({ ok: true, data: 0 })
  }, 60_000)
})
