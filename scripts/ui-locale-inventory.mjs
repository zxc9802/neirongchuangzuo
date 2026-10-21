import { readdir, readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { DOMParser } from 'linkedom';

const chinese = /[\u3400-\u9fff]/u;
const excluded = /^(?:workspace-locales|workspace-locale-extra|workspace-i18n|workspace-preferences(?:-init)?)\.js$/;
const attributes = ['title', 'placeholder', 'aria-label', 'alt', 'label', 'data-placeholder'];
const normalize = value => value.replace(/\s+/g, ' ').trim();

export async function uiLocaleInventory(root = new URL('../design/', import.meta.url)) {
  const entries = new Map();
  function add(text, file) {
    const key = normalize(text);
    if (!chinese.test(key) || key.length > 1800 || key.includes('data-action=') || key.includes('function(')) return;
    if (!entries.has(key)) entries.set(key, new Set());
    entries.get(key).add(file);
  }
  function collect(value, file) {
    if (!chinese.test(value)) return;
    if (!/<\/?[a-z][^>]*>/i.test(value) && /(?:aria-label|title|placeholder)=["']/.test(value)) {
      for (const match of value.matchAll(/(?:aria-label|title|placeholder)=(["'])(.*?)\1/g)) add(match[2], file);
      return;
    }
    if (/<\/?[a-z][^>]*>/i.test(value)) {
      const document = new DOMParser().parseFromString(`<main>${value}</main>`, 'text/html');
      function walk(node) {
        if (node.nodeType === 3) add(node.textContent, file);
        else if (node.nodeType === 1 && !['SCRIPT', 'STYLE'].includes(node.tagName)) {
          for (const name of attributes) if (node.hasAttribute(name)) add(node.getAttribute(name), file);
          for (const child of node.childNodes) walk(child);
        }
      }
      walk(document.documentElement);
    } else add(value, file);
  }
  function visit(node, file) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && typeof node.value === 'string') collect(node.value, file);
    if (node.type === 'TemplateLiteral') {
      collect(node.quasis.map((part, index) => (part.value.cooked ?? part.value.raw) + (index < node.expressions.length ? `{value${index}}` : '')).join(''), file);
      let alternatives = [''];
      function values(expression, index) {
        if (expression.type === 'Literal' && typeof expression.value === 'string') return [expression.value];
        if (expression.type === 'ConditionalExpression') {
          const branches = [expression.consequent, expression.alternate];
          if (branches.every(branch => branch.type === 'Literal' && typeof branch.value === 'string')) return branches.map(branch => branch.value);
        }
        return [`{value${index}}`];
      }
      node.quasis.forEach((part, index) => {
        alternatives = alternatives.map(text => text + (part.value.cooked ?? part.value.raw));
        if (index < node.expressions.length) alternatives = alternatives.flatMap(text => values(node.expressions[index], index).map(value => text + value)).slice(0, 16);
      });
      for (const alternative of alternatives) collect(alternative, file);
    }
    for (const [key, child] of Object.entries(node)) {
      if (['start', 'end', 'loc'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(item => visit(item, file));
      else if (child && typeof child === 'object') visit(child, file);
    }
  }
  for (const file of await readdir(root)) {
    if (excluded.test(file) || !/\.(?:js|html)$/.test(file)) continue;
    const source = await readFile(new URL(file, root), 'utf8');
    if (file.endsWith('.html')) collect(source, file);
    else visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), file);
  }
  return [...entries].map(([text, files]) => ({ text, files: [...files] })).sort((a, b) => a.text.localeCompare(b.text, 'zh-CN'));
}
