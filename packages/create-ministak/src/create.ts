import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const templateRoot = fileURLToPath(new URL('../template/', import.meta.url))

export interface CreateProjectOptions {
  cwd: string
  target: string
  install: boolean
}

export interface CreatedProject {
  name: string
  root: string
}

function validateProjectName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(
      '项目目录名只能包含小写字母、数字、点、连字符和下划线',
    )
  }
}

async function copyTemplate(targetRoot: string): Promise<void> {
  const entries = await readdir(templateRoot, { withFileTypes: true })
  for (const entry of entries) {
    await cp(
      path.join(templateRoot, entry.name),
      path.join(targetRoot, entry.name),
      { recursive: true, errorOnExist: true, force: false },
    )
  }

  await rename(
    path.join(targetRoot, '_gitignore'),
    path.join(targetRoot, '.gitignore'),
  )
}

async function writeProjectPackage(targetRoot: string, name: string) {
  const packageFile = path.join(targetRoot, 'package.json')
  const packageJson = JSON.parse(
    await readFile(packageFile, 'utf8'),
  ) as Record<string, unknown>
  packageJson.name = name
  await writeFile(
    packageFile,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  )
}

async function installDependencies(root: string): Promise<void> {
  const command =
    process.platform === 'win32'
      ? (process.env.ComSpec ?? 'cmd.exe')
      : 'pnpm'
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm install']
      : ['install']
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          signal
            ? `pnpm install 被信号 ${signal} 终止`
            : `pnpm install 失败，退出码：${code}`,
        ),
      )
    })
  })
}

export async function createProject(
  options: CreateProjectOptions,
): Promise<CreatedProject> {
  const root = path.resolve(options.cwd, options.target)
  const name = path.basename(root)
  validateProjectName(name)

  await mkdir(root, { recursive: true })
  const existing = await readdir(root)
  if (existing.length > 0) {
    throw new Error(`目标目录不是空目录：${root}`)
  }

  await copyTemplate(root)
  await writeProjectPackage(root, name)

  if (options.install) {
    await installDependencies(root)
  }

  return { name, root }
}
