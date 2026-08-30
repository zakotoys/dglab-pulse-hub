# 质量与发布计划

## 1. 质量策略

测试金字塔围绕领域确定性建立：大量纯函数/属性测试，少量 adapter 契约测试，最少但完整的跨端用户流程。测试不是阶段末补充项；每个实施切片以失败测试开始。

## 2. 测试层级

| 层级 | 目标 | 典型测试 | 是否阻断合并 |
| --- | --- | --- | --- |
| L0 静态 | 类型、格式、依赖边界 | TypeScript strict、lint、workspace import rule | 是 |
| L1 单元 | parser、validator、stream、serializer、插值 | 表格测试、边界测试 | 是 |
| L2 属性/模糊 | 任意输入安全、往返性质、确定性 | seeded property test、字节 fuzz corpus | 是；长时 fuzz 可定时运行 |
| L3 契约 | CLI/HTTP/IPC/schema/文件 adapter | golden DTO、错误映射、原子写 | 是 |
| L4 组件 | view model 与可视化交互 | 诊断定位、viewport、hover | 是 |
| L5 E2E | 用户闭环与跨端一致性 | Web/Electron 导入到导出 | 是 |
| L6 互操作 | 目标 App 导入/导出 | 版本化人工/半自动实验 | 支持 QR/格式映射发布时是 |

## 3. 核心不变量

以下性质必须进入自动化测试：

1. parser 对任意输入不崩溃，结果只有成功或分类诊断。
2. `parse -> serialize -> parse` 保持规范语义。
3. 同一 document/ruleset 的 stream 和 metadata 确定。
4. validator 不修改输入，诊断稳定排序。
5. 有 error 的文档不能进入成功导出。
6. stream point 都能追溯到源 section/shape point 或明确的派生原因。
7. CLI、HTTP、IPC 在去除 transport/timing 字段后结果等价。
8. 取消、失败或输出冲突不会修改原输入或已有输出。

## 4. 夹具结构

```text
tests/fixtures/
  manifest.json
  pulse/valid/minimal/
  pulse/valid/corpus-derived/
  pulse/invalid/syntax/
  pulse/invalid/range/
  pulse/invalid/semantic/
  pulse/limits/
  qr/candidates/
  golden/inspect/
  golden/stream/
  golden/export/
```

manifest 至少记录：fixture ID、来源类别、原始文件哈希（如派生）、预期识别类型、预期诊断、规则集和再分发许可状态。

golden 只固定公共契约，不快照内部对象或完整 UI DOM。变更 golden 必须说明对应需求、PDR/ADR 或规则证据，不能无审查批量接受。

## 5. 诊断测试

每个稳定 code 至少有一个直接触发夹具。测试断言 `code/severity/location/parameters`，不依赖中文 message。多错误输入还要断言：

- 不产生同一根因的级联噪声；
- 排序按 source location、validator priority、code 稳定；
- 无法确定位置时使用文档级 location，而不是伪造 section 0；
- UI 能把 location 映射到 metadata 和时间轴。

## 6. 性能与资源门禁

M0 先建立基准，不先承诺最终数字。M2 上线前定稿硬限制。基准至少覆盖：

- 最长现有语料；
- 设计上限的 section/point 文档；
- 会在展开阶段放大的短 shape + 长 duration 文档；
- 多诊断非法文档；
- 并发 Web 请求与批量取消；
- SVG/PNG/JPG 最大允许尺寸。

记录 wall time、CPU time、峰值 RSS、输出点数和诊断数。CI 使用宽松回归阈值发现数量级退化；发布基准在固定 runner 上运行。

## 7. 安全测试

### 7.1 内容处理

- 非 UTF-8、NUL、极长数字、极深分隔、超多点、压缩炸弹和畸形 hex。
- 所有整数转换检查安全范围，所有展开在分配前计算上限。
- SVG 文本转义；不把文件名或 Pulse 文本当作 markup。
- JPG/PNG 库在隔离进程或明确资源限制下处理不可信数据（取决于选型）。

### 7.2 Web

- multipart boundary、慢请求、提前断连、content-type 欺骗、超限和并发耗尽。
- 安全响应头、CSP、无目录浏览、API 不回显路径/堆栈。
- Nginx 与 API 双层大小限制一致，避免代理完整接收后 API 才拒绝。

### 7.3 Electron

- renderer compromise 场景下无法读任意文件或执行 shell。
- preload 参数运行时校验；IPC sender/frame 校验。
- 拒绝任意导航、远程脚本、新窗口和不受控外部协议。
- 安装包启用适用的 Electron fuses，并在构建后审计。

## 8. CI 流水线

### 每个合并请求

1. 锁文件一致性与 `npm ci`。
2. lint、typecheck、单元/属性测试、覆盖率。
3. workspace 依赖边界检查。
4. build 全部受影响 workspace。
5. 契约/golden 测试。
6. Web E2E；Electron smoke 在支持 runner 上执行。
7. 文档相对链接和需求 ID 检查。

### main/nightly

- 全夹具 fuzz 与较长属性测试。
- Windows/Linux 矩阵；macOS 在宣布支持前加入。
- 依赖漏洞和许可证扫描。
- 容器构建、健康检查、优雅停止与镜像扫描。
- Electron 打包 smoke。

### release

- 固定 commit、干净环境、锁文件安装。
- 全套测试与固定 runner 性能基准。
- 生成 SBOM、checksums、容器 digest 和桌面安装包。
- 签名/公证策略完成前，发布说明不得暗示已签名平台支持。

## 9. 发布版本与契约

- 应用版本遵循 SemVer；发布前阶段可快速破坏内部 API，不提供兼容层。
- `contractVersion` 只在跨进程/HTTP DTO 不兼容变化时升级。
- `ruleSetId` 在任何会改变解析判定、派生 stream 或序列化结果的规则变化时升级。
- 尚未对外发布的错误 schema/规则直接替换；不在代码中同时维护旧路径。
- 已发布版本的变更策略需要新的 PDR，不在当前计划中预先构造迁移系统。

## 10. 发布清单

- [ ] 需求追踪矩阵中目标范围全部 Done。
- [ ] 所有阻断级未知项关闭或从发布范围明确移除。
- [ ] `.example` 与合成夹具回归通过。
- [ ] 跨端一致性和导出再导入通过。
- [ ] 安全、性能、可访问性与隐私门禁通过。
- [ ] Docker Compose 和 Electron 产物从干净环境构建并 smoke test。
- [ ] 依赖许可证、SBOM、漏洞报告和 checksums 已归档。
- [ ] 发布说明列出 ruleset、contract、支持格式、限制和已知互操作风险。

任何勾选项都必须链接到 CI run、报告、夹具 manifest 或人工互操作记录；口头确认不算完成证据。
