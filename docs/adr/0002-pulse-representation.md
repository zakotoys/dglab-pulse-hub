# ADR-0002：语法、领域和派生模型分离

## 状态

Accepted — 2026-08-30

## 背景

`.pulse` 是无公开完整规范的紧凑文本格式。项目既要精确定位语法错误和展示原始索引，又要展开 stream、编辑和规范导出。如果只用一个可变对象表示所有阶段，原始 token、验证状态、派生点和 UI 临时状态会互相污染。

强度样例包含两位小数；JavaScript `number` 不能精确表示所有十进制小数。频率/时长物理映射也未完全验证。

## 决策

使用三个明确分离的表示层：

```text
bytes/text
  -> PulseSyntaxDocument   # token、结构、source span、原始十进制
  -> PulseDocument         # 已验证的规范领域值与原始索引
  -> WaveformStream        # 给定 RuleSet 的确定性派生序列
```

### PulseSyntaxDocument

- 可以表示结构正确但范围/语义不合法的输入。
- 保留每个字段 token 和 source span，供诊断与规范化 diff。
- 不暴露给 UI 作为可编辑业务对象。

### PulseDocument

- 只能由 validation/normalization 成功创建。
- section 和 point 使用只读有序集合；编辑命令返回新文档。
- 全局、频率、时长保留 index 值；物理值不是权威字段。
- 强度使用定点整数（初始精度在 OQ-006 后定稿）或经评审的十进制类型，serializer 不依赖二进制浮点格式化。
- 不包含文件路径、任务状态、UI selection 或 stream cache。

### WaveformStream

- 由 `PulseDocument + RuleSetId` 纯函数生成。
- point 包含时间位置、持续时间、强度、频率 index、可选 derived 物理值、section/shape source 和 derivation kind。
- stream 不反向修改 Pulse；UI 编辑必须发送领域命令。
- 派生前计算资源上限，禁止在内存分配后才发现超限。

### 诊断与变更

- `Diagnostic` 独立于文档，包含稳定 code/severity/location/parameters。
- `ChangeSet` 记录显式 normalize/edit/upgrade 的 before/after path 与原因。
- message 本地化在边界层完成，核心逻辑不比较 message。

## 解析策略

实现小型确定性 parser，由识别、词法/分段和结构解析组成。不使用 `split` 后静默忽略多余字段，也不用单个巨型正则完成所有语义。

解析与校验分离，但 parser 可在不可能继续定位时返回 syntax diagnostics。validator 不能修复 syntax tree。

## 序列化策略

只有 `PulseDocument` 可序列化。serializer 产生单一规范文本；随后重新 parse/validate 并执行语义等价检查。原始文本快照只用于展示和 diff，不建立“尽量原样”的第二序列化路径。

## 未选择的方案

### 直接 `split` 到普通 JavaScript 对象

拒绝。难以保留位置、区分空字段和额外字段，也容易接受 `parseInt` 的部分字符串。

### 全部数值使用 `number`

拒绝。小数词法往返与舍入不可控。

### 直接编辑 WaveformStream

拒绝。stream 重复并派生自 section，点位修改不总能无歧义地回到 Pulse。

### 领域对象保留所有原始格式细节

拒绝。语义模型会被空白/小数位等词法细节污染。source span 与 raw token 属于 syntax 层。

## 影响

- parser、validator、normalizer、stream builder、serializer 可以独立 TDD。
- UI 必须通过来源映射把 stream point 操作转换成明确领域命令。
- 规则集变化不会破坏源索引，可重新派生并比较结果。
- 初始代码量略高于直接 `split`，但避免后续为诊断、编辑和跨端一致性重写模型。
