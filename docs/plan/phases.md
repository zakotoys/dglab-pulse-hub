# 分阶段实施计划

## 1. M0：格式证据与仓库基线

### 目标

把文档仓库变成可执行的 TypeScript 项目，并用当前 16 个样例固定第一版可观察语法，而不是立即实现所有产品能力。

### 实施顺序

1. 建立 npm workspaces、TypeScript 严格配置、单元测试、lint/format、构建和 CI。
2. 将 `.example`
   登记为本地只读 corpus；生成确定性的文件标识、字节长度、section/点位统计和校验信息。把“原样语料是否可提交”与干净 clone 的行为写入 provenance 记录；在来源和再分发权确认前，CI 只使用覆盖相同结构特征的最小合成夹具。
3. 先冻结支持画像：`parse-supported` 覆盖 1..10 section，`app-verified`
   逐项记录目标 App 证据；11 个 section、缺失字段和超限输入必须有明确拒绝预期。
4. 先写 tokenizer/grammar 的表格驱动失败测试，再实现只负责结构拆分的 parser
   prototype。矩阵中的每个样例都必须写明 accepted/rejected、诊断 code 和位置预期。
5. 为错误输入建立最小变异集：错误前缀、编码标记、缺少
   `=`、空 section、字段数量错误、非法数值、小数异常、错误开关、错误锚点、超限 section。
6. 输出机器可读的 corpus report，确认每个样例能被完整消费且没有忽略尾随 token；报告同时输出 parse
   profile 和互操作证据状态。
7. 在 M1 前冻结 stream 规则表和 golden vectors：100
   ms 点位、完整重复、目标/实际时长、全局 rest、播放速度、禁用 section、四种模式、端点采样、舍入和单位边界。未知映射保留为
   `Not verified`。
8. 建立 `contracts` workspace，选择并记录 schema library，写出 result
   envelope 草案和未知 schema/rule
   version 的拒绝测试；同时把 ADR-0003 与 TRD 的 FileMetadata 公共字段完成对齐。
9. 用真实 App 做最小互操作记录：原文件导入、未修改导出再导入、规范化导出再导入。无法测试的项明确标为
   `Not verified`，不得写成支持承诺。

### 交付物

- `packages/core` 的语法层原型和诊断类型。
- 本地 corpus metadata manifest/回归入口、provenance 决策、CI 合成合法夹具、非法变异夹具。
- `npm test`、`npm run typecheck`、`npm run lint` 和 CI。
- 格式画像 v1、`parse-supported`/`app-verified` 能力矩阵及互操作记录模板。
- `contracts` schema library 决策、result envelope 草案、stream 规则表和 golden vectors。

### 退出标准

- 本地 corpus suite 中 16 个样例全部被解析到 EOF，统计与 metadata manifest 一致；缺少 `.example`
  时明确 skip，并由 CI 合成夹具继续覆盖规则。provenance 和再分发结论已记录，不能把忽略目录当作干净 clone 的必备输入。
- grammar 矩阵的每个输入都有确定的 accepted/rejected 结论、稳定 code 和结构位置；`parse-supported`
  与 `app-verified` 没有混用。
- parser 不使用 `Number(x) || default` 一类会吞掉零值/非法值的写法。
- 所有拒绝路径返回稳定 code 和结构位置，不以异常文本作为契约。
- 尚未确认的字段只有中性名称，不在代码中伪装为物理单位。
- FileMetadata 的公共边界已与 ADR-0003 对齐：可公开显示的名称必须是明确的
  `displayName`，路径、临时路径和未经证实的通用 `version` 不进入公共 DTO。
- stream 规则、schema library、result
  envelope 和未知版本拒绝行为已有可执行测试；尚未具备的 App 证据显式为
  `Not verified`，不提前进入 M1/M2 的通过条件。

## 2. M1：核心单文件闭环

### 目标

提供第一个真正可用的产品：通过 Node 命令处理一个
`.pulse`，获得诊断、metadata 和逻辑 stream，并安全导出。

### 实施顺序

1. **解析边界**：以测试定义 `SourceDocument -> SyntacticPulse`，保留原始文本、数值 lexeme 和位置。
2. **规范化边界**：以测试定义 `SyntacticPulse -> Pulse`，验证字段数量、范围、启用状态和曲线点。
3. **诊断**：为识别、语法、范围、语义和导出建立 code 目录及 severity 规则。
4. **metadata**：先实现文件、Pulse、section 层；每个字段标记 `raw`、`derived` 或
   `unverified mapping` 来源。公共 DTO 只通过明确的 `displayName`
   表达用户可见名称，不暴露本地路径、临时路径或未经证实的通用 `version`。
