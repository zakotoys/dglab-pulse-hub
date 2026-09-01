# PDR-0001：`.pulse` 支持画像与导出保真承诺

| 项目 | 内容                                   |
| ---- | -------------------------------------- |
| 状态 | Accepted                               |
| 日期 | 2026-08-30                             |
| 关联 | IO-001、IO-003、VAL-001..004、EDIT-006 |

## 背景

官方帮助页公开了自定义波形的产品语义，但官方协议仓库没有完整 `.pulse`
文件规范，文件内也没有显式版本号。项目语料则包含 1 至 10 个 section、小数强度和超过三个启用 section 的文件。若把 App 版本、文件画像和社区解析器版本混成一个“版本”，产品会给出无法证明的兼容承诺。

## 决策

### 支持画像

首个支持画像命名为
`dungeonlab-pulse-text/corpus-v1`，只表示本项目验证过的文件语法和语义规则，不声称是官方文件版本。其输入边界为：

- UTF-8 明文，以精确前缀 `Dungeonlab+pulse:` 开始。
- 三个全局数值字段、一个 `=`、1 至 10 个 section。
- section 使用 `+section+` 分隔，含五个头字段、`/` 和至少两个曲线点。
- 曲线强度保留十进制数值；anchor/type 只接受明确支持值。
- 禁用 section 仍属于 Pulse 源结构，不在解析时丢弃。
- QR 是同一明文的 envelope；进入 M4 前不属于 M1 输入画像。

精确范围必须由格式研究、语料测试和互操作结果共同冻结在 rule
version 中。语料未出现某个值，不足以证明该值非法；社区代码中的范围也不能单独升级为产品事实。

### 识别结果

识别结果分别报告：

- `format`：明文 `.pulse`、QR envelope 或 unsupported。
- `profile`：当前匹配的支持画像，无法匹配时为 unknown/unsupported。
- `ruleVersion`：本项目解析/校验/展开规则版本。
- `evidence`：`official-semantics`、`corpus-observed`、`community-inferred` 或 `unverified`。

不从文件名或 App 名称推导文件版本，不把 `ruleVersion` 展示成文件版本。

### 导出保真

- 未修改 Pulse 的默认导出使用不可变源快照，目标是字节相同。
- 发生编辑、升级或用户明确选择“规范化”后，使用规范 serializer，目标是受支持语义等价和 App 互操作，而不是原始排版相同。
- serializer 在导出前完整校验；不能表达的值阻断导出，不静默裁剪。
- 规范化造成的小数格式、舍入或其他语义变化必须进入 change record。

## 不采用的方案

- **把目标命名为“DG-LAB 4.0 文件版本”**：文件缺少可验证版本标识，名称会制造错误确定性。
- **只保留 JavaScript number 并统一取整**：样例含两位小数，会在解析阶段丢失信息。
- **所有导出都原样返回源文本**：编辑后无法表达变化，也无法建立确定 serializer。
- **接受任意 section 数量**：无法建立资源上限，也与当前语料支持范围不符。

## 影响

- UI 应显示“支持画像/规则版本”，而非杜撰的文件版本。
- parser 需要保留 source snapshot、lexeme 和位置；领域模型可以使用验证后的数值。
- M0 必须先完成 corpus manifest 和互操作记录。
- 未来新画像直接替代旧画像或作为明确的新目标；不为未发布试验行为保留 fallback。

## 证据

- [DG-LAB 官方自定义波形帮助](https://www.dungeon-lab.cn/instructions-cn.html)
- [DG-LAB 官方蓝牙协议仓库](https://github.com/dungeonlab-open/dglab-bluetooth-protocol)
- [本地语料分析](../research/pulse-corpus.md)
- [外部格式研究](../research/dglab-pulse-format.md)
