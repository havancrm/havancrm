// Two-way sync with the server: push local changes, pull everything newer than our cursor.
import { mem, STORES, getMeta, setMeta, putMany, mergeRecords } from './db.js';

let running = null;
const state = { status: 'idle', error: '', lastSyncAt: 0 };
const subs = new Set();
export const syncState = () => state;
export function onSync(fn) { subs.add(fn); }
function set(patch) { Object.assign(state, patch); for (const fn of subs) fn(state); }

export async function getConfig() {
  return { url: (await getMeta('serverUrl')) || '', token: (await getMeta('token')) || '' };
}

export const pendingCount = () =>
  STORES.reduce((n, s) => n + [...mem[s].values()].filter((r) => r._dirty).length, 0);

export function sync() {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  const { url, token } = await getConfig();
  if (!url) { set({ status: 'off', error: '' }); return false; }
  if (!navigator.onLine) { set({ status: 'offline', error: '' }); return false; }
  set({ status: 'syncing', error: '' });
  try {
    const since = (await getMeta('cursor')) || 0;
    const changes = {};
    for (const s of STORES) {
      changes[s] = [...mem[s].values()].filter((r) => r._dirty).map(({ _dirty, ...r }) => r);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url.replace(/\/+$/, '') + '/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ since, changes }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(res.status === 401 ? 'รหัสซิงค์ไม่ถูกต้อง' : `เซิร์ฟเวอร์ตอบกลับ ${res.status}`);
    const data = await res.json();

    // Clear the dirty flag only for records not edited again while the request was in flight.
    for (const s of STORES) {
      const cleared = [];
      for (const r of changes[s]) {
        const cur = mem[s].get(r.id);
        if (cur && cur._dirty && cur.updatedAt === r.updatedAt) cleared.push({ ...cur, _dirty: 0 });
      }
      await putMany(s, cleared, 'sync');
    }
    await mergeRecords(data.changes || {}, { source: 'sync' });
    await setMeta('cursor', data.cursor);
    const now = Date.now();
    await setMeta('lastSyncAt', now);
    set({ status: 'ok', lastSyncAt: now });
    return true;
  } catch (e) {
    set({ status: 'error', error: e.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อ' : e.message });
    return false;
  }
}

let debounce;
export function scheduleSync(delay = 2000) {
  clearTimeout(debounce);
  debounce = setTimeout(sync, delay);
}

export async function startAutoSync() {
  state.lastSyncAt = (await getMeta('lastSyncAt')) || 0;
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', () => set({ status: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(300); });
  setInterval(() => { if (!document.hidden) sync(); }, 60000);
  scheduleSync(300);
}
