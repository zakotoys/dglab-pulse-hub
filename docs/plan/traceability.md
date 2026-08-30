# PRD 需求追踪矩阵

状态说明：`Planned` 表示已安排但尚无实现证据；`In progress` 表示失败测试或可复现夹具已进入实现；`Verified` 表示完整门禁通过；`Conditional` 表示必须先满足已记录的证据门槛；`Blocked` 表示有明确外部决策或证据缺口；`Deferred` 必须有 PDR/ADR 依据；`P2` 不进入当前发布承诺。`Not verified` 只表示人工互操作尚未执行，永远不是通过状态。

## IO、校验与升级

| PRD ID | 里程碑 | 主要实现证据 | 最低测试证据 | 状态 |
| --- | --- | --- | --- | --- |
| IO-001 | M1 | core parser + single-file use case | corpus、非法变异、CLI 契约 | Planned |
| IO-002 | M4.1 | QR envelope adapter | golden envelope、损坏/超限输入 | Planned |
| IO-003 | M1 | validated serializer + export use case | source/canonical 往返、阻断错误 | Planned |
| IO-004 | M4.1 | QR encoder + QR image adapter | 内容等价、容量、扫描互操作 | Planned |
| IO-005 | M4.2 | bounded batch orchestrator | 部分失败、取消、冲突、有界并发 | Planned |
| IO-006 | M4.3 | shared stream snapshot + image encoders | SVG 结构、位图像素/尺寸/一致性 | Planned |
| VAL-001 | M0-M1 | recognizer + format profile | 明文/QR/未知；parse-supported 与 app-verified 分开；无伪造 file version | Planned |
| VAL-002 | M0-M1 | syntactic validator | 字段/分隔符/编码/EOF/位置矩阵及预期 verdict | Planned |
| VAL-003 | M1 | semantic validator | 每字段边界与越界一格、零值/小数保真 | Planned |
| VAL-004 | M1 | expander preconditions | 禁用、点数、重复、rest/速度、四模式 golden vectors | Planned |
| VAL-005 | M4.6 | explicit upgrade use case | 真实旧/新夹具、change record、App 验证 | Conditional |
| VAL-006 | M4.5（编辑）；M4.6（升级复用） | shared interpolation rule | 编辑端点/锚点/区间/舍入/裁剪；升级复用另需旧新夹具和 App 验证 | Planned（编辑）；Conditional（升级复用） |

## 预览与编辑

| PRD ID | 里程碑 | 主要实现证据 | 最低测试证据 | 状态 |
| --- | --- | --- | --- | --- |
| PRE-001 | M1-M2 | metadata projector + workspace | 层级、来源、诊断状态 | Planned |
| PRE-002 | M1-M2 | WaveformStream + timeline | 时间顺序、长流、点位追溯 | Planned |
| PRE-003 | M4.4 | preview scheduler/controller | 播放/暂停/停止/定位/节流 | Planned |
| PRE-004 | M4.3 | intensity visualization | 数值替代、颜色对比、同源数据 | Planned |
| PRE-005 | M2/M4.3 | point detail view model | 时间/频率/强度/来源/插值状态 | Planned |
| PRE-006 | M1-M2 | stream metadata projector | 点数、时长、统计、警告 | Planned |
| EDIT-001 | M4.5 | frequency/duration commands | 范围、派生刷新、往返 | Planned |
| EDIT-002 | M4.5 | point/anchor commands | 受影响区间重算、锚点不覆盖 | Planned |
| EDIT-003 | M4.5 | reviewed assist command | 预览确认、取消、确定性、可复现 change record | Planned |
| EDIT-004 | M4.5 | semantic diff projector | Pulse/metadata/stream 三层差异 | Planned |
| EDIT-005 | M4.5 | domain history | 连续撤销/重做、分支编辑、源快照 | Planned |
| EDIT-006 | M1 起 | export precondition | 每种修改/升级后的阻断与通过 | Planned |

## 任务、交付和横切要求

| PRD ID | 里程碑 | 主要实现证据 | 最低测试证据 | 状态 |
| --- | --- | --- | --- | --- |
| TASK-001 | M1 | single task result/state | 成功、失败、取消、非法转换 | Planned |
| TASK-002 | M4.2 | batch progress | 计数、警告、取消竞态、顺序 | Planned |
| TASK-003 | M1/M4.2 | result envelope + operation record | status、成功加 warning、取消、input/output 摘要、rule version、下载描述、脱敏且无路径 | Planned |
| 跨端一致性 | M2-M3 | HTTP/IPC/CLI contract | 同语料 golden response、schema/rule version 拒绝、状态和诊断映射 | Planned |
| FileMetadata 公共边界 | M0-M1 | public DTO + local file adapter | `displayName`、format profile、ruleVersion、证据和状态；无路径/临时路径/伪造 version | Planned |
| Corpus 证据与 provenance | M0 | metadata manifest + synthetic fixtures | 16 个样例统计、干净 clone 行为、来源/再分发权、缺失样例处理 | Planned |
| Web 临时处理 | M2/M4.2/M5 | request/task-scoped lifecycle | 成功/失败/取消/断开/过期/进程停止/重启清理；下载生命周期与 PDR-0003 一致 | Planned |
| 资源与访问边界 | M2/M5 | application limits + task isolation | 字节/点数/时长/并发/超时、信任边界、跨任务隔离、日志脱敏 | Planned |
| 体验与无障碍 | M2-M4 | workspace/view model/E2E | 首屏导入、文字诊断、层级浏览、键盘操作、恢复和预览/设备语义区分 | Planned |
| Compose/Nginx | M5 | production deployment | health、shutdown、proxy limits、runbook | Planned |
| 账户/长期保存 | M5 后 | 独立 PDR/威胁模型 | 未定义前不得实现 | P2 |
| 设备 adapter | 独立立项 | 独立 PDR/ADR/安全评审 | 不得由预览路径触发 | P2 |

VAL-006 的“编辑插值”和“升级复用”是计划层面的作用域拆分，必须在 M4.5 开始前通过 PDR-0002 的决策更新确认；在确认前，原有 `Conditional` 门槛同时适用于两者。

## 维护规则

- 工作项开始时把对应行从 `Planned` 改为 `In progress`，并链接测试或 issue。
- 行为通过完整质量门禁后改为 `Verified`，不能以代码已合并代替验证。
- `Conditional` 项只有在门槛材料进入仓库并经决策更新后才能转为 `Planned`；作用域状态可以拆分，例如 VAL-006 的编辑与升级复用。
- `Not verified` 必须保留 App 版本、平台、输入哈希、步骤和待执行动作；不能直接改为 `Verified`。
- 需求移出发布必须更新 PRD/PDR；不得只在本表中删除。
