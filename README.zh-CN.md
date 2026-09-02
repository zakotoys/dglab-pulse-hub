# DG-LAB Pulse Hub

[![CI](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/ci.yml)
[![Release](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/release.yml/badge.svg)](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/release.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

[English](README.md) | **简体中文** | [日本語](README.ja-JP.md)

用于检查、预览、编辑和导出 DG-LAB `.pulse` 波形的开源工作台。

> [!IMPORTANT]
>
> 当前仓库提供源码、Docker Web 部署，以及通过 GitHub
> Releases 下载的 Windows/macOS 未签名桌面安装包。每个版本同时提供规范命名的便携 ZIP 归档。暂未配置代码签名和 notarization。本项目是独立的社区项目，并非 DG-LAB 官方应用。

## 功能

- 导入 UTF-8 `.pulse` 文件或 DG-LAB QR 文本/分享 URL。
- 查看格式诊断、文件 metadata、section 结构以及频率和强度时间轴。
- 模拟播放波形，并查看每个 stream 点的时间、频率、强度和来源。
- 编辑强度、频率、时长和控制点，支持撤销、重做和文件差异比较。
- 在确认预览值后应用二次曲线辅助编辑。
- 导出原始快照或规范化 `.pulse`、QR 图片以及 SVG/PNG/JPG 波形预览。
- 批量检查和导出多个文件。
- 桌面端提供 `Documents/Pulse Hub` 本地工作区，支持搜索、多选、安全导入和拖放归档。
- 提供简体中文、English、日本語界面以及明暗主题。

桌面应用在本机处理文件。Web 版本会把文件发送到你运行或选择的 API 服务；默认 Docker 部署不使用账号或数据库，上传内容仅在内存中处理，临时下载文件最多保留 15 分钟并在下载后失效。

## 快速开始

### 桌面应用

需要 [Node.js 24 或更高版本](https://nodejs.org/) 和 npm。

```sh
npm ci
npm run desktop:dev
```

该命令构建并启动 Electron 应用。创建当前平台的安装包和便携归档：

```sh
npm run desktop:make
```

产物位于 `apps/desktop/out/`。Windows 会生成 Squirrel `.exe` 安装程序和便携 `.zip`，macOS 会生成
`.dmg` 安装包和便携 `.zip`。解压后的应用和可执行文件名称为
`DGLab Pulse Hub`。未签名构建可能被操作系统的安全机制拦截。桌面端会将受管理的 `.pulse` 文件保存在
`Documents/Pulse Hub`；从目录外导入时会复制文件，并避免覆盖同名文件。

### 下载发布版本

推送 `vX.Y.Z` tag 后会运行发布流水线，自动创建名为 `DGLab Pulse Hub vX.Y.Z`
的 Release，生成 Windows/macOS 安装包、便携 ZIP、API/Web 容器镜像、Release 说明和
`SHA256SUMS.txt`。版本同步和回滚流程见 [`docs/release.md`](docs/release.md)。

### 本地 Web 开发

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。该命令同时启动带监听重载的 API（端口 `8787`）、Web UI 和 TypeScript
workspace 构建器。按 `Ctrl+C` 停止全部进程。

### Docker Web 部署

需要 Docker Engine 和 Docker Compose v2。

```sh
docker compose up -d --build
```

打开 <http://127.0.0.1:8080>。使用其他主机端口：

```sh
PULSE_HUB_PORT=9080 docker compose up -d --build
```

使用 GHCR 中的已发布版本而不是从源码构建：

```sh
PULSE_HUB_IMAGE_TAG=0.1.1 docker compose pull
PULSE_HUB_IMAGE_TAG=0.1.1 docker compose up -d
```

检查和停止服务：

```sh
docker compose ps
curl --fail http://127.0.0.1:8080/health/ready
docker compose down --timeout 20
```

公网部署前，请自行配置 TLS、访问控制、日志和主机级资源限制。运维细节见
[`ops/runbook.md`](ops/runbook.md)。

## 基本使用

1. Web 端选择 **打开 pulse 文件**，或粘贴 DG-LAB
   QR 文本/分享 URL 并解码；桌面端可从本地工作区选择，或通过文件管理器导入。
2. 先检查 Diagnostics；有错误的文档不会进入预览或导出流程。
3. 在时间轴上播放或选择点位，并在编辑器中调整波形。
4. 使用 Compare、Undo 和 Redo 检查改动。
5. 导出 `.pulse`、QR 图片或波形预览图。需要保留输入字节时选择 Source
   snapshot；需要稳定、规范化文本时选择 Canonical。

界面不能直接读取相机中的 QR 图片；请粘贴已解码的 QR 内容或分享 URL。

## CLI

CLI 适合自动化检查、转换和渲染：

```sh
npm run cli:run -- --help
npm run cli:run -- inspect waveform.pulse --json
npm run cli:run -- export input.pulse output.pulse --canonical
npm run cli:run -- render input.pulse preview.png --format png
npm run cli:run -- qr-encode input.pulse
```

批量命令、覆盖选项和退出状态请以 `--help` 输出为准。CLI 从源码运行，因此也需要 Node.js 24+ 和
`npm ci`。

## 支持范围和限制

- 规范输入/输出是使用 `Dungeonlab+pulse:` 语法的 `.pulse` 文本。
- QR 是承载 `.pulse` 内容的 DG-LAB 分享封装，不是另一种波形格式。
- 超过三个 section 的文件可以解析，但其官方 App 互操作性未验证；QR 导出最多支持三个 section。
- 不支持 dglab-kit JSON/JSON5/`.pulses` 数据包、BLE/V3/V4 传输帧或其他社区方言。
- 不提供设备连接、远程控制或直接发送波形到设备的功能。
- 旧版本自动升级仍需真实样本和 App 互操作证据，因此当前不会猜测性地改写未知版本。

请始终保留原文件，并在目标 App 中验证导出的波形。格式研究和已知边界见
[`docs/research/dglab-pulse-format.md`](docs/research/dglab-pulse-format.md)。

## 开发命令

| 命令                               | 用途                                    |
| ---------------------------------- | --------------------------------------- |
| `npm run dev`                      | 同时监听 TypeScript、API 和 Web UI。    |
| `npm run api:dev`                  | 仅监听 TypeScript workspace 和 API。    |
| `npm run web:dev`                  | 仅监听 TypeScript workspace 和 Web UI。 |
| `npm run web:preview`              | 构建并预览生产 Web 包。                 |
| `npm run desktop:dev`              | 构建并启动桌面应用。                    |
| `npm run desktop:make`             | 创建当前平台的安装包和便携归档。        |
| `npm run cli:run -- <...>`         | 从源码运行 CLI。                        |
| `npm run check`                    | 运行格式、类型、测试和完整构建检查。    |
| `npm run test:watch`               | 在监听模式运行测试。                    |
| `npm run test:coverage`            | 运行带覆盖率的测试。                    |
| `npm run docker:up`                | 在前台构建并启动 Docker 服务。          |
| `npm run docker:down`              | 停止 Docker 服务。                      |
| `npm run release:version -- X.Y.Z` | 同步所有包版本和 lockfile。             |

架构、产品决策、质量门禁、发布运维和研究资料从 [`docs/README.md`](docs/README.md)
开始阅读。界面翻译位于 `packages/workspace-ui/src/locales/`；新增或修改翻译后运行
`npm test -- packages/workspace-ui/test/i18n.test.ts`。

## 许可证

本项目使用 [GNU General Public License v3.0](LICENSE)。
