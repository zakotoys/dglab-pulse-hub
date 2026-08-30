# dglab-pulse-hub

面向 DG-LAB 4 App `.pulse` 文件的桌面工具与可部署服务。项目以 TypeScript、Node.js 和 npm 为主要技术栈，最终提供两种交付形态：

- Electron 应用：供普通用户在本地导入、检查、预览、修改和导出波形。
- Docker Compose 部署包：由 Web、Node.js API 和 Nginx 组成，供开发者在服务端部署可访问的网页与服务。

## Development Intent Overview

### 开发意图

`dglab-pulse-hub` 的目标不是重新实现某一个 DG-LAB App，而是建立一个独立、可复用的 `.pulse` 处理内核，并在其上提供桌面端和 Web 端体验。Pulse 应被视为结构化领域数据，而不是只能在界面中编辑的字符串。

核心开发意图如下：

1. **以波形领域模型为中心**
   - 统一描述频率、时长、强度、section、脉冲元、曲线点、播放参数和来源信息。
   - 将解析、校验、采样、经验证的规则变换、渲染和序列化拆成清晰的能力边界。
   - 在格式之间转换时保留足够的原始信息，避免因展示或导出造成不可逆的数据丢失。

2. **内核独立于交互和部署**
   - 核心包不依赖 Electron、浏览器 DOM 或 Nginx，可以在 Node.js、Electron 主进程、Web API 和批处理 CLI 中复用。
   - UI 只负责状态呈现、用户操作和任务编排；文件系统、二维码、图像导出及设备通信通过适配器接入。
   - Electron 和 Web 端应共享同一套领域逻辑、校验规则和导出结果。

3. **优先保证可验证的波形正确性**
   - 导入后先识别格式方言与适用 ruleset，再执行结构校验、范围校验和语义校验；来源 App 版本只接受外部明确 metadata。
   - 对 `.pulse` 和二维码封装提供明确的诊断信息，而不是静默修正未知数据。
   - 对任何显式规则变换和插值补点保留可追踪的变更结果；没有真实源/目标夹具时不猜测“旧版本”。

4. **从小到大分层交付**
   - 先完成“导入一条波形 -> 校验 -> 预览 -> 导出”的闭环，再扩展批处理、编辑、可视化和部署能力。
   - 每一层都应有可独立测试的纯函数或服务，避免桌面端或服务端成为唯一的验证入口。

### 技术与架构约束

- 语言与运行时：TypeScript、Node.js、npm。
- 核心领域层：纯 TypeScript，负责模型、解析器、校验器、采样/插值、规则变换和序列化。
- 应用层：负责单文件与批量任务、任务结果、错误聚合、取消和进度报告。
- 适配器层：负责本地文件、HTTP 上传下载、二维码、图片/SVG 导出、Electron IPC 及未来的 DG-LAB 设备/Socket 接入。
- 展示层：Electron renderer 与 Web 前端共享可复用的视图模型和波形渲染能力，但不把 UI 状态写入领域模型。
- 部署层：Web 服务由 Node.js API、静态 Web 前端和 Nginx 组成，通过 Docker Compose 提供可直接部署的生产入口；Nginx 负责静态资源和反向代理，不承载领域逻辑。

### 格式边界

当前项目支持的格式边界如下：

- `.pulse`：本项目唯一的规范用户波形输入和输出格式，使用 `Dungeonlab+pulse:` 语法。
- QR 分享候选：URL fragment 中带 `#DGLAB-PULSE#` 的 legacy 分享载荷；现有证据表明它与当前 `.pulse` 明文结构不同，必须由独立 adapter 验证和转换。
- `WaveformStream`：由 `.pulse` 展开的内部波形序列，用于预览、播放模拟、编辑和预览图导出，不作为独立文件格式。
- dglab-kit 的 JSON/JSON5/`.pulses` 数据包、BLE/V3/V4 传输帧和其他社区方言不属于当前核心文件格式支持范围。

详细的协议依据和兼容性风险见 [`docs/research/dglab-pulse-format.md`](docs/research/dglab-pulse-format.md)。

## Project Brief Overview

### 产品定位

