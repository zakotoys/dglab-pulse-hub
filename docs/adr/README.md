# 架构决策记录（ADR）

ADR 记录对多个模块或运行环境有长期影响的技术决定。产品范围和用户承诺见 [PDR](../pdr/README.md)。

| ID                                                     | 决策                          | 状态     | 日期       |
| ------------------------------------------------------ | ----------------------------- | -------- | ---------- |
| [ADR-0001](0001-workspace-and-runtime-architecture.md) | npm workspace 与分层运行架构  | Accepted | 2026-08-30 |
| [ADR-0002](0002-pulse-processing-pipeline.md)          | `.pulse` 两阶段解析与派生模型 | Accepted | 2026-08-30 |
| [ADR-0003](0003-versioned-boundary-contracts.md)       | 版本化跨端契约与 adapter 边界 | Accepted | 2026-08-30 |

修改已接受架构时新增 ADR 并 supersede 旧记录；不要用“兼容层”同时保留两套未发布架构。
