# Ministak

Ministak 是一个轻量的 Vue 全栈框架，组合 Vue 客户端 SPA、Fastify 服务端与 Server Action。

## 安装

```bash
pnpm add ministak
```

```ts
import { defineConfig } from 'ministak'
import { defineServer } from 'ministak/server'
```

## 公开异常

`ActionError` 的消息在开发和生产环境都会返回给客户端，普通异常只记录在服务端：

```ts
import { ActionError } from 'ministak/server'

throw new ActionError('操作失败')

throw new ActionError('请先登录', {
  code: 'UNAUTHORIZED',
  status: 401,
})
```

## 命令

```text
ministak dev [root]
ministak build [root]
ministak start [root]
```

需要 Node.js 24 或更高版本。
