// Two-way sync with the server: push local changes, pull everything newer than our cursor.
import { mem, STORES, getMeta, setMeta, putMany, mergeRecords, applySnapshot } from './db.js';

const FULL_SYNC_MS = 24 * 3600000;
let running = null;
const state = { status: 'idle', error: '', lastSyncAt: 0, backend: '', readOnly: false, rejected: 0 };
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
    const cursor = (await getMeta('cursor')) || 0;
    // Deleted rows never show up in an incremental sync, so the whole sheet is read once a day.
    const full = !cursor || Date.now() - ((await getMeta('fullAt')) || 0) > FULL_SYNC_MS;
    const changes = {};
    for (const s of STORES) {
      changes[s] = [...mem[s].values()].filter((r) => r._dirty).map(({ _dirty, ...r }) => r);
    }
    const data = await callServer('sync', { since: full ? 0 : cursor, changes, user: (await getMeta('user')) || '' });

    // Clear the dirty flag only for records the server took (all of them unless it says
    // otherwise) and that were not edited again while the request was in flight.
    for (const s of STORES) {
      const took = Array.isArray(data.accepted?.[s]) ? new Set(data.accepted[s]) : null;
      const cleared = [];
      for (const r of changes[s]) {
        const cur = mem[s].get(r.id);
        if ((!took || took.has(r.id)) && cur && cur._dirty && cur.updatedAt === r.updatedAt) cleared.push({ ...cur, _dirty: 0 });
      }
      await putMany(s, cleared, 'sync');
    }
    const incoming = expandItems(data.changes || {}, data.dict);
    if (data.snapshot) {
      await applySnapshot(incoming);
      await setMeta('fullAt', Date.now());
    } else {
      await mergeRecords(incoming, { source: 'sync' });
    }
    const backend = data.backend || '';
    const rejected = STORES.reduce((n, s) => n + (data.rejected?.[s]?.length || 0), 0);
    await setMeta('backend', backend);
    await setMeta('cursor', data.cursor);
    const now = Date.now();
    await setMeta('lastSyncAt', now);
    set({ status: 'ok', lastSyncAt: now, backend, readOnly: !!data.readOnly, rejected });
    return true;
  } catch (e) {
    set({ status: 'error', error: e.message });
    return false;
  }
}

// A-CRM sends items as [code, qty, price, name?, unit?] with names/units from a product dictionary.
function expandItems(changes, dict = {}) {
  for (const o of changes.orders || []) {
    if (!Array.isArray(o.items)) continue;
    o.items = o.items.map((i) => {
      if (!Array.isArray(i)) return i;
      const [code, qty, price, name, unit] = i;
      const d = dict[code] || [];
      return { code, name: name ?? d[0] ?? code, qty, price, unit: unit ?? d[1] ?? '' };
    });
  }
  return changes;
}

let debounce;
export function scheduleSync(delay = 2000) {
  clearTimeout(debounce);
  debounce = setTimeout(sync, delay);
}

export async function startAutoSync() {
  state.lastSyncAt = (await getMeta('lastSyncAt')) || 0;
  state.backend = (await getMeta('backend')) || '';
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', () => set({ status: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(300); });
  setInterval(() => { if (!document.hidden) sync({ periodic: true }); }, 60000);
  scheduleSync(300);
}
