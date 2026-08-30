# 未知项与证据登记

## 1. 管理规则

未知项不是普通 backlog。只有继续实现会迫使团队猜测格式、产品政策或不可逆数据行为时，才登记在此。每项必须有关闭证据和未关闭时的产品行为。

| ID | 问题 | 当前证据 | 关闭方式 | 未关闭时行为 | 状态 |
| --- | --- | --- | --- | --- | --- |
| OQ-001 | `.example` 中 4–10 section 文件来自哪个 App/工具，当前 DG-LAB 4 App 如何处理？ | E3 有 4–10 section；E1 UI 最多 3 | 目标 App 逐个导入、再导出并记录版本/结果 | 允许语法解析，>3 给 interop warning，不承诺 App 可导入 | Open |
| OQ-002 | 三个全局索引和 section 时长/频率索引的目标 App 精确映射是什么？ | E1 有 UI 语义；E4 有逆向表 | A-02～A-05 App 实验 + 多实现交叉验证 | MVP 保留/展示 index；物理值标记不可用或 derived | Open |
| OQ-003 | 目标 DG-LAB 4 App 的 QR payload 是否仍是已知样例的 20 字段 legacy 格式，如何与 current `.pulse` 互转？ | E5 2024 QR 实测与 current `.pulse` 明显不同 | A-07：同一波形导出 `.pulse` 与 QR，双向导入 | QR 仅识别 candidate，不解码为可编辑 Pulse、不导出 | Open / blocks IO-002/004 |
| OQ-004 | “旧版本”有哪些可识别方言，转换到哪个目标？ | 当前文件无版本标记；只有社区方言记录 | 获得真实源/目标夹具、逐字段规则和产品 PDR | 不提供 upgrade；未知方言明确拒绝 | Open / blocks VAL-005 |
| OQ-005 | 二次函数用于哪些缺点场景，方向、舍入和端点约束为何？ | PRD/TRD 指定公式，未给真实前后夹具 | 获得至少三组 App/业务期望前后样例并接受 PDR | 不自动补点；只展示自动点原值 | Open / blocks VAL-006 |
| OQ-006 | 规范序列化小数位数与结尾换行政策 | E3 全部强度两位小数且看似无换行 | A-01/A-08 App 往返 | M0 parser 保留 token；serializer 完成前必须关闭 | Open / blocks M1 export |
| OQ-007 | `.example` 文件的来源和再分发许可 | 文件名与内容存在，无 provenance manifest | 仓库所有者补充来源/许可 | 只用于本地回归；发布包使用合成派生夹具 | Open |
| OQ-008 | Web 首发部署是否公开暴露在互联网 | PRD 只说可部署 | 发布 PDR 确认 threat model 与运营边界 | 以不持久化、无账户的单请求服务设计；文档不宣称公共托管 | Open / blocks M5 public deployment |

## 2. 已关闭项

暂无。关闭时保留原记录，增加结论、日期、证据链接和影响的 rule set/PDR/ADR，不删除历史。

## 3. 搜索与实验顺序

1. 检查 DG-LAB 官方帮助、官方协议仓库、官方 SDK、官方发布说明。
2. 对目标 App 版本做可复现实验。
3. 检查维护活跃且有测试/源码的社区实现。
4. 最后才使用单篇逆向文章、Issue 或工具页面提出假设。

外部链接会变化。关键结论必须落为本仓库的最小夹具、哈希、实验步骤和观察结果，不能只保存 URL。
