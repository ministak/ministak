import { createHmac } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from '@babel/parser'
import type {
  ExportNamedDeclaration,
  FunctionDeclaration,
  Program,
  Statement,
} from '@babel/types'
import fg from 'fast-glob'
import type { ActionDefinition, ActionManifest } from './types.js'

const ACTION_FILES = ['src/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}']
const IGNORE_FILES = [
  '**/*.d.ts',
  '**/node_modules/**',
  '**/dist/**',
  '**/.ministak/**',
]
const ACTION_TYPES_DIRECTORY = '.ministak/action-types'
const MODULE_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/

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

function parseModule(code: string, file: string): Program {
  try {
    return parse(code, {
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
  const program = parseModule(code, file)

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
    if (
      !declaration.id ||
      !declaration.async ||
      declaration.generator
    ) {
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

function relativeModuleSpecifier(
  fromFile: string,
  target: string,
): string {
  const relative = normalizePath(
    path.relative(path.dirname(fromFile), target),
  )
  return relative.startsWith('.') ? relative : `./${relative}`
}

function actionFunctionDeclarations(
  program: Program,
): Map<string, FunctionDeclaration> {
  const declarations = new Map<string, FunctionDeclaration>()
  for (const statement of program.body) {
    if (
      statement.type === 'ExportNamedDeclaration' &&
      statement.declaration?.type === 'FunctionDeclaration' &&
      statement.declaration.id
    ) {
      declarations.set(
        statement.declaration.id.name,
        statement.declaration,
      )
    }
  }
  return declarations
}

export function createActionTypeSource(options: {
  source: string
  sourceFile: string
  generatedFile: string
  actions: readonly ActionDefinition[]
}): string {
  const program = parseModule(options.source, options.sourceFile)
  const declarations = actionFunctionDeclarations(program)
  const target = relativeModuleSpecifier(
    options.generatedFile,
    options.sourceFile,
  ).replace(MODULE_EXTENSION_PATTERN, '')
  const aliases: string[] = []
  const overloads: string[] = []

  options.actions.forEach((action, index) => {
    const declaration = declarations.get(action.exportName)
    if (!declaration) {
      throw new ActionCompileError(
        `找不到 Action ${action.exportName} 的函数声明`,
        options.sourceFile,
      )
    }

    const alias = `__MinistakOriginalAction${index}`
    const typeParameters = declaration.typeParameters
    const typeParameterSource =
      typeParameters &&
      typeof typeParameters.start === 'number' &&
      typeof typeParameters.end === 'number'
        ? options.source.slice(typeParameters.start, typeParameters.end)
        : ''
    const typeArguments =
      typeParameters?.type === 'TSTypeParameterDeclaration'
        ? `<${typeParameters.params
            .map((parameter) => parameter.name)
            .join(', ')}>`
        : ''
    const original = `typeof ${alias}${typeArguments}`

    aliases.push(`const ${alias} = ${action.exportName}`)
    overloads.push(
      `  function ${action.exportName}${typeParameterSource}(`,
      `    ...args: Parameters<${original}>`,
      `  ): __MinistakServerActionRequest<`,
      `    Awaited<ReturnType<${original}>>`,
      '  >',
    )
  })

  return `${options.source.trimEnd()}

import type {
  ServerActionRequest as __MinistakServerActionRequest,
} from 'ministak/client'

${aliases.join('\n')}

declare module ${JSON.stringify(target)} {
${overloads.join('\n')}
}
`
}

async function writeFileIfChanged(
  file: string,
  content: string,
): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) {
      return
    }
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
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

export async function writeActionTypeDeclarations(
  root: string,
  manifest: ActionManifest,
): Promise<string[]> {
  const absoluteRoot = path.resolve(root)
  const directory = path.join(absoluteRoot, ACTION_TYPES_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const actionsByFile = new Map<string, ActionDefinition[]>()
  for (const action of manifest.actions) {
    const actions = actionsByFile.get(action.file)
    if (actions) {
      actions.push(action)
    } else {
      actionsByFile.set(action.file, [action])
    }
  }

  const files: string[] = []
  for (const [sourceFile, actions] of actionsByFile) {
    const relativeFile = normalizePath(
      path.relative(absoluteRoot, sourceFile),
    )
    const extension = /\.[cm]?[jt]sx$/.test(sourceFile) ? '.tsx' : '.ts'
    const generatedFile = path.join(
      directory,
      `${relativeFile}${extension}`,
    )
    const source = await readFile(sourceFile, 'utf8')
    const content = createActionTypeSource({
      source,
      sourceFile,
      generatedFile,
      actions,
    })
    await writeFileIfChanged(generatedFile, content)
    files.push(generatedFile)
  }

  const expected = new Set(files.map((file) => path.resolve(file)))
  const existing = await fg('**/*', {
    cwd: directory,
    absolute: true,
    onlyFiles: true,
    dot: true,
  })
  for (const file of existing) {
    if (!expected.has(path.resolve(file))) {
      await rm(file)
    }
  }
  return files
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
