# `.pulse` 格式基线计划

## 1. 目标

在实现解析器之前，把可证实的格式事实固化为夹具、规则表和诊断契约。该计划的结果不是宣称得到官方规范，而是形成一个有明确证据边界、可被新证据修正的支持配置。

关联决策：[PDR-0002](../pdr/0002-format-support-policy.md)、[ADR-0002](../adr/0002-pulse-representation.md)。

## 2. 证据等级

| 等级 | 来源 | 可以支撑的实现行为 | 不可以支撑的行为 |
| --- | --- | --- | --- |
| E1 | DG-LAB 官方帮助、官方协议仓库、官方 SDK | 产品术语、设备帧、公开 UI 行为、时间粒度 | 未公开的 `.pulse` 字段语义 |
| E2 | 经目标版本 App 导入/导出的可复现实验 | 对该 App 版本的文件/QR 互操作规则 | 推广到未测试版本 |
| E3 | 仓库 `.example` 语料 | 词法、结构、观察范围、回归行为 | 声称语料来源版本或官方上限 |
| E4 | 多个独立社区实现一致的逆向结论 | 形成带规则集 ID 的候选映射 | 静默当作官方事实或无警告转换 |
| E5 | 单一社区实现、Issue 或个人文章 | 设计实验和风险清单 | 直接成为阻断/自动修正规则 |

冲突处理：E2 对其明确测试版本优先于 E3/E4；E1 只在官方确实覆盖该主题时优先。E3 与官方 UI 上限冲突时，解析器可支持语料结构，但必须诊断其 App 互操作性未经确认。

## 3. 当前语料基线

截至 2026-08-30，`.example` 包含 16 个 `.pulse` 文件，共 15,364 bytes。解析前的只读统计如下：

| 特征 | 观察结果 |
| --- | --- |
| 文件大小 | 170–2,768 bytes |
| 前缀 | 全部为 `Dungeonlab+pulse:` |
| 全局字段 | 全部为 3 个整数；出现 9 种组合 |
| section 数 | 1–10；分布覆盖 1、2、3、4、5、6、9、10 |
| section 总数 | 69 |
| 频率索引 | 观察到 `0..83` |
| 时长索引 | 观察到 `0..73` |
| 频率模式 | 观察到 `1`、`2`、`3`；未覆盖 `4` |
| 启用值 | `0` 或 `1`；67 个启用、2 个禁用 |
| 每 section 点数 | 2–106 |
| 强度 | `0.00..100.00`，样例使用两位小数 |
| 点类型 | 后缀 `0`/`1`；共 709 个自动点、977 个锚点 |

这些是 E3 观察结果，不自动等于协议范围。特别是官方当前帮助页描述单段波形最多三个连续 section，而语料包含最多十个 section；需要 OQ-001 的 App 实验确定来源和互操作性。

### 3.1 语料治理任务

- 为每个文件记录 SHA-256、字节数、section 数、点数、观察字段范围。
- 不直接修改 `.example`；从中选取的测试夹具复制到测试目录并记录来源哈希。
- 增加最小合法、每种模式、禁用 section、自动点、小数边界和最大语料夹具。
- 人工构造的非法夹具必须放在独立目录，并在文件名或 manifest 中写明预期诊断 code。
- 若样例授权或来源未知，在发布包中只保留派生的最小合成夹具，不默认再分发原文件。

## 4. 当前语法假设

以下 E3/E4 假设用于设计第一批测试，不在验证前标记为最终格式规范：

```ebnf
document       = "Dungeonlab+pulse:", globals, "=", section,
                 { "+section+", section } ;
globals        = integer, ",", integer, ",", integer ;
section        = sectionHead, "/", point, { ",", point } ;
sectionHead    = integer, ",", integer, ",", integer, ",",
                 integer, ",", integer ;
point          = decimal, "-", integer ;
integer        = "0" | nonZeroDigit, { digit } ;
decimal        = integer | integer, ".", digit, { digit } ;
```

第一版语法政策：

