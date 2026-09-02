import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalPulseWorkspace } from '../src/local-workspace.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('LocalPulseWorkspace', () => {
  it('recursively lists pulse files newest first and ignores other files', async () => {
    const root = await temporaryDirectory('pulse-workspace-');
    await mkdir(join(root, 'archive'));
    await writeFile(join(root, 'older.pulse'), 'older');
    await writeFile(join(root, 'notes.txt'), 'ignored');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(root, 'archive', 'newer.PULSE'), 'newer');

    const workspace = new LocalPulseWorkspace(root);
    const index = await workspace.list();

    expect(index.rootPath).toBe(root);
    expect(index.files.map((file) => file.relativePath)).toEqual([
      'archive/newer.PULSE',
      'older.pulse'
    ]);
    expect(index.files[0]).toMatchObject({ name: 'newer.PULSE', byteSize: 5 });
  });

  it('resolves only pulse files contained in the workspace', async () => {
    const root = await temporaryDirectory('pulse-workspace-');
    await writeFile(join(root, 'source.pulse'), 'pulse');
    const workspace = new LocalPulseWorkspace(root);

    await expect(workspace.resolveFile('source.pulse')).resolves.toBe(join(root, 'source.pulse'));
    await expect(workspace.resolveFile('../outside.pulse')).rejects.toThrow('outside');
    await expect(workspace.resolveFile('source.txt')).rejects.toThrow('.pulse');
  });

  it('archives external files without overwriting an existing workspace file', async () => {
    const parent = await temporaryDirectory('pulse-import-');
    const root = join(parent, 'workspace');
    const external = join(parent, 'source.pulse');
    await mkdir(root);
    await writeFile(join(root, 'source.pulse'), 'existing');
    await writeFile(external, 'incoming');
    const workspace = new LocalPulseWorkspace(root);

    const archived = await workspace.archive(external);

    expect(archived).toBe(join(root, 'source (1).pulse'));
    await expect(readFile(join(root, 'source.pulse'), 'utf8')).resolves.toBe('existing');
    await expect(readFile(archived, 'utf8')).resolves.toBe('incoming');
  });

  it('keeps files already inside the workspace in place', async () => {
    const root = await temporaryDirectory('pulse-workspace-');
    const source = join(root, 'source.pulse');
    await writeFile(source, 'pulse');
    const workspace = new LocalPulseWorkspace(root);

    await expect(workspace.archive(source)).resolves.toBe(source);
  });
});
