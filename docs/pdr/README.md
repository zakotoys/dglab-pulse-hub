# 产品决策记录（PDR）

PDR 记录会改变用户范围、发布承诺、数据政策或格式支持政策的决定。实现计划必须遵守状态为 `Accepted` 的记录。

| ID | 决策 | 状态 | 日期 |
| --- | --- | --- | --- |
| [PDR-0001](0001-staged-product-scope.md) | 分层交付与首发范围 | Accepted | 2026-08-30 |
| [PDR-0002](0002-format-support-policy.md) | `.pulse` 格式支持与证据政策 | Accepted | 2026-08-30 |
| [PDR-0003](0003-ephemeral-web-processing.md) | Web 端无持久化处理 | Accepted | 2026-08-30 |

## 状态

- `Proposed`：正在评审，不约束实现。
- `Accepted`：当前产品决策，计划与实现必须遵守。
- `Superseded`：被新 PDR 替代，保留历史链接。
- `Rejected`：评审后不采用。

PDR 不直接修改历史。决策变化时新增记录，并在旧记录中标明 `Superseded by`。
