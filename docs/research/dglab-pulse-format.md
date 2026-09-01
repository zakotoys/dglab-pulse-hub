# DGLab Pulse 波形文件格式研究

> 资料范围：本文只依据 D-LAB/Dungeonlab 公开协议仓库、相关开源项目和公开实现整理，不引用本项目内的资料。由于官方协议仓库目前没有发布完整的
> `.pulse` 文件规范，部分字段含义来自对官方 App 导出数据的逆向解析和多个社区实现的交叉验证。

工作区 `.example` 的独立观察结果见
[本地 `.pulse` 语料分析](pulse-corpus.md)；该文档与本文的外部资料证据分开维护。

## 结论摘要

| 类型                           | 常见来源                            | 内容本质                                                | 是否为官方公开完整规范                               |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| `.pulse`                       | DGLab/Dungeonlab App 导出或分享文本 | `Dungeonlab+pulse:` 开头的明文曲线描述                  | 官方 App 格式；完整文件规范未在协议仓库正式发布      |
| `.json` / `.json5` / `.pulses` | Coyote-Game-Hub 等游戏/工具生态     | 已编译的 V3 HEX 帧列表，外加 ID、名称等元数据           | 社区数据格式，帧编码与官方 V3 协议一致               |
| V4 Socket JSON                 | DG-LAB 4 App 的 V4 中继协议         | `device.op`/`AppendPulseData` RPC 外壳，波形在 `v` 字段 | `dglab-kit` 公开了协议和类型；不是独立波形文件扩展名 |
| QR 内容                        | DGLab Pulse 分享二维码              | `.pulse` 明文经 Base64、gzip、十六进制封装后的字符串    | 社区实现已稳定复现，官方协议仓库未单独给出文件规范   |

简单说，`.pulse` 是“编辑器/分享层”的曲线描述，JSON 是“运行时层”的 100
ms 帧数组。两者描述的是同一类刺激波形，但不是同一种序列化格式。还要把 **3.0/4.0 App 的版本差异** 与
**V2/V3 主机波形帧差异** 分开：App 4.0 主要引入了 V4 Socket/设备管理能力，默认下发的 Coyote
V3 波形字节并没有被替换。

## 一、`.pulse` 明文格式

### 1. 顶层结构

常见官方 App 导出形式为：

```text
Dungeonlab+pulse:<全局设置>=<第1小节>[+section+<第2小节>...]
```

示例：

```text
Dungeonlab+pulse:18,1,8=27,7,32,3,1/0-1,50-0,100-1
```

等号左侧是逗号分隔的全局设置，等号右侧是一个或多个小节（section）。多个小节之间使用 `+section+`
连接。公开社区对文件上限的实测/整理通常按最多 10 个小节处理；官方当前 App 帮助页的 UI 只展示最多 3 个连续小节，这属于 UI 限制与文件语法上限的差别。

### 2. 全局设置

官方 App 导出数据的主流逆向实现将等号前的三个数字解释为：

```text
sectionRestTime,playbackSpeed,frequencyBalance
```

字段含义如下：

| 位置 | 字段                          | 作用（根据实现和 App 行为归纳）                                     |
| ---: | ----------------------------- | ------------------------------------------------------------------- |
|    0 | `sectionRestTime`             | 小节之间的休止/间隔设置索引或数值                                   |
|    1 | `playbackSpeed`               | 播放速度设置                                                        |
|    2 | `frequencyBalance` / 未知字段 | 多个解析器将其当作频率平衡；也有资料只记录为未知值，默认常见为 `16` |

这些值不是 V3 蓝牙帧中的字节，而是编辑器/播放器层的参数。其精确 UI 单位和取值表依赖 App 版本；公开协议仓库没有给出完整的官方枚举表。

### 3. 小节头

每个小节通常由以下部分组成：

```text
<freqStartIndex>,<freqEndIndex>,<durationIndex>,<freqMode>,<enabled>/<shapePoints>
```

以示例拆分：

```text
27,7,32,3,1/0-1,50-0,100-1
```

对应：

| 字段             | 说明                   |
| ---------------- | ---------------------- |
| `freqStartIndex` | 频率起始索引           |
| `freqEndIndex`   | 频率结束索引           |
| `durationIndex`  | 小节时长索引           |
| `freqMode`       | 频率变化模式           |
| `enabled`        | 小节是否启用           |
| `shapePoints`    | 斜杠后的强度曲线点序列 |

