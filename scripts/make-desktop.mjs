import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const platform = args.find((arg) => arg.startsWith('--platform='))?.split('=')[1];
const architecture = args.find((arg) => arg.startsWith('--arch='))?.split('=')[1];
const cwd = new URL('../apps/desktop/', import.meta.url);
const spawnOptions = { cwd, stdio: 'inherit', shell: process.platform === 'win32' };
const run = (command, commandArgs) =>
  new Promise((resolve) => {
    const child = spawn(command, commandArgs, spawnOptions);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

const forgeArgs = args;
const buildArgs = [
  '--config',
  'electron-builder.yml',
  ...args.filter((arg) => !arg.startsWith('--platform=') && !arg.startsWith('--arch=')),
  ...(architecture ? [`--${architecture}`] : [])
];
const exitCode =
  platform === 'win32'
    ? await run('electron-forge', ['package', ...forgeArgs]).then(
        (code) =>
          code ||
          run('electron-builder', buildArgs).then(
            (builderCode) => builderCode || run('electron-forge', ['make', ...forgeArgs])
          )
      )
    : await run('electron-forge', ['make', ...forgeArgs]);
process.exitCode = exitCode;
