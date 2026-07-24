# Ministak

Ministak 是一个轻量的 Vue 全栈框架：

```text
Vue 客户端 SPA + Fastify 服务端 + Server Action
```

客户端、服务端和共享 TypeScript 统一放在 `src`，需要服务端能力时直接使用 Server Action 或 Fastify。

## 创建项目

```bash
pnpm create ministak my-app
cd my-app
pnpm dev
```

需要 Node.js 24 或更高版本。

## Server Action

在文件顶部添加 `'use server'`，导出的异步函数就可以从客户端直接调用。

```ts
// src/actions.ts
'use server'

let count = 0

export async function getCount() {
  return count
}

export async function increment() {
  count += 1
  return count
}
```

Vue 组件直接从源码导入，保留 TypeScript 类型检查和源码跳转：

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getCount, increment } from './actions'

const count = ref(0)

onMounted(async () => {
  count.value = await getCount()
})

async function add() {
  count.value = await increment()
}
</script>

<template>
  <button @click="add">{{ count }}</button>
</template>
```

参数和返回值通过 JSON 传输。数据库、文件和私密配置等服务端依赖只会留在服务端构建中。

## 拦截 Server Action

服务端入口直接创建并默认导出 Fastify 实例，可以按照 Fastify 原生方式使用选项、Hook、插件和路由。Action 请求会在 `request.serverAction` 中提供可读的 `相对路径#导出名`：

```ts
// src/server.ts
import Fastify from 'fastify'
import { ActionError } from 'ministak/server'

const app = Fastify()

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

普通请求的 `request.serverAction` 为 `null`。生产环境传输使用不可读的 Action ID，但服务端内部始终使用可读名称匹配。

`app.register()`、`app.decorate()`、`app.setErrorHandler()` 等 API 均为 Fastify 原生行为。服务端入口只负责创建和配置实例，不调用 `app.listen()`；监听、关闭和开发热重启由 Ministak 管理。

请求体大小等服务端设置直接使用 Fastify 实例选项，例如 `Fastify({ bodyLimit: 1024 })`。

## Action 请求上下文

Action 内可以通过 `getActionContext()` 读取当前 Fastify 请求、响应、Action 名称和请求 ID：

```ts
'use server'

import { getActionContext } from 'ministak/server'

export async function getRequestId() {
  const { requestId } = getActionContext()
  return requestId
}
```

## 错误处理

`ActionError` 的消息、错误码和状态码会在开发及生产环境返回客户端；其他异常只记录在服务端，避免泄露内部信息。

客户端收到公开异常时会抛出 `ServerActionError`：

```ts
import { ServerActionError } from 'ministak/client'
```

## 配置与命令

- 框架配置：`ministak.config.*`
- Vite 配置：`vite.config.*`
- 服务端入口：`src/server.ts`，默认导出 Fastify 实例

页面模式使用 Vite 原生 `appType`，默认值为 `spa`：

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'spa',
})
```

- `spa`：页面地址未命中时返回 `index.html`。
- `mpa`：只提供实际存在的页面，未命中返回 404。
- `custom`：当前不支持，配置后会直接报错。

项目根目录、构建输出目录和服务端构建入口由 Ministak 管理；Vite 配置显式设置冲突值时会直接提示，不会静默覆盖。

```bash
pnpm dev
pnpm build
pnpm start
```

生产构建输出客户端静态资源和独立的 Fastify 服务端程序。

## 许可证

MIT
