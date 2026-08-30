# ADR-0004：共享工作台、Electron 安全边界与 Web 部署

## 状态

Accepted — 2026-08-30

## 背景

PRD 要求 Electron 和 Web 提供一致体验，TRD 要求 Web/API/Nginx 通过 Docker Compose 交付。两端既有大量相同视图，也有完全不同的文件与信任边界。

## 决策

### 共享工作台

M2 选择一个成熟、维护活跃且支持 TypeScript 的前端框架和构建工具，Web 与 Electron renderer 使用同一 workbench UI 与 view model。具体框架在脚手架提交前通过依赖评审定稿，不在 ADR 中提前锁定未检查版本。

共享范围包括：任务/诊断状态、metadata、时间轴、selection、导出状态和可访问性行为。平台文件选择、保存、HTTP 和 IPC client 通过窄接口注入。

只有出现真实共享代码后才创建 `packages/workbench-ui`；不先创建空抽象。

### Electron 边界

- main process 是本地文件和应用 use case 的 composition root。
- renderer 视为不可信 Web 内容：启用 context isolation 与 sandbox，禁用 Node integration。
- preload 暴露最小、具名、参数经 runtime schema 验证的方法。
- 使用打包器编译 renderer/preload；发布使用 Electron 官方推荐的 Forge 路径。
- CSP、导航、新窗口、外部协议、IPC sender 和 Electron fuses 纳入发布门禁。

### Web 边界

- 浏览器只调用 Node.js API，不在浏览器复制 parser。
- API 按 [PDR-0003](../pdr/0003-ephemeral-web-processing.md) 单请求处理，不持久化用户文件。
- Web 静态资源与 API 分开构建；Nginx 提供静态资源、TLS/反向代理和入口限制。
- Nginx 不承载领域逻辑，API 也不依赖 Nginx 才能运行测试。

### 可视化

时间轴 view model 使用同一 stream DTO。视口裁剪、命中测试和图像导出的坐标变换属于独立渲染模块，不从 canvas/SVG 像素反推领域值。

先实现可缩放的二维轨道；环形频谱和播放模拟在核心工作台可用后加入，不将装饰性可视化作为首屏主流程。

## 未选择的方案

### Web 与 Electron 两套 UI

拒绝。会复制交互和一致性测试。

### renderer 直接使用 Node.js `fs`

拒绝。扩大攻击面并绕开用例/契约。

### Electron 启动内置 HTTP API

拒绝。增加端口、生命周期和鉴权问题，没有必要。

### Nginx 模块解析 Pulse

拒绝。领域规则会分叉且不可复用。

## 影响

- Electron 与 Web 共享视图，但各自有 adapter E2E。
- Playwright 的 Electron 自动化当前为 experimental，关键主进程安全行为还需要 Node 级集成测试和构建后审计，不能只依赖 UI E2E。
- 框架/图表库/HTTP 库的选型必须先核对官方文档、类型、维护状态和许可证，再记录在依赖清单；无需为每个普通库新增 ADR，除非它改变边界。

## 依据

- [Electron 应用打包文档](https://www.electronjs.org/docs/latest/tutorial/application-distribution)：官方推荐 Electron Forge。
- [Electron ESM 与 renderer 文档](https://www.electronjs.org/docs/latest/tutorial/esm)：renderer 中 npm 包应由 Vite/webpack 等 bundler 编译，并说明 preload 限制。
- [Playwright Electron 文档](https://playwright.dev/docs/api/class-electron)：Electron 自动化能力和 experimental 状态。
