# Release and Distribution

## Automated flow

The release workflow is [`release.yml`](../.github/workflows/release.yml). It runs when a tag that
matches `vX.Y.Z` or `vX.Y.Z-prerelease` is pushed, and it can also be started manually for an
existing tag.

Before publishing, the workflow:

1. Checks that the tag matches the root `package.json` version.
2. Runs the full format, type, test, build, audit, and corpus gates.
3. Builds and pushes the API and Web images to GitHub Container Registry for `linux/amd64` and
   `linux/arm64`.
4. Builds six desktop targets in parallel: Windows x64 and ARM64 on `windows-latest`, macOS Intel
   and ARM64 on `macos-latest`, plus Linux x64 and ARM64 on `ubuntu-latest`.
5. Audits every packaged app's executable architecture, Electron runtime files, ASAR entry points,
   version, and source-file exclusions before upload.
6. Creates a published `DGLab Pulse Hub vX.Y.Z` GitHub Release with generated notes, 16 desktop
   packages, and `SHA256SUMS.txt`.

The workflow uses the repository `GITHUB_TOKEN`; the release job needs `contents: write`, and the
container job needs `packages: write`. No long-lived registry credential is required.

## Version a release

All root and workspace package manifests must use the same version. Update them and the lockfile
with:

```sh
npm run release:version -- 0.1.1
npm run check
```

The version command updates `package.json` files, exact internal workspace dependency versions, and
`package-lock.json`. It does not create a commit or tag. After review, commit the change and push
the tag:

```sh
git add package.json package-lock.json apps packages scripts
git commit -m "chore: release 0.1.1"
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main v0.1.1
```

The tag must point at the version commit. A mismatch stops the workflow before any release or image
is published.

## Published artifacts

Each release is named `DGLab Pulse Hub vX.Y.Z` and contains these desktop packages:

```text
dglab-pulse-hub-windows-x64-vX.Y.Z-setup.exe
dglab-pulse-hub-windows-x64-vX.Y.Z.zip
dglab-pulse-hub-windows-arm64-vX.Y.Z-setup.exe
dglab-pulse-hub-windows-arm64-vX.Y.Z.zip
dglab-pulse-hub-macos-x86-vX.Y.Z.dmg
dglab-pulse-hub-macos-x86-vX.Y.Z.zip
dglab-pulse-hub-macos-arm64-vX.Y.Z.dmg
dglab-pulse-hub-macos-arm64-vX.Y.Z.zip
dglab-pulse-hub-linux-x64-vX.Y.Z.AppImage
dglab-pulse-hub-linux-x64-vX.Y.Z.deb
dglab-pulse-hub-linux-x64-vX.Y.Z.rpm
dglab-pulse-hub-linux-x64-vX.Y.Z.zip
dglab-pulse-hub-linux-arm64-vX.Y.Z.AppImage
dglab-pulse-hub-linux-arm64-vX.Y.Z.deb
dglab-pulse-hub-linux-arm64-vX.Y.Z.rpm
dglab-pulse-hub-linux-arm64-vX.Y.Z.zip
```

The `.exe` and `.dmg` files are the primary unsigned Windows and macOS installers. On Linux, use
`.deb` for Debian/Ubuntu, `.rpm` for Fedora/RHEL/openSUSE, or the portable `.AppImage` on other
mainstream desktop distributions. ZIP files are also provided as portable archives. The packaged
application is named `DGLab Pulse Hub`; installed Linux packages expose `dglab-pulse-hub`, and the
macOS app is `DGLab Pulse Hub.app`. The macOS `x86` label means Intel 64-bit and maps to Electron
`x64`; it is not a 32-bit macOS build. Windows SmartScreen and macOS Gatekeeper may warn until code
signing and notarization are configured. The Windows NSIS installer supports choosing the
installation directory and optional shortcuts.

The workflow audits both Linux package staging trees, verifies DEB/RPM package names and
architectures, and rejects Linux artifacts smaller than 1 MB before upload. AppImage improves
portability but cannot guarantee compatibility with every libc, graphics stack, or desktop
environment; test the package on the target distribution before deployment.

On Parallels, launching the Windows portable archive from `C:\Mac\Home`, `\\Mac\Home`, or a
`file://psf` shared path copies that exact build to `%LOCALAPPDATA%\DGLabPulseHub\portable` and
relaunches it there. Chromium cannot safely run sandboxed child processes or SQLite caches directly
from the Parallels shared filesystem. The local copy is keyed and verified by the packaged ASAR
digest; ordinary local Windows launches do not use this path.

The container images are:

```text
ghcr.io/zakotoys/dglab-pulse-hub-api:X.Y.Z
ghcr.io/zakotoys/dglab-pulse-hub-web:X.Y.Z
```

Stable releases also update the `latest` tag. Prereleases do not move `latest`.

To deploy an immutable published version with Compose:

```sh
PULSE_HUB_IMAGE_TAG=0.1.1 docker compose pull
PULSE_HUB_IMAGE_TAG=0.1.1 docker compose up -d
```

For a local source build, keep using `docker compose up -d --build`.

## Rollback

Set `PULSE_HUB_IMAGE_TAG` to the previous release, pull the two images, and restart Compose. Desktop
rollback is the corresponding archive from the previous GitHub Release. Confirm `/health/ready` and
inspect one valid and one invalid fixture after a rollback; see
[`ops/runbook.md`](../ops/runbook.md).
