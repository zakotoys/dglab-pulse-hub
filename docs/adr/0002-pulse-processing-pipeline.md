# ADR-0002：`.pulse` 两阶段解析与派生模型

| 项目 | 内容 |
| --- | --- |
| 状态 | Accepted |
| 日期 | 2026-08-30 |
| 关联 | TRD 4-7、13；PDR-0001 |

## 背景

`.pulse` 是带自定义分隔符的文本格式。样例包含有效零值、小数、启用/禁用 section 和多层位置。将字符串直接 `split` 后塞入最终领域对象，容易把缺失值当默认值、在解析时取整、丢弃禁用 section，并让错误无法定位。另一方面，为小语法引入通用 parser generator 会增加不必要复杂度。

## 决策

采用手写、全量消费、两阶段 pipeline：

```text
SourceDocument
  -> recognize
  -> parse syntax
  -> SyntacticPulse
  -> validate/normalize profile
  -> Pulse
  -> derive metadata / WaveformStream
  -> validate export
  -> source or canonical serialize
```

### 语法阶段

- 使用小型 cursor/token reader，不使用宽松的嵌套 `split` 作为完整 parser。
- 每个 token 保存原始 lexeme、解析值和字符范围。
- 区分缺失、空、非法、非有限数和合法零。
- 保留所有 section，包括禁用项，并要求消费到 EOF。
- 语法错误可以返回带位置的 invalid syntax result，但绝不返回可编辑 Pulse。

### 语义阶段

- 按明确的 format profile 校验字段数量、范围和组合规则。
- 使用中性字段名保存未证实字段；物理频率/时长映射是独立规则表，不污染原始索引。
- Pulse 是不可变值对象或只读数据；编辑通过明确 command 生成新 Pulse 和 change record。
- source snapshot 与 Pulse 分离，避免派生值或 UI 状态改写原输入。

### 派生阶段

- metadata 和 WaveformStream 都是纯函数结果，可按 Pulse revision 缓存，但缓存不是领域状态。
- stream 基本逻辑粒度为一个曲线点 100 ms；每个点记录 section、脉冲元重复序号和源曲线点。
- section 实际时长使用完整脉冲元向上取整规则。
- 四种频率模式分别实现并以表格测试固定；未确认物理映射时 stream 保留 index/normalized 值，不伪装为 Hz。

### 数值与序列化

- 领域强度保留十进制语义；实现前通过样例和库能力决定使用受约束 number 还是成熟 decimal 库，不自行实现十进制定点算法。
- 未修改导出直接使用 source bytes。
- canonical serializer 是唯一修改后写出路径；不提供多个格式化方言或旧 serializer fallback。

## 不采用的方案

- **正则一次解析整个文件**：难以给出字段/点位位置和局部错误。
- **`split` + 宽松默认值**：会把非法输入和合法零混合。
- **parser generator**：语法规模小，生成工具与运行时不降低总复杂度。
- **解析时直接生成设备 HEX**：设备帧不属于当前文件领域范围，也会丢失编辑语义。
- **在 Pulse 内保存 stream**：派生数据会过期并增加撤销/编辑一致性负担。

## 影响

- parser、validator、expander 和 serializer 是独立测试单元。
- raw/source、syntax、semantic、derived 四类数据在类型上可区分。
- 诊断位置可以稳定映射到源文本和结构路径。
- 将来确认新画像时替换/增加明确规则集；不在当前 parser 中堆叠猜测分支。

## 依据

- [DG-LAB 官方自定义波形帮助](https://www.dungeon-lab.cn/instructions-cn.html)
- [本地语料分析](../research/pulse-corpus.md)
- [格式研究](../research/dglab-pulse-format.md)

