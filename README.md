# Ministak

Ministak 是一个轻量的 Vue 全栈框架：

```text
Vue 客户端 SPA + Fastify 服务端 + Server Action
```

Vue 和 Vite 负责浏览器应用，Fastify 负责服务端，Server Action 连接两端。框架不包装 Vue，也不隐藏 Fastify 实例，可以继续使用它们的原生 API。

## 快速开始

```bash
pnpm create ministak my-app
cd my-app
pnpm dev
```

客户端、服务端和共享 TypeScript 统一放在 `src`，运行位置由入口和依赖关系决定：

- Vue 组件和 `src/main.ts` 的依赖运行在客户端。
- `'use server'` 文件是 Server Action。
- `src/server.ts` 是服务端入口。
- 普通模块可以由客户端、服务端或两端共享。
- `server-only` 用于明确禁止模块进入客户端。

## Server Action

在文件顶部添加 `'use server'`，客户端便可以直接导入并调用其中的具名异步函数：

```ts
// src/actions.ts
'use server'

import { getActionContext } from 'ministak/server'

let count = 0

export async function login() {
  const { reply } = getActionContext()
  reply.header(
    'set-cookie',
    'session=logged-in; Path=/; HttpOnly; SameSite=Lax',
  )
}

export async function increment() {
  count += 1
  return count
}
```

客户端仍从真实源码导入，保留 TypeScript 类型检查和源码跳转：

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { ServerActionError } from 'ministak/client'
import { increment, login } from './actions'

const count = ref<number | null>(null)
const message = ref('')

async function handleLogin() {
  await login()
  message.value = '已登录'
}

async function add() {
  try {
    count.value = await increment()
    message.value = ''
  } catch (error) {
    if (error instanceof ServerActionError) {
      message.value = error.message
      return
    }
    throw error
  }
}
</script>

<template>
  <p>{{ count }}</p>
  <button @click="handleLogin">登录</button>
  <button @click="add">+1</button>
  <p>{{ message }}</p>
</template>
```

客户端构建时，这些函数会被转换成异步 RPC 调用；服务端仍执行原函数。参数和返回值通过 JSON 传输。

`'use server'` 文件只能导出具名异步函数和 TypeScript 类型，不支持默认导出、重导出、导出变量或同步函数。

## Fastify 和 Action 鉴权

`src/server.ts` 直接创建并默认导出 Fastify 实例。选项、Hook、插件、装饰器、错误处理和普通路由都使用 Fastify 原生 API：

```ts
// src/server.ts
import Fastify from 'fastify'
import { ActionError } from 'ministak/server'

const app = Fastify({
  bodyLimit: 1024 * 1024,
})

app.addHook('onRequest', async (request) => {
  if (request.serverAction?.name !== 'src/actions.ts#increment') {
    return
  }

  const loggedIn = request.headers.cookie
    ?.split(';')
    .some((cookie) => cookie.trim() === 'session=logged-in')

  if (!loggedIn) {
    throw new ActionError('请先登录', {
      code: 'UNAUTHORIZED',
      status: 401,
    })
  }
})

app.get('/api/health', async () => ({ ok: true }))

export default app
```

Action 请求的 `request.serverAction.name` 始终是可读的 `项目相对路径#导出名`，例如 `src/actions.ts#increment`。可以精确匹配一个 Action，也可以使用 `startsWith()` 按目录或文件统一处理。普通请求的 `request.serverAction` 为 `null`。

服务端入口不调用 `app.listen()`；监听、关闭和开发热重启由 Ministak 管理。

## Action 请求上下文

Action 内可以通过 `getActionContext()` 取得当前 Fastify 的 `request`、`reply`，以及 `actionName` 和 `requestId`。上面的 `login()` 就是通过它设置 Cookie。

## 服务端专用模块

数据库连接、文件系统和私密配置等模块可以使用 `server-only`：

```ts
// src/database.ts
import 'server-only'

export const databaseUrl = process.env.DATABASE_URL
```

客户端依赖链触及该模块时，Ministak 会直接报错。Action 模块及其服务端依赖不会进入客户端产物。

## 错误处理

需要公开给客户端的业务异常使用 `ActionError`。客户端会收到 `ServerActionError`，其中包含 `message`、`code`、`status` 和 `requestId`。

其他异常只记录在服务端日志中，客户端统一收到 `INTERNAL_ERROR`，避免泄露堆栈、数据库信息或密钥。不要使用 `ActionError` 包装不应公开的内部异常。

所有 Action 都应视为可以被外部请求调用。生产环境使用不可读的传输 ID，但它不是权限机制；鉴权和参数校验必须在服务端完成。

## 配置

```ts
// ministak.config.ts
import { defineConfig } from 'ministak'

export default defineConfig({
  serverEntry: 'src/server.ts',
  outDir: 'dist',
  actionPath: '/_actions',
})
```

这些都是默认值，通常不需要创建配置文件。Vite 配置继续使用原生 `vite.config.*`：

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/app/',
  appType: 'spa',
})
```

`appType` 支持 `spa` 和 `mpa`。`spa` 由 Ministak 处理页面回退；需要 Fastify 自定义 NotFoundHandler 时使用 `mpa`。其他非冲突配置继续使用 Vite 原生方式。

```bash
pnpm dev
pnpm build
pnpm start
```

## 许可证

MIT
