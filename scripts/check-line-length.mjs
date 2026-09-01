import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import { readFileSync } from 'node:fs';

const maxColumns = 100;
const checkedExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml'
]);

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' }
)
  .split('\0')
  .filter((file) => checkedExtensions.has(extname(file)));

const violations = files.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const columns = Array.from(line).length;
      return columns > maxColumns ? [`${file}:${index + 1}:${columns}`] : [];
    })
);

if (violations.length > 0) {
  console.error(`Source lines must not exceed ${maxColumns} columns:\n${violations.join('\n')}`);
  process.exitCode = 1;
}
