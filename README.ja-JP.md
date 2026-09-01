# DG-LAB Pulse Hub

[![CI](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

DG-LAB `.pulse` 波形を検査、プレビュー、編集、書き出しするオープンソースのワークベンチです。

> [!IMPORTANT]
>
> 現在、このリポジトリではソースコード、Docker
> Web デプロイ、ローカルでのデスクトップビルド手順を提供しています。署名済みデスクトップインストーラーはまだ提供していません。本プロジェクトは独立したコミュニティプロジェクトであり、DG-LAB 公式アプリではありません。

## 機能

- UTF-8 の `.pulse` ファイル、または DG-LAB の QR テキスト/共有 URL を読み込めます。
- フォーマット診断、ファイルの metadata、section 構造、周波数/強度タイムラインを確認できます。
- 波形をシミュレーション再生し、各 stream ポイントの時刻、周波数、強度、由来を確認できます。
- 強度、周波数、長さ、制御点を編集でき、元に戻す、やり直す、ファイル比較に対応しています。
- 提案値を確認した後、二次曲線による編集支援を適用できます。
- 元のスナップショットまたは正規化した `.pulse`、QR 画像、SVG/PNG/JPG プレビューを書き出せます。
- 複数ファイルの一括検査と一括書き出しに対応しています。
- 簡体字中国語、英語、日本語の UI とライト/ダークテーマを利用できます。

デスクトップ版はファイルをローカルで処理します。Web 版では、自分で運用または選択した API サービスへファイルを送信します。標準の Docker 構成にはアカウントやデータベースがなく、アップロードはメモリ上で処理されます。一時ダウンロードファイルは最長 15 分間、かつ最初のダウンロードまで保持されます。

## クイックスタート

### デスクトップアプリ

[Node.js 24 以降](https://nodejs.org/)と npm が必要です。

```sh
npm ci
npm run desktop:dev
```

Electron アプリをビルドして起動します。現在のプラットフォーム向け配布ファイルを作成するには、次を実行します。

```sh
npm run desktop:make
```

成果物は `apps/desktop/out/`
に出力されます。未署名のビルドは OS によってブロックされる場合があります。

### ローカル Web 開発

```sh
npm ci
npm run dev
```

<http://127.0.0.1:5173> を開きます。API（ポート `8787`）、Web UI、TypeScript
workspace ビルダーが watch モードで同時に起動します。すべて停止するには `Ctrl+C` を押します。

### Docker Web デプロイ

Docker Engine と Docker Compose v2 が必要です。

```sh
docker compose up -d --build
```

<http://127.0.0.1:8080> を開きます。ホスト側のポートを変更する場合は次のように指定します。

```sh
PULSE_HUB_PORT=9080 docker compose up -d --build
```

サービスの確認と停止：

```sh
docker compose ps
curl --fail http://127.0.0.1:8080/health/ready
docker compose down --timeout 20
```

インターネットへ公開する前に、TLS、アクセス制御、ログ、ホスト側のリソース制限を設定してください。運用の詳細は
[`ops/runbook.md`](ops/runbook.md) を参照してください。

## 基本的な使い方

1. **Open pulse file** を選ぶか、DG-LAB の QR テキスト/共有 URL を貼り付けてデコードします。
2. 最初に Diagnostics を確認します。エラーがある文書はプレビューや書き出しへ進めません。
3. タイムラインを再生またはポイントを選択し、エディターで波形を調整します。
4. Compare、Undo、Redo で変更を確認します。
5. `.pulse`、QR 画像、または波形プレビューを書き出します。入力バイトを保持する場合は Source
   snapshot、安定した正規化テキストには Canonical を選びます。

UI はカメラから QR 画像を読み取りません。デコード済みの QR 内容または共有 URL を貼り付けてください。

## CLI

CLI では検査、変換、レンダリングを自動化できます。

```sh
npm run cli:run -- --help
npm run cli:run -- inspect waveform.pulse --json
npm run cli:run -- export input.pulse output.pulse --canonical
npm run cli:run -- render input.pulse preview.png --format png
npm run cli:run -- qr-encode input.pulse
```

一括コマンド、上書きオプション、終了ステータスの正確な仕様は `--help`
を参照してください。CLI はソースから実行するため、Node.js 24+ と `npm ci` が必要です。

## 対応範囲と制限

- 正規の入出力は `Dungeonlab+pulse:` 構文を使う `.pulse` テキストです。
- QR は `.pulse` 内容を運ぶ DG-LAB 共有用エンベロープであり、別の波形形式ではありません。
- 3 個を超える section も解析できますが、公式 App との相互運用性は未確認です。QR 書き出しは最大 3
  section です。
- dglab-kit の JSON/JSON5/`.pulses`
  パッケージ、BLE/V3/V4 転送フレーム、その他のコミュニティ方言には対応していません。
- デバイス接続、遠隔操作、デバイスへの波形直接送信には対応していません。
- 旧バージョンの自動アップグレードには実ファイルと App 相互運用の証拠が必要なため、不明なバージョンを推測で書き換えることはありません。

元ファイルは必ず保管し、書き出した波形を対象 App で確認してください。フォーマット調査と既知の境界は
[`docs/research/dglab-pulse-format.md`](docs/research/dglab-pulse-format.md) を参照してください。

## 開発コマンド

| コマンド                   | 用途                                                 |
| -------------------------- | ---------------------------------------------------- |
| `npm run dev`              | TypeScript、API、Web UI を同時に watch。             |
| `npm run api:dev`          | TypeScript workspace と API のみ watch。             |
| `npm run web:dev`          | TypeScript workspace と Web UI のみ watch。          |
| `npm run web:preview`      | 本番用 Web バンドルをビルドしてプレビュー。          |
| `npm run desktop:dev`      | デスクトップアプリをビルドして起動。                 |
| `npm run desktop:make`     | 現在のプラットフォーム向けデスクトップ配布物を作成。 |
| `npm run cli:run -- <...>` | CLI をソースから実行。                               |
| `npm run check`            | フォーマット、型、テスト、完全ビルドを実行。         |
| `npm run test:watch`       | テストを watch モードで実行。                        |
| `npm run test:coverage`    | カバレッジ付きでテストを実行。                       |
| `npm run docker:up`        | Docker サービスをビルドしてフォアグラウンドで起動。  |
| `npm run docker:down`      | Docker サービスを停止。                              |

アーキテクチャ、プロダクト判断、品質ゲート、調査資料は [`docs/README.md`](docs/README.md)
から参照できます。UI 翻訳は `packages/workspace-ui/src/locales/` にあります。変更後は
`npm test -- packages/workspace-ui/test/i18n.test.ts` を実行してください。

## ライセンス

本プロジェクトは [GNU General Public License v3.0](LICENSE) の下で提供されます。
