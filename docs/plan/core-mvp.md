# 核心闭环实施计划

## 1. 范围

本计划覆盖 M0 工程骨架与 M1 CLI 闭环。目标是在进入 UI 开发前得到可发布、可复用的 `.pulse` 内核和应用用例。

不包含 QR、批处理、图片、编辑器、账户、数据库和设备通信。

## 2. 目标目录与依赖方向

目录名可在首次脚手架提交中微调，但依赖方向不得反转：

```text
packages/pulse-core        # 领域类型、解析、校验、派生、序列化
packages/pulse-application # inspect/export 用例、结果与任务语义
packages/contracts         # HTTP/IPC/CLI 可序列化 DTO 与 schema
apps/cli                   # 文件系统与命令行适配器
tests/fixtures             # 合成与经许可的固定夹具、manifest
```

```text
apps/cli -> pulse-application -> pulse-core
    |              |
    +------------> contracts
```

`pulse-core` 不导入其他 workspace；`contracts` 不导入 Electron、HTTP server 或 UI。具体边界见 [ADR-0001](../adr/0001-workspace-and-layers.md)。

## 3. 工程基线

### CM-01：工作区

- Node.js 24 LTS 与仓库锁定的 npm major。
- npm workspaces；单一根 `package-lock.json`。
- TypeScript strict、ESM、统一 `tsconfig` 基线。
- 根命令至少包含 `test`、`test:coverage`、`typecheck`、`lint`、`build`。
- 依赖版本精确落锁；运行时与开发依赖分开。

完成证据：干净检出后执行 `npm ci` 和所有根命令成功。

### CM-02：测试基线

- 单元/属性测试运行器在依赖选型前核对官方文档和类型能力。
- 测试可以按 workspace 运行，也能从根一次运行。
- 覆盖率按核心包分开报告；初始门槛以语句/分支 `90%/85%` 为底线，但不能用无断言测试填充。
- 随机/属性测试记录 seed，失败可重放。

完成证据：故意破坏一个 parser 分支会使 CI 失败。

## 4. 领域切片

### CM-03：值对象与语法树

测试先行：构造合法/非法的精确十进制、索引、模式、boolean flag 和 source span。

实现最小类型：

- `PulseSyntaxDocument`：保留解析结构、原始 token 和 source span。
- `PulseDocument`：只包含受支持且验证后的规范语义。
- `PulseSection`、`StrengthPoint`、`Diagnostic`、`RuleSetId`。
- 精确强度采用十进制定点表达（例如百分之一单位）或经验证的十进制库，不把 `0.1` 直接作为领域权威值。

完成标准：任何从 syntax 到 domain 的失败都返回诊断，不能产生半合法对象。

### CM-04：解析器

测试先行顺序：最小合法 -> 16 个语料 -> 每个语法错误 -> 资源上限。

实现阶段：识别、UTF-8 解码、tokenize/分段、结构解析。每层只负责本层错误。

完成标准：parser 是总函数式 API；对任意字节输入返回 `Result`，不泄漏内部异常或部分状态。

### CM-05：校验器

测试先行顺序：单字段边界 -> section 组合 -> 文档组合 -> 多诊断去级联。

实现 validator：

- `syntax`：字段与分隔符已经由 parser 保证。
- `range`：产品支持范围。
- `semantic`：点数、模式所需字段、启用/禁用规则和可展开性。
- `interop`：超出官方 UI 已证实范围但语法受支持的 warning。
- `resource`：字节数、section 数、点数和展开点数硬限制。

完成标准：诊断 code、severity、location、parameters 稳定；message 只是本地化呈现。

### CM-06：WaveformStream

先实现且测试以下最小语义：

- 一个 shape point 对应 `100 ms`；
- section 由完整脉冲元重复，重复次数向上取整且至少一次；
- 禁用 section 不进入可播放 stream，但保留在 Pulse metadata；
- 每个 stream point 保留 section/shape 来源和锚点状态；
- 四种频率模式使用索引域计算，物理 Hz 映射为可选派生字段。

必须分别记录目标时长、实际时长和因完整重复产生的超出量。休息时间是否进入 stream 必须由 OQ-002 的规则集决定；在此之前作为独立 segment，不伪造点。

完成标准：相同 document + rule set 得到字节级稳定的 DTO；大 stream 有预先检查的上限。

