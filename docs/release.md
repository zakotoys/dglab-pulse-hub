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
4. Builds a Windows Squirrel installer and portable ZIP on `windows-latest`, plus a macOS DMG
   installer and portable ZIP on `macos-latest`.
5. Creates a published `DGLab Pulse Hub vX.Y.Z` GitHub Release with generated notes, the four
   desktop packages, and `SHA256SUMS.txt`.

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
dglab-pulse-hub-windows-vX.Y.Z-setup.exe
dglab-pulse-hub-windows-vX.Y.Z.zip
dglab-pulse-hub-macos-vX.Y.Z.dmg
dglab-pulse-hub-macos-vX.Y.Z.zip
```

The `.exe` and `.dmg` files are the primary unsigned installers. The ZIP files are portable
archives; their packaged application and executable are named `DGLab Pulse Hub` (the macOS app is
`DGLab Pulse Hub.app`). Windows SmartScreen and macOS Gatekeeper may warn until code-signing and
notarization are configured. Squirrel update metadata and NuGet packages are used during the build
but are not uploaded to the Release.

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
