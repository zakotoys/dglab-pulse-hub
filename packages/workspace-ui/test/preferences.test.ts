import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../src/preferences.js';
import { createTranslator, resolveLocale } from '../src/i18n.js';

describe('workspace preferences', () => {
  it('normalizes supported browser languages in priority order', () => {
    expect(resolveLocale(null, ['fr-FR', 'zh-Hans-CN', 'ja-JP'])).toBe('zh-CN');
    expect(resolveLocale(null, ['ja'])).toBe('ja-JP');
    expect(resolveLocale(null, ['en-GB'])).toBe('en-US');
  });

  it('uses a saved locale before browser detection', () => {
    expect(resolveLocale('ja-JP', ['zh-CN'])).toBe('ja-JP');
    expect(resolveLocale('invalid', ['zh-CN'])).toBe('zh-CN');
  });

  it('uses a saved theme before the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme('invalid', false)).toBe('light');
  });

  it('formats translated interface messages', () => {
    expect(createTranslator('zh-CN')('filesRead', { completed: 3, total: 8 })).toBe(
      '已读取 3/8 个文件'
    );
    expect(createTranslator('ja-JP')('openDocument')).toBe('パルスドキュメントを開く');
    expect(createTranslator('en-US')('openDocument')).toBe('Open a pulse document');
  });
});
