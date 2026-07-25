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

客户端构建时，这些函数会被转换成惰性 RPC 请求；服务端仍执行原函数。参数和返回值通过 JSON 传输。

直接等待 Action 时，用法和普通异步函数一致：

```ts
const count = await increment()
```

需要请求状态时，可以先保留本次请求：

```ts
const request = increment()

request.loading // false，请求尚未开始
const count = await request
request.loading // false，请求已经结束
```

`request.loading` 是 Vue 可以追踪的响应式布尔值，只在本次请求执行期间为 `true`。第一次等待请求时才会执行；多次等待同一个请求只执行一次。

也可以把请求状态绑定到页面已有的 Vue ref：

```ts
const loading = ref(false)

async function add() {
  count.value = await increment().bindLoading(loading)
}
```

多个并发请求绑定同一个 ref 时，它会在全部请求结束后恢复为 `false`。

`'use server'` 文件只能导出具名异步函数和 TypeScript 类型，不支持默认导出、重导出、导出变量或同步函数。

## 客户端 Action Hook

可以在客户端统一处理所有 Action 请求：

```ts
// src/main.ts
import {
  ServerActionError,
  setServerActionHooks,
} from 'ministak/client'
import { increment } from './actions'

setServerActionHooks({
  onRequest({ action, args, headers }) {
    headers.set('x-trace-id', crypto.randomUUID())

    if (action === increment) {
      console.log('正在增加计数', args)
    }
  },

  onResponse({ response, data }) {
    console.log(response.status)
    return data
  },

  onError({ error }) {
    if (
      error instanceof ServerActionError &&
      error.status === 401
    ) {
      location.assign('/login')
      return
    }
    throw error
  },
})
```

`onRequest` 可以修改 `args` 和 `headers`。`onResponse` 的返回值会替换 Action 原始结果；`onError` 正常返回表示异常已处理，返回值成为最终结果，抛出异常则继续失败。三个 Hook 都可以是异步函数。

具体 Action 通过函数身份匹配，不依赖生产环境中的传输 ID。重复调用 `setServerActionHooks()` 会替换原配置，不会叠加；不传参数可以清除配置。

全局 Hook 修改结果后，TypeScript 仍保留服务端函数原本的返回类型。返回替代结果时，应保证它与对应 Action 的返回类型兼容。

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

## 环境变量

开发环境依次读取 `.env`、`.env.local`、`.env.development` 和 `.env.development.local`；生产环境依次读取 `.env`、`.env.local`、`.env.production` 和 `.env.production.local`。后面的文件覆盖前面的文件，启动进程中已有的环境变量优先级最高。

服务端通过 `process.env` 读取全部变量。客户端通过 `import.meta.env` 读取变量，只有 `VITE_` 开头的名称会进入客户端，不能用于密钥：

```ts
const databaseUrl = process.env.DATABASE_URL
const apiUrl = import.meta.env.VITE_API_URL
```

`.env.local` 和 `.env.*.local` 默认不会提交，适合存放本机配置。生产环境也可以直接由部署平台注入变量。

修改环境文件后需要重新启动开发服务器。

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
pnpm inspect
pnpm build
pnpm start
```

`pnpm inspect` 使用真实生产构建生成客户端和服务端文件树，但不会写入 `dist`。它还会显示生产环境变量的名称、最终来源、覆盖关系和可见范围，所有变量值都会隐藏。客户端文件树和 `VITE_` 变量就是可能发送给浏览器的边界。

## 许可证

MIT
