# PRD 需求追踪矩阵

状态说明：`Planned` 表示已安排但尚无实现证据；`In progress`
表示失败测试或可复现夹具已进入实现；`Verified` 表示完整门禁通过；`Conditional`
表示必须先满足已记录的证据门槛；`Blocked` 表示有明确外部决策或证据缺口；`Deferred`
必须有 PDR/ADR 依据；`P2` 不进入当前发布承诺。`Not verified`
只表示人工互操作尚未执行，永远不是通过状态。

## 证据快照（2026-09-03）

以下结果在当前工作区完成；命令输出未包含路径或完整波形内容：

| 门禁                                                                   | 结果                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc -b --force --pretty false`                                    | 通过                                                                                                                                                                                   |
| `npm test`                                                             | 通过：22 个文件、193 个测试                                                                                                                                                            |
| `npm run test:coverage -- --run`                                       | 通过；V8 coverage provider/report 已启用（当前无阈值门禁）                                                                                                                             |
| `npm audit --omit=dev --audit-level=high`                              | 通过；production dependency tree 未报告 high/critical vulnerability                                                                                                                    |
| `npm run build`                                                        | 通过                                                                                                                                                                                   |
| `npm run desktop:package`                                              | 通过；Electron Forge 在本机 macOS arm64 生成 asar，主进程依赖已 bundle                                                                                                                 |
| `npm run desktop:make`                                                 | 通过；本机 macOS arm64 DMG 和规范命名所需的 ZIP maker 产物生成                                                                                                                         |
| packaged Electron startup smoke                                        | 通过；本机 macOS arm64 app 启动且 sandbox preload 正常加载                                                                                                                             |
| `npm run web:build`                                                    | 通过                                                                                                                                                                                   |
| `npm run corpus:report`                                                | 通过；无 expectation mismatch                                                                                                                                                          |
| `npm run corpus:verify -- .example`                                    | 通过；253 个文件，239 个接受、14 个明确拒绝，解析异常 0，源/规范化导出 239/239，QR 往返 239，SVG/PNG/JPG 717，编辑 239，批量检查/导出 253/253，临时文件写回 239，unexpected failures 0 |
| `docker compose config --quiet`                                        | 通过                                                                                                                                                                                   |
| `docker compose build api web`                                         | 通过；API/Web 使用定向 workspace 安装、BuildKit npm cache 和独立构建；本机验证约 8.4 秒（此前约 34.1 秒）                                                                              |
| `git diff --check`                                                     | 通过                                                                                                                                                                                   |
| `release.yml` 静态检查                                                 | 已配置：tag 校验、完整质量门禁、GHCR API/Web 多架构镜像、Windows Squirrel、macOS DMG、便携 ZIP、Release 附件和 SHA-256 校验和；GitHub hosted runner 尚未在本地执行                     |
| Compose smoke：`/health/ready`、静态 `/`、API inspect（有效/无效输入） | 通过（`127.0.0.1:8080`）；精简 workspace runtime image 后 readiness/静态首页/有效 inspect 返回 200，无效输入返回 422 和稳定诊断，安全响应头存在                                        |

测试文件覆盖范围为 core 语法/数值/展开/编辑/播放/渲染、application/contract、CLI、HTTP、Electron
IPC、Web workflow 和 corpus 夹具。边界回归还覆盖 direct `Pulse`
输入的资源校验、QR 解压后的最终文本字节限制、批量单项字节限制，以及公共 DTO 的 digest、stream、metadata 和 rule/schema 一致性校验。浏览器人工回归已通过 QR 文本导入、metadata/诊断、timeline
hover 与键盘导航、播放/暂停/停止/定位、点位/section 编辑、撤销/重做、reviewed
assist（含 interior-anchor preview/apply parity）、change
records、导出提示、非法 QR 清空和 390×844 无横向溢出；Web SVG 预览还验证了完整 render
DTO、二进制响应和下载成功状态。Electron 人工回归已通过原生文件选择、同一 `valid-mode-4.pulse`
的 metadata/timeline 展示，以及原生批量导出落盘并显示
`saved`。Chrome 扩展未授予本地文件 URL 权限，无法注入合成文件执行原生 file
chooser/拖放路径，因此浏览器文件工作流 E2E 与完整跨端无障碍检查仍未完成。DG-LAB
App 导入或 QR 扫描互操作、真实旧版本升级夹具也未执行；这些门槛在本表中继续保留为
`Conditional`、`In progress` 或 `Not verified`。

### Corpus provenance

`.example/`
只读观察（2026-08-30）记录了 16 个文件、69 个 section、1,686 个曲线点和 15,364 字节；该目录被 git 忽略，不能作为干净 clone 或 CI 的唯一证据。CI 使用
`tests/fixtures/manifest.json`
中的 8 个合成夹具（含合法、越界、资源上限和非法 UTF-8），`npm run corpus:report` 在缺少 `.example/`
时明确使用 `synthetic-fixtures` 并校验 expectation，`npm run corpus:verify -- tests/fixtures --json`
覆盖提交后可复现的解析、导出、QR、渲染、编辑、批量和临时文件写回闭环。原始 corpus 的来源、再分发授权和 DG-LAB
App 接受性仍未验证。

## IO、校验与升级

| PRD ID  | 里程碑                         | 主要实现证据                            | 最低测试证据                                                            | 状态                                                    |
| ------- | ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| IO-001  | M1                             | core parser + single-file use case      | corpus、非法变异、CLI 契约                                              | Verified                                                |
| IO-002  | M4.1                           | QR envelope adapter                     | golden envelope、损坏/超限输入                                          | Verified（App 扫描仍 `Not verified`）                   |
| IO-003  | M1                             | validated serializer + export use case  | source/canonical 往返、阻断错误                                         | Verified                                                |
| IO-004  | M4.1                           | QR encoder + QR image adapter           | 内容等价、容量、扫描互操作                                              | Not verified（未执行官方 App 扫描互操作）               |
| IO-005  | M4.2                           | bounded batch orchestrator              | 部分失败、取消、冲突、有界并发                                          | Verified（application/API 自动化覆盖）                  |
| IO-006  | M4.3                           | shared stream snapshot + image encoders | SVG 结构、位图像素/尺寸/一致性                                          | Verified（自动化 SVG/PNG/JPG 与共享 stream 证据）       |
| VAL-001 | M0-M1                          | recognizer + format profile             | 明文/QR/未知；parse-supported 与 app-verified 分开；无伪造 file version | Verified（parse-supported；App profile `Not verified`） |
| VAL-002 | M0-M1                          | syntactic validator                     | 字段/分隔符/编码/EOF/位置矩阵及预期 verdict                             | Verified                                                |
| VAL-003 | M1                             | semantic validator                      | 每字段边界与越界一格、零值/小数保真                                     | Verified                                                |
| VAL-004 | M1                             | expander preconditions                  | 禁用、点数、重复、rest/速度、四模式 golden vectors                      | Verified                                                |
| VAL-005 | M4.6                           | explicit upgrade use case               | 真实旧/新夹具、change record、App 验证                                  | Conditional                                             |
| VAL-006 | M4.5（编辑）；M4.6（升级复用） | shared interpolation rule               | 编辑端点/锚点/区间/舍入/裁剪；升级复用另需旧新夹具和 App 验证           | Verified（编辑）；Conditional（升级复用）               |

## 预览与编辑

| PRD ID   | 里程碑  | 主要实现证据                                                 | 最低测试证据                                                | 状态                                                                                                                                                                  |
| -------- | ------- | ------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRE-001  | M1-M2   | metadata projector + workspace                               | 层级、来源、诊断状态                                        | Verified                                                                                                                                                              |
| PRE-002  | M1-M2   | WaveformStream + Web/Electron timeline                       | 时间顺序、长流、降采样绘图、原始点 hover/键盘追溯           | In progress（Web QR 导入后的 hover/键盘和响应式证据、Electron 原生文件选择后的 timeline/metadata 展示已完成；浏览器原生 file chooser/拖放和完整跨端无障碍检查待验证） |
| PRE-003  | M4.4    | preview scheduler/controller                                 | 播放/暂停/停止/定位/节流                                    | In progress（core controller 与 Web 播放/暂停/停止/定位已验证；Electron 人工播放证据和完整归档待完成）                                                                |
| PRE-004  | M4.3    | intensity visualization                                      | 数值替代、颜色对比、同源数据                                | Verified（SVG/PNG/JPG 自动化渲染测试）                                                                                                                                |
| PRE-005  | M2/M4.3 | point detail view model                                      | 时间/频率/强度/来源/插值状态                                | Verified（stream source 与 desktop detail 投影测试）                                                                                                                  |
| PRE-006  | M1-M2   | stream metadata projector                                    | 点数、时长、统计、警告                                      | Verified                                                                                                                                                              |
| EDIT-001 | M4.5    | frequency/duration commands                                  | 范围、派生刷新、往返                                        | Verified                                                                                                                                                              |
| EDIT-002 | M4.5    | point/anchor commands                                        | 受影响区间重算、锚点不覆盖                                  | Verified                                                                                                                                                              |
| EDIT-003 | M4.5    | reviewed assist command                                      | 预览确认、取消、确定性、可复现 change record                | Verified（review gate、quadratic preview/apply golden、change record）                                                                                                |
| EDIT-004 | M4.5    | semantic diff projector                                      | Pulse/metadata/stream 三层差异                              | Verified（core/API diff 自动化测试）                                                                                                                                  |
| EDIT-005 | M4.5    | Web history plus Electron main/preload/renderer history path | 连续撤销/重做、分支编辑、源快照、保存后基线重置、字节不泄露 | Verified                                                                                                                                                              |
| EDIT-006 | M1 起   | export precondition                                          | 每种修改/升级后的阻断与通过                                 | Verified                                                                                                                                                              |

## 任务、交付和横切要求

| PRD ID                   | 里程碑     | 主要实现证据                           | 最低测试证据                                                                          | 状态                                                                                                                                    |
| ------------------------ | ---------- | -------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| TASK-001                 | M1         | single task result/state               | 成功、失败、取消、非法转换                                                            | Verified（状态转换、非协作取消、timeout race）                                                                                          |
| TASK-002                 | M4.2       | batch progress                         | 计数、警告、取消竞态、顺序                                                            | Verified（application/API batch 自动化覆盖）                                                                                            |
| TASK-003                 | M1/M4.2    | result envelope + operation record     | status、成功加 warning、取消、input/output 摘要、rule version、下载描述、脱敏且无路径 | Verified                                                                                                                                |
| 跨端一致性               | M2-M3      | HTTP/IPC/CLI contract                  | 同语料 golden response、schema/rule version 拒绝、状态和诊断映射                      | Verified（合法/非法 synthetic fixture 的 direct/CLI/HTTP/IPC envelope 逐字段比较）                                                      |
| FileMetadata 公共边界    | M0-M1      | public DTO + local file adapter        | `displayName`、format profile、ruleVersion、证据和状态；无路径/临时路径/伪造 version  | Verified                                                                                                                                |
| Corpus 证据与 provenance | M0         | metadata manifest + synthetic fixtures | 16 个样例统计、干净 clone 行为、来源/再分发权、缺失样例处理                           | Verified（合成夹具/report 行为；原始 corpus provenance 未验证）                                                                         |
| Web 临时处理             | M2/M4.2/M5 | request/task-scoped lifecycle          | 成功/失败/取消/断开/过期/进程停止/重启清理；下载生命周期与 PDR-0003 一致              | Verified（过期/消费、部分/全失败 staging、断连清理、异常停止后重启清理、API close 自动化覆盖）                                          |
| 资源与访问边界           | M2/M5      | application limits + task isolation    | 字节/点数/时长/并发/超时、信任边界、跨任务隔离、日志脱敏                              | Verified（应用限额、QR 解压限额、超时/取消、路径与 payload 脱敏自动化覆盖）                                                             |
| Electron 发布打包        | M3/M5      | Electron Forge + bundled main/preload  | package/make、sandbox preload、启动和目标平台验证                                     | In progress（本机 macOS arm64 package/make/启动已通过；CI 已配置 Windows Squirrel/macOS DMG/便携 ZIP；Windows、签名和安装升级仍未验证） |
| CI/CD 发布流水线         | M5         | `.github/workflows/release.yml`        | tag/version 校验、质量门禁、GHCR、Windows/macOS 产物、Release 和校验和                | In progress（配置已完成；GitHub hosted runner 发布尚未执行）                                                                            |
| 体验与无障碍             | M2-M4      | workspace/view model/E2E               | 首屏导入、文字诊断、层级浏览、键盘操作、恢复和预览/设备语义区分                       | Not verified（未完成浏览器人工 UI/无障碍检查）                                                                                          |
| Compose/Nginx            | M5         | production deployment                  | health、shutdown、proxy limits、runbook                                               | In progress（构建、health 和 smoke 已通过；完整生产故障注入门禁未完成）                                                                 |
| 账户/长期保存            | M5 后      | 独立 PDR/威胁模型                      | 未定义前不得实现                                                                      | P2                                                                                                                                      |
| 设备 adapter             | 独立立项   | 独立 PDR/ADR/安全评审                  | 不得由预览路径触发                                                                    | P2                                                                                                                                      |

VAL-006 的“编辑插值”和“升级复用”是计划层面的作用域拆分，必须在 M4.5 开始前通过 PDR-0002 的决策更新确认；在确认前，原有
`Conditional` 门槛同时适用于两者。

## 维护规则

- 工作项开始时把对应行从 `Planned` 改为 `In progress`，并链接测试或 issue。
- 行为通过完整质量门禁后改为 `Verified`，不能以代码已合并代替验证。
- `Conditional` 项只有在门槛材料进入仓库并经决策更新后才能转为
  `Planned`；作用域状态可以拆分，例如 VAL-006 的编辑与升级复用。
- `Not verified` 必须保留 App 版本、平台、输入哈希、步骤和待执行动作；不能直接改为 `Verified`。
- 需求移出发布必须更新 PRD/PDR；不得只在本表中删除。
