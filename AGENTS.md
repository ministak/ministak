# AGENTS.md

## 项目概述

Ministak 是一个轻量的 Vue 全栈框架：

```text
Vue 客户端 SPA + Node/Fastify 服务端 + Server Action
```

框架连接 Vue、Vite、Fastify 和 Node，提供前后端构建、运行环境边界、Server Action、开发热更新与生产启动。应用可以直接使用这些生态的原生能力继续扩展。

实现时保持最简，不要过度设计。

## 核心能力

- Vue 作为纯客户端 SPA 运行。
- 应用直接创建并导出 Fastify 实例，可以使用原生选项、Hook、插件和路由。
- 文件级 `'use server'` 声明可远程调用的异步函数。
- 客户端从真实源码导入 Server Action，保留 TypeScript 类型检查和源码跳转。
- 开发环境使用可读的 `相对路径#导出名` 作为 Action ID，生产环境使用不透明的 Action ID。
- 客户端与服务端通过标准 JSON RPC 通信。
- 客户端可以统一拦截 Action 请求、响应和异常。
- 客户端 Action 在首次等待时执行，每次请求提供响应式 `loading` 状态，并可绑定到 Vue ref。
- 客户端、服务端和共享 TypeScript 统一放在 `src`，由入口与依赖图决定运行位置。
- `server-only` 显式标记服务端专有依赖，构建时阻止其进入客户端。
- 开发模式同时提供 Vue HMR 和服务端热重建，并通过一个公开端口访问。
- 生产模式分别生成客户端静态资源和服务端程序。
- `pnpm create ministak` 可创建独立项目，源码仍使用 `ministak` 导入。

## 代码边界

```text
.vue / src/main.ts  -> 客户端
'use server'        -> Server Action
server-only         -> 服务端专有模块
普通 .ts            -> 客户端、服务端或两端共享
src/server.ts       -> 默认导出 Fastify 实例
```

Fastify Hook 可以通过 `request.serverAction?.name` 匹配 Action。Action 内可以通过 `getActionContext()` 访问当前请求上下文。通用请求处理使用 Fastify Hook，具体权限由 Action 内的应用函数显式检查。

可公开的业务异常使用 `ActionError`，开发和生产环境都会原样返回；其他异常仅写入服务端日志并向客户端隐藏具体信息。

## 配置与运行

- 框架配置使用 `ministak.config.*`。
- Vite 配置继续使用原生 `vite.config.*`。
- 页面模式由 Vite `appType` 统一控制，支持 `spa` 和 `mpa`。
- Fastify 实例由服务端入口直接创建并默认导出，入口不调用 `listen()`。
- Fastify 实例选项、Hook、插件和路由使用原生 API。
- 框架必须接管的 Vite 配置发生冲突时直接报错，不静默覆盖。
- 客户端环境变量使用 `VITE_` 前缀，服务端环境变量通过 `process.env` 读取。

开发模式由 Vite 主进程管理客户端 HMR、Fastify 请求转发和 Fastify 子进程。生产构建输出：

```text
dist/client  -> Vue SPA 静态资源
dist/server  -> Fastify、Action 和服务端依赖
```

## 文件地图

以下是仓库维护文件的职责，依赖和构建产物不展开：

```text
.
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ index.ts              公共入口
│  │  │  ├─ config.ts             框架配置类型
│  │  │  ├─ config-loader.ts      配置加载
│  │  │  ├─ env.ts                服务端环境变量加载
│  │  │  ├─ types.ts              共享类型
│  │  │  ├─ action-scanner.ts     Action 扫描、校验与请求类型生成
│  │  │  ├─ client.ts             浏览器 RPC 客户端
│  │  │  ├─ server.ts             Fastify 服务端运行时
│  │  │  ├─ routing.ts            开发与生产共享的请求路由规则
│  │  │  ├─ vite.ts               Vite 转换与代码边界
│  │  │  ├─ dev.ts                构建、开发服务与生产启动
│  │  │  └─ cli.ts                命令行入口
│  │  ├─ package.json             核心包定义
│  │  └─ tsup.config.ts           核心包构建配置
│  ├─ create-ministak/
│  │  ├─ src/
│  │  │  ├─ create.ts             模板复制、项目生成与依赖安装
│  │  │  └─ cli.ts                创建项目命令行入口
│  │  ├─ template/                 独立项目基础模板
│  │  ├─ package.json             创建器包定义
│  │  └─ tsup.config.ts           创建器构建配置
├─ examples/basic/
│  ├─ src/
│  │  ├─ App.vue                  登录与计数器示例页面
│  │  ├─ actions.ts               登录、退出与计数器 Action
│  │  ├─ main.ts                  Vue 入口
│  │  └─ server.ts                Fastify Action 鉴权
│  ├─ index.html                  HTML 入口
│  └─ package.json                示例包定义
├─ tests/
│  ├─ typecheck/
│  │  └─ server-action.vue        Action 类型测试夹具
│  ├─ action-scanner.test.ts      Action 编译测试
│  ├─ client.test.ts              RPC 客户端测试
│  ├─ create-ministak.test.ts      创建器与仓库外安装测试
│  ├─ env.test.ts                 环境变量加载测试
│  ├─ server.test.ts              Fastify 运行时测试
│  └─ integration.test.ts         构建与热更新集成测试
├─ AGENTS.md                      项目概览和接手入口
├─ README.md                      项目使用说明
├─ LICENSE                        MIT 许可证
├─ package.json                   工作区命令和依赖
├─ pnpm-workspace.yaml            工作区范围
├─ pnpm-lock.yaml                 依赖锁定
├─ tsconfig.json                  TypeScript 配置
├─ vitest.config.ts               测试配置
└─ .gitignore                     Git 忽略规则
```

## 常用命令

统一使用 pnpm：

```text
pnpm install
pnpm dev
pnpm inspect
pnpm typecheck
pnpm test
pnpm build
pnpm start
```
