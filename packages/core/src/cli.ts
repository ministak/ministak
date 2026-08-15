#!/usr/bin/env node
import path from 'node:path'
import {
  scanServerActions,
  writeActionTypeDeclarations,
} from './action-scanner.js'
import {
  buildApplication,
  createDevServer,
  inspectApplication,
  startProduction,
  type MinistakDevServer,
} from './dev.js'
import {
  findEnvironmentFiles,
  printLoadedEnvironmentFiles,
} from './env.js'

const [, , command = 'dev', rootArgument = '.'] = process.argv
const root = path.resolve(process.cwd(), rootArgument)

switch (command) {
  case 'types': {
    const manifest = await scanServerActions(root)
    await writeActionTypeDeclarations(root, manifest)
    break
  }
  case 'build': {
    const result = await buildApplication({ root })
    printLoadedEnvironmentFiles(
      'production',
      findEnvironmentFiles(root, 'production'),
    )
    console.log(`构建完成：${result.manifest.actions.length} 个 Server Action`)
    break
  }
  case 'inspect': {
    const report = await inspectApplication({ root })
    printLoadedEnvironmentFiles(
      'production',
      findEnvironmentFiles(root, 'production'),
    )
    console.log(report)
    break
  }
  case 'dev': {
    let server: MinistakDevServer | undefined
    let stopping = false

    const shutdown = async () => {
      if (stopping) {
        return
      }
      stopping = true
      await server?.close()
      process.exit(0)
    }
    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())

    while (!stopping) {
      server = await createDevServer({ root })
      console.log(`开发服务器已启动：${server.url}`)
      await server.waitForRestart()
      if (stopping) {
        break
      }
      console.log('项目配置已变化，正在重启开发服务器')
      await server.close()
      server = undefined
    }
    break
  }
  case 'start': {
    await startProduction(root)
    break
  }
  default:
    throw new Error(`未知命令：${command}`)
}
