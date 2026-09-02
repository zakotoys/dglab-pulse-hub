# 文档索引

## 定义与研究

- [PRD](prd.md)：用户、范围、需求编号和产品验收。
- [TRD](trd.md)：技术能力、边界和可验证约束。
- [术语表](glossary.md)：跨文档统一概念。
- [`.pulse` 外部格式研究](research/dglab-pulse-format.md)：官方与社区公开资料。
- [本地样例语料分析](research/pulse-corpus.md)：`.example` 的可观察事实与测试使用规则。
- [设备与 SDK 研究](research/dglab-brief.md)：设备/传输 adapter 的外部边界。

## 计划与决策

- [交付总计划](plan/README.md)：里程碑、关键路径和决策门槛。
- [阶段实施计划](plan/phases.md)：M0-M5 的顺序、交付物和退出标准。
- [质量门禁](plan/quality-gates.md)：TDD、测试矩阵和完成定义。
- [需求追踪矩阵](plan/traceability.md)：PRD ID 到里程碑和证据。
- [产品决策记录](pdr/README.md)：支持承诺、发布范围和数据生命周期。
- [架构决策记录](adr/README.md)：workspace、处理 pipeline 和跨端契约。

## 发布与运维

- [发布与分发](release.md)：版本同步、tag 发布、GHCR 镜像、Windows/macOS 产物和回滚。
- [生产运行手册](../ops/runbook.md)：Compose 启动、健康检查、升级和故障处理。

## 文档职责

```text
研究事实 -> PRD/TRD -> PDR/ADR -> plan -> 实现与测试证据
```

研究变化先更新事实与证据等级；需求变化更新 PRD/TRD；改变既定取舍新增 PDR/ADR；实施状态只在 plan/追踪矩阵维护。
