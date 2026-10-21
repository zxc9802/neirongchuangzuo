import test from 'node:test';
import assert from 'node:assert/strict';
import { digitalHumanApi as api } from '../design/digital-human-api.js';

const avatar = { id: 'avatar', name: '测试形象', videoUrl: '/avatar.mp4' };
const voice = { id: 'voice', name: '测试声音', audioUrl: '/voice.mp3', isDefault: true };
const active = id => ({ id, status: 'processing', step: 'render', progress: 20, createdAt: Date.now(), inputs: { avatarId: avatar.id, scriptText: id }, results: {} });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function page(t, initialTasks = []) {
  const tasks = [...initialTasks], regions = new Map(), listeners = {}, storage = new Map(), notices = [], requests = [];
  const node = () => ({ innerHTML: '', children: [], textContent: '', setAttribute() {}, insertAdjacentHTML() {}, querySelector: () => ({ textContent: '' }) });
  const root = { isConnected: true, addEventListener: (event, callback) => { listeners[event] = callback; }, querySelector: selector => {
    if (!regions.has(selector)) regions.set(selector, node());
    return regions.get(selector);
  } };
  for (const [key, value] of Object.entries({ document: { querySelector: () => root }, window: {}, localStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
  } })) {
    const original = globalThis[key]; globalThis[key] = value;
    t.after(() => { if (original === undefined) delete globalThis[key]; else globalThis[key] = original; });
  }
  t.mock.method(api, 'getSession', async () => ({ data: { user: { id: 'test' } } }));
  t.mock.method(api, 'getStatus', async () => ({ ready: true, engines: ['b', 'd', 'e'].map(id => ({ id, label: id, available: true })) }));
  t.mock.method(api, 'listVoices', async () => [voice]);
  t.mock.method(api, 'listLibrary', async () => ({
    items: tasks.map(task => ({ kind: 'task', id: task.id, task })), selection: { avatar },
    activeTasks: tasks.filter(task => ['pending', 'processing'].includes(task.status)), counts: { tasks: tasks.length }, hasMore: false,
  }));
  t.mock.method(api, 'getTask', async id => tasks.find(task => task.id === id));
  const create = t.mock.method(api, 'createTask', async input => {
    requests.push(input);
    const task = { ...active(`task-${tasks.length + 1}`), inputs: { ...input } };
    tasks.push(task); return task;
  });
  let mod;
  const ctx = { configs: { avatar: { prompt: '第一份口播文案' } }, storeInfo: {}, esc: value => String(value ?? ''), icon: () => '',
    button: (action, label, className, attrs = '') => `<button data-action="${action}" class="${className}" ${attrs}>${label}</button>`,
    toast: text => notices.push(text) };
  const reload = async () => {
    mod?.disposeDigitalHuman();
    mod = await import(`../design/digital-human.js?concurrency=${Math.random()}`);
    mod.renderDigitalHuman(ctx); mod.bindDigitalHuman(ctx); await settle();
  };
  t.after(() => mod?.disposeDigitalHuman());
  await reload();
  return { tasks, requests, notices, create, reload,
    action: (action, dataset = {}) => mod.handleDigitalHumanAction(action, { dataset }, ctx),
    input: value => listeners.input({ target: { id: 'dh-script', value, dataset: {} } }),
    engine: value => listeners.change({ target: { value, dataset: { dhOption: 'engine' } } }),
    button: () => root.querySelector('[data-action="dh-generate"]'),
    hint: () => root.querySelector('#dh-generate-hint').textContent,
    html: () => mod.renderDigitalHuman(ctx),
  };
}

test('running digital-human tasks allow further submissions while duplicate in-flight clicks are blocked', async t => {
  const ui = await page(t, [active('existing')]);
  assert.equal(ui.button().disabled, false);
  let accept;
  ui.create.mock.mockImplementationOnce(input => {
    ui.requests.push(input);
    return new Promise(resolve => { accept = () => {
      const task = { ...active('first'), inputs: { ...input } };
      ui.tasks.push(task); resolve(task);
    }; });
  });
  ui.action('dh-generate');
  assert.equal(ui.button().disabled, true);
  ui.action('dh-generate');
  assert.equal(ui.requests.length, 1, 'a double click must not create another paid task');
  ui.input('第二份口播文案'); ui.engine('e');
  accept(); await settle();
  assert.equal(ui.button().disabled, false);
  ui.action('dh-generate'); await settle();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.tasks.length, 3);
  assert.deepEqual(ui.requests.map(input => [input.scriptText, input.engine]), [['第一份口播文案', 'b'], ['第二份口播文案', 'e']]);
  assert.equal(new Set(ui.tasks.map(task => task.id)).size, 3);
  assert.equal(ui.button().disabled, false);
});

test('multiple tasks restore after reload and update their own progress and results', async t => {
  const ui = await page(t, [active('first'), active('second')]);
  await ui.reload();
  assert.equal(ui.button().disabled, false);
  ui.tasks[0] = { ...ui.tasks[0], progress: 65 };
  ui.tasks[1] = { ...ui.tasks[1], status: 'completed', step: 'done', progress: 100, results: { finalVideoUrl: '/second.mp4' } };
  ui.action('dh-poll-retry'); await settle();
  const html = ui.html();
  assert.match(html, /data-library-key="task:first"[\s\S]*?<strong>65%<\/strong>/);
  assert.match(html, /data-library-key="task:second"[\s\S]*?dh-card-status completed/);
  assert.match(html, /\/api\/tasks\/second\/download\/final.mp4/);
  assert.equal(ui.button().disabled, false);
});

test('a rejected new submission leaves existing tasks available and unlocks the form', async t => {
  const ui = await page(t, [active('existing')]);
  ui.create.mock.mockImplementationOnce(async () => { throw new Error('生成任务并发已达上限，请稍后再试'); });
  ui.action('dh-generate'); await settle();
  assert.match(ui.notices.at(-1), /并发已达上限/);
  assert.match(ui.html(), /data-library-key="task:existing"/);
  assert.equal(ui.button().disabled, false);
  ui.input('');
  assert.equal(ui.button().disabled, true, 'required input validation remains enabled');
});
