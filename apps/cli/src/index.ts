#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteFile,
  DEFAULT_QR_LIMITS,
  decodeQr,
  encodeQr,
  exportPulse,
  exportBatch,
  inspectBatch,
  inspectPulse,
  readInputFile,
  renderPreviewImage,
  toOperationDto,
  operationResult,
  type BatchInput,
  type ExportData,
  type OperationResult,
  type OperationStatus
} from '@dglab-pulse-hub/application';
import { DIAGNOSTIC_CODES, location, makeDiagnostic } from '@dglab-pulse-hub/core';

export interface CliIo {
  readonly stdout?: { write: (text: string) => void };
  readonly stderr?: { write: (text: string) => void };
}

const stdout = (io: CliIo): { write: (text: string) => void } => io.stdout ?? process.stdout;
const stderr = (io: CliIo): { write: (text: string) => void } => io.stderr ?? process.stderr;
const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    stdout(io).write(helpText());
    return command === undefined ? 2 : 0;
  }
  if (command === '--version' || command === 'version') {
    stdout(io).write('dglab-pulse-hub ' + packageJson.version + '\n');
    return 0;
  }
  try {
    switch (command) {
      case 'inspect':
        return await inspectCommand(argv.slice(1), io);
      case 'export':
        return await exportCommand(argv.slice(1), io);
      case 'batch-inspect':
        return await batchInspectCommand(argv.slice(1), io);
      case 'batch-export':
        return await batchExportCommand(argv.slice(1), io);
      case 'render':
        return await renderCommand(argv.slice(1), io);
      case 'qr-encode':
        return await qrEncodeCommand(argv.slice(1), io);
      case 'qr-decode':
        return await qrDecodeCommand(argv.slice(1), io);
      default:
        stderr(io).write('Unknown command: ' + command + '\n');
        stderr(io).write(helpText());
        return 2;
    }
  } catch {
    stderr(io).write('Unexpected CLI failure.\n');
    return 1;
  }
}

async function inspectCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = flags(args);
  if (!checkFlags(parsed, io, 'Usage: pulse inspect <file> [--json] [--no-stream]\n')) return 2;
  const inputPath = parsed.positionals[0];
  if (inputPath === undefined || parsed.positionals.length !== 1) {
    stderr(io).write('Usage: pulse inspect <file> [--json] [--no-stream]\n');
    return 2;
  }
  const read = await readInputFile(inputPath);
  if (read.status !== 'success' || read.data === null) {
    printResult(read, parsed.json, io);
    return exitCode(read.status);
  }
  const result = inspectPulse(read.data.content, {
    input: { displayName: read.data.displayName, bytes: read.data.byteSize },
    includeStream: !parsed.noStream
  });
  printResult(result, parsed.json, io);
  return exitCode(result.status);
}

async function exportCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = flags(args);
  if (
    !checkFlags(
      parsed,
      io,
      'Usage: pulse export <input> <output> [--json] [--overwrite] [--source|--canonical] [--qr]\n'
    )
  )
    return 2;
  if (parsed.qr && parsed.mode !== undefined) {
    const result = operationResult('export', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_MODE,
        'error',
        'export',
        'Source and canonical modes apply only to pulse-text export.',
        location('mode')
      )
    ]);
    printResult(result, parsed.json, io);
    return exitCode(result.status);
  }
  const inputPath = parsed.positionals[0];
  const outputPath = parsed.positionals[1];
  if (inputPath === undefined || outputPath === undefined || parsed.positionals.length !== 2) {
    stderr(io).write(
      'Usage: pulse export <input> <output> [--json] [--overwrite] [--source|--canonical] [--qr]\n'
    );
    return 2;
  }
  const read = await readInputFile(inputPath);
  if (read.status !== 'success' || read.data === null) {
    printResult(read, parsed.json, io);
    return exitCode(read.status);
  }
  const result = exportPulse(read.data.content, {
    displayName: basename(outputPath),
    mode: parsed.mode,
    format: parsed.qr ? 'qr-envelope' : 'pulse-text'
  });
  if (result.status !== 'success' || result.data === null) {
    printResult(result, parsed.json, io);
    return exitCode(result.status);
  }
  const write = await atomicWriteFile(outputPath, result.data.bytes, {
    overwrite: parsed.overwrite
  });
  const combined = {
    ...result,
    status: write.status === 'success' ? result.status : write.status,
    diagnostics: [...result.diagnostics, ...write.diagnostics],
    data: write.status === 'success' ? result.data : null
  } as OperationResult<ExportData>;
  printResult(combined, parsed.json, io);
  return exitCode(combined.status);
}

