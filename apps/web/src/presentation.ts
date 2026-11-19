import { COPY } from './i18n.js';
import type { Lang } from './i18n.js';
import { formatError } from './view-model.js';

export type ThemePreference = 'system' | 'light' | 'dark';
export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}
export function readTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const value = storage.getItem('llm-lab-theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}
export function saveTheme(storage: Pick<Storage, 'setItem'>, preference: ThemePreference): void {
  try { storage.setItem('llm-lab-theme', preference); } catch { /* Private/storage-blocked mode remains usable. */ }
}
export type ErrorContext = 'run' | 'import' | 'paging';
export function localizedError(error: unknown, lang: Lang, context: ErrorContext): string {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : 'ERROR';
  const copy = COPY[lang];
  if (lang === 'en' && error instanceof Error) return formatError(error);
  const text = code === 'OOM' ? copy.oom : code.startsWith('WORKER_') ? copy.workerError
    : context === 'import' ? copy.invalidDocument : context === 'paging' ? copy.invalidPaging
    : code === 'INPUT' || code === 'CONTEXT_LIMIT' ? copy.invalidInput : copy.unexpectedError;
  return `${code}: ${text}`;
}
