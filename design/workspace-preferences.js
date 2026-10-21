import { LANGUAGES, translate } from './workspace-locales.js';

export { LANGUAGES };
let language = 'zh-CN', explicitTheme = false;
let theme = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
try {
  const savedLanguage = globalThis.localStorage?.getItem('qiya-ui-language');
  if (LANGUAGES.some(item => item.id === savedLanguage)) language = savedLanguage;
  const savedTheme = globalThis.localStorage?.getItem('qiya-ui-theme');
  if (['light', 'dark'].includes(savedTheme)) { theme = savedTheme; explicitTheme = true; }
} catch { /* Use defaults without blocking the workspace. */ }

export const uiLanguage = () => language;
export const uiTheme = () => theme;
export const t = (text, values) => translate(text, language, values);

function persist(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* Session-only preference. */ }
}

function paint() {
  const doc = globalThis.document;
  if (!doc?.documentElement) return;
  doc.documentElement.lang = language;
  doc.documentElement.dataset.theme = theme;
  const picker = doc.getElementById('workspace-language');
  if (picker) { picker.value = language; picker.setAttribute('aria-label', t('语言')); }
  const container = doc.getElementById('workspace-preferences');
  container?.setAttribute('aria-label', t('显示设置'));
  const toggle = doc.getElementById('workspace-theme');
  if (toggle) {
    const label = t(theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  for (const element of doc.querySelectorAll('[data-ui-copy]')) element.textContent = t(element.dataset.uiCopy);
  for (const element of doc.querySelectorAll('[data-ui-label]')) {
    element.setAttribute('aria-label', t(element.dataset.uiLabel));
    element.title = t(element.dataset.uiLabel);
  }
}

export function setUiLanguage(value) {
  if (!LANGUAGES.some(item => item.id === value)) return false;
  if (language === value) return true;
  language = value;
  persist('qiya-ui-language', language);
  paint();
  globalThis.window?.dispatchEvent(new CustomEvent('workspace:languagechange', { detail: { language } }));
  return true;
}

export function setUiTheme(value) {
  if (!['light', 'dark'].includes(value)) return false;
  theme = value;
  explicitTheme = true;
  persist('qiya-ui-theme', theme);
  paint();
  return true;
}

export function initializePreferences() {
  paint();
  const doc = globalThis.document;
  const picker = doc?.getElementById?.('workspace-language');
  if (picker && !picker.dataset.bound) {
    picker.dataset.bound = 'true';
    picker.addEventListener('change', event => setUiLanguage(event.target.value));
  }
  const toggle = doc?.getElementById?.('workspace-theme');
  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = 'true';
    toggle.addEventListener('click', () => setUiTheme(theme === 'dark' ? 'light' : 'dark'));
  }
}

if (globalThis.document?.documentElement) initializePreferences();
const systemTheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
systemTheme?.addEventListener?.('change', event => {
  if (explicitTheme) return;
  theme = event.matches ? 'dark' : 'light';
  paint();
});
