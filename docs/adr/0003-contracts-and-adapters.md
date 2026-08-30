# ADR-0003：transport-neutral 用例与版本化契约

## 状态

Accepted — 2026-08-30

## 背景

同一处理能力要通过 CLI、HTTP 和 Electron IPC 暴露。直接让各端调用内部函数会泄漏领域对象与异常；为每端重写 service 又会产生行为差异。

## 决策

应用层定义 transport-neutral use case，contracts 包定义它们的可序列化 DTO 和 runtime schema。adapter 只负责边界转换。

### 用例接口

M1 最小用例：

- `inspectPulse(input, options, signal)`；
- `exportPulse(input, target, options, signal)`。

M3 再加入 batch/image/QR，不预先建立通用 command bus 或插件系统。

### 统一结果

所有用例返回 `OperationResult<T>`，状态为 `success | rejected | failed | cancelled`。预期输入问题是 `rejected`；I/O 和内部异常映射为 `failed`，但内部 Error/stack 不进入 DTO。

结果包含：

- `contractVersion`；
- `ruleSetId`；
- 稳定排序 diagnostics；
- 成功数据或明确允许的部分结果；
- 可选统计/耗时，其中非确定字段在一致性比较中排除。

### Port 与 adapter

应用层只定义当前用例实际需要的窄 port，例如 input reader、atomic output writer、clock。HTTP multipart、Electron dialog、Node path 和 browser File 不进入 port。

adapter 在 composition root 组合：

- CLI：Node 文件 + stdout/stderr + process exit code；
- API：multipart/request abort + HTTP response；
- Electron：main process 文件/dialog + validated IPC；
- UI：HTTP client 或 preload client。

### Schema 与版本

- contracts 的 runtime schema 是边界验证权威，TypeScript 类型从同一来源产生或由契约测试保证一致。
- HTTP 与 IPC 使用相同 DTO，不要求使用相同 envelope framing。
- `contractVersion` 只表示 DTO 兼容性，`ruleSetId` 表示领域判定/派生规则，应用版本单独存在。
- 预发布阶段不维护多个 contract handler；不兼容变化直接更新所有 app 和 golden。

具体 schema 库与 HTTP 框架在 M2 选型时依据官方文档、类型、multipart 限制和维护状态决定；该决策不依赖某个库。

## 一致性比较

同一输入与 options 经 CLI/HTTP/IPC 处理后，移除 transport metadata、文件展示名和 timing，结果必须通过同一 canonical comparison。该测试调用真实 adapter 边界，不能只 mock use case。

## 未选择的方案

### 共享内部领域对象并 JSON.stringify

拒绝。定点值、只读类型、Error 和未来内部重构会泄漏为隐式 API。

### 通用事件总线/command bus

拒绝。当前用例少，增加间接层但没有多 handler 需求。

### HTTP API 作为 Electron 唯一后端

拒绝。Electron 基础工作流必须离线，不依赖本地端口或 Web 服务生命周期。

## 影响

- contracts 需要 golden schema 测试。
- UI 不能导入 domain object 或根据中文 message 分支。
- adapter 的取消必须转换为同一 `cancelled` 状态。
- 新 transport 复用 use case/contract，而不是复制领域流程。
