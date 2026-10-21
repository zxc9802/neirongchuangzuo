import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from '../preview.mjs';

test('every literal JavaScript import reachable from the workspace is served as JavaScript', async t => {
  const ai = async (_req, res) => { res.end('{}'); return true; };
  ai.ready = Promise.resolve(); ai.shutdown = async () => {};
  const server = createPreviewServer({ createAI: () => ai, credits: null });
  t.after(() => server.shutdown());
  await server.ready;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin)).text();
  for (const match of html.matchAll(/(?:src|href)="(\/(?:workspace-[^"/]+\.(?:js|css)))"/g)) {
    const response = await fetch(origin + match[1]);
    assert.equal(response.status, 200, `missing preference asset: ${match[1]}`);
    assert.match(response.headers.get('content-type') || '', match[1].endsWith('.css') ? /css/ : /javascript/);
  }
  const pending = ['/app.js'], visited = new Set();
  while (pending.length) {
    const path = pending.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `missing workspace module: ${path}`);
    assert.match(response.headers.get('content-type') || '', /javascript/, `wrong module MIME: ${path}`);
    const source = await response.text();
    const imports = /\bimport\s+(?:[^;]*?\s+from\s*)?['"]([./][^'"]+)['"]|\bimport\s*\(\s*['"]([./][^'"]+)['"]\s*\)/g;
    for (const match of source.matchAll(imports)) {
      const url = new URL(match[1] || match[2], origin + path);
      if (url.origin === origin && url.pathname.endsWith('.js')) pending.push(url.pathname);
    }
  }
  assert.ok(visited.has('/malaysian-prices.js'), 'shared pricing import must be checked');
  assert.ok(visited.has('/video-creator-ui.js'), 'video UI import must be checked');
  assert.ok(visited.has('/workspace-preferences.js'), 'language and theme preferences must be served');
  assert.ok(visited.has('/workspace-locales.js'), 'interface dictionaries must be served');
  assert.ok(visited.size > 20, 'exercise the full workspace module graph');
});