`freqMode` 在现有实现中通常使用 `1..4`
表示不同的频率变化模式。不同 App/实现可能对模式名称的映射不同，因此处理器应保留原始模式值，不要只按名称硬编码。

### 4. 强度曲线点

形状点使用逗号分隔，每个点是：

```text
<strength>-<anchor>
```

例如：

```text
0-1,50-0,100-1
```

其中：

- `strength`：强度，通常为 `0..100`。
- 第二个值在公开解析中通常称为 `type`/`anchor`：`0` 表示普通点（由相邻锚点自动插值），`1`
  表示锚点（用户固定编辑的点）。
- 一个形状点通常对应 100 ms 的编辑时间单位；转换为 V3 运行时帧时，会展开为 4 个各 25 ms 的采样。

公开格式整理还指出，脉冲元至少包含 2 根竖条（0.2 s）；官方当前帮助页用“每根竖线 0.1
s”描述这一编辑粒度。

因此，`.pulse`
的曲线点不是直接的蓝牙包，也不等价于一个 16 字符 HEX 帧。播放器需要先根据频率区间、模式、时长和形状点进行插值/采样，再生成 V3 帧。

### 5. 索引和范围

社区逆向实现普遍使用以下范围：

- 频率索引：`0..83`。
- 时长索引：`0..99`。
- 频率模式：通常为 `1..4`。
- 强度：`0..100`。

频率索引和时长索引是 App 的索引，不是最终毫秒或赫兹值；具体索引到物理值的映射应以对应 App 版本的实现为准。

## 二、二维码封装格式

DGLab Pulse 分享二维码的内容不是直接的 `.pulse`
文本，而是官方下载页 URL 的 fragment，后面接标记和压缩数据：

```text
https://www.dungeon-lab.com/app-download.php#DGLAB-PULSE#<HEX-DATA>
```

公开实现复现的编码流程为（注意：gzip 内层是 App 专用内部文本，不是 `.pulse` 明文）：

```text
App 内部 QR 文本
    -> UTF-8
    -> Base64
    -> gzip 压缩
    -> 大写十六进制编码
    -> 拼接官方下载页 URL 和 #DGLAB-PULSE# fragment 前缀
```

App 内部 QR 文本由 20 个全局字段和 3 个小节组成：

```text
频率起点(3),频率终点(3),点数(3),时长索引(3),频率模式(3),
第2/3小节开关(2),休息索引,高低频平衡索引,播放速度
+第1小节+第2小节+第3小节
```

每个小节的点使用 `锚点-强度/5`，例如 `1-0.00,0-4.00`。从 `.pulse` 导出时，点的强度必须能够在 `0.01`
的 QR 精度下无损表示；App QR 最多支持 3 个小节。

从 `.pulse` 到 App 内部文本的流程为：

```text
Dungeonlab+pulse 明文
    -> 解析并映射到 App 内部 QR 文本
    -> UTF-8
    -> Base64
    -> gzip 压缩
    -> 大写十六进制编码
    -> 拼接官方下载页 URL 和 #DGLAB-PULSE# fragment 前缀
```

还原流程相反：

```text
取 URL fragment 中的 #DGLAB-PULSE# 后半段
    -> 十六进制解码
    -> gzip 解压
    -> Base64 解码
    -> UTF-8 App 内部 QR 文本
    -> 映射为 Dungeonlab+pulse 文本
```

需要注意：下载页 URL、fragment 前缀、十六进制大小写和压缩顺序应严格按实现处理；只生成裸
`#DGLAB-PULSE#...` 内容时，二维码虽然可能被通用扫描器解出，但不能保证被 DG-LAB 4.0
App 的导入路由接受。把十六进制字符串直接当作 `.pulse` 文本也会失败。

## 三、JSON / JSON5 / `.pulses` 波形格式

### 1. 顶层结构

Coyote-Game-Hub 生态中常见的数据文件是一个数组，每个元素描述一条已编译波形：

```json
[
  {
    "id": "d6f83af0",
    "name": "呼吸",
    "pulseData": ["0A0A0A0A00000000", "0A0A0A0A14141414"]
  }
]
```

常见字段：

| 字段        | 类型       | 说明                                         |
| ----------- | ---------- | -------------------------------------------- |
| `id`        | 字符串     | 波形标识；具体是否要求固定长度取决于使用方   |
| `name`      | 字符串     | 展示名称                                     |
| `pulseData` | 字符串数组 | 按时间顺序排列的 V3 帧，每项为十六进制字符串 |