async function batchInspectCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = flags(args);
  if (!checkFlags(parsed, io, 'Usage: pulse batch-inspect <files...> [--json] [--concurrency N]\n'))
    return 2;
  const inputs = await readBatchInputs(parsed.positionals, io);
  if (inputs === null) return 2;
  const result = await inspectBatch(inputs, { concurrency: parsed.concurrency });
  printResult(result, parsed.json, io);
  return exitCode(result.status);
}

async function batchExportCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = flags(args);
  if (
    !checkFlags(
      parsed,
      io,
      'Usage: pulse batch-export <files...> --out-dir <directory> ' +
        '[--overwrite] [--source|--canonical] [--json]\n'
    )
  )
    return 2;
  const outputDirectory = parsed.outputDirectory;
  if (outputDirectory === undefined) {
    stderr(io).write(
      'Usage: pulse batch-export <files...> --out-dir <directory> ' +
        '[--overwrite] [--source|--canonical]\n'
    );
    return 2;
  }
  const inputs = await readBatchInputs(parsed.positionals, io);
  if (inputs === null) return 2;
  const results = await exportBatch(inputs, { concurrency: parsed.concurrency, mode: parsed.mode });
  let finalResults: OperationResult<unknown> = results as OperationResult<unknown>;
  if (results.data !== null) {
    const writeDiagnosticsByIndex = new Map<number, readonly ReturnType<typeof makeDiagnostic>[]>();
    for (const item of results.data.items) {
      if (item.status !== 'success' || item.data === null) continue;
      const write = await atomicWriteFile(
        join(outputDirectory, item.data.displayName),
        item.data.bytes,
        { overwrite: parsed.overwrite }
      );
      if (write.status !== 'success') {
        writeDiagnosticsByIndex.set(item.index, write.diagnostics);
      }
    }
    if (writeDiagnosticsByIndex.size > 0) {
      const items = results.data.items.map((item) => {
        const writeDiagnostics = writeDiagnosticsByIndex.get(item.index);
        if (writeDiagnostics === undefined) return item;
        return Object.freeze({
          ...item,
          status: writeDiagnostics.some((diagnostic) => diagnostic.severity === 'error')
            ? ('failed' as const)
            : item.status,
          diagnostics: [...item.diagnostics, ...writeDiagnostics],
          data: null
        });
      });
      const succeeded = items.filter((item) => item.status === 'success').length;
      const rejected = items.filter((item) => item.status === 'rejected').length;
      const failed = items.filter((item) => item.status === 'failed').length;
      finalResults = {
        ...results,
        status: failed > 0 ? 'failed' : rejected > 0 ? 'rejected' : results.status,
        data: {
          ...results.data,
          succeeded,
          rejected,
          failed,
          items
        },
        diagnostics: items.flatMap((item) => item.diagnostics)
      } as OperationResult<unknown>;
    }
  }
  printResult(finalResults, parsed.json, io);
  return exitCode(finalResults.status);
}

async function renderCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = flags(args);
  if (!checkFlags(parsed, io, 'Usage: pulse render <input> <output> [--format svg|png|jpg]\n'))
    return 2;
  const inputPath = parsed.positionals[0];
  const outputPath = parsed.positionals[1];
  if (inputPath === undefined || outputPath === undefined || parsed.positionals.length !== 2) {
    stderr(io).write('Usage: pulse render <input> <output> [--format svg|png|jpg]\n');
    return 2;
  }
  if (parsed.format !== 'svg' && parsed.format !== 'png' && parsed.format !== 'jpg') {
    const result = operationResult('render', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_UNSUPPORTED_FORMAT,
        'error',
        'export',
        'Preview format is not supported.',
        location('format')
      )
    ]);
    printResult(result, parsed.json, io);
    return exitCode(result.status);
  }
  const read = await readInputFile(inputPath);
  if (read.status !== 'success' || read.data === null) {
    printResult(read, parsed.json, io);
    return exitCode(read.status);
  }
  const inspected = inspectPulse(read.data.content, {
    input: { displayName: read.data.displayName, bytes: read.data.byteSize }
  });
  if (
    inspected.status !== 'success' ||
    inspected.data?.stream === null ||
    inspected.data?.stream === undefined
  ) {
    printResult(inspected, parsed.json, io);
    return exitCode(inspected.status);
  }
  const format = parsed.format;
  let image: ReturnType<typeof renderPreviewImage>;
  try {
    image = renderPreviewImage(inspected.data.stream, format);
  } catch {
    const failed = operationResult('render', 'failed', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.EXPORT_BLOCKED,
        'error',
        'export',
        'Preview could not be rendered.',
        location('format')
      )
    ]);
    printResult(failed, parsed.json, io);
    return exitCode(failed.status);
  }
  const write = await atomicWriteFile(outputPath, image.bytes, { overwrite: parsed.overwrite });
  const result = {
    ...inspected,
    operation: 'render',
    status: (write.status === 'success' ? 'success' : write.status) as OperationStatus,
    data:
      write.status === 'success'
        ? {
            displayName: basename(outputPath),
            format: image.format,
            byteSize: image.bytes.byteLength,
            width: image.width,
            height: image.height,
            streamDigest: image.streamDigest
          }
        : null,
    diagnostics: [...inspected.diagnostics, ...write.diagnostics]
  };
  printResult(result as OperationResult<unknown>, parsed.json, io);
  return exitCode(result.status);
}

