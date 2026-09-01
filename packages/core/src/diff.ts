import { expandWaveform } from './expand.js';
import { projectMetadata } from './metadata.js';
import { canonicalPulseText } from './serializer.js';
import type { ChangeRecord, Pulse, RuleSet, WaveformStream } from './types.js';
import { DEFAULT_RULE_SET } from './types.js';

export interface PulseDiff {
  readonly equal: boolean;
  readonly structural: readonly DiffEntry[];
  readonly metadata: readonly DiffEntry[];
  readonly stream: readonly DiffEntry[];
  readonly text: readonly DiffEntry[];
}

export interface DiffEntry {
  readonly path: string;
  readonly before: string | number | boolean | null;
  readonly after: string | number | boolean | null;
}

function entry(path: string, before: unknown, after: unknown): DiffEntry {
  return {
    path,
    before:
      typeof before === 'string' || typeof before === 'number' || typeof before === 'boolean'
        ? before
        : null,
    after:
      typeof after === 'string' || typeof after === 'number' || typeof after === 'boolean'
        ? after
        : null
  };
}

export function diffPulse(
  before: Pulse,
  after: Pulse,
  rules: RuleSet = DEFAULT_RULE_SET
): PulseDiff {
  const structural: DiffEntry[] = [];
  compareValue(
    'globals.sectionRestIndex',
    before.globals.sectionRestIndex,
    after.globals.sectionRestIndex,
    structural
  );
  compareValue(
    'globals.playbackSpeed',
    before.globals.playbackSpeed,
    after.globals.playbackSpeed,
    structural
  );
  compareValue(
    'globals.frequencyBalanceIndex',
    before.globals.frequencyBalanceIndex,
    after.globals.frequencyBalanceIndex,
    structural
  );
  compareValue('sections.length', before.sections.length, after.sections.length, structural);
  const sectionCount = Math.min(before.sections.length, after.sections.length);
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const left = before.sections[sectionIndex];
    const right = after.sections[sectionIndex];
    if (left === undefined || right === undefined) continue;
    const path = 'sections[' + sectionIndex + ']';
    compareValue(
      path + '.frequencyStartIndex',
      left.frequencyStartIndex,
      right.frequencyStartIndex,
      structural
    );
    compareValue(
      path + '.frequencyEndIndex',
      left.frequencyEndIndex,
      right.frequencyEndIndex,
      structural
    );
    compareValue(path + '.durationIndex', left.durationIndex, right.durationIndex, structural);
    compareValue(path + '.frequencyMode', left.frequencyMode, right.frequencyMode, structural);
    compareValue(path + '.enabled', left.enabled, right.enabled, structural);
    compareValue(
      path + '.points.length',
      left.pulseElement.points.length,
      right.pulseElement.points.length,
      structural
    );
    const pointCount = Math.min(left.pulseElement.points.length, right.pulseElement.points.length);
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const beforePoint = left.pulseElement.points[pointIndex];
      const afterPoint = right.pulseElement.points[pointIndex];
      if (beforePoint === undefined || afterPoint === undefined) continue;
      compareValue(
        path + '.points[' + pointIndex + '].strength',
        beforePoint.strengthDecimal,
        afterPoint.strengthDecimal,
        structural
      );
      compareValue(
        path + '.points[' + pointIndex + '].anchor',
        beforePoint.anchor,
        afterPoint.anchor,
        structural
      );
    }
  }
  const beforeExpansion = expandWaveform(before, {}, rules);
  const afterExpansion = expandWaveform(after, {}, rules);
  const beforeMetadata = projectMetadata(before, beforeExpansion.stream, { rules });
  const afterMetadata = projectMetadata(after, afterExpansion.stream, { rules });
  const metadata: DiffEntry[] = [];
  compareValue(
    'metadata.pulse.sectionCount',
    beforeMetadata.pulse.sectionCount,
    afterMetadata.pulse.sectionCount,
    metadata
  );
  compareValue(
    'metadata.pulse.enabledSectionCount',
    beforeMetadata.pulse.enabledSectionCount,
    afterMetadata.pulse.enabledSectionCount,
    metadata
  );
  compareValue(
    'metadata.pulse.disabledSectionCount',
    beforeMetadata.pulse.disabledSectionCount,
    afterMetadata.pulse.disabledSectionCount,
    metadata
  );
  compareValue(
    'metadata.pulse.sourceDurationMs',
    beforeMetadata.pulse.sourceDurationMs,
    afterMetadata.pulse.sourceDurationMs,
    metadata
  );
  compareValue(
    'metadata.pulse.effectiveDurationMs',
    beforeMetadata.pulse.effectiveDurationMs,
    afterMetadata.pulse.effectiveDurationMs,
    metadata
  );
  const metadataSectionCount = Math.min(
    beforeMetadata.sections.length,
    afterMetadata.sections.length
  );
  for (let sectionIndex = 0; sectionIndex < metadataSectionCount; sectionIndex += 1) {
    const left = beforeMetadata.sections[sectionIndex];
    const right = afterMetadata.sections[sectionIndex];
    if (left === undefined || right === undefined) continue;
    const path = 'metadata.sections[' + sectionIndex + ']';
    compareValue(
      path + '.targetDurationMs',
      left.targetDurationMs,
      right.targetDurationMs,
      metadata
    );
    compareValue(
      path + '.effectiveDurationMs',
      left.effectiveDurationMs,
      right.effectiveDurationMs,
      metadata
    );
    compareValue(path + '.repetitionCount', left.repetitionCount, right.repetitionCount, metadata);
    compareValue(
      path + '.pulseElementDurationMs',
      left.pulseElementDurationMs,
      right.pulseElementDurationMs,
      metadata
    );
    compareValue(path + '.pointCount', left.pointCount, right.pointCount, metadata);
  }
  compareValue(
    'metadata.stream.timeGranularityMs',
    beforeMetadata.stream.timeGranularityMs,
    afterMetadata.stream.timeGranularityMs,
    metadata
  );
  compareValue(
    'metadata.stream.sectionCount',
    beforeMetadata.stream.sectionCount,
    afterMetadata.stream.sectionCount,
    metadata
  );
  compareValue(
    'metadata.stream.warningCount',
    beforeMetadata.stream.warningCount,
    afterMetadata.stream.warningCount,
    metadata
  );
  compareValue(
    'metadata.stream.ruleVersion',
    beforeMetadata.stream.ruleVersion,
    afterMetadata.stream.ruleVersion,
    metadata
  );
  const beforeStats = beforeMetadata.stream.stats;
  const afterStats = afterMetadata.stream.stats;
  (
    [
      'pointCount',
      'totalDurationMs',
      'minFrequencyIndex',
      'maxFrequencyIndex',
      'minIntensity',
      'maxIntensity',
      'meanIntensity'
    ] as const
  ).forEach((key) => {
    if (beforeStats[key] !== afterStats[key]) {
      metadata.push(entry('stream.stats.' + key, beforeStats[key], afterStats[key]));
    }
  });
  const beforeStream = beforeExpansion.stream;
  const afterStream = afterExpansion.stream;
  const stream: DiffEntry[] = [];
  compareStreams(beforeStream, afterStream, stream);
  const text: DiffEntry[] = [];
  const beforeText = canonicalPulseText(before);
  const afterText = canonicalPulseText(after);
  if (beforeText !== afterText) text.push(entry('canonicalText', beforeText, afterText));
  return Object.freeze({
    equal:
      structural.length === 0 && metadata.length === 0 && stream.length === 0 && text.length === 0,
    structural: Object.freeze(structural),
    metadata: Object.freeze(metadata),
    stream: Object.freeze(stream),
    text: Object.freeze(text)
  });
}

