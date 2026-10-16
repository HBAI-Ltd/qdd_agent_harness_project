# qdd_agent_harness_project

Aidol 创造营参赛项目——钱多多门店人工智能助手。

基于 Node.js、TypeScript 和 npm workspaces 的 monorepo。

## 环境

- Node.js 24 或更高版本（当前验证版本：24.15.0）
- npm 11 或更高版本（当前验证版本：11.12.1）

## 快速开始

在仓库根目录执行：

```powershell
npm ci
npm run dev
```

默认监听 `http://127.0.0.1:3000`，健康检查地址为 `http://127.0.0.1:3000/health`。

如需修改监听地址或端口，将 `.env.example` 复制为根目录下的 `.env` 后调整配置。

```powershell
Copy-Item .env.example .env
```

## 目录结构

```text
apps/
  server/             Node.js HTTP 服务入口
packages/
  shared/             应用间共享的类型和常量
package.json          workspace 定义与根命令
tsconfig.base.json    共享 TypeScript 配置
tsconfig.json         各 workspace 的构建依赖
tsconfig.check.json   无产物的全仓类型检查
```

`apps/server` 通过包名 `@qdd/shared` 引用共享包。TypeScript project references 保证构建时先处理共享包，再处理应用。新增 workspace 时，需要同步维护根目录的构建 references；新增共享包时，也需要在 `tsconfig.check.json` 的 `paths` 中添加对应映射。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 首次构建后监听 TypeScript 修改，并自动重启服务；修改共享包也会触发重启 |
| `npm run build` | 按依赖顺序编译，产物位于各 workspace 的 `dist/` |
| `npm run typecheck` | 检查全部应用及共享包，不生成产物 |
| `npm start` | 启动编译后的服务，需先执行构建 |
| `npm run clean` | 清理 TypeScript 构建产物及增量构建信息 |

部署时在仓库根目录安装依赖、构建并启动：

```powershell
npm ci
npm run build
npm start
```

当前仅包含服务骨架和健康检查，业务功能尚未实现。仓库通过 [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) 管理本地包依赖。
