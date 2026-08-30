# 产品化实施计划

## 1. 前置条件

只有 [核心闭环计划](core-mvp.md) 完成并发布内部契约版本后，才开始本计划。UI 和 adapter 不得补做或覆盖领域校验。

## 2. M2：单文件工作台

### 2.1 共享交互模型

工作台共享以下 view model，而不是共享文件系统或 HTTP 细节：

- 当前文档摘要、原始导入快照标识和规则集 ID；
- 任务状态、诊断分组和选中位置；
- metadata 层级与 stream viewport；
- 未保存/可导出状态；
- 用户选择的展示单位和派生值置信度。

Web 与 Electron renderer 使用同一 UI workspace。平台能力通过窄接口注入：`openInput`、`saveOutput`、`inspect`、`export`。不建立一个可任意调用方法的通用 bridge。

### 2.2 Web API 切片

#### WB-01：契约

- `POST /api/v1/pulses/inspect`：单文件 multipart 上传，返回 `OperationResult<InspectResultDto>`。
- `POST /api/v1/pulses/export`：提交规范 Pulse DTO 或已上传文本，返回下载响应与摘要 header。
- `GET /health/live` 与 `GET /health/ready`：仅部署健康，不泄露配置。

先写 schema 契约测试和恶意 multipart 测试，再选择 HTTP 库并实现。M2 不提供异步任务 API、文件 ID、账户或分享 URL。

#### WB-02：资源与隐私

- 请求体、文件数、文件 bytes、解析点数、处理时间全部有硬限制。
- 上传只在请求内存/受控临时目录存活，请求结束清理。
- 日志使用 request ID 和诊断 code，不记录完整文件名或内容。
- 错误响应不包含堆栈；内部异常关联 server log event ID。

#### WB-03：API 验收

- 契约 schema 能同时验证成功、拒绝和失败响应。
- 客户端中断、超限、畸形 multipart 和解析拒绝都释放资源。
- API 结果与 CLI 规范化后相等。

### 2.3 Web 工作台切片

#### UI-01：导入与诊断

- 首屏是工作区和导入动作。
- 拖放/文件选择后立即显示任务状态。
- 错误按文件、section、字段/点定位，可跳转到对应 metadata/时间轴位置。
- warning 与 error 同时有文字、code 帮助和非纯颜色标识。

#### UI-02：metadata 与时间轴

- 文件/Pulse/section/stream 分层浏览。
- 时间轴的频率索引与强度分轨；物理值只有在规则集提供时显示。
- 长 stream 使用 viewport 裁剪或成熟可视化库的数据降采样能力；原始 hover 值来自 stream DTO。
- 键盘、触控与缩放状态不会改变领域数据。

#### UI-03：导出

- 只有通过导出前校验才启用成功下载。
- 明确显示规范化会改变的词法格式与不变的语义。
- 下载文件名由安全的原名 stem + 操作后缀产生，不信任上传路径。

### 2.4 Electron 切片

#### EL-01：安全窗口

- `contextIsolation: true`、`sandbox: true`、renderer 无 Node integration。
- CSP 默认拒绝远程脚本；拦截导航、新窗口和非预期协议。
- preload 只暴露已校验 DTO 的窄方法。

#### EL-02：本地文件

- 主进程负责原生 open/save dialog 与文件 adapter。
- renderer 不接收绝对路径，除非展示所必需且经过脱敏。
- 本地处理直接调用应用层，不依赖 Web API。

#### EL-03：跨端测试

- Playwright 浏览器测试覆盖 Web 主流程。
- Electron 自动化覆盖启动、导入、诊断、时间轴和导出；原生 dialog 在主进程测试中确定性替换。
- 独立契约测试比较 CLI、API 和 IPC 的领域结果。

## 3. M3：批处理

### BT-01：领域外编排

批处理只组合单文件用例，不把多文件状态放进 `pulse-core`。先写部分失败、取消和重复输入测试。

