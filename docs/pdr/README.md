# 产品决策记录（PDR）

PDR 记录会改变用户可见范围、数据承诺或发布顺序的决定。实现细节进入 [ADR](../adr/README.md)，需求本身仍以 [PRD](../prd.md) 为准。

| ID | 决策 | 状态 | 日期 |
| --- | --- | --- | --- |
| [PDR-0001](0001-pulse-support-and-fidelity.md) | `.pulse` 支持画像与导出保真承诺 | Accepted | 2026-08-30 |
| [PDR-0002](0002-release-slicing-and-upgrade-gate.md) | 分层发布与版本升级证据门槛 | Accepted | 2026-08-30 |
| [PDR-0003](0003-file-lifecycle-and-source-safety.md) | 文件生命周期与源文件保护 | Accepted | 2026-08-30 |

## 状态规则

- `Proposed`：讨论中，不可作为实现依据。
- `Accepted`：当前产品基线。
- `Superseded`：由新 PDR 取代，旧记录只保留决策历史。
- `Rejected`：已评估但未采用。

改变已接受决定时新增 PDR 并将旧记录标为 `Superseded`；不在原记录中改写历史。

