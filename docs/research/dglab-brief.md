# DG-LAB 设备与 SDK 研究

> 本文用于说明本项目依赖的设备、传输协议与 SDK 边界。协议事实以 DG-LAB 官方公开仓库和 `dglab-kit`
> 类型定义为准；“文件合法”不代表人体使用安全，也不构成医疗建议。

## 1. 设备与波形模型

DG-LAB
Coyote 是双通道经皮电刺激设备，输出通道为 A、B。设备负责产生脉冲，应用负责选择频率、强度、脉宽（pulse
width）及波形序列；两个通道可以独立调节。Coyote V2 与 V3 是主机型号，不应与 DG-LAB
3.0/4.0 手机 App 的版本号混用。

设备连接采用低功耗蓝牙（BLE）。BLE 链路承载设备控制和波形数据，手机 App 或桌面程序属于控制端；设备状态（连接、电量、输出状态等）属于遥测数据。直接 BLE 控制与经 WebSocket 中继的远程控制是两种传输路径，不改变波形本身的领域语义。

## 2. `dglab-kit` SDK 能力

[`dglab-kit`](https://github.com/dungeonlab-open/dglab-kit) 为 TypeScript
SDK，提供统一的事件驱动 API，屏蔽 BLE
GATT 特征、Socket 连接和原始帧拼装等传输细节。其能力可按职责归纳为：

1. **连接与设备管理**：发现、配对、连接/断开、设备槽位和通道选择；支持 Web Bluetooth、Node
   BLE 及 WebSocket 中继。
2. **波形与强度控制**：发送 V2/V3 波形帧，按通道追加数据，逐步调整强度，并设置上限（limit）等运行约束。
3. **状态与遥测**：以事件方式报告连接状态、电量和设备反馈，便于 UI 或任务服务更新状态。

SDK 的 `sendPulse`/`AppendPulseData` 等方法属于传输适配器接口，不应成为本项目 `.pulse`
领域模型的一部分。`.pulse`
解析、校验、采样和序列化应在独立的纯 TypeScript 核心层完成，只有在明确启用设备播放时，才由适配器将
`WaveformStream` 编译为目标帧。

## 3. 参考资料

- [DGLab Bluetooth Protocol（官方协议）](https://github.com/dungeonlab-open/dglab-bluetooth-protocol)
- [Coyote V3 帧协议](https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/coyote/v3/README.md)
- [dglab-kit（官方 TypeScript SDK）](https://github.com/dungeonlab-open/dglab-kit)
- [dglab-kit V4 类型定义](https://github.com/dungeonlab-open/dglab-kit/blob/main/src/socket/v4/types.ts)
