import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const sourceDirectory = resolve(projectRoot, 'apps/desktop/src');
const outputDirectory = resolve(projectRoot, 'apps/desktop/dist');

await mkdir(outputDirectory, { recursive: true });
for (const asset of ['index.html']) {
  await cp(resolve(sourceDirectory, asset), resolve(outputDirectory, asset));
}
