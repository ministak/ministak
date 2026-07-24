import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from '@babel/parser'
import type { ExportNamedDeclaration, Statement } from '@babel/types'
import fg from 'fast-glob'
import type { ActionDefinition, ActionManifest } from './types.js'

const ACTION_FILES = ['src/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}']
const IGNORE_FILES = [
  '**/*.d.ts',
  '**/node_modules/**',
  '**/dist/**',
  '**/.ministak/**',
]

export class ActionCompileError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${message}\n文件：${file}`)
    this.name = 'ActionCompileError'
  }
}

function normalizePath(file: string): string {
  return file.replaceAll('\\', '/')
}

function isTypeOnlyExport(node: ExportNamedDeclaration): boolean {
  if (node.exportKind === 'type') {
    return true
  }

  if (node.declaration) {
    return (
      node.declaration.type === 'TSInterfaceDeclaration' ||
      node.declaration.type === 'TSTypeAliasDeclaration' ||
      node.declaration.type === 'TSDeclareFunction'
    )
  }

  return (
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) =>
        specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type',
    )
  )
}

export function parseServerActionExports(code: string, file: string): string[] {
  let program
  try {
    program = parse(code, {
      sourceType: 'module',
      sourceFilename: file,
      plugins: [
        'typescript',
        'jsx',
        'decorators-legacy',
        'importAttributes',
        'explicitResourceManagement',
      ],
    }).program
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ActionCompileError(`无法解析模块：${message}`, file)
  }

  const isServerActionModule = program.directives.some(
    (directive) => directive.value.value === 'use server',
  )
  if (!isServerActionModule) {
    return []
  }

  const exports: string[] = []
  for (const statement of program.body as Statement[]) {
    if (statement.type === 'ExportDefaultDeclaration') {
      throw new ActionCompileError(
        "'use server' 文件不支持默认导出，请使用具名异步函数",
        file,
      )
    }

    if (statement.type === 'ExportAllDeclaration') {
      throw new ActionCompileError(
        "'use server' 文件不支持 export *",
        file,
      )
    }

    if (statement.type !== 'ExportNamedDeclaration') {
      continue
    }

    if (isTypeOnlyExport(statement)) {
      continue
    }

    if (!statement.declaration) {
      throw new ActionCompileError(
        "'use server' 文件不支持重导出或导出别名",
        file,
      )
    }

    if (statement.declaration.type !== 'FunctionDeclaration') {
      throw new ActionCompileError(
        "'use server' 文件只能导出具名异步函数",
        file,
      )
    }

    const declaration = statement.declaration
    if (!declaration.id || !declaration.async) {
      throw new ActionCompileError(
        "'use server' 文件只能导出具名异步函数",
        file,
      )
    }
    exports.push(declaration.id.name)
  }

  if (exports.length === 0) {
    throw new ActionCompileError(
      "'use server' 文件至少需要导出一个异步函数",
      file,
    )
  }

  return exports
}

export function createActionName(
  relativeFile: string,
  exportName: string,
): string {
  return `${normalizePath(relativeFile)}#${exportName}`
}

export function createActionTransportId(
  transportKey: string,
  actionName: string,
): string {
  const digest = createHmac('sha256', transportKey)
    .update(actionName)
    .digest('base64url')
    .slice(0, 22)
  return `a_${digest}`
}

export async function scanServerActions(
  root: string,
): Promise<ActionManifest> {
  const absoluteRoot = path.resolve(root)
  const files = await fg(ACTION_FILES, {
    cwd: absoluteRoot,
    absolute: true,
    onlyFiles: true,
    ignore: IGNORE_FILES,
  })

  const actions: ActionDefinition[] = []
  for (const file of files.sort()) {
    const code = await readFile(file, 'utf8')
    if (!code.includes('use server')) {
      continue
    }

    const exportNames = parseServerActionExports(code, file)
    const relativeFile = normalizePath(path.relative(absoluteRoot, file))
    for (const exportName of exportNames) {
      const name = createActionName(relativeFile, exportName)
      actions.push({
        name,
        file: path.resolve(file),
        relativeFile,
        exportName,
      })
    }
  }

  return { actions }
}
