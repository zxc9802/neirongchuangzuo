import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const ownerId = /^[a-f0-9]{64}$/;
const taskId = /^mix:[a-f0-9]{32}:[1-9][0-9]{0,5}$/;
const publicRecord = record => record && Object.fromEntries(Object.entries(record).filter(([key]) => !['userId', 'wallet'].includes(key)));

/** This listener is private to the Python worker. Identities never come from browser request bodies. */
export function createMixCreditsBridge({ credits, dataDir, token }) {
  const path = join(dataDir, 'credit-owners.json');
  let owners = {}, sequence = Promise.resolve(), server, starting;
  const ready = (async () => {
    await mkdir(dataDir, { recursive: true });
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid credit owner map');
      owners = JSON.parse(await readFile(path, 'utf8'));
      if (!owners || Array.isArray(owners) || Object.entries(owners).some(([key, value]) => !ownerId.test(key) || typeof value !== 'string' || hash(value) !== key)) throw new Error('Invalid credit owner map');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  })();
  ready.catch(() => {});
  async function register(userId) {
    const owner = hash(userId);
    const operation = sequence.then(async () => {
      await ready;
      if (owners[owner] === userId) return owner;
      const next = { ...owners, [owner]: userId }, temporary = join(dataDir, `.credit-owners-${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); owners = next; }
      finally { await unlink(temporary).catch(() => {}); }
      return owner;
    });
    sequence = operation.catch(() => {}); return operation;
  }
  async function handle(req, res) {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const auth = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from('Bearer ' + token);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected) || req.method !== 'POST' || req.headers.origin) { send(401, { error: '内部积分凭据无效', code: 'UNAUTHENTICATED' }); return; }
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Object.assign(new Error('请求过大'), { status: 413 }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await ready; await sequence;
      if (!ownerId.test(body.owner || '') || !owners[body.owner]) { send(403, { error: '账号积分映射不可用', code: 'CREDITS_OWNER_UNKNOWN' }); return; }
      const userId = owners[body.owner];
      if (req.url === '/snapshot') { send(200, { wallet: await credits.snapshot(userId) }); return; }
      if (!taskId.test(body.taskId || '')) { send(400, { error: '混剪积分任务标识无效' }); return; }
      const argument = { userId, taskId: body.taskId, units: body.units };
      let record;
      switch (req.url) {
        case '/read': record = await credits.reservation(userId, body.taskId); break;
        case '/reserve': record = await credits.reserve({ ...argument, kind: 'mix' }); break;
        case '/extend': record = await credits.extendReservation(argument); break;
        case '/settle': record = await credits.settle(argument); break;
        case '/release': record = await credits.release(argument); break;
        default: send(404, { error: '接口不存在' }); return;
      }
      send(200, { reservation: publicRecord(record) });
    } catch (error) { send(error.status || error.statusCode || 503, { error: error.code ? error.message : '积分服务暂时不可用，请稍后重试。', code: error.code || 'CREDITS_STORAGE_UNAVAILABLE' }); }
  }
  return {
    register,
    async start() {
      if (starting) return starting;
      starting = (async () => { await ready; server = createServer((req, res) => { void handle(req, res); }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return `http://127.0.0.1:${server.address().port}`; })();
      return starting;
    },
    async shutdown() { await starting?.catch(() => {}); if (server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } },
  };
}