`.json5` 允许注释、尾逗号等 JSON5 语法，但波形对象和 `pulseData` 的语义不变。`.pulses`
更多是生态中的文件扩展名约定，核心仍是相同的 JSON 数组数据。

### 2. `pulseData` 帧

每个 `pulseData` 字符串通常具有固定结构：

```text
16 个十六进制字符 = 8 字节
```

按 V3 协议拆分：

```text
字节 0..3：4 个频率采样
字节 4..7：4 个强度采样
```

每个采样持续 25 ms，所以一个 8 字节帧代表：

```text
4 × 25 ms = 100 ms
```

波形总时长可按下式估算：

```text
pulseData.length × 100 ms
```

示例中的：

```text
0A0A0A0A00000000
```

表示 4 个频率采样值为 `0x0A`，4 个强度采样值为 `0x00`。

### 3. 频率和强度字节

- 强度字节范围为 `0..100`，通常直接以一个字节保存。
- 频率字节使用 V3 的压缩值，合法输出范围为 `10..240`。
- 一个帧不能任意增加/删除字节；解析器应校验字符串长度为 16 且仅包含十六进制字符。

## 四、V3 频率压缩规则

V3 帧中的频率并非总是直接保存原始频率值。公开协议实现使用分段压缩，将较大的频率范围映射到一个字节：

```text
10..100       -> 原值
101..600      -> (x - 100) / 5 + 100
601..1000     -> (x - 600) / 10 + 200
```

实现时应对结果取整数并限制在
`10..240`；具体取整方向要与发送端保持一致。反向解码也必须使用同一版本的协议实现，否则高频段可能出现舍入差异。

从 `.pulse` 到 JSON 的典型转换链为：

```text
小节频率索引/模式 + 强度曲线
    -> 根据 App 索引表还原频率和时长
    -> 按 100 ms 单位插值
    -> 每 100 ms 展开成 4 个 25 ms 频率/强度采样
    -> 频率压缩
    -> 8 字节、16 字符 HEX
    -> 写入 pulseData 数组
```

## 五、格式差异和兼容性风险

### 1. `.pulse` 的等号前字段存在社区方言

官方 App 导出的主流逆向解析把：

```text
Dungeonlab+pulse:<三个全局数字>=...
```

解释为 `sectionRestTime,playbackSpeed,frequencyBalance`。

但 DG-Kit 等社区实现还出现过类似：

```text
Dungeonlab+pulse:<名称>=...
```

把等号前内容当作波形名称的方言。两者在表面上都以 `Dungeonlab+pulse:`
开头，不能仅凭前缀判断语义。解析器应根据目标应用/版本选择明确的方言，或在发现非数字字段时报告需要人工确认，而不是静默套用另一种解释。

### 2. 官方协议与社区文件格式的边界

`dungeonlab-open/dglab-bluetooth-protocol` 主要规范蓝牙连接、命令和 V3 数据帧；它并没有把
`.pulse`、JSON5 数据文件或二维码分享格式作为一个完整的官方文件标准发布。因此：

- V3 8 字节帧的拆分和频率压缩，可视为协议层事实。
- `.pulse` 顶层语法、全局字段和曲线点含义，属于 App 格式的逆向结果。
- JSON/JSON5 的 `id`、`name`、`pulseData` 外壳，属于 Coyote-Game-Hub 等社区项目的数据约定。
- 二维码压缩封装来自公开工具的互操作实现，不能等同于正式标准文档。

### 3. 实际校验建议

读取未知文件时建议按以下顺序识别：

1. 以 `Dungeonlab+pulse:` 开头：按 `.pulse` 明文解析。
2. 以 `https://www.dungeon-lab.com/app-download.php#DGLAB-PULSE#` 开头：取 URL
   fragment 中的二维码封装并按流程解压后再解析明文。
3. 顶层为数组、对象含 `pulseData`：按 JSON/JSON5 已编译帧处理。
4. 对每个 `pulseData` 项校验 16 个十六进制字符、8 字节和频率/强度范围。
5. 对 `.pulse` 中的数字范围、section 分隔符和形状点格式做严格校验，遇到名称方言时显式标记版本/方言。

## 六、3.0 App 与 4.0 App 的波形差异

这里的“3.0 App/4.0 App”是手机 App（Socket/设备管理）的版本线，不等同于 Coyote
3.0/2.0 主机型号。公开资料能确认的差异主要在传输协议和设备管理层。若将“4.0”理解为新的主机硬件型号，目前官方公开协议仓库和
`dglab-kit` 尚未发布一套独立的 Coyote V4 蓝牙波形帧规范，不能据此推断存在新的文件字节格式。

