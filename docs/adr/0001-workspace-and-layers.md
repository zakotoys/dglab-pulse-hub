# ADR-0001：npm workspace 与分层依赖

## 状态

Accepted — 2026-08-30

## 背景

系统需要在 CLI、Node.js API、Electron 主进程和浏览器 UI 中复用格式行为。仓库指定 TypeScript、Node.js 和 npm，但尚无工程结构或依赖。

如果按客户端复制解析/校验，跨端结果会漂移；如果把所有能力放在一个包中，核心会被 Node/Electron/DOM 依赖污染。

## 决策

使用单仓库、单锁文件的 npm workspaces。初始长期边界为：

```text
packages/pulse-core
packages/pulse-application
packages/contracts
apps/cli
apps/api              # M2 创建
apps/web              # M2 创建
apps/desktop          # M2 创建
packages/workbench-ui # 只有 Web/Electron 确有共享代码时在 M2 创建
```

依赖方向：

```text
apps -> application -> pulse-core
  |          |
  +------> contracts <------ workbench-ui
```

详细规则：

- `pulse-core` 是纯 TypeScript，不读取文件、不使用 Node-only API、不依赖 DOM，不导入其他 workspace。
- `pulse-application` 编排 use case、任务、取消和 adapter port，不包含 CLI/HTTP/IPC 类型。
- `contracts` 只包含可序列化 DTO、runtime schema 和 contract version；不能导出领域对象引用。
- app 是 composition root，选择具体文件、HTTP、IPC、QR、图像等 adapter。
- UI 只消费 contracts/view model，不导入 parser/validator 内部模块。
- 跨 workspace 只能从包公开入口导入；CI 检查深层路径和反向依赖。

运行时基线使用 Node.js 24 LTS。Node.js 26 在 2026-08-30 仍为 Current，进入 LTS 并通过依赖矩阵前不作为生产基线。具体依赖版本由 lockfile 固定。

## 原因

- npm workspaces 是项目指定包管理器的原生能力，不增加 monorepo 编排层。
- 三个核心 package 对应真实的领域、用例和传输契约差异。
- app 逐阶段创建，避免在 M0 生成空的 Web/Electron 结构。
- 单锁文件让跨端依赖和安全扫描可复现。

## 未选择的方案

### 每个客户端独立仓库/包

拒绝。格式规则和 golden 契约难以原子更新。

### 一个包包含全部代码

拒绝。Node/Electron/DOM 依赖会进入核心，无法证明跨端复用。

### 引入额外 monorepo 构建系统

暂不采用。初始 workspace 数量和构建图不证明需要。出现可测量的 CI/缓存问题时再提出 ADR。

## 影响

- 首个实现提交先建立 M0/M1 所需的四个 workspace，不创建空 app。
- 共享代码必须满足依赖方向，不能仅因两处看似相似就提取。
- 包公开 API 变化在预发布期直接更新所有调用方，不保留旧入口。

## 依据

- [Node.js 官方发布状态](https://nodejs.org/en/about/previous-releases)：截至决策日，Node.js 24 为 LTS，26 为 Current。
- [npm workspaces 官方文档](https://docs.npmjs.com/cli/using-npm/workspaces/)：单根 package 管理和本地 workspace 自动链接。
