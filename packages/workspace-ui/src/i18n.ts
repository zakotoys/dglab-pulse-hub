import en from './locales/en-US.json' with { type: 'json' };
import ja from './locales/ja-JP.json' with { type: 'json' };
import zh from './locales/zh-CN.json' with { type: 'json' };

export const supportedLocales = ['en-US', 'zh-CN', 'ja-JP'] as const;
export type Locale = (typeof supportedLocales)[number];

export type MessageKey = keyof typeof en;
type Messages = Readonly<Record<MessageKey, string>>;

const messages = {
  'en-US': en,
  'zh-CN': zh,
  'ja-JP': ja
} satisfies Record<Locale, Messages>;

export function resolveLocale(stored: string | null, languages: readonly string[]): Locale {
  if (supportedLocales.includes(stored as Locale)) return stored as Locale;

  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
    if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja-JP';
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  }

  return 'en-US';
}

export function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en-US';

  return resolveLocale(window.localStorage.getItem('pulse-hub-locale'), navigator.languages);
}

export type Translator = (
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>
) => string;

export function createTranslator(locale: Locale): Translator {
  return (key, values = {}) =>
    Object.entries(values).reduce(
      (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      messages[locale][key]
    );
}