- 只接受 ASCII 结构字符和无符号十进制；不接受指数、正号、负号、`NaN`、`Infinity` 或区域化逗号。
- 文件内容按严格 UTF-8 解码；可在识别阶段接受 UTF-8 BOM 并给出规范化 warning，导出不写 BOM。
- 除单个结尾换行外，不接受结构外空白；最终是否接受 CRLF/LF 由 App 往返实验确认。
- 数值先以词法 token 和精确十进制保存，不在解析阶段转成二进制浮点并取整。
- 语法解析不猜字段默认值、不补缺失 section、不删除尾随字段。

## 5. 字段置信度表

| 位置 | 暂定名称 | 当前证据 | 实现政策 |
| --- | --- | --- | --- |
| 全局 0 | `sectionRestIndex` | 官方有休息时间 UI；字段映射来自 E4 | 保留整数索引；物理秒数需规则集 |
| 全局 1 | `playbackSpeed` | 官方 UI 与 E3 值 `1/2/4` 一致 | 校验支持集合前先做 App 实验 |
| 全局 2 | `frequencyBalanceIndex` | 官方有高低频平衡 UI；位置来自 E4 | 保留索引，不假定物理单位 |
| section 0/1 | `frequencyStartIndex` / `frequencyEndIndex` | 官方有一/双滑块与 E4 映射 | `0..83` 先作为支持范围；Hz 为派生值 |
| section 2 | `durationIndex` | 官方有 section 持续时间；位置来自 E4 | 保留索引；目标时长与实际时长分开 |
| section 3 | `frequencyMode` | E1 明确四种模式，E3/E4 明确编号 | 支持 `1..4`，为模式 4 增加合成夹具 |
| section 4 | `enabled` | E3/E4 | 只接受 `0/1`；禁用 section 仍保留 |
| point 左值 | `strength` | E3 为 `0..100`；E4 当前 `.pulse` 实现 | 精确小数；设备帧取整属于后续 adapter |
| point 右值 | `anchor` | E1 描述锚点/自动点；E3/E4 映射 | 只接受 `0/1`；不在解析时重算自动点 |

字段名表达当前最佳语义，但原始整数仍是权威值。任何 Hz、秒或设备帧映射都必须注明 `derivationRuleSet`。

## 6. QR 是独立研究对象

当前第三方实测的官方分享二维码包含完整 URL，片段形式为 `#DGLAB-PULSE#<hex>`。hex 经 gzip 解压后得到 Base64，再解码得到的是 20 字段 legacy 元数据与 `type-strength` 点串；它与 `.example` 的当前 `.pulse` 明文在字段数量、点顺序和强度范围上都不同。

因此：

- M0/M1 不把 QR 识别为 `.pulse` 的透明封装。
- 输入识别可以报告 `qr-share-candidate`，但在目标 App 夹具验证前不进入 Pulse 编辑态。
- QR adapter 需要独立源模型、明确到规范 Pulse 的转换表和不可逆诊断。
- 不使用 URL 的任意 `includes` 匹配；应解析 URL fragment 或严格匹配裸 fragment，并限制 hex、解压大小和嵌套步骤。

## 7. TDD 任务清单

### FB-01：语料清单

先写测试/检查：manifest 中每个哈希都能匹配磁盘文件，重复内容可识别。

实现：只读扫描脚本和 machine-readable manifest。脚本输出稳定排序，不写回 `.example`。

完成标准：CI 能发现样例被意外修改、删除或新增但未登记。

### FB-02：输入识别

先写失败用例：空输入、随机文本、JSON、裸 QR fragment、完整 QR URL、大小写变化、前缀前空白、BOM。

实现：只识别 `pulse-text`、`qr-share-candidate`、`unsupported`；识别不执行完整解析。

完成标准：所有路径返回稳定 code，不用文件扩展名决定内容类型。

### FB-03：词法与结构解析

先写失败用例：每一个分隔符缺失/重复、字段过多/过少、空点、负数、指数、小数点缺位、尾随垃圾。