5. **展开**：严格按 M0 冻结的 stream 规则表和 golden vectors 生成逻辑 stream，覆盖 100
   ms 曲线点、完整脉冲元重复、section 目标/实际时长、rest、播放速度、禁用 section 和四种频率模式。
6. **序列化**：实现源快照导出和规范化导出；两者均执行导出前校验。
7. **用例**：组合 `inspectPulse` 和
   `exportPulse`，提供 Node 命令作为可运行入口；结果统一经过 status/result/diagnostics
   envelope，并明确成功加 warning 与取消的状态。
8. **闭环测试**：对 corpus 执行 parse -> validate -> expand -> serialize ->
   parse，并比较受支持语义。

### 交付物

- `@dglab-pulse-hub/core`：纯领域能力。
- `@dglab-pulse-hub/application`：单文件用例、任务结果和取消接口。
- Node 命令：检查文件、输出 JSON 报告、导出文件。
- diagnostic code catalog 和 rule version。

### 退出标准

- IO-001、IO-003、VAL-001..004、PRE-001..002、EDIT-006、TASK-001 有自动化证据。
- TASK-003 的公共结果不泄漏路径，且 direct/CLI 共享同一 schema、rule version、状态和诊断投影。
- 未修改文件可按源快照无损导出；规范化导出的语义往返稳定。
- WaveformStream 点位能追溯到 section、脉冲元重复序号和曲线点，并通过 M0 golden
  vectors 固定时长、rest、速度、禁用 section 和模式规则。
- 无 DOM、Electron、HTTP 或设备协议依赖进入 core/application。

## 3. M2：Web 工作台 MVP

### 目标

让用户在浏览器完成单文件闭环，同时验证稳定的跨进程 schema。

### 实施顺序

1. 从 M1 用例生成/维护版本化输入输出 schema，不直接序列化内部 class；明确 status 枚举、成功加 warning、取消、结果/下载描述和禁止暴露的路径字段。
2. 在 API 实现前冻结上传限制、超时、取消、错误映射、任务隔离、访问信任边界和临时文件清理测试；application/adapter 必须独立执行这些限制。
3. 先确定每个端点是同步还是异步，再实现单文件上传/检查/导出端点；默认内存或请求级临时处理，不建立账户/数据库。需要异步输出时，必须先按 PDR-0003 记录任务级 artifact 的存活期、下载/关闭/过期/停止清理行为。
4. 实现工作区首屏：文件选择、处理状态、诊断列表、metadata 分层视图、时间轴和点位详情。
5. 对长 stream 实现视口裁剪或抽样展示，但 hover/详情必须读取原始 stream 数据。
6. 加入 API schema 契约测试、浏览器端到端测试和无障碍检查。
7. 建立最小容器开发运行方式；生产 Nginx/Compose 完整门禁留到 M5。

### 退出标准

- 用户不阅读说明即可从首屏开始导入并完成下载。
- API 和 Node 对同一输入产生等价的 schema、状态、诊断、metadata、stream 和导出内容。
- 请求结束、取消、失败、客户端断开、任务过期或进程停止后临时内容按 PDR-0003 删除；若下载需要延长存活期，PDR-0003 的成功/删除语义已先完成决策更新。
- 未知 schema/rule
  version 被明确拒绝；上传大小、展开点数、处理时长和并发限制在应用层生效，任务之间不能互相读取或覆盖临时内容。
- UI 对错误/警告提供文字、位置和建议，不只依赖颜色。

## 4. M3：Electron 离线 MVP

### 目标

复用 M2 的工作区与 M1 的应用用例，提供不依赖 Web 服务的桌面文件工作流。

### 实施顺序

1. 建立 Electron 主进程/preload/renderer 安全边界及 IPC schema 测试。
2. 文件选择、读取和另存为只存在于主进程 adapter；renderer 不获得任意文件系统能力。
3. 复用共享工作区组件和 view model，替换传输 adapter，不复制解析与校验。
4. 增加未保存状态、关闭确认、原始快照恢复和“另存为”路径冲突测试。
5. 在 Windows 主目标环境完成打包、安装、启动、非 ASCII 文件名和大文件失败路径验证。
6. 运行 Node/API/IPC 三入口的同语料契约测试。

### 退出标准

- 完全断网时仍可导入、预览和另存 `.pulse`。
- 默认不覆盖源文件；用户明确选择相同路径时才允许替换。
- renderer 未开启 Node integration，IPC 仅暴露白名单用例。
- Electron 与 Web 的领域结果一致，差异仅限文件交互和展示环境。

## 5. M4：首个完整版本

