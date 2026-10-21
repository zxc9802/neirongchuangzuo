import { UI_COPY, translate } from './workspace-locales.js';

const attributes = ['title', 'placeholder', 'aria-label', 'alt', 'label', 'data-placeholder'];
const chinese = /[\u3400-\u9fff]/u;
const normalize = text => text.replace(/\s+/g, ' ').trim();
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.keys(UI_COPY).filter(key => /\{\w+\}/.test(key)).map(key => {
  const names = [...key.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
  const parts = key.split(/\{\w+\}/);
  return { key, names, prefix: parts[0], suffix: parts.at(-1), weight: parts.join('').length,
    regex: new RegExp('^' + parts.map(escapeRegExp).join('(.*?)') + '$', 'u') };
}).sort((a, b) => b.weight - a.weight);

const protectedText = [
  'script', 'style', 'textarea', 'input', 'pre', 'code', '[contenteditable]', '[translate="no"]', '[data-no-i18n]',
  '[data-ui-copy]', '#workspace-preferences', '#nav', '#workbar', 'body[data-page="home"] #main',
  '#workspace-account', '#workspace-credits', '#account-name', '#account-email', '.brand', '.auth-brand',
  '.markdown-body', '.agent-user-bubble', '.agent-history-row strong', '.agent-delete-summary',
  '.vc-script-document', '.vc-user-message', '.vc-rich-editor', '.vc-library-item strong',
  '.vc-task-copy strong', '.vc-favorites-grid strong', '.vc-prompt-library strong', '.vc-prompt-library article > p',
  '.vc-reference-chip', '#vc-character-file-name', '.vc-reference-options small', '.vc-removed-list article > span',
  '.restaurant-body-copy', '.restaurant-title-copy', '.restaurant-tag-copy', '.restaurant-title-list',
  '.generated-asset-copy h2', '.dh-card-copy strong', '.dh-selected-avatar-copy strong',
  '.dh-library-voice strong', '.dh-confirm-copy', '.upload-thumb small', '.asset-item small',
  '.source-media-grid figcaption', '.image-result-prompt > p', '.draft-detail > p', '.saved-prompt > p',
  '#image-preset-active-note', '#dh-voice-select option:not([value=""])', '.restaurant-draft-copy ol',
].join(',');
const protectedAttributes = '[translate="no"], [data-no-i18n], .vc-library-item img, .upload-thumb img, .generated-asset-copy h2';

export function createInterfaceLocalizer({ document: doc, language = () => doc.documentElement.lang, Observer = doc.defaultView?.MutationObserver } = {}) {
  const nodes = new WeakMap(), nodeAttributes = new WeakMap(), matches = new Map();
  let observer, active = false;
  function resolve(source, locale) {
    if (!chinese.test(source)) return source;
    const core = normalize(source);
    if (core.length > 4000) return source;
    let match = matches.get(core);
    if (match === undefined) {
      match = Object.hasOwn(UI_COPY, core) ? { key: core, values: {} } : null;
      if (!match) for (const item of patterns) {
        if (item.prefix && !core.startsWith(item.prefix) || item.suffix && !core.endsWith(item.suffix)) continue;
        const result = item.regex.exec(core);
        if (!result) continue;
        match = { key: item.key, values: Object.fromEntries(item.names.map((name, i) => [name, result[i + 1]])) };
        break;
      }
      if (matches.size > 4000) matches.clear();
      matches.set(core, match);
    }
    if (!match) {
      const decoration = /^([✦✧✓●※]+\s*)(.+)$/u.exec(core);
      if (decoration) return source.slice(0, source.indexOf(core)) + decoration[1] + resolve(decoration[2], locale) + source.slice(source.indexOf(core) + core.length);
      return source;
    }
    if (locale === 'zh-CN') return source;
    const leading = source.match(/^\s*/)[0], trailing = source.match(/\s*$/)[0];
    return leading + translate(match.key, locale, match.values) + trailing;
  }
  function text(node, locale) {
    if (!node.parentElement || node.parentElement.closest(protectedText)) return;
    const current = node.nodeValue;
    let record = nodes.get(node);
    if (!record || current !== record.output) record = { source: current, output: current };
    const output = resolve(record.source, locale);
    if (output !== current) {
      const option = node.parentElement;
      if (option.tagName === 'OPTION' && !option.hasAttribute('value')) option.setAttribute('value', normalize(option.textContent));
      node.nodeValue = output;
    }
    record.output = output;
    nodes.set(node, record);
  }
  function element(node, locale) {
    if (['SCRIPT', 'STYLE', 'PRE', 'CODE'].includes(node.tagName) || node.closest('[translate="no"], [data-no-i18n]')) return;
    if (!node.closest(protectedAttributes) && !node.matches('[data-ui-label], #workspace-language, #workspace-theme')) {
      const records = nodeAttributes.get(node) || new Map();
      for (const attribute of attributes) {
        if (!node.hasAttribute(attribute)) continue;
        const current = node.getAttribute(attribute);
        let record = records.get(attribute);
        if (!record || current !== record.output) record = { source: current, output: current };
        const output = resolve(record.source, locale);
        if (current !== output) node.setAttribute(attribute, output);
        record.output = output;
        records.set(attribute, record);
      }
      nodeAttributes.set(node, records);
    }
    for (const child of [...node.childNodes]) walk(child, locale);
  }
  function walk(node, locale) {
    if (node.nodeType === 3) text(node, locale);
    else if (node.nodeType === 1) element(node, locale);
    else if (node.nodeType === 9) for (const child of node.childNodes) walk(child, locale);
  }
  function observe() {
    if (active) observer?.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
  }
  function localize(root = doc.documentElement) {
    observer?.disconnect();
    walk(root, language());
    observe();
  }
  function start() {
    if (active) return;
    active = true;
    if (Observer) observer = new Observer(records => {
      observer.disconnect();
      const roots = new Set();
      for (const record of records) {
        if (record.type === 'childList') for (const node of record.addedNodes) roots.add(node);
        else roots.add(record.target);
      }
      for (const root of roots) walk(root, language());
      observe();
    });
    localize();
  }
  return { start, localize, stop: () => { active = false; observer?.disconnect(); } };
}
