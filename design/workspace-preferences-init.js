(() => {
  let language = 'zh-CN', theme;
  try {
    const savedLanguage = localStorage.getItem('qiya-ui-language');
    if (['zh-CN', 'ms', 'en'].includes(savedLanguage)) language = savedLanguage;
    const savedTheme = localStorage.getItem('qiya-ui-theme');
    if (['light', 'dark'].includes(savedTheme)) theme = savedTheme;
  } catch { /* Preferences remain usable when storage is unavailable. */ }
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
})();
