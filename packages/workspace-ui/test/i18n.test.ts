import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createTranslator, localizeDiagnostic, supportedLocales } from '../src/i18n.js';

const localesDirectory = new URL('../src/locales/', import.meta.url);

async function readMessages(locale: string): Promise<Record<string, string>> {
  const source = await readFile(new URL(`${locale}.json`, localesDirectory), 'utf8');
  return JSON.parse(source) as Record<string, string>;
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).sort();
}

describe('locale resources', () => {
  it('stores exactly one JSON file for each supported locale', async () => {
    const files = (await readdir(localesDirectory)).sort();
    const expected = supportedLocales.map((locale) => `${locale}.json`).sort();

    expect(files).toEqual(expected);
  });

  it('keeps message keys and placeholders aligned across locales', async () => {
    const [referenceLocale, ...translatedLocales] = supportedLocales;
    const reference = await readMessages(referenceLocale);
    const referenceKeys = Object.keys(reference).sort();

    for (const locale of translatedLocales) {
      const messages = await readMessages(locale);

      expect(Object.keys(messages).sort()).toEqual(referenceKeys);
      for (const key of referenceKeys) {
        expect(placeholders(messages[key] ?? '')).toEqual(placeholders(reference[key] ?? ''));
      }
    }
  });

  it('localizes known diagnostic messages while preserving unknown fallbacks', () => {
    const diagnostic = {
      code: 'PULSE_SEMANTIC_UNVERIFIED_SECTION_COUNT',
      severity: 'warning' as const,
      stage: 'semantic' as const,
      message:
        'More than three sections are parse-supported but App interoperability is not verified.',
      suggestion: 'Verify this file in the target App before sharing it.',
      location: { path: 'sections' }
    };

    expect(localizeDiagnostic(diagnostic, createTranslator('zh-CN'))).toEqual({
      message: '解析器支持超过三个段落，但尚未验证与 App 的互操作性。',
      suggestion: '分享前请在目标 App 中验证此文件。'
    });
    expect(localizeDiagnostic(diagnostic, createTranslator('ja-JP'))).toEqual({
      message: '3 セクションを超える形式は解析できますが、App との相互運用性は未検証です。',
      suggestion: '共有する前に対象 App でこのファイルを確認してください。'
    });
    const unknown = { ...diagnostic, code: 'PULSE_UNKNOWN' };
    expect(localizeDiagnostic(unknown, createTranslator('zh-CN'))).toEqual({
      message: diagnostic.message,
      suggestion: diagnostic.suggestion
    });
  });
});
