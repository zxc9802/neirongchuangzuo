import { Marked, Renderer } from 'marked';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function safeLink(href) {
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

const parser = new Marked({ gfm: true, breaks: true, async: false, renderer: {
  html({ text }) { return escape(text); },
  link({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens), url = safeLink(href);
    return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escape(title)}"` : ''}>${text}</a>` : text;
  },
  image({ text }) { return escape(text); },
  table(token) { return `<div class="markdown-table">${Renderer.prototype.table.call(this, token)}</div>`; },
} });

export function renderMarkdown(value) {
  const text = String(value ?? '');
  try { return parser.parse(text); }
  catch { return `<p>${escape(text).replace(/\r?\n/g, '<br>')}</p>`; }
}

export function markdownText(value) {
  return `<div class="markdown-body">${renderMarkdown(value)}</div>`;
}