async function qrEncodeCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = flags(args);
  if (!checkFlags(parsed, io, 'Usage: pulse qr-encode <file> [--json]\n')) return 2;
  const inputPath = parsed.positionals[0];
  if (inputPath === undefined || parsed.positionals.length !== 1) {
    stderr(io).write('Usage: pulse qr-encode <file>\n');
    return 2;
  }
  const read = await readInputFile(inputPath);
  if (read.status !== 'success' || read.data === null) {
    printResult(read, parsed.json, io);
    return exitCode(read.status);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.data.content);
  } catch {
    const result = operationResult('qr-encode', 'rejected', null, [
      makeDiagnostic(
        DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING,
        'error',
        'recognize',
        'Input is not valid UTF-8.',
        location('$')
      )
    ]);
    printResult(result, parsed.json, io);
    return exitCode(result.status);
  }
  const encoded = encodeQr(text);
  const result = operationResult(
    'qr-encode',
    encoded.content === null ? 'rejected' : 'success',
    encoded.content === null ? null : { content: encoded.content },
    encoded.diagnostics
  );
  if (parsed.json) printResult(result, true, io);
  else if (result.status === 'success' && result.data !== null)
    stdout(io).write(result.data.content + '\n');
  else printResult(result, false, io);
  return exitCode(result.status);
}

async function qrDecodeCommand(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = flags(args);
  if (!checkFlags(parsed, io, 'Usage: pulse qr-decode <file-or-content> [--json]\n')) return 2;
  const inputPath = parsed.positionals[0];
  if (inputPath === undefined || parsed.positionals.length !== 1) {
    stderr(io).write('Usage: pulse qr-decode <file-or-content>\n');
    return 2;
  }
  let content: string;
  const contentCandidate = inputPath.trim();
  if (/^https?:\/\/[^\s]+#DGLAB-PULSE#/i.test(contentCandidate)) {
    content = contentCandidate;
  } else {
    const read = await readInputFile(inputPath, {
      maxBytes: DEFAULT_QR_LIMITS.maxHexCharacters + 64
    });
    if (read.status !== 'success' || read.data === null) {
      // Preserve the file adapter's terminal state while changing the
      // operation name to the command that owns the request.
      const result = operationResult('qr-decode', read.status, null, read.diagnostics);
      printResult(result, parsed.json, io);
      return exitCode(result.status);
    }
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(read.data.content);
    } catch {
      const result = operationResult('qr-decode', 'rejected', null, [
        makeDiagnostic(
          DIAGNOSTIC_CODES.RECOGNIZE_INVALID_ENCODING,
          'error',
          'recognize',
          'Input is not valid UTF-8.',
          location('$')
        )
      ]);
      printResult(result, parsed.json, io);
      return exitCode(result.status);
    }
  }
  const decoded = decodeQr(content.trim());
  const result = operationResult(
    'qr-decode',
    decoded.accepted ? 'success' : 'rejected',
    decoded.accepted ? { pulseText: decoded.pulseText } : null,
    decoded.diagnostics
  );
  if (parsed.json) printResult(result, true, io);
  else if (result.status === 'success' && result.data !== null)
    stdout(io).write(result.data.pulseText + '\n');
  else printResult(result, false, io);
  return exitCode(result.status);
}

async function readBatchInputs(paths: readonly string[], io: CliIo): Promise<BatchInput[] | null> {
  if (paths.length === 0) {
    stderr(io).write('At least one input file is required.\n');
    return null;
  }
  const result: BatchInput[] = [];
  for (const path of paths) {
    const read = await readInputFile(path);
    if (read.status === 'success' && read.data !== null) {
      result.push({ displayName: read.data.displayName, content: read.data.content });
    } else {
      result.push({
        displayName: basename(path),
        content: new Uint8Array(),
        diagnostics: read.diagnostics
      });
    }
  }
  return result;
}

interface ParsedFlags {
  readonly positionals: string[];
  readonly json: boolean;
  readonly noStream: boolean;
  readonly overwrite: boolean;
  readonly mode?: 'source' | 'canonical';
  readonly qr: boolean;
  readonly format: string;
  readonly outputDirectory?: string;
  readonly concurrency: number;
  readonly errors: readonly string[];
}