function compareValue(
  path: string,
  before: string | number | boolean | null,
  after: string | number | boolean | null,
  entries: DiffEntry[]
): void {
  if (before !== after) entries.push(entry(path, before, after));
}

function compareStreams(
  before: WaveformStream | null,
  after: WaveformStream | null,
  entries: DiffEntry[]
): void {
  if (before === null || after === null) {
    if (before !== after)
      entries.push(entry('stream', before?.digest ?? null, after?.digest ?? null));
    return;
  }
  if (before.points.length !== after.points.length) {
    entries.push(entry('stream.points.length', before.points.length, after.points.length));
  }
  const count = Math.min(before.points.length, after.points.length);
  for (let index = 0; index < count; index += 1) {
    const left = before.points[index];
    const right = after.points[index];
    if (left === undefined || right === undefined) continue;
    if (left.frequencyIndex !== right.frequencyIndex) {
      entries.push(
        entry(
          'stream.points[' + index + '].frequencyIndex',
          left.frequencyIndex,
          right.frequencyIndex
        )
      );
    }
    if (left.intensityDecimal !== right.intensityDecimal) {
      entries.push(
        entry(
          'stream.points[' + index + '].intensity',
          left.intensityDecimal,
          right.intensityDecimal
        )
      );
    }
    if (left.timeMs !== right.timeMs || left.durationMs !== right.durationMs) {
      entries.push(entry('stream.points[' + index + '].time', left.timeMs, right.timeMs));
    }
  }
}

export function changesToDiff(records: readonly ChangeRecord[]): readonly DiffEntry[] {
  return Object.freeze(records.map((record) => entry(record.path, record.before, record.after)));
}
