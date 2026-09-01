import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { supportedLocales } from '../src/i18n.js';

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
});