### BT-02：结果模型

- 总计、已完成、成功、拒绝、失败、warning 文件数。
- 每个输入有稳定 task item ID、操作、状态、诊断和输出意图。
- 取消停止尚未开始的项目；正在执行的 adapter 通过 `AbortSignal` 协作取消。
- 结果顺序按输入顺序稳定，不按异步完成顺序漂移。

### BT-03：输出冲突

默认不覆盖。批量开始前预计算安全输出名和冲突，冲突项单独拒绝；已经成功的其他项不回滚。

## 4. M3：图像导出

### IMG-01：共享绘图场景

先定义与 renderer 无关的绘图场景：尺寸、坐标域、轨道、折线/点、标注和无障碍文本。SVG 是第一权威输出。

### IMG-02：栅格输出

在核对依赖文档、Node/Electron 支持和许可证后，使用同一 SVG/scene 栅格化 PNG/JPG，不分别实现三套坐标计算。

### IMG-03：测试

- 结构测试：SVG 包含预期 viewBox、轨道和点数摘要。
- 像素测试：PNG/JPG 非空、尺寸正确、关键区域非透明/非纯色。
- 数据测试：图像 metadata 中的 stream digest 与输入一致。
- 视觉回归：少量代表夹具，阈值和字体环境固定。

## 5. M3：QR adapter

### QR-01：证据门禁

必须先提供至少以下夹具：目标 App 导出的完整 QR 字符串、解码后的 payload、对应界面设置、App 版本，以及至少一个本项目输出被目标 App 接受的记录。

### QR-02：安全解码

严格执行 URL/fragment -> hex -> gzip -> Base64 -> legacy payload，各阶段分别限制输入和输出大小。拒绝奇数 hex、非 hex、gzip 尾随多成员、解压炸弹、非法 Base64 和未知 payload 字段数。

### QR-03：语义转换

QR legacy model 与 current Pulse model 分离。转换必须列出：

- 强度 `0..20` 与 `0..100` 的比例和舍入；
- `type-strength` 与 `strength-anchor` 的字段顺序；
- 3-section 固定元数据与可变 section 列表；
- 休息、速度、平衡、时长和频率索引映射；
- 无法保留的字段与阻断/警告策略。

不存在完整转换表时，只允许“解码并检查”，不允许导出 QR。

## 6. M4：编辑器

### ED-01：领域命令

每个编辑是带前置条件的领域命令，例如 `SetStrengthPoint`、`SetAnchor`、`SetSectionFrequencyRange`。命令返回新文档、change set 和诊断，不直接修改共享对象。

### ED-02：撤销/重做

历史保存领域命令或紧凑不可变快照；导入原始快照不在历史中被覆盖。新编辑发生后清空 redo 分支。

### ED-03：自动点重算

先用表格测试固定 `f(x) = 1 - (1 - x) ** 2` 的方向、端点、精确域、舍入和裁剪，再实现一个共享插值服务。只重算相邻锚点包围且受影响的自动点。

起点/终点不是锚点、只有一个锚点或连续锚点的行为在实现前必须由 PDR/格式实验定稿。

### ED-04：差异与保存

- diff 分结构、metadata、stream 和规范文本四层。
- 未保存状态来自当前文档 digest 与最后保存 digest，不靠 UI 手工布尔值。
- 保存/导出前重新执行完整校验和往返等价。

## 7. P1 Definition of Done

- 单文件 Web/Electron、批处理、图片和已验证 QR 各自有端到端测试。
- UI 不包含 parser/validator 的重复规则。
- 所有平台输出都携带相同 contract/ruleset 版本。
- 资源上限来自基准并在 API、Electron 和 CLI 一致执行。
- 需求追踪矩阵无“implemented but untested”项。
- 若 QR 或规则变换证据门禁未关闭，则明确从 P1 发布范围移除，而不是以实验性成功路径发布。