这是一个“`.pulse` 文件工作台”：用户可以把来自 DG-LAB 4 App 或其他来源的 `.pulse` 文件导入，快速确认其合法性和元数据，在时间轴上查看频率与强度变化，进行受控修改，然后导出为 `.pulse` 文件、二维码或预览图。

### 核心概念

- **Pulse**：`.pulse` 文件解析后的脉冲波形文档，包含全局播放参数、section、脉冲元和曲线点。
- **WaveformStream**：由 Pulse 展开的有序波形序列，是预览、播放模拟、点位 hover、编辑和图像导出的基础。
- **Metadata**：按文件、Pulse、section、stream 和点位等层级提供的描述信息，不是单一固定字段集合。

### 功能范围

#### IO

- 单个或批量导入波形文件。
- 单个或批量导出 `.pulse` 文件及二维码内容。
- 导出波形 stream 预览图：SVG、PNG、JPG。
- 对批量任务返回逐文件成功、失败、警告和诊断信息。

#### 简易工具

- `.pulse` 格式方言、ruleset 和字段范围检查。
- 波形合法性检查，包括 section、脉冲元、曲线点、频率和强度范围。
- 对有真实源/目标夹具的方言执行显式规则变换；需要补点且规则已验证时使用 `f(x) = 1 - (1 - x) ** 2`，并明确标记结果。

#### 波形预览

- 波形文件 metadata 预览。
- 波形 stream 时间轴预览。
- 波形 stream 播放模拟与播放状态控制。
- 强度可视化：环形频谱与颜色强度映射。
- stream metadata 展示。
- 鼠标悬停查看 stream 点位的时间、频率、强度、section 和来源信息。

#### 波形修改

- 在时间轴上选择和编辑 stream 点位。
- 对频率、时长、强度和曲线进行智能化手动修改。
- 支持修改前后对比、撤销/重做、范围限制和导出前重新校验。
- 保持修改过程与原始数据的边界清晰，避免把 UI 临时状态直接写回源文件。

### 典型用户流程

```text
导入文件/批量目录
    -> 自动识别格式方言与 ruleset
    -> 生成诊断报告和 metadata
    -> 预览 waveform stream / 播放
    -> 手动修改或执行已验证的显式规则变换
    -> 再次校验
    -> 导出 .pulse、二维码或预览图片
```

### 预期交付物

- 可复用的 `.pulse` 核心库：模型、解析、校验、展开、插值和序列化。
- 面向 Node.js 的应用服务/CLI 能力，支持批量任务和自动化处理。
- Electron 桌面应用，提供本地文件工作流和波形可视化编辑器。
- Web 应用与 Node.js API，可由 Docker Compose 和 Nginx 部署。
- 自动化测试、格式样例、协议研究和面向贡献者的开发文档。

### 当前阶段建议

实施从核心库与 CLI 的单文件闭环开始，再交付共享契约下的 Web/Electron 工作台。批处理、图片、QR、编辑和规则变换逐项加入；QR 与规则变换必须先通过真实 App 夹具门禁。完整顺序见 [`docs/plan/`](docs/plan/README.md)。

### 非目标与边界

- 不把不同 App 版本或社区方言未经确认地混为同一种格式。
- 不把 dglab-kit JSON/JSON5/`.pulses` 数据包或设备传输帧作为当前 `.pulse` 文件格式处理。
- 不在 UI 层复制协议解析和校验逻辑。
- 不承诺未知格式的无损转换；无法确定语义时应报告诊断并要求用户选择目标方言。
- 设备通信和远程控制属于可插拔的后续适配器，不阻塞基础 `.pulse` 文件处理能力。

## Repository Notes

- [`docs/plan/`](docs/plan/README.md)：实施路线图、质量门禁、需求追踪与未知项。
- [`docs/pdr/`](docs/pdr/README.md)：产品范围、格式支持和 Web 数据政策。
- [`docs/adr/`](docs/adr/README.md)：工作区、领域模型、契约和交付架构。
- [`docs/research/dglab-pulse-format.md`](docs/research/dglab-pulse-format.md)：波形文件、二维码、V3/V4 和兼容性研究。
- [`docs/research/dglab-brief.md`](docs/research/dglab-brief.md)：DG-LAB 设备、传输协议与 SDK 边界。

项目仍处于设计与早期实现阶段；README 描述的是目标边界和开发基线，不代表所有功能已经完成。