M4 以小增量逐项加入，每项都在 M2/M3 已工作的单文件产品上完成。

### M4.1 QR

- 固定 `#DGLAB-PULSE#` envelope 的编码/解码夹具和损坏输入。
- 复用明文 parser；QR adapter 不拥有第二套 Pulse 模型。
- 验证内容往返、压缩炸弹上限、二维码容量和扫描可读性。

### M4.2 批量任务

- 单文件用例外包一层有界并发编排。
- 先测试部分失败、取消、重复输入、同名输出和结果排序。
- Electron 使用目录/多选文件 adapter；Web 使用有数量和总大小限制的上传任务。

### M4.3 预览与图片导出

- 从同一不可变 stream
  snapshot 生成屏幕 SVG 与导出 SVG；不引入未在 M1/M2 契约中定义的第二套波形中间模型。
- PNG/JPG 只作为 SVG/snapshot 的编码 adapter，不重新计算波形。
- 验证非空像素、尺寸、关键坐标、长 stream 和中文 metadata。

### M4.4 播放模拟

- 使用单调时钟和可测试 scheduler；不以 UI timer 数量推断当前位置。
- 覆盖播放、暂停、继续、停止、定位、后台节流和结束状态。
- 所有文案均为“播放模拟”，不出现设备已输出的暗示。

### M4.5 编辑与历史

- 先实现单点强度/锚点编辑，再实现频率、时长、曲线点增删。
- 编辑命令作用于 Pulse 草稿；stream、metadata 和 diff 始终重新派生。
- 撤销/重做保存领域命令或不可变快照，不保存组件状态。
- 自动点只在受影响锚点区间重算；导出前执行完整校验。
- “智能化手动修改”在基础编辑稳定后作为可取消、可预览、可复现的 reviewed assist
  command 加入，不引入自动提交的黑盒修改。
- VAL-006 的编辑插值与升级复用属于两个验收作用域；M4.5 开始前必须先按
  [PDR-0002](../pdr/0002-release-slicing-and-upgrade-gate.md)
  记录拆分决策，否则原有条件门槛同时约束两者。

### M4.6 版本升级（条件能力）

- 只有满足 PDR-0002 的证据门槛才开始。
- 每条升级规则必须有旧输入、目标输出、变更记录和 App 互操作结果。
- 二次函数仅用于已确认需要该规则的补点场景，不替代当前格式自动点的既有插值语义。
- 只有在 PDR-0002 已记录作用域拆分时，门槛未满足才可只延期升级作用域的 VAL-005 和 VAL-006；VAL-006 的编辑插值作用域按 M4.5 单独验证。未完成拆分决策时，保留原有条件门槛，其余不相关的 M4 能独立发布。

### 退出标准

- [需求追踪矩阵](traceability.md) 中目标为 M4 的条目均为 `Verified` 或有批准的延期 PDR。
- 批量、图片、播放和编辑分别有独立失败隔离，不共享可变全局任务状态。
- 任何转换和编辑都有可复核 change record。

## 6. M5：生产发布

### 实施顺序

1. 固定受支持 Node/Electron/浏览器版本和锁文件，生成 SBOM/许可证报告。
2. 构建 Web、API、Nginx Compose，加入健康检查、优雅停止和只读运行文件系统评估。
3. 按 M2/M4 已冻结的限制契约设置生产默认值，覆盖上传大小、文件数、展开点数、QR 解压大小、并发数和处理时长；M5 不重新发明业务限制。
4. 验证日志脱敏、临时文件删除、代理超时、TLS 边界和安全响应头。
5. 完成性能基线、故障注入、备份/恢复（若届时有持久化）和发布回滚演练。
6. Electron 完成签名/更新策略决策；未决定自动更新时只提供明确的手动发布流程。
7. 发布 runbook、运维检查表、已知限制、精确版本配对和拒绝不匹配 schema/rule 的兼容性矩阵。

当前仓库已落地的发布自动化包括：`vX.Y.Z` tag 校验、完整质量门禁、GHCR API/Web 多架构镜像、Windows
Squirrel 安装程序、macOS DMG、规范命名的便携 ZIP 和 GitHub Release 附件。代码签名、macOS
notarization、SBOM 和完整目标平台人工互操作仍需独立验证，不能由工作流配置本身替代。

### 退出标准

- 新环境可仅凭文档和版本化配置完成构建与部署。
- 健康检查反映真实依赖状态，停止不会遗留处理中临时文件。
- 资源耗尽、畸形输入和取消路径均经过自动化或可重复的故障测试。
- 发布物能回退到上一稳定版本，且不会依赖未记录的数据迁移。
