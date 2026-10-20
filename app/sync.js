// Queue-driven two-way sync. Operations are sent in order and removed only after the server
// confirms their opId. Anything not confirmed stays in the queue and is retried with backoff.
import * as db from './db.js';

const FULL_SYNC_MS = 24 * 3600000;
// Servers that predate per-operation acks (Apps Script) only handle these two entities.
const LEGACY_ENTITIES = ['customers', 'orders'];
let running = null;
const state = { status: 'idle', error: '', lastSyncAt: 0, backend: '', readOnly: false, supports: LEGACY_ENTITIES };
const subs = new Set();
export const syncState = () => state;
export function onSync(fn) { subs.add(fn); }
function set(patch) { Object.assign(state, patch); for (const fn of subs) fn(state); }

export async function getConfig() {
  return { url: (await db.getMeta('serverUrl')) || '', token: (await db.getMeta('token')) || '' };
}

export const pendingCount = () => db.pendingCount();

export function sync(opts = {}) {
  if (!running) running = doSync(opts).finally(() => { running = null; });
  return running;
}

export const retryFailed = () => sync({ manual: true, failedOnly: true });

// Google Apps Script web apps (URL ends in /exec) only accept "simple" CORS requests:
// text/plain body with the token inside instead of an Authorization header.
export const isAppsScript = (url) => /\/exec\/?$/.test(url.trim());

export async function callServer(action, payload = {}) {
  const { url, token } = await getConfig();
  if (!url) throw new Error('ยังไม่ได้ตั้งค่าฐานข้อมูลกลาง');
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
    throw new Error(e.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อ' : 'เชื่อมต่อฐานกลางไม่ได้ ข้อมูลในเครื่องยังใช้งานได้');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(res.status === 401 ? 'รหัสซิงค์ไม่ถูกต้อง' : `ฐานกลางตอบกลับ ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('ฐานกลางตอบกลับไม่ถูกต้อง (ตรวจสอบ URL)'); }
  if (data.error) throw new Error(data.error === 'unauthorized' ? 'รหัสซิงค์ไม่ถูกต้อง' : data.error);
  return data;
}

// What goes over the wire: the record plus the operation id and the revision this device last saw.
const wire = (op) => ({ ...op.record, opId: op.opId, baseRevision: op.baseRevision });

// failedOnly: the "ลองใหม่" button retries only operations that already failed once.
async function doSync({ periodic = false, manual = false, again = false, failedOnly = false } = {}) {
  const { url } = await getConfig();
  if (!url) { set({ status: 'off', error: '' }); return false; }
  if (!navigator.onLine) { set({ status: 'offline', error: '' }); return false; }
  // Apps Script is slower and quota-limited: when nothing changed locally, poll every 3 minutes.
  if (periodic && isAppsScript(url) && !db.pendingCount() && Date.now() - state.lastSyncAt < 180000) return true;
  set({ status: 'syncing', error: '' });
  try {
    await db.flush();
    const now = Date.now();
    const ops = db.pendingOps().filter((op) => state.supports.includes(op.entity)
      && (manual || op.nextTryAt <= now) && (!failedOnly || op.retryCount > 0));
    const cursor = (await db.getMeta('cursor')) || 0;
    // Deleted rows never show up in an incremental sync, so the whole sheet is read once a day.
    const full = !cursor || Date.now() - ((await db.getMeta('fullAt')) || 0) > FULL_SYNC_MS;
    const changes = {};
    for (const op of ops) (changes[op.entity] ??= []).push(wire(op));
    const data = await callServer('sync', { since: full ? 0 : cursor, changes, user: db.getUser(), device: db.getDevice() });

    const legacy = !data.acceptedIds;
    const accepted = data.acceptedIds || {};
    const conflicted = new Map();
    for (const rows of Object.values(data.conflicts || {})) for (const r of rows) conflicted.set(r.opId, r);
    let failed = 0;
    let merged = 0;
    for (const op of ops) {
      const ok = legacy ? LEGACY_ENTITIES.includes(op.entity) : (accepted[op.entity] || []).includes(op.opId);
      if (ok) { db.ackOp(op.opId); continue; }
      const c = conflicted.get(op.opId);
      if (c) { if (db.mergeOrConflict(op.opId, c.current, 'sync') === 'merged') merged += 1; continue; }
      db.failOp(op.opId, 'ฐานกลางยังไม่รับรายการนี้ ระบบจะลองใหม่');
      failed += 1;
    }

    const incoming = expandItems(data.changes || {}, data.dict);
    if (data.snapshot) {
      db.applySnapshot(incoming);
      await db.setMeta('fullAt', Date.now());
    } else {
      for (const e of db.ENTITIES) if (incoming[e]) db.applyIncoming(e, incoming[e], 'sync');
    }

    const supports = Array.isArray(data.supports) ? data.supports : LEGACY_ENTITIES;
    const newlySupported = supports.some((e) => !state.supports.includes(e));
    await db.setMeta('backend', data.backend || '');
    await db.setMeta('cursor', data.cursor);
    const at = Date.now();
    await db.setMeta('lastSyncAt', at);
    set({
      status: failed ? 'error' : 'ok',
      error: failed ? `ส่ง ${failed} รายการไม่สำเร็จ ระบบจะลองใหม่` : '',
      lastSyncAt: at, backend: data.backend || '', readOnly: !!data.readOnly, supports,
    });
    if (newlySupported && db.pendingOps().some((op) => supports.includes(op.entity))) scheduleSync(300);
    // Merged changes were queued during this pass; send them right away in one follow-up pass.
    if (merged && !again) return doSync({ manual: true, again: true });
    return !failed;
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
  debounce = setTimeout(() => sync(), delay);
}

export async function startAutoSync() {
  state.lastSyncAt = (await db.getMeta('lastSyncAt')) || 0;
  state.backend = (await db.getMeta('backend')) || '';
  state.supports = (await db.getMeta('supports')) || LEGACY_ENTITIES;
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', () => set({ status: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(300); });
  setInterval(() => { if (!document.hidden) sync({ periodic: true }); }, 60000);
  scheduleSync(300);
}
