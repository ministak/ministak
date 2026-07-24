#!/usr/bin/env node
import path from 'node:path'
import { createProject } from './create.js'

interface CliOptions {
  help: boolean
  install: boolean
  target?: string
}

function parseArguments(args: string[]): CliOptions {
  let help = false
  let install = true
  let optionsEnded = false
  const positional: string[] = []

  for (const argument of args) {
    if (!optionsEnded && argument === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && (argument === '--help' || argument === '-h')) {
      help = true
      continue
    }
    if (!optionsEnded && argument === '--no-install') {
      install = false
      continue
    }
    if (!optionsEnded && argument.startsWith('-')) {
      throw new Error(`未知选项：${argument}`)
    }
    positional.push(argument)
  }

  if (positional.length > 1) {
    throw new Error('只能指定一个项目目录')
  }
  return { help, install, target: positional[0] }
}

function printHelp(): void {
  console.log(`创建 Ministak 项目

用法：
  create-ministak <项目目录> [--no-install]

选项：
  --no-install  跳过 pnpm install
  -h, --help    显示帮助`)
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!options.target) {
    throw new Error('请指定项目目录')
  }

  const created = await createProject({
    cwd: process.cwd(),
    target: options.target,
    install: options.install,
  })
  const relative = path.relative(process.cwd(), created.root) || '.'

  console.log(`\nMinistak 项目创建完成：${created.root}\n`)
  if (relative !== '.') {
    console.log(`  cd ${relative}`)
  }
  if (!options.install) {
    console.log('  pnpm install')
  }
  console.log('  pnpm dev')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
