# ADR-0001：npm workspace 与分层运行架构

| 项目 | 内容                     |
| ---- | ------------------------ |
| 状态 | Accepted                 |
| 日期 | 2026-08-30               |
| 关联 | TRD 3、9、11；计划 M0-M5 |

## 背景

产品需要 Node 命令、HTTP API、Web UI 和 Electron，且必须共享 `.pulse`
领域结果。仓库尚无依赖，当前最重要的是建立最少的稳定边界，而不是引入任务编排平台或大量空包。

## 决策

采用单仓库 npm workspaces、TypeScript strict、ES modules 和单一根 lockfile。M0 固定 Node.js 24
LTS；运行时或 Electron 内置 Node 升级通过常规依赖更新完成，不维护旧运行时分支。

目录随里程碑增长：

```text
apps/
  cli/          # M1：可运行单文件入口
  api/          # M2：HTTP adapter
  web/          # M2：浏览器工作区
  desktop/      # M3：Electron main/preload/renderer
packages/
  core/         # 领域模型、解析、校验、展开、序列化
  application/  # 用例、任务、结果、取消
  contracts/    # HTTP/IPC/CLI 外部 schema 与 DTO
  workspace-ui/ # M2 起共享组件和 view model
```

只有对应里程碑开始时才创建目录，不预先生成空包。

依赖方向为：

```text
core <- application <- cli/api/desktop-main
                 ^
contracts -------+---- api/preload/web/renderer
workspace-ui ---------- web/desktop-renderer
```

- `core`
  只依赖 JavaScript/TypeScript 运行时无关能力，不依赖 DOM、Node 文件系统、HTTP、Electron 或设备 SDK。
- `application`
  通过小型 ports 接收字节/文本、时钟、取消信号和输出 sink，不知道路径、request 或 BrowserWindow。
- `contracts` 只定义外部 DTO/schema，不重新声明领域规则。
- Web 和 Electron renderer 共享 React 工作区与 view model；平台文件操作由注入的 client
  adapter 提供。
- API 使用 Fastify；Web 使用 React + Vite；Electron 使用官方文档推荐的 Electron
  Forge 完成打包。具体版本由 lockfile 固定并在 M0/M2/M3 分别核对官方支持矩阵。
- 测试使用 Vitest；浏览器与 Electron 用户流程使用 Playwright。新增库前先检查已有依赖和官方类型。

不引入 Turborepo/Nx、内部事件总线、依赖注入容器或微服务。npm workspace
scripts 和显式函数/对象组合足以覆盖当前规模。

## 不采用的方案

- **每个应用独立仓库**：共享规则和契约容易漂移。
- **所有代码放在 Electron 应用中**：Web/API 无法复用，renderer 安全边界恶化。
- **一个 `shared` 包容纳所有内容**：职责会快速混合且形成循环依赖。
- **提前建立大量 adapter 包**：没有当前用例，不产生真实边界价值。
- **部署为多个领域微服务**：文件处理是进程内纯能力，拆分只增加失败模式。

## 影响

- M1 首先创建 `core`、`application` 和 `cli`，确保工作产品先出现。
- UI 共享限于 workspace/view model，不强迫主进程与浏览器使用同一 IO 实现。
- workspace 依赖必须由 lint/构建检查方向；禁止应用包被核心反向引用。
- Node 24 选择基于 2026-08-30 官方 LTS 状态；升级时直接更新基线和 CI。

## 官方依据

- [Node.js 发布与 LTS 状态](https://nodejs.org/en/about/previous-releases)
- [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)
- [Electron 应用打包建议](https://www.electronjs.org/docs/latest/tutorial/application-distribution)
- [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Fastify Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
