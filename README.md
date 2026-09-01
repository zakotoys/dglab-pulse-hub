# DG-LAB Pulse Hub

[![CI](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/zakotoys/dglab-pulse-hub/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md)

An open-source workbench for inspecting, previewing, editing, and exporting DG-LAB `.pulse`
waveforms.

> [!IMPORTANT]
>
> This repository currently provides source code, a Docker Web deployment, and a local desktop build
> workflow. It does not yet provide signed desktop installers. This is an independent community
> project, not an official DG-LAB application.

## Features

- Import UTF-8 `.pulse` files or DG-LAB QR text/share URLs.
- Review format diagnostics, file metadata, section structure, and frequency/intensity timelines.
- Simulate playback and inspect the time, frequency, intensity, and origin of each stream point.
- Edit intensity, frequency, duration, and control points with undo, redo, and file comparison.
- Apply quadratic curve assistance after reviewing the proposed values.
- Export the source snapshot or canonical `.pulse` text, QR images, and SVG/PNG/JPG previews.
- Inspect and export multiple files in batch.
- Use the UI in Simplified Chinese, English, or Japanese with light and dark themes.

The desktop app processes files locally. The Web app sends files to the API service you run or
choose. The default Docker deployment has no accounts or database, processes uploads in memory, and
keeps temporary download artifacts for no more than 15 minutes and until their first download.

## Quick start

### Desktop app

Requires [Node.js 24 or newer](https://nodejs.org/) and npm.

```sh
npm ci
npm run desktop:dev
```

This builds and starts the Electron app. To create a distributable for the current platform:

```sh
npm run desktop:make
```

Artifacts are written under `apps/desktop/out/`. Your operating system may block unsigned builds.

### Local Web development

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. This starts the API on port `8787`, the Web UI, and the TypeScript
workspace builder in watch mode. Press `Ctrl+C` to stop all processes.

### Docker Web deployment

Requires Docker Engine and Docker Compose v2.

```sh
docker compose up -d --build
```

Open <http://127.0.0.1:8080>. To use a different host port:

```sh
PULSE_HUB_PORT=9080 docker compose up -d --build
```

Inspect and stop the services with:

```sh
docker compose ps
curl --fail http://127.0.0.1:8080/health/ready
docker compose down --timeout 20
```

Before exposing the service publicly, configure TLS, access control, logging, and host-level
resource limits. See [`ops/runbook.md`](ops/runbook.md) for operational details.

## Basic workflow

1. Select **Open pulse file**, or paste and decode DG-LAB QR text/a share URL.
2. Review Diagnostics first. Documents with errors cannot proceed to preview or export.
3. Play the timeline or select points, then adjust the waveform in the editor.
4. Review changes with Compare, Undo, and Redo.
5. Export a `.pulse` file, QR image, or waveform preview. Choose Source snapshot to preserve the
   input bytes, or Canonical for stable normalized text.

The UI does not scan QR images from a camera. Paste decoded QR content or a share URL instead.

## CLI

The CLI supports automated inspection, conversion, and rendering:

```sh
npm run cli:run -- --help
npm run cli:run -- inspect waveform.pulse --json
npm run cli:run -- export input.pulse output.pulse --canonical
npm run cli:run -- render input.pulse preview.png --format png
npm run cli:run -- qr-encode input.pulse
```

Use `--help` as the source of truth for batch commands, overwrite options, and exit behavior. The
CLI runs from source, so it also requires Node.js 24+ and `npm ci`.

## Supported scope and limitations

- The canonical input/output is `.pulse` text using the `Dungeonlab+pulse:` syntax.
- QR is a DG-LAB share envelope carrying `.pulse` content, not a separate waveform format.
- Files with more than three sections can be parsed, but official App interoperability is
  unverified; QR export supports at most three sections.
- dglab-kit JSON/JSON5/`.pulses` bundles, BLE/V3/V4 transport frames, and other community dialects
  are not supported.
- Device connections, remote control, and direct waveform transmission are not provided.
- Automatic legacy upgrades still require real fixtures and App interoperability evidence, so
  unknown versions are not rewritten speculatively.

Always keep the original file and verify exported waveforms in the target App. See
[`docs/research/dglab-pulse-format.md`](docs/research/dglab-pulse-format.md) for format research and
known boundaries.

## Development commands

| Command                    | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `npm run dev`              | Watch TypeScript, the API, and the Web UI together.      |
| `npm run api:dev`          | Watch the TypeScript workspace and API only.             |
| `npm run web:dev`          | Watch the TypeScript workspace and Web UI only.          |
| `npm run web:preview`      | Build and preview the production Web bundle.             |
| `npm run desktop:dev`      | Build and start the desktop app.                         |
| `npm run desktop:make`     | Create a desktop distributable for the current platform. |
| `npm run cli:run -- <...>` | Run the CLI from source.                                 |
| `npm run check`            | Run formatting, types, tests, and the complete build.    |
| `npm run test:watch`       | Run tests in watch mode.                                 |
| `npm run test:coverage`    | Run tests with coverage.                                 |
| `npm run docker:up`        | Build and start Docker services in the foreground.       |
| `npm run docker:down`      | Stop Docker services.                                    |

Start with [`docs/README.md`](docs/README.md) for architecture, product decisions, quality gates,
and research. UI translations live in `packages/workspace-ui/src/locales/`; after changing them, run
`npm test -- packages/workspace-ui/test/i18n.test.ts`.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
