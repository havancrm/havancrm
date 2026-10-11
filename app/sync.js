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

export function sync(opts) {
  if (!running) running = doSync(opts).finally(() => { running = null; });
  return running;
}

// Google Apps Script web apps (URL ends in /exec) only accept "simple" CORS requests:
// text/plain body with the token inside instead of an Authorization header.
export const isAppsScript = (url) => /\/exec\/?$/.test(url.trim());

export async function callServer(action, payload = {}) {
  const { url, token } = await getConfig();
  if (!url) throw new Error('ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = isAppsScript(url)
      ? await fetch(url.trim(), {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...payload, action, token }),
        signal: ctrl.signal,
      })
      : await fetch(url.replace(/\/+$/, '') + '/api/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อ' : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (ตรวจสอบ URL และการ Deploy แบบ Anyone)');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(res.status === 401 ? 'รหัสซิงค์ไม่ถูกต้อง' : `เซิร์ฟเวอร์ตอบกลับ ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (ตรวจสอบ URL)'); }
  if (data.error) throw new Error(data.error === 'unauthorized' ? 'รหัสซิงค์ไม่ถูกต้อง' : data.error);
  return data;
}

async function doSync({ periodic = false } = {}) {
  const { url } = await getConfig();
  if (!url) { set({ status: 'off', error: '' }); return false; }
  if (!navigator.onLine) { set({ status: 'offline', error: '' }); return false; }
  // Apps Script is slower and quota-limited: when nothing changed locally, poll every 3 minutes.
  if (periodic && isAppsScript(url) && !pendingCount() && Date.now() - state.lastSyncAt < 180000) return true;
  set({ status: 'syncing', error: '' });
  try {
    const since = (await getMeta('cursor')) || 0;
    const changes = {};
    for (const s of STORES) {
      changes[s] = [...mem[s].values()].filter((r) => r._dirty).map(({ _dirty, ...r }) => r);
    }
    const data = await callServer('sync', { since, changes });

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
    set({ status: 'error', error: e.message });
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
  setInterval(() => { if (!document.hidden) sync({ periodic: true }); }, 60000);
  scheduleSync(300);
}