| 对比项            | DG-LAB 3.0 App                                                        | DG-LAB 4.0 App                                                                                        |
| ----------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 官方支持范围      | 官方下载页注明支持 Coyote 2.0、3.0                                    | 官方下载页注明支持 Coyote 2.0、3.0 及后续产品                                                         |
| Socket 线         | 旧 V3 Socket；一个控制方只维护一个 App 配对                           | 新 V4 Socket；支持 `1 控制方 : N APP 被控方`、设备列表和 RPC 响应                                     |
| Coyote V3 波形帧  | 8 字节帧：`[a1,a2,a3,a4,b1,b2,b3,b4]`，每 100 ms 发送 4 个 25 ms 采样 | V4 `AppendPulseData` 默认 `ver=3`，仍使用完全相同的 8 字节帧；每个 tick 通常 100 ms                   |
| Coyote V2 波形帧  | 通过旧链路使用 V2 格式                                                | V4 可显式设置 `ver=2`，发送 `[a,b,interval]` V2 帧                                                    |
| `.pulse` 曲线文件 | 3.4.4 起官方开放导出，使用 `Dungeonlab+pulse:` 语法                   | 目前没有公开证据表明 4.x 改写了该语法；官方 4.x 帮助页仍描述相同的 section、0.1 s 竖条和 4 种频率模式 |
| 跨版本远程控制    | 3.x 之间（3.1.0 及以上）可用                                          | 官方下载页明确 3.x 与 4.x 之间不能互相远程控制                                                        |

### 结论：波形字节基本相同，外层协议不同

面向 DG-LAB 4 App 的官方 `dglab-kit` 明确把同一组 `raw: string[]` 十六进制帧同时用于：

```text
V3: sendPulse({ channel, time, data })
V4: sendPulse(clientId, slotId, channel, duration, frames)
```

因此，对 Coyote 3.0 主机而言，下面这种帧在 3.0 App 和 4.0 App 中的含义不变：

```text
0A0A0A0A64646464
```

它仍然是 8 字节、前 4 字节频率、后 4 字节强度，代表 100 ms。变化的是承载它的消息：

- 3.0 App 的旧 V3 Socket 通常把 `pulse-A:["..."]` 放在 `message` 字段中。
- 4.0 App 的 V4 Socket 使用 `device.op` RPC，波形动作类型为 `AppendPulseData`（`t: 0`），数据放在
  `v`，持续时间放在 `d`（毫秒），可选 `ver` 指定 V2/V3。

示意：

```json
{
  "t": "req",
  "reqId": "req-1",
  "m": "device.op",
  "data": {
    "t": 0,
    "s": "slot-a",
    "c": 0,
    "d": 1000,
    "v": ["0A0A0A0A64646464"],
    "ver": 3
  }
}
```

### 何时会出现“4.0 波形不同”

以下情况会造成文件或数据看起来不同，但不是同一条 Coyote V3 波形被重新定义：

1. **V4 RPC 外壳**：4.0 App 的 JSON 消息包含 `t/m/reqId/s/c/d/v` 等字段；这不是 `.pulse` 文件本体。
2. **V2 兼容帧**：V4 的 `ver=2` 使用旧设备的 `[a,b,interval]` 三元素帧，不能按 8 字节 V3 HEX 解析。
3. **导入校验/版本缺陷**：社区工具曾记录部分 `.pulse` 在 4.0
   App 中无法导入的情况。这类问题属于 App 导入器对字段、小数格式或版本校验的兼容性，不足以证明存在新的公开文件语法；应以实际版本测试和官方更新说明为准。
4. **文件扩展名误导**：Coyote-Game-Hub 的 `.json/.json5/.pulses` 是社区运行时帧库，4.0 App 的 V4
   RPC 也使用 JSON，但二者顶层结构并不相同，不能仅凭扩展名互换。

### 实现建议

- 只面向 Coyote 3.0：继续生成 V3 8 字节 HEX 帧；3.0/4.0 App 选择由 Socket 接入层决定。
- 面向 4.0 App：实现 V4 `device.op`/`AppendPulseData`，默认
  `ver=3`；只有明确连接 V2 主机并确认 App 要求时才使用 `ver=2`。
- 解析 `.pulse`
  时不要根据 App 名称擅自改变字段；优先按官方 App 导出语法，保留第三个全局字段和小数格式，避免 4.0 导入器因格式化差异拒绝文件。

