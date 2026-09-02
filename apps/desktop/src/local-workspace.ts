import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface LocalPulseFile {
  readonly name: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
}

export interface LocalPulseIndex {
  readonly rootPath: string;
  readonly files: readonly LocalPulseFile[];
}

function isPulseFile(path: string): boolean {
  return extname(path).toLowerCase() === '.pulse';
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const offset = relative(rootPath, candidatePath);
  return (
    offset === '' || (offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset))
  );
}

function portableRelativePath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).split('\\').join('/');
}

/** Owns the default directory used to browse and archive local pulse files. */
export class LocalPulseWorkspace {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async ensureExists(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
  }

  async list(): Promise<LocalPulseIndex> {
    await this.ensureExists();
    const files: LocalPulseFile[] = [];
    await this.collect(this.rootPath, files);
    files.sort(
      (left, right) =>
        right.modifiedAt.localeCompare(left.modifiedAt) ||
        left.relativePath.localeCompare(right.relativePath)
    );
    return Object.freeze({ rootPath: this.rootPath, files: Object.freeze(files) });
  }

  async resolveFile(relativePath: string): Promise<string> {
    if (!isPulseFile(relativePath))
      throw new Error('Workspace files must use the .pulse extension.');
    const candidate = resolve(this.rootPath, relativePath);
    if (!isInside(this.rootPath, candidate))
      throw new Error('Workspace path points outside the root.');
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error('Workspace path is not a file.');
    return candidate;
  }

  async archive(sourcePath: string): Promise<string> {
    const source = resolve(sourcePath);
    if (!isPulseFile(source)) throw new Error('Imported files must use the .pulse extension.');
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error('Imported path is not a file.');
    await this.ensureExists();
    if (isInside(this.rootPath, source)) return source;

    const fileName = basename(source);
    const extension = extname(fileName);
    const stem = fileName.slice(0, -extension.length);
    for (let index = 0; ; index += 1) {
      const candidate = join(
        this.rootPath,
        index === 0 ? fileName : stem + ' (' + index + ')' + extension
      );
      try {
        await copyFile(source, candidate, constants.COPYFILE_EXCL);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }

  private async collect(directory: string, files: LocalPulseFile[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await this.collect(path, files);
          return;
        }
        if (!entry.isFile() || !isPulseFile(entry.name)) return;
        const metadata = await stat(path);
        files.push(
          Object.freeze({
            name: entry.name,
            relativePath: portableRelativePath(this.rootPath, path),
            byteSize: metadata.size,
            modifiedAt: metadata.mtime.toISOString()
          })
        );
      })
    );
  }
}
