export const CLOUD_COLLECTIONS = ['drafts','prompts','favorites','folders','asset-meta','hidden-tasks','hidden-drafts','hidden-local-drafts'];
const sets = new Set(['favorites','hidden-tasks','hidden-drafts','hidden-local-drafts']);
const toMap = (key, values) => new Map((values || []).map(v => [sets.has(key) ? v : v.id, sets.has(key) ? true : v]));
const equal = (a,b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createWorkspaceSync({ read, write, request, changed = () => {}, protect = () => null, conflict = () => {}, uuid = () => crypto.randomUUID() }) {
  let entries = read('cloud-cache', {}), pending = read('cloud-pending', {}), running, status = 'local', enabled = true, timer;
  const notify = value => { status = value; changed(value); };
  const persist = () => { write('cloud-cache', entries); write('cloud-pending', pending); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void sync(), 600); timer.unref?.(); };
  function set(collection, values) {
    const before = toMap(collection, read(collection, [])), after = toMap(collection, values);
    // Persist the outbox before the visible cache, so refresh never loses an acknowledged edit.
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const value = after.get(id) ?? null, key = collection + '/' + id;
      if (!equal(before.get(id), value)) pending[key] = { collection, id, value, revision: pending[key]?.revision ?? entries[key]?.revision ?? 0 };
    }
    write('cloud-pending', pending); write(collection, values); notify('pending'); schedule();
  }
  function apply(remote, accepted = {}) {
    for (const [key, entry] of Object.entries(remote.entries)) {
      if (pending[key]) continue;
      if (!accepted[key] && entry.collection === 'drafts' && entry.id === protect() && entries[key] && !equal(entry.value, entries[key].value)) continue;
      entries[key] = entry;
    }
    for (const collection of CLOUD_COLLECTIONS) {
      const map = new Map(Object.values(entries).filter(e => e.collection === collection).map(e => [e.id,e.value]));
      for (const p of Object.values(pending).filter(p => p.collection === collection)) map.set(p.id,p.value);
      write(collection, [...map].filter(([,v]) => v !== null).map(([id,v]) => sets.has(collection) ? id : v));
    }
    persist();
  }
  async function run() {
    if (!enabled) return;
    notify('syncing');
    try {
      let remote = await request('/workspace'); if (!enabled) return;
      if (!read('cloud-migrated', false)) {
        for (const collection of CLOUD_COLLECTIONS) for (const [id,value] of toMap(collection, read(collection, []))) {
          const key = collection + '/' + id;
          if (!remote.entries[key] && !pending[key]) pending[key] = { collection,id,value,revision:0 };
          else if (['drafts','prompts'].includes(collection) && remote.entries[key] && !equal(remote.entries[key].value,value) && !pending[key]) {
            const copyId=uuid(); pending[collection+'/'+copyId]={collection,id:copyId,value:{...value,id:copyId,title:(value.title||'草稿')+'（本机副本）'},revision:0};
          }
        }
        persist(); write('cloud-migrated', true);
      }
      for (let round = 0; Object.keys(pending).length && round < 20; round++) {
        const batch = Object.values(pending).slice(0, 2).map(v => structuredClone(v));
        try {
          remote = await request('/workspace', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ changes:batch }) });
          if (!enabled) return;
          const accepted = {};
          for (const p of batch) {
            const key=p.collection+'/'+p.id; accepted[key]=true; entries[key]=remote.entries[key];
            if (equal(pending[key],p)) delete pending[key];
            else if (pending[key]) pending[key].revision=entries[key]?.revision || 0;
          }
          apply(remote, accepted);
        } catch (error) {
          if (error.status !== 409) throw error;
          remote = await request('/workspace'); if (!enabled) return;
          for (const p of batch) {
            const key=p.collection+'/'+p.id, latest=remote.entries[key];
            if (!pending[key] || (latest?.revision || 0) === p.revision) continue;
            const local=pending[key]; delete pending[key];
            if (local.value && ['drafts','prompts'].includes(p.collection) && !equal(latest?.value,local.value)) {
              const id=uuid(); pending[p.collection+'/'+id]={...local,id,revision:0,value:{...local.value,id,title:(local.value.title||'草稿')+'（冲突副本）'}};
              conflict(p.collection,p.id,id);
            } else if (!equal(latest?.value,local.value)) {
              // Do not resurrect a remotely deleted folder or silently overwrite a concurrent move.
              conflict(p.collection,p.id,null);
            }
            if (latest) entries[key]=latest;
          }
          apply(remote);
        }
      }
      apply(remote); notify(Object.keys(pending).length ? 'pending' : 'synced');
      if (Object.keys(pending).length) schedule();
    } catch (error) { if (enabled) notify(error.status === 400 ? 'rejected' : 'offline'); }
  }
  function sync() { if (!running) running=run().finally(()=>{running=null;}); return running; }
  return { set, sync, get status(){return status;}, close(){enabled=false;clearTimeout(timer);} };
}