### CM-07：metadata

从领域对象和 stream 派生，不读取 UI 状态：

- 文件 metadata 由 adapter 提供，领域层不保存本地路径。
- Pulse/section metadata 包含原始索引、观察范围、目标/实际时长和诊断计数。
- stream metadata 包含点数、总时长、索引范围、可选物理值范围和 ruleset。
- 点位 metadata 包含时间、来源、强度、频率索引、锚点和派生置信度。

完成标准：metadata 的每个数字都有单元或 `index` 后缀，不出现单位不明的 `duration`/`frequency`。

### CM-08：序列化与等价

测试先行：最小文档、每种模式、自动点、小数、禁用 section、最大语料、属性往返。

规范输出：一个前缀、一个字段顺序、一个小数政策、无 BOM、无多余空白。原始文本可作为导入快照供比较，但 serializer 不承担“保留任意原格式”的双重职责。

语义等价比较至少覆盖：

- 全局三个原始索引；
- section 数量、顺序、五个头字段；
- 每个强度点的精确值与 anchor；
- 使用同一规则集时的 stream。

完成标准：serializer 只接受已验证 `PulseDocument`；不提供 `force` 跳过校验。

## 5. 应用用例切片

### CM-09：统一结果

定义 transport-neutral `OperationResult<T>`：

- `status`: `success | rejected | failed | cancelled`；
- `data`: 仅成功或带可用部分结果时存在；
- `diagnostics`: 稳定排序；
- `ruleSetId` 与 `contractVersion`；
- `timing` 只用于观察，不参与契约等价；
- 不包含 Error 对象、绝对路径或不可序列化类型。

### CM-10：inspect

输入字节与安全的来源描述，输出识别、Pulse、metadata、stream 摘要和诊断。默认不返回完整原文，调用方显式请求时也受大小限制。

### CM-11：export

输入已验证 Pulse 或待检查的文本与明确目标路径意图，先在内存完成 serialize -> parse -> equivalence，再由文件 adapter 原子写入目标。

输出冲突不默认覆盖；调用方必须选择新路径。失败时不留下看似成功的部分文件。

### CM-12：任务状态

单文件任务状态机：

```text
pending -> running -> succeeded
                   -> rejected
                   -> failed
                   -> cancelled
```

非法用户输入是 `rejected`，适配器或内部意外是 `failed`。这一区分必须在 CLI/API/IPC 中一致。

## 6. CLI 切片

### CM-13：命令与退出码

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pulse inspect <file> [--json]` | metadata、stream 摘要、诊断 | 0 成功/仅 warning；2 输入拒绝；1 系统失败 |
| `pulse export <input> <output> [--json]` | 规范 `.pulse` 和往返结果 | 同上 |

参数使用成熟 CLI 库前先核对其 ESM、类型、错误处理和 help 测试能力。M1 不加入配置文件、插件系统或交互式 shell。

### CM-14：文件 adapter

- 扩展名只用于文件选择提示，不决定格式。
- 读取前检查文件 metadata，读取中仍限制实际 bytes。
- 输出使用同目录临时文件 + 原子 rename；明确处理 Windows 目标冲突。
- 面向人的错误不打印完整内容；`--json` 输出稳定 schema。

## 7. M1 验收场景

1. 对 16 个样例逐个 inspect，全部返回结构与语料统计一致的结果。
2. 对包含禁用 section 的样例，Pulse 保留 section，stream 排除其播放点并给出计数。
3. 对自动点与小数强度样例，往返后精确值和 anchor 不变。
4. 对含 10 个 section 的样例，按支持政策解析并给出 App 互操作 warning。
5. 对损坏分隔符和超限输入，CLI 不生成输出且退出码为 2。
6. 对无写权限和输出冲突，CLI 退出码为 1，原输入与已有输出不变。
7. 运行同一命令两次，除 timing 外 JSON 结果完全一致。

## 8. Definition of Done

- 上述 CM-01～14 全部满足完成标准。
- PRD 追踪矩阵中的 M1 需求都有自动化测试 ID。
- 核心 API 有面向贡献者的最小使用文档，且示例在 CI 编译/执行。
- 性能基准记录最长语料、产品上限和超限拒绝的时间/内存。
- 没有 TODO 形式的协议猜测进入成功路径；未知项都在 [open-questions.md](open-questions.md) 有负责人和门禁。
