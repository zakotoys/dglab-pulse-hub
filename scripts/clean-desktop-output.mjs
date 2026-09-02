import { rm } from 'node:fs/promises';

await rm(new URL('../apps/desktop/out/', import.meta.url), { recursive: true, force: true });