实现：小型确定性解析器或清晰的分段 parser；不使用一个覆盖全文的巨型正则。

完成标准：错误位置至少包含 byte/character offset、section index 和字段/point index（可确定时）。

### FB-04：范围与语义

先写失败用例：频率索引 `-1/84`、模式 `0/5`、enabled/anchor 非 `0/1`、强度越界、零点/单点、超出产品资源上限。

实现：语法、范围、互操作风险、资源限制四组 validator，可聚合非级联诊断。

完成标准：同一错误不会因客户端不同得到不同 severity。

### FB-05：规范序列化

先写属性：`parse(serialize(parse(x)))` 与第一次 parse 的规范语义相等。

实现：唯一字段顺序、ASCII 分隔符、无 BOM/尾随空白；小数格式政策由实验定稿。

完成标准：16 个样例往返通过；任何舍入或词法变化都显式可见。

### FB-06：派生规则实验

先写表格测试：官方帮助描述的四种模式、完整脉冲元向上取整、每点 100 ms。

实现：先提供 index-based stream；频率/时长物理映射放在命名规则集中。

完成标准：E4 映射不得覆盖源索引；规则集切换会改变 ID 并在结果中可见。

## 8. App 实验矩阵

每次实验记录 App 完整版本、平台、设备型号（若相关）、输入、操作、导出原文/QR、结果截图和结论。

| 实验 | 最小变量 | 需要回答的问题 |
| --- | --- | --- |
| A-01 | 单 section、两个锚点 | 最小点数、强度小数格式、结尾换行 |
| A-02 | 分别设置四种模式 | 模式编号与起止索引方向 |
| A-03 | 调整休息/速度/平衡各一档 | 三个全局字段的精确映射和范围 |
| A-04 | 调整 section 时长全范围代表点 | `durationIndex` 到目标时长映射 |
| A-05 | 增减自动点/锚点 | 自动点序列化、插值和删除规则 |
| A-06 | 1、2、3、4、10 section 文件导入 | 当前 App 对超 UI section 的接受、保留或截断行为 |
| A-07 | `.pulse` 导出并生成分享 QR | 两种载荷是否能互转、是否随 App 版本变化 |
| A-08 | 修改词法格式 | 整数/小数、BOM、LF/CRLF、前导零容忍度 |

## 9. 格式基线退出标准

- OQ-001、OQ-002 已关闭，或产品明确采用 index-only MVP 并展示限制。
- 当前支持语法、观察范围、产品资源上限与 App UI 上限分别记录。
- 所有语义规则都能追溯到 E1–E5 来源和规则集 ID。
- `.pulse` 与 QR 不再共用未经验证的解析路径。
- 新贡献者可以只凭夹具 manifest、规则表和测试复现全部格式判定。

## 10. 当前证据入口

官方来源优先：

- [DG-LAB 用户自定义波形介绍](https://www.dungeon-lab.cn/instructions-cn.html)：1–3 section、100 ms 竖线、完整脉冲元向上重复、锚点与四种频率模式。
- [DG-LAB 官方蓝牙协议仓库](https://github.com/dungeonlab-open/dglab-bluetooth-protocol)：设备帧与时间粒度，不包含完整 `.pulse` 文件规范。
- [DGLAB KIT](https://github.com/dungeonlab-open/dglab-kit)：面向 DG-LAB 4 App 的 V3/V4 Socket 与波形帧接口。

第三方来源用于提出和交叉验证假设：

- [sse-dg-lab waveform parser](https://github.com/admilkjs/sse-dg-lab/blob/main/src/waveform-parser.ts)：current `.pulse` 字段与派生实现。
- [DG-LAB APP QR 逆向记录](https://fang.blog.miri.site/archives/990/)：完整 QR URL、hex/gzip/Base64 流程和 20 字段 legacy payload 样例。

引用社区实现不等于采用其全部算法。实现任务仍需把结论转成最小夹具，并按 E1–E5 标注。
