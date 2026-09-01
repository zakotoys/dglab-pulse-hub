# ADR-0003：版本化跨端契约与 adapter 边界

| 项目 | 内容                      |
| ---- | ------------------------- |
| 状态 | Accepted                  |
| 日期 | 2026-08-30                |
| 关联 | TRD 3、7-9；TASK-001..003 |

## 背景

CLI、HTTP、Electron
IPC 和 UI 都要表达任务、Pulse 摘要、stream、诊断和导出结果。直接暴露内部领域对象会把运行时细节、不可序列化值和重构变化扩散到所有入口；为每个入口手写 DTO 又会导致语义漂移。

## 决策

建立一个 `contracts`
workspace，使用成熟的运行时 schema 库定义外部 DTO，并由 schema 推导 TypeScript 类型。M0 在候选库中核对 ESM、Node
24、浏览器、Fastify、许可证和维护状态后选择一个；不得自己实现 schema validator。

每个响应 envelope 至少包含：

```text
schemaVersion
ruleVersion
operation
status
result | diagnostics
```

- `schemaVersion` 只描述外部 DTO；`ruleVersion` 描述 `.pulse` 处理规则。
- CLI JSON、HTTP 和 IPC 使用同一 DTO/schema；传输层只映射状态码、文件流或 IPC channel。
- 内部领域对象通过一个 projector 转换为 DTO，不从 UI 组件拼装。
- 未知 schema major 直接拒绝；在产品未发布前直接更新调用方，不维护兼容 alias/fallback。
- 大 stream 的传输策略在 M2 以测量决定；若需要分页/切片，仍由 application 提供稳定查询，不让 UI 读取内部对象。
- 错误统一使用 diagnostic DTO；HTTP status、进程 exit code 和 UI 状态只是同一结果的呈现。
- 文件路径、临时目录、绝对堆栈和 source content 不进入通用 DTO。

Adapter 职责限定为：

- CLI：参数/stdio/exit code/本地文件。
- HTTP：multipart、响应流、超时和 request cancellation。
- Electron main/preload：文件对话框、原子写出、IPC 白名单。
- UI client：调用 contract、维护交互状态和展示，不解析 `.pulse`。

## 不采用的方案

- **直接 JSON.stringify 领域对象**：重构即破坏边界，也难以校验输入。
- **HTTP 与 IPC 各自定义 schema**：相同用例会产生两个事实来源。
- **GraphQL/消息总线**：当前请求/响应与任务查询足够，增加协议层无收益。
- **用 message 文本判断错误**：无法稳定本地化和自动处理。

## 影响

- contract golden tests 可以对 direct/CLI/HTTP/IPC 做同输入比较。
- schema 变更必须更新 `schemaVersion`、测试和消费者。
- application 保持 transport-neutral，但负责结果语义和取消状态。
- 选择 schema 库是 M0 的有界技术验证，不阻塞本 ADR 的边界决定。