## 七、外部参考资料

以下链接均为项目外部的官方协议仓库或公开开源实现：

1. [DGLab Bluetooth Protocol（官方协议仓库）](https://github.com/dungeonlab-open/dglab-bluetooth-protocol)
2. [Coyote 协议说明](https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/coyote/README.md)
3. [Coyote V3 帧协议说明](https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/coyote/v3/README.md)
4. [sse-dg-lab waveform-parser.ts（`.pulse` 解析实现）](https://github.com/admilkjs/sse-dg-lab/blob/main/src/waveform-parser.ts)
5. [DG-Lab-Coyote-Game-Hub decode_pulse_qrcode.py（二维码解码）](https://github.com/hyperzlib/DG-Lab-Coyote-Game-Hub/blob/main/decode_pulse_qrcode.py)
6. [node-dglab-pulse-helper DGLabPulseQRHelper.ts（二维码编码/解码）](https://github.com/hyperzlib/node-dglab-pulse-helper/blob/master/src/DGLabPulseQRHelper.ts)
7. [node-dglab-pulse-helper DGLabPulseHelper.ts（波形与帧转换）](https://github.com/hyperzlib/node-dglab-pulse-helper/blob/master/src/DGLabPulseHelper.ts)
8. [node-dglab-pulse-helper CLI](https://github.com/hyperzlib/node-dglab-pulse-helper/blob/master/src/cli.ts)
9. [DG-Lab-Coyote-Game-Hub game.ts（`pulseData` 类型）](https://github.com/hyperzlib/DG-Lab-Coyote-Game-Hub/blob/main/server/src/types/game.ts)
10. [DG-Lab-Coyote-Game-Hub pulse.json5（JSON5 波形示例）](https://github.com/hyperzlib/DG-Lab-Coyote-Game-Hub/blob/main/server/data/pulse.json5)
11. [DG-Kit pulse.ts（社区 `.pulse` 方言实现）](https://github.com/0xNullAI/DG-Kit/blob/main/packages/waveforms/src/pulse.ts)
12. [DGLAB KIT（面向 DG-LAB 4 App 的官方 TypeScript SDK，含 V3/V4 波形接口）](https://github.com/dungeonlab-open/dglab-kit)
13. [DGLAB KIT README：V4 `AppendPulseData`、`ver=2/3` 和 100 ms tick](https://github.com/dungeonlab-open/dglab-kit/blob/main/README.md)
14. [DGLAB KIT V4 类型定义：V2/V3 帧数组和 `ver` 字段](https://github.com/dungeonlab-open/dglab-kit/blob/main/src/socket/v4/types.ts)
15. [DG-LAB 官方下载页：4.x/3.x App 支持范围和远程控制兼容性](https://www.dungeon-lab.cn/)
16. [DG-LAB 官方帮助页：自定义波形 section、0.1 s 竖条和四种频率模式](https://www.dungeon-lab.cn/instructions-cn.html)
17. [Coyote Claw：`.pulse` 文件及 3.4.4 导出格式整理](https://qiekn.github.io/coyote-claw/pulse/)
18. [Coyote Claw：8 字节/100 ms 波形单元与 V3 WebSocket 消息](https://qiekn.github.io/coyote-claw/json/)
19. [官方协议仓库 Issue #48：通过官方 4.0 App 更新 Coyote V3 固件后仍使用原 GATT 服务](https://github.com/dungeonlab-open/dglab-bluetooth-protocol/issues/48)
20. [波形坩埚（社区工具，页面记录 `.pulse` 在 4.0 App 的导入兼容问题）](https://www.lushgarden.cn/alchemy.html)

## 最终判断

如果目标是导入/导出 DGLab App 分享波形，应实现 `Dungeonlab+pulse:` 明文和官方下载页 URL
fragment 形式的 `#DGLAB-PULSE#` 封装；如果目标是向 Coyote/Game
Hub 或蓝牙 V3 播放器提供运行时数据，应生成 JSON/JSON5 中的 `pulseData` HEX 数组。对于 3.0 App 与 4.0
App，当前外部证据支持的判断是：Coyote V3 的波形帧编码和 100 ms/25
ms 时间粒度保持不变，4.0 主要改变 Socket 外层（V4
RPC）并增加 V2 帧显式兼容选项。两条链路之间需要经过采样、频率压缩和 25
ms 时间粒度展开，不能把一种文件的字符串直接改扩展名当作另一种格式。
