// Local-first data layer: every record lives in memory (Map) for instant reads,
// and is persisted to IndexedDB in the background so the app works offline.
const DB_NAME = 'havancrm';
const VERSION = 1;
export const STORES = ['customers', 'orders'];
export const mem = { customers: new Map(), orders: new Map() };

let idb;
const listeners = new Set();

const wrap = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export async function init() {
  const req = indexedDB.open(DB_NAME, VERSION);
  req.onupgradeneeded = () => {
    const d = req.result;
    for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
  };
  idb = await wrap(req);
  for (const s of STORES) {
    for (const r of await wrap(idb.transaction(s).objectStore(s).getAll())) mem[s].set(r.id, r);
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(source) { for (const fn of listeners) fn(source); }

// Write records to memory immediately, IndexedDB asynchronously.
export function putMany(store, recs, source = 'local') {
  if (!recs.length) return Promise.resolve();
  for (const r of recs) mem[store].set(r.id, r);
  const tx = idb.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const r of recs) os.put(r);
  emit(source);
  return done(tx);
}

// Create or update a record and mark it for sync.
export function save(store, data) {
  const now = Date.now();
  const prev = data.id ? mem[store].get(data.id) : null;
  const rec = { ...prev, ...data, id: data.id || uid(), createdAt: prev?.createdAt || now, updatedAt: now, _dirty: 1 };
  putMany(store, [rec]);
  return rec;
}

// Soft delete so the deletion can be synced to other devices.
export function remove(store, id) {
  const prev = mem[store].get(id);
  if (prev) save(store, { id, deleted: true });
}

export const list = (store) => [...mem[store].values()].filter((r) => !r.deleted);
export const get = (store, id) => { const r = mem[store].get(id); return r && !r.deleted ? r : null; };

export async function getMeta(key) {
  return wrap(idb.transaction('meta').objectStore('meta').get(key));
}
export async function setMeta(key, value) {
  const tx = idb.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  return done(tx);
}

export function deleteMany(store, ids, source = 'sync') {
  if (!ids.length) return Promise.resolve();
  for (const id of ids) mem[store].delete(id);
  const tx = idb.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const id of ids) os.delete(id);
  emit(source);
  return done(tx);
}

// Replace server-owned records (src set) with a full snapshot. Local unsynced edits are kept.
export async function applySnapshot(data) {
  for (const s of STORES) {
    const incoming = data[s] || [];
    const ids = new Set(incoming.map((r) => r.id));
    const remove = [];
    for (const r of mem[s].values()) if (r.src && !r._dirty && !ids.has(r.id)) remove.push(r.id);
    const put = [];
    for (const r of incoming) {
      const cur = mem[s].get(r.id);
      if (cur && cur._dirty) continue;
      const rec = { ...r, _dirty: 0 };
      if (cur && JSON.stringify(cur) === JSON.stringify(rec)) continue;
      put.push(rec);
    }
    await deleteMany(s, remove);
    await putMany(s, put, 'sync');
  }
}

// Merge records from a backup or the server: newest updatedAt wins.
export async function mergeRecords(data, { markDirty = false, source = 'merge' } = {}) {
  let count = 0;
  for (const s of STORES) {
    const out = [];
    for (const r of data[s] || []) {
      if (!r || !r.id || typeof r.updatedAt !== 'number') continue;
      const cur = mem[s].get(r.id);
      if (cur && cur.updatedAt > r.updatedAt) continue;
      if (cur && cur._dirty && cur.updatedAt === r.updatedAt && !markDirty) {
        out.push({ ...cur, _dirty: 0 });
      } else {
        out.push({ ...r, _dirty: markDirty ? 1 : 0 });
      }
    }
    count += out.length;
    await putMany(s, out, source);
  }
  return count;
}

export function exportAll() {
  const strip = ({ _dirty, ...r }) => r;
  return {
    app: 'havancrm',
    version: 1,
    exportedAt: new Date().toISOString(),
    customers: [...mem.customers.values()].map(strip),
    orders: [...mem.orders.values()].map(strip),
  };
}
