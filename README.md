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
   - 将解析、校验、采样、插值、版本升级、渲染和序列化拆成清晰的能力边界。
   - 在格式之间转换时保留足够的原始信息，避免因展示或导出造成不可逆的数据丢失。

2. **内核独立于交互和部署**
   - 核心包不依赖 Electron、浏览器 DOM 或 Nginx，可以在 Node.js、Electron 主进程、Web API 和批处理 CLI 中复用。
   - UI 只负责状态呈现、用户操作和任务编排；文件系统、二维码、图像导出及设备通信通过适配器接入。
   - Electron 和 Web 端应共享同一套领域逻辑、校验规则和导出结果。

3. **优先保证可验证的波形正确性**
   - 导入后先识别格式与版本，再执行结构校验、范围校验和语义校验。
   - 对 `.pulse` 和二维码封装提供明确的诊断信息，而不是静默修正未知数据。
   - 对旧版本升级和插值补点保留可追踪的变更结果，用户能够知道哪些数据被补充或调整。

4. **从小到大分层交付**
   - 先完成“导入一条波形 -> 校验 -> 预览 -> 导出”的闭环，再扩展批处理、编辑、可视化和部署能力。
   - 每一层都应有可独立测试的纯函数或服务，避免桌面端或服务端成为唯一的验证入口。

### 技术与架构约束

- 语言与运行时：TypeScript、Node.js、npm。
- 核心领域层：纯 TypeScript，负责模型、解析器、校验器、采样/插值、版本升级和序列化。
- 应用层：负责单文件与批量任务、任务结果、错误聚合、取消和进度报告。
- 适配器层：负责本地文件、HTTP 上传下载、二维码、图片/SVG 导出、Electron IPC 及未来的 DG-LAB 设备/Socket 接入。
- 展示层：Electron renderer 与 Web 前端共享可复用的视图模型和波形渲染能力，但不把 UI 状态写入领域模型。
- 部署层：Web 服务由 Node.js API、静态 Web 前端和 Nginx 组成，通过 Docker Compose 提供可直接部署的生产入口；Nginx 负责静态资源和反向代理，不承载领域逻辑。

### 格式边界

当前项目支持的格式边界如下：

- `.pulse`：本项目唯一的规范用户波形输入和输出格式，使用 `Dungeonlab+pulse:` 语法。
- QR：以 `https://www.dungeon-lab.com/app-download.php#DGLAB-PULSE#` URL fragment 承载的 `.pulse` 分享封装，还原后得到 `.pulse` 明文，不作为独立波形格式。
- `WaveformStream`：由 `.pulse` 展开的内部波形序列，用于预览、播放模拟、编辑和预览图导出，不作为独立文件格式。
- dglab-kit 的 JSON/JSON5/`.pulses` 数据包、BLE/V3/V4 传输帧和其他社区方言不属于当前核心文件格式支持范围。

详细的协议依据和兼容性风险见 [`docs/research/dglab-pulse-format.md`](docs/research/dglab-pulse-format.md)，本地样例覆盖见 [`docs/research/pulse-corpus.md`](docs/research/pulse-corpus.md)。

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

- `.pulse` 格式、版本和字段范围检查。
- 波形合法性检查，包括 section、脉冲元、曲线点、频率和强度范围。
- 旧版本 `.pulse` 文件升级（条件能力，当前保留为待证据项）；若未来确认需要补点，使用二次函数递减算法 `f(x) = 1 - (1 - x) ** 2`，并明确标记升级结果。

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
    -> 自动识别格式与版本
    -> 生成诊断报告和 metadata
    -> 预览 waveform stream / 播放
    -> 手动修改（版本升级需先满足证据门槛）
    -> 再次校验
    -> 导出 .pulse、二维码或预览图片
```

### 预期交付物

- 可复用的 `.pulse` 核心库：模型、解析、校验、展开、插值和序列化。
- 面向 Node.js 的应用服务/CLI 能力，支持批量任务和自动化处理。
- Electron 桌面应用，提供本地文件工作流和波形可视化编辑器。
- Web 应用与 Node.js API，可由 Docker Compose 和 Nginx 部署。
- 自动化测试、格式样例、协议研究和面向贡献者的开发文档。

### 当前实施阶段

项目当前已有可运行的 M1-M4 单文件、批量、编辑、预览和跨端契约实现；M5 生产发布门禁仍在进行，旧版本升级仍为条件能力。完整质量证据、未验证边界和需求覆盖见 [`docs/plan/`](docs/plan/README.md) 与 [`docs/plan/traceability.md`](docs/plan/traceability.md)。旧版本升级只有在具备真实旧/新夹具、可识别画像、变更规则和 App 互操作证据后才进入实现，不为未知版本建立猜测性兼容路径。

### 非目标与边界

- 不把不同 App 版本或社区方言未经确认地混为同一种格式。
- 不把 dglab-kit JSON/JSON5/`.pulses` 数据包或设备传输帧作为当前 `.pulse` 文件格式处理。
- 不在 UI 层复制协议解析和校验逻辑。
- 不承诺未知格式的无损转换；无法确定语义时应报告诊断并要求用户选择目标方言。
- 设备通信和远程控制属于可插拔的后续适配器，不阻塞基础 `.pulse` 文件处理能力。

## Repository Notes

- [`docs/README.md`](docs/README.md)：文档职责与完整索引。
- [`docs/plan/README.md`](docs/plan/README.md)：M0-M5 交付计划、关键路径和决策门槛。
- [`docs/pdr/README.md`](docs/pdr/README.md)：产品范围与数据承诺决策。
- [`docs/adr/README.md`](docs/adr/README.md)：长期架构决策。
- [`docs/research/dglab-pulse-format.md`](docs/research/dglab-pulse-format.md)：波形文件、二维码、V3/V4 和兼容性研究。
- [`docs/research/dglab-brief.md`](docs/research/dglab-brief.md)：DG-LAB 设备、传输协议与 SDK 研究。

项目处于可运行实现与发布验证阶段；README 描述的功能范围不等同于已完成的官方 App 互操作或生产发布验收。
