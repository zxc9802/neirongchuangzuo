import { jsonrepair } from 'jsonrepair';
import { parseStructuredOutput } from '../restaurant/structured-output.mjs';

function escapeQuotedProse(source) {
  const stack = []; let quoted = false, key = false, escaped = false, output = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) { output += char; escaped = false; continue; }
      if (char === '\\') { output += char; escaped = true; continue; }
      if (char === '"') {
        const rest = source.slice(i + 1).trimStart(), parent = stack.at(-1);
        const closes = key ? rest.startsWith(':') : /^[}\]]/.test(rest)
          || parent === '{' && /^,\s*"[^"\\]*"\s*:/.test(rest)
          || parent === '[' && /^,\s*(?:"|\{|\[|-?\d|true\b|false\b|null\b)/.test(rest);
        if (!closes) { output += '\\"'; continue; }
        quoted = false;
      }
      output += char; continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') stack.pop();
    if (char === '"') { quoted = true; key = stack.at(-1) === '{' && /[{,]\s*$/.test(output); }
    output += char;
  }
  return output;
}

export function parseDirectorOutput(payload) {
  try { return { value: parseStructuredOutput(payload) }; }
  catch (cause) {
    const choice = payload?.choices?.[0], raw = choice?.message?.content;
    if (cause.outputIssue !== 'invalid_json' || choice?.finish_reason !== 'stop') throw cause;
    const content = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter(item => item?.type === 'text').map(item => item.text || '').join('') : '';
    const source = content.trim().replace(/^\uFEFF/, '').replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
    if (!source.startsWith('{') || !source.endsWith('}') || source.length > 512 * 1024) throw cause;
    try {
      let repaired;
      try { repaired = JSON.stringify(JSON.parse(escapeQuotedProse(source))); }
      catch { repaired = jsonrepair(source); }
      // Only escaping, whitespace and commas may change; never invent values, keys or closing structures.
      const unchanged = value => value.replace(/[\\\s,]/gu, '');
      if (unchanged(source) !== unchanged(repaired)) throw cause;
      const fixed = { ...payload, choices: [{ ...choice, message: { ...choice.message, content: repaired } }] };
      return { value: parseStructuredOutput(fixed), repair: { type:'json_escaping', originalIssue:'invalid_json' } };
    } catch { throw cause; }
  }
}
