import { readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const version = process.argv[2];
if (
  version === undefined ||
  !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version
  )
) {
  console.error('Usage: npm run release:version -- X.Y.Z[-prerelease]');
  process.exit(1);
}

const workspaceDirectories = await Promise.all(
  ['apps', 'packages'].map(async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name, 'package.json'));
  })
);
const manifestPaths = ['package.json', ...workspaceDirectories.flat()];
const manifests = await Promise.all(
  manifestPaths.map(async (path) => ({
    path,
    data: JSON.parse(await readFile(path, 'utf8'))
  }))
);
const rootVersion = manifests[0].data.version;
const workspaceNames = new Set(
  manifests
    .slice(1)
    .map(({ data }) => data.name)
    .filter((name) => typeof name === 'string')
);

for (const { path, data } of manifests) {
  data.version = version;
  for (const dependencyGroup of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies'
  ]) {
    const dependencies = data[dependencyGroup];
    if (dependencies === null || typeof dependencies !== 'object') continue;
    for (const name of workspaceNames) {
      if (dependencies[name] === rootVersion) dependencies[name] = version;
    }
  }
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const lockfile = spawnSync(npmCommand, ['install', '--package-lock-only', '--ignore-scripts'], {
  stdio: 'inherit'
});
if (lockfile.status !== 0) process.exit(lockfile.status ?? 1);

console.log('Updated workspace version to ' + version + '.');
