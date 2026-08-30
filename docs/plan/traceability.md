# 需求追踪矩阵

## 1. 使用方式

`Test ID` 是计划中的稳定测试族名称，不代表测试已经存在。实现时测试文件/用例应包含该 ID，完成证据填写 CI run、报告或发布产物链接。状态初始均为 `Not started`。

## 2. IO 与校验

| Requirement | Milestone | 主要交付 | Test ID | 退出证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| IO-001 | M1 | core parser + CLI inspect | T-IO-001 | 16 样例与非法夹具报告 | Not started |
| IO-002 | M3 | QR candidate decoder + adapter | T-QR-IMPORT | App QR 互操作记录 | Blocked: OQ-003 |
| IO-003 | M1 | canonical serializer + CLI export | T-IO-003 | 全语料往返报告 | Not started |
| IO-004 | M3 | QR encoder | T-QR-EXPORT | 目标 App 导入记录 | Blocked: OQ-003 |
| IO-005 | M3 | batch orchestrator/adapters | T-BATCH-IO | 部分失败与取消报告 | Not started |
| IO-006 | M3 | shared scene + SVG/raster adapters | T-IMAGE-EXPORT | 结构/像素/数据一致性报告 | Not started |
| VAL-001 | M0/M1 | content recognition + ruleset | T-VAL-IDENTIFY | 类型识别矩阵 | Not started |
| VAL-002 | M0/M1 | syntax/structure parser | T-VAL-STRUCTURE | 语法错误夹具矩阵 | Not started |
| VAL-003 | M1 | range/resource validators | T-VAL-RANGE | 边界/超限报告 | Not started |
| VAL-004 | M1 | semantic validator + stream | T-VAL-SEMANTIC | 语义与展开报告 | Not started |
| VAL-005 | M4 | explicit dialect transform | T-UPGRADE | 源/目标 App 夹具与 diff | Blocked: OQ-004 |
| VAL-006 | M4 | shared interpolation service | T-INTERPOLATE | 表格/属性测试报告 | Blocked: OQ-005 |

## 3. 预览与编辑

| Requirement | Milestone | 主要交付 | Test ID | 退出证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| PRE-001 | M1/M2 | metadata DTO + workbench | T-PRE-METADATA | CLI/UI 契约与 E2E | Not started |
| PRE-002 | M1/M2 | index-based stream + timeline | T-PRE-TIMELINE | 最长/上限 stream 交互报告 | Not started |
| PRE-003 | M4 | local simulation clock | T-PRE-PLAYBACK | 暂停/停止/定位状态测试 | Not started |
| PRE-004 | M4 | ring/color visualization | T-PRE-INTENSITY | 数值替代文本与视觉回归 | Not started |
| PRE-005 | M2 | source-backed hover | T-PRE-HOVER | point source 映射 E2E | Not started |
| PRE-006 | M1/M2 | stream statistics | T-PRE-STREAM-META | golden metadata | Not started |
| EDIT-001 | M4 | section frequency/duration commands | T-EDIT-SECTION | command/undo/export tests | Not started |
| EDIT-002 | M4 | point/anchor commands | T-EDIT-POINT | 受影响点重算 tests | Not started |
| EDIT-003 | M4 | constrained edit assistance | T-EDIT-ASSIST | 用户确认与边界 tests | Not started |
| EDIT-004 | M4 | structure/metadata/stream diff | T-EDIT-DIFF | golden diff | Not started |
| EDIT-005 | M4 | command history | T-EDIT-HISTORY | 分支/边界/原快照 tests | Not started |
| EDIT-006 | M1 | export use case guard | T-EXPORT-REVALIDATE | 阻断输出 tests | Not started |

## 4. 任务、跨端与非功能要求

| Requirement | Milestone | 主要交付 | Test ID | 退出证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| TASK-001 | M1 | operation/task state | T-TASK-SINGLE | CLI 状态/退出码 tests | Not started |
| TASK-002 | M3 | batch progress/cancel | T-TASK-BATCH | 并发取消 tests | Not started |
| TASK-003 | M3 | per-item trace/result | T-TASK-TRACE | batch golden result | Not started |
| TRD-跨端一致性 | M2 | CLI/HTTP/IPC contracts | T-CONTRACT-EQUIV | 三端 golden diff | Not started |
| TRD-资源限制 | M0/M2/M5 | core/API/proxy limits | T-RESOURCE-LIMIT | benchmark + stress report | Not started |
| TRD-隐私 | M2/M5 | ephemeral processing/log redaction | T-PRIVACY | log/cleanup integration test | Not started |
| TRD-部署 | M5 | Compose/Nginx/API/Web | T-DEPLOY | clean deploy smoke | Not started |
| TRD-Electron 安全 | M2/M5 | sandboxed window/preload/fuses | T-ELECTRON-SEC | automated audit | Not started |

## 5. 阶段覆盖门禁

| Milestone | 必须关闭的 Test ID |
| --- | --- |
| M0 | T-VAL-IDENTIFY、T-VAL-STRUCTURE 的格式基线子集 |
| M1 | T-IO-001、T-IO-003、T-VAL-*、T-PRE-METADATA、T-PRE-TIMELINE、T-PRE-STREAM-META、T-EXPORT-REVALIDATE、T-TASK-SINGLE |
| M2 | T-CONTRACT-EQUIV、T-PRE-HOVER、T-PRIVACY、T-ELECTRON-SEC，以及 M1 回归 |
| M3 | T-QR-*（若范围包含 QR）、T-BATCH-IO、T-IMAGE-EXPORT、T-TASK-BATCH、T-TASK-TRACE |
| M4 | T-UPGRADE（若证据门禁关闭）、T-INTERPOLATE、T-PRE-PLAYBACK、T-PRE-INTENSITY、T-EDIT-* |
| M5 | T-RESOURCE-LIMIT、T-DEPLOY、完整安全/发布清单 |

需求若从某次发布移除，必须通过 PDR 更新 PRD 范围和本矩阵；不能仅把测试标记为 skipped。
