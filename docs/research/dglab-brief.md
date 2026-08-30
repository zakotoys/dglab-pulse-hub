# DG-LAB 设备与 SDK 研究

> 本文用于说明本项目依赖的设备、传输协议与 SDK 边界。协议事实以 DG-LAB 官方公开仓库和 `dglab-kit` 类型定义为准；“文件合法”不代表人体使用安全，也不构成医疗建议。

## 1. 设备与波形模型

DG-LAB Coyote 是双通道经皮电刺激设备，输出通道为 A、B。设备负责产生脉冲，应用负责选择频率、强度、脉宽（pulse width）及波形序列；两个通道可以独立调节。Coyote V2 与 V3 是主机型号，不应与 DG-LAB 3.0/4.0 手机 App 的版本号混用。

设备连接采用低功耗蓝牙（BLE）。BLE 链路承载设备控制和波形数据，手机 App 或桌面程序属于控制端；设备状态（连接、电量、输出状态等）属于遥测数据。直接 BLE 控制与经 WebSocket 中继的远程控制是两种传输路径，不改变波形本身的领域语义。

## 2. `dglab-kit` SDK 能力

[`dglab-kit`](https://github.com/dungeonlab-open/dglab-kit) 是面向 DG-LAB 4 App 的 TypeScript SDK。当前公开能力集中在 V3/V4 WebSocket 中继和可直接下发的内置波形，不是 BLE GATT SDK。其能力可按职责归纳为：

1. **Socket 连接与 App 配对**：连接 V3/V4 WebSocket 中继、生成 App 配对信息并管理一个或多个受控 App。
2. **设备操作**：通过 App 暴露的设备槽位和通道下发 V2/V3 波形帧、调整或重置强度、清理任务。
3. **状态与事件**：报告 Socket、App、设备列表、设备属性和自定义反馈事件。
4. **Waveform SDK**：提供郊狼与负鼠的内置 raw 波形帧，可供 V3/V4 `sendPulse` 使用。

SDK 的 `sendPulse`/`AppendPulseData` 等方法属于 Socket/设备传输适配器接口，不应成为本项目 `.pulse` 领域模型的一部分。`.pulse` 解析、校验、采样和序列化应在独立的纯 TypeScript 核心层完成。若未来明确启用设备播放，再由独立 adapter 把经验证的 `WaveformStream` 编译为目标帧；直接 BLE 仍需要另行选型和评审。

## 3. 参考资料

- [DGLab Bluetooth Protocol（官方协议）](https://github.com/dungeonlab-open/dglab-bluetooth-protocol)
- [Coyote V3 帧协议](https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/coyote/v3/README.md)
- [dglab-kit（官方 TypeScript SDK）](https://github.com/dungeonlab-open/dglab-kit)
- [dglab-kit V4 类型定义](https://github.com/dungeonlab-open/dglab-kit/blob/main/src/socket/v4/types.ts)