function flags(args: readonly string[]): ParsedFlags {
  const positionals: string[] = [];
  let json = false;
  let noStream = false;
  let overwrite = false;
  let mode: 'source' | 'canonical' | undefined;
  let qr = false;
  let format = 'svg';
  let outputDirectory: string | undefined;
  let concurrency = 4;
  const errors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--json') json = true;
    else if (arg === '--no-stream') noStream = true;
    else if (arg === '--overwrite') overwrite = true;
    else if (arg === '--source') {
      if (mode !== undefined && mode !== 'source')
        errors.push('--source and --canonical cannot be combined.');
      else mode = 'source';
    } else if (arg === '--canonical') {
      if (mode !== undefined && mode !== 'canonical')
        errors.push('--source and --canonical cannot be combined.');
      else mode = 'canonical';
    } else if (arg === '--qr') qr = true;
    else if (arg === '--format') {
      const value = args[++index];
      if (value === undefined || value.startsWith('-')) errors.push('--format requires a value.');
      else format = value;
    } else if (arg === '--out-dir') {
      const value = args[++index];
      if (value === undefined || value.startsWith('-')) errors.push('--out-dir requires a value.');
      else outputDirectory = value;
    } else if (arg === '--concurrency') {
      const value = args[++index];
      const numeric = value === undefined ? NaN : Number(value);
      if (!Number.isSafeInteger(numeric) || numeric < 1)
        errors.push('--concurrency must be a positive integer.');
      else concurrency = numeric;
    } else if (arg.startsWith('-')) errors.push('Unknown option: ' + arg);
    else if (!arg.startsWith('-')) positionals.push(arg);
  }
  return {
    positionals,
    json,
    noStream,
    overwrite,
    mode,
    qr,
    format,
    outputDirectory,
    concurrency,
    errors
  };
}

function checkFlags(parsed: ParsedFlags, io: CliIo, usage: string): boolean {
  if (parsed.errors.length === 0) return true;
  for (const error of parsed.errors) stderr(io).write(error + '\n');
  stderr(io).write(usage);
  return false;
}

function printResult(result: OperationResult<unknown>, asJson: boolean, io: CliIo): void {
  if (asJson) {
    stdout(io).write(JSON.stringify(toOperationDto(result)) + '\n');
    return;
  }
  stdout(io).write('status: ' + result.status + '\n');
  if (result.data !== null && typeof result.data === 'object') {
    const data = result.data as Record<string, unknown>;
    if ('metadata' in data) {
      const metadata = data.metadata as {
        pulse?: { sectionCount: number };
        stream?: { stats: { pointCount: number; totalDurationMs: number } };
      };
      stdout(io).write('sections: ' + String(metadata.pulse?.sectionCount ?? 0) + '\n');
      stdout(io).write('stream points: ' + String(metadata.stream?.stats.pointCount ?? 0) + '\n');
      stdout(io).write(
        'duration: ' + String(metadata.stream?.stats.totalDurationMs ?? 0) + ' ms\n'
      );
    }
    if ('displayName' in data) stdout(io).write('output: ' + String(data.displayName) + '\n');
  }
  printDiagnostics(result.diagnostics, io);
}

function printDiagnostics(
  diagnostics: readonly {
    code: string;
    severity: string;
    message: string;
    location: { path: string };
  }[],
  io: CliIo
): void {
  for (const diagnostic of diagnostics) {
    stdout(io).write(
      '[' +
        diagnostic.severity +
        '] ' +
        diagnostic.code +
        ' ' +
        diagnostic.location.path +
        ': ' +
        diagnostic.message +
        '\n'
    );
  }
}

function exitCode(status: string): number {
  return status === 'success' ? 0 : status === 'rejected' ? 2 : 1;
}

function helpText(): string {
  return [
    'dglab-pulse-hub pulse workbench',
    '',
    'Commands:',
    '  pulse inspect <file> [--json] [--no-stream]',
    '  pulse export <input> <output> [--json] [--overwrite] [--source|--canonical] [--qr]',
    '  pulse batch-inspect <files...> [--json] [--concurrency N]',
    '  pulse batch-export <files...> --out-dir <directory> [--overwrite] [--source|--canonical]',
    '  pulse render <input> <output> [--format svg|png|jpg]',
    '  pulse qr-encode <file> [--json]',
    '  pulse qr-decode <file-or-content> [--json]',
    ''
  ].join('\n');
}

const entryPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMainModule =
  entryPath !== null &&
  (() => {
    try {
      return realpathSync(entryPath) === realpathSync(modulePath);
    } catch {
      return entryPath === modulePath;
    }
  })();
if (isMainModule) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // Keep unexpected runtime details out of stderr; command failures already
      // have stable diagnostics at the application boundary.
      process.stderr.write('Unexpected CLI failure.\n');
      process.exitCode = 1;
    });
}
