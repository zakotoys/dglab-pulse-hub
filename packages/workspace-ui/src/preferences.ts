export const themes = ['light', 'dark'] as const;
export type Theme = (typeof themes)[number];

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (themes.includes(stored as Theme)) return stored as Theme;
  return prefersDark ? 'dark' : 'light';
}

export function detectTheme(): Theme {
  if (typeof window === 'undefined') return 'light';

  return resolveTheme(
    window.localStorage.getItem('pulse-hub-theme'),
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}
