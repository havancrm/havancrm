// Local-first data layer. Records live in memory (Map) for instant reads and are persisted
// to IndexedDB. Every local change also becomes one Sync Queue operation, and the queue row
// is written in the same transaction as the record, so an edit can never exist without its operation.
// An operation is removed only after the server confirms its opId.
import { threeWayMerge } from './core.js';

const DB_NAME = 'havancrm'; // same name as the first version, so existing data is kept
const VERSION = 2;
export const ENTITIES = ['customers', 'leads', 'orders', 'tasks', 'activities', 'products'];
const KEYED = { queue: 'opId', audit: 'id', backups: 'id', snapshots: 'id', imports: 'id', conflicts: 'id' };
const META_KEYS = ['revision', 'baseRevision', 'updatedAt', 'updatedBy', 'createdAt', 'opId'];

export const mem = Object.fromEntries(ENTITIES.map((e) => [e, new Map()]));
const queue = new Map(); // opId -> operation
const qIndex = new Map(); // entity + recordId -> opId (at most one pending operation per record)
const conflicts = new Map(); // conflictId -> conflict
const listeners = new Set();
const errorListeners = new Set();
let idb;
let flushed = Promise.resolve();
let auditWrites = 0;
let currentUser = '';
let device = '';
export let masters = {};

export const DEFAULT_MASTERS = {
  zones: ['เหนือ', 'ใต้', 'กลาง', 'ตะวันออก', 'ตะวันตก'],
  businessTypes: ['ร้านโชห่วย', 'มินิมาร์ท', 'ร้านอาหาร', 'ร้านค้าส่ง', 'โรงแรม', 'อื่น ๆ'],
  owners: [],
  tags: ['VIP', 'ขายส่ง'],
  terms: ['เงินสด', 'เครดิต 7 วัน', 'เครดิต 15 วัน', 'เครดิต 30 วัน'],
  payments: ['ลูกค้าโอน', 'เก็บเงินสด', 'เครดิต'],
  taskTypes: ['โทร', 'เข้าพบ', 'นัดหมาย', 'ติดตาม'],
  provinces: [],
  priceThreshold: 0,
};

const wrap = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const qKey = (entity, id) => entity + '\u0001' + id;
const stripLocal = (r) => {
  const out = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) out[k] = v;
  return out;
};
const brief = (r) => {
  if (!r) return null;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('_') || META_KEYS.includes(k) || v === null || typeof v === 'object') continue;
    out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
  }
  return out;
};

export async function init() {
  const req = indexedDB.open(DB_NAME, VERSION);
  req.onupgradeneeded = () => {
    const d = req.result;
    for (const s of ENTITIES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    for (const [s, key] of Object.entries(KEYED)) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: key });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
  };
  idb = await wrap(req);
  const readAll = (s) => wrap(idb.transaction(s).objectStore(s).getAll());
  for (const s of ENTITIES) for (const r of await readAll(s)) mem[s].set(r.id, r);
  for (const op of await readAll('queue')) indexOp(op);
  for (const c of await readAll('conflicts')) conflicts.set(c.id, c);
  currentUser = (await getMeta('user')) || '';
  device = (await getMeta('device')) || uid().slice(0, 8);
  await setMeta('device', device);
  masters = { ...DEFAULT_MASTERS, ...((await getMeta('masters')) || {}) };

  // Upgrade from version 1: records that were marked "dirty" become queue operations.
  const legacy = [];
  for (const s of ENTITIES) {
    for (const r of mem[s].values()) {
      if (r._dirty) {
        delete r._dirty;
        r.revision = r.revision || 1;
        r._base = r._base || 0;
        if (!qIndex.has(qKey(s, r.id))) legacy.push({ entity: s, rec: r });
      }
    }
  }
  if (legacy.length) persist({ ops: legacy.map(({ entity, rec }) => enqueue(entity, rec.id, stripLocal(rec), null, 'ย้ายจากเวอร์ชันเดิม', Date.now()).op) });
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  await flush();
}

export const flush = () => flushed;

export function setUser(name) {
  currentUser = name;
  return setMeta('user', name);
}
export const getUser = () => currentUser;
export const getDevice = () => device;

export function setMasters(next) {
  masters = { ...DEFAULT_MASTERS, ...next };
  return setMeta('masters', masters);
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onWriteError(fn) { errorListeners.add(fn); return () => errorListeners.delete(fn); }
function emit(source) { for (const fn of listeners) fn(source); }

// ---------- queue bookkeeping ----------
function indexOp(op) {
  queue.set(op.opId, op);
  qIndex.set(qKey(op.entity, op.recordId), op.opId);
}
function unindexOp(op) {
  queue.delete(op.opId);
  if (qIndex.get(qKey(op.entity, op.recordId)) === op.opId) qIndex.delete(qKey(op.entity, op.recordId));
}

// Create or coalesce the pending operation for one record. Coalescing keeps the first base
// snapshot and base revision, so the server (and a later merge) still compares against what this device last saw.
function enqueue(entity, id, record, prev, action, now) {
  const key = qKey(entity, id);
  const existing = queue.get(qIndex.get(key) || '');
  const op = existing
    ? { ...existing, opId: uid(), record, action, updatedAt: now }
    : {
      opId: uid(), entity, recordId: id, operation: record.deleted ? 'delete' : 'upsert', record,
      base: prev ? stripLocal(prev) : null, baseRevision: prev?._base || 0,
      createdAt: now, updatedAt: now, action, user: currentUser, device, retryCount: 0, lastError: '', nextTryAt: 0,
    };
  const replaced = existing ? existing.opId : '';
  if (existing) unindexOp(existing);
  indexOp(op);
  return { op, replaced };
}

function auditEntry(entity, prev, rec, action, now) {
  return {
    id: String(now).padStart(13, '0') + '-' + uid().slice(0, 8),
    at: now, user: currentUser, device, action, entity, recordId: rec.id,
    label: rec.name || rec.no || rec.title || rec.sku || '',
    before: brief(prev), after: brief(rec),
  };
}

// Write many records at once. One IndexedDB transaction per call keeps bulk imports fast.
export function writeRecords(entity, datas, { action = 'แก้ไข', source = 'local', importId = '', audit = true } = {}) {
  const now = Date.now();
  const recs = [];
  const ops = [];
  const dropOps = [];
  const audits = [];
  for (const data of datas) {
    const id = data.id || uid();
    const prev = mem[entity].get(id);
    const rec = {
      ...prev, ...data, id,
      createdAt: prev?.createdAt || data.createdAt || now,
      updatedAt: now, updatedBy: currentUser,
      revision: (prev?.revision || 0) + 1,
      _base: prev?._base || 0,
    };
    if (importId) rec.importId = importId;
    mem[entity].set(id, rec);
    const { op, replaced } = enqueue(entity, id, stripLocal(rec), prev, action, now);
    ops.push(op);
    if (replaced) dropOps.push(replaced);
    recs.push(rec);
    if (audit) audits.push(auditEntry(entity, prev, rec, action, now));
  }
  if (!recs.length) return [];
  persist({ records: { [entity]: recs }, ops, dropOps, audit: audits });
  emit(source);
  return recs;
}

export const save = (entity, data, opts) => writeRecords(entity, [data], opts)[0];

// Soft delete so the deletion can be synced to other devices.
export function remove(entity, id) {
  const prev = mem[entity].get(id);
  if (prev && !prev.deleted) return save(entity, { id, deleted: true }, { action: 'ลบ' });
  return null;
}

export const list = (entity) => [...mem[entity].values()].filter((r) => !r.deleted);
export const get = (entity, id) => { const r = mem[entity].get(id); return r && !r.deleted ? r : null; };

// Shared write path: memory is already updated by the caller; this persists rows atomically.
function persist({ records = {}, ops = [], dropOps = [], conflictRows = [], dropConflicts = [], audit = [] }) {
  const names = new Set(['queue', 'conflicts', 'audit', ...Object.keys(records)]);
  const tx = idb.transaction([...names], 'readwrite');
  for (const [entity, list] of Object.entries(records)) for (const r of list) tx.objectStore(entity).put(r);
  for (const op of ops) tx.objectStore('queue').put(op);
  for (const id of dropOps) tx.objectStore('queue').delete(id);
  for (const c of conflictRows) tx.objectStore('conflicts').put(c);
  for (const id of dropConflicts) tx.objectStore('conflicts').delete(id);
  for (const a of audit) tx.objectStore('audit').put(a);
  flushed = done(tx).catch((e) => { for (const fn of errorListeners) fn(e); });
  if (audit.length && (auditWrites += audit.length) >= 200) { auditWrites = 0; pruneAudit().catch(() => {}); }
  return flushed;
}

export async function pruneAudit(keep = 5000) {
  const keys = await wrap(idb.transaction('audit').objectStore('audit').getAllKeys());
  if (keys.length <= keep) return;
  const tx = idb.transaction('audit', 'readwrite');
  for (const k of keys.slice(0, keys.length - keep)) tx.objectStore('audit').delete(k);
  return done(tx);
}

// ---------- sync-facing operations ----------
export const pendingOps = () => [...queue.values()].sort((a, b) => a.createdAt - b.createdAt);
export const pendingCount = () => queue.size;
export const failedCount = () => [...queue.values()].filter((o) => o.retryCount > 0).length;
export const hasPending = (entity, id) => qIndex.has(qKey(entity, id));
export const conflictList = () => [...conflicts.values()].sort((a, b) => b.createdAt - a.createdAt);
export const conflictFor = (entity, id) => [...conflicts.values()].find((c) => c.entity === entity && c.recordId === id) || null;

export function recordStatus(entity, id) {
  if (conflictFor(entity, id)) return 'conflict';
  if (qIndex.has(qKey(entity, id))) return 'pending';
  return 'synced';
}

// The server confirmed this operation. Remove it, and move the base of any newer pending edit to this revision.
export function ackOp(opId) {
  const op = queue.get(opId);
  if (!op) return;
  unindexOp(op);
  const next = queue.get(qIndex.get(qKey(op.entity, op.recordId)) || '');
  const writes = { dropOps: [opId] };
  if (next) {
    next.baseRevision = op.record.revision;
    writes.ops = [next];
  } else {
    const rec = mem[op.entity].get(op.recordId);
    if (rec) {
      rec._base = op.record.revision;
      writes.records = { [op.entity]: [rec] };
    }
  }
  persist(writes);
}

export function failOp(opId, message) {
  const op = queue.get(opId);
  if (!op) return;
  op.retryCount += 1;
  op.lastError = message;
  op.nextTryAt = Date.now() + Math.min(60000 * 2 ** (op.retryCount - 1), 15 * 60000);
  persist({ ops: [op] });
}

// The server holds a newer revision that this change cannot merge with. Keep both versions for the user to decide.
export function raiseConflict(opId, cloud, source = 'sync') {
  const op = queue.get(opId);
  if (!op) return null;
  unindexOp(op);
  const cur = mem[op.entity].get(op.recordId);
  if (cur) { cur._base = cloud.revision || 0; }
  const row = {
    id: uid(), entity: op.entity, recordId: op.recordId, createdAt: Date.now(),
    local: stripLocal(cur || op.record), base: op.base, cloud,
  };
  conflicts.set(row.id, row);
  persist({ records: cur ? { [op.entity]: [cur] } : {}, dropOps: [opId], conflictRows: [row] });
  emit(source);
  return row;
}

// The server rejected an operation because the cloud moved on. Merge when the changed fields do not overlap
// (the merged record is queued again on top of the cloud revision); otherwise keep both versions as a conflict.
export function mergeOrConflict(opId, cloud, source = 'sync') {
  const op = queue.get(opId);
  if (!op) return null;
  const m = threeWayMerge(op.base, op.record, cloud);
  if (!m.ok) return raiseConflict(opId, cloud, source);
  unindexOp(op);
  const rec = {
    ...m.record, id: op.recordId, revision: Math.max(op.record.revision || 0, cloud.revision || 0) + 1,
    updatedAt: Date.now(), updatedBy: currentUser, _base: cloud.revision || 0,
  };
  mem[op.entity].set(op.recordId, rec);
  const next = {
    ...op, opId: uid(), record: stripLocal(rec), base: stripLocal(cloud), baseRevision: cloud.revision || 0,
    action: 'รวมข้อมูลกับเครื่องอื่น', retryCount: 0, lastError: '', nextTryAt: 0,
  };
  indexOp(next);
  persist({ records: { [op.entity]: [rec] }, ops: [next], dropOps: [opId] });
  emit(source);
  return 'merged';
}

// Resolve a conflict: 'mine' keeps this device's version, 'cloud' takes the cloud version, 'merge' combines non-overlapping fields.
export function resolveConflict(conflictId, choice) {
  const c = conflicts.get(conflictId);
  if (!c) return false;
  const cur = mem[c.entity].get(c.recordId) || c.local;
  const now = Date.now();
  let rec;
  if (choice === 'cloud') {
    rec = { ...c.cloud, _base: c.cloud.revision || 0 };
    conflicts.delete(conflictId);
    mem[c.entity].set(c.recordId, rec);
    persist({ records: { [c.entity]: [rec] }, dropConflicts: [conflictId] });
    emit('sync');
    return true;
  }
  let data = stripLocal(cur);
  if (choice === 'merge') {
    const m = threeWayMerge(c.base, stripLocal(cur), c.cloud);
    if (!m.ok) return false;
    data = m.record;
  }
  conflicts.delete(conflictId);
  rec = { ...data, id: c.recordId, revision: (c.cloud.revision || 0) + 1, updatedAt: now, updatedBy: currentUser, _base: c.cloud.revision || 0 };
  mem[c.entity].set(c.recordId, rec);
  const { op, replaced } = enqueue(c.entity, c.recordId, stripLocal(rec), { _base: c.cloud.revision || 0, ...c.cloud, id: c.recordId }, 'แก้ไขหลังชนกัน', now);
  op.base = c.cloud;
  op.baseRevision = c.cloud.revision || 0;
  persist({ records: { [c.entity]: [rec] }, ops: [op], dropOps: replaced ? [replaced] : [], dropConflicts: [conflictId] });
  emit('local');
  return true;
}

// Merge records pulled from the server. Records with no local change are replaced; records with a
// pending local change are merged field by field, or become conflicts when the same field changed on both sides.
export function applyIncoming(entity, records, source = 'sync') {
  const put = [];
  let conflictCount = 0;
  for (const cloud of records) {
    if (!cloud || !cloud.id) continue;
    const cur = mem[entity].get(cloud.id);
    if (cloud.revision === undefined) {
      // Legacy record (no revision): last write wins by updatedAt, and never overwrites a pending local change.
      if (hasPending(entity, cloud.id) || (cur && cur.updatedAt > cloud.updatedAt)) continue;
      put.push({ ...cloud, _base: 0 });
      continue;
    }
    if (cur && cur._base >= cloud.revision) continue; // already have this revision
    if (!hasPending(entity, cloud.id)) { put.push({ ...cloud, _base: cloud.revision }); continue; }

    const op = queue.get(qIndex.get(qKey(entity, cloud.id)));
    const m = threeWayMerge(op.base, stripLocal(cur), cloud);
    if (m.ok) {
      const rec = { ...m.record, id: cloud.id, revision: Math.max(cur.revision || 0, cloud.revision) + 1, updatedAt: Date.now(), updatedBy: currentUser, _base: cloud.revision };
      put.push(rec);
      unindexOp(op);
      const { op: nextOp } = enqueue(entity, cloud.id, stripLocal(rec), { _base: cloud.revision, ...cloud }, 'รวมข้อมูลจากเครื่องอื่น', Date.now());
      nextOp.base = stripLocal(cloud);
      nextOp.baseRevision = cloud.revision;
      persist({ ops: [nextOp], dropOps: [op.opId] });
    } else {
      conflictCount += 1;
      raiseConflict(op.opId, cloud, source);
      continue;
    }
  }
  if (put.length) {
    for (const r of put) mem[entity].set(r.id, r);
    persist({ records: { [entity]: put } });
    emit(source);
  }
  return { applied: put.length, conflicts: conflictCount };
}

// Full snapshot from a server that cannot send revisions (legacy Apps Script). Rows that vanished
// from the server are removed locally, but only when no local change is pending for them.
export function applySnapshot(data) {
  for (const entity of ENTITIES) {
    if (!data[entity]) continue;
    const ids = new Set(data[entity].map((r) => r.id));
    const gone = [...mem[entity].values()].filter((r) => r.src && !hasPending(entity, r.id) && !ids.has(r.id));
    for (const r of gone) mem[entity].delete(r.id);
    const tx = idb.transaction(entity, 'readwrite');
    for (const r of gone) tx.objectStore(entity).delete(r.id);
    done(tx).catch(() => {});
    applyIncoming(entity, data[entity], 'sync');
  }
}

// ---------- meta, audit, backups, imports ----------
export async function getMeta(key) {
  return wrap(idb.transaction('meta').objectStore('meta').get(key));
}
export async function setMeta(key, value) {
  const tx = idb.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  return done(tx);
}

export async function listAudit(limit = 500) {
  const rows = await wrap(idb.transaction('audit').objectStore('audit').getAll());
  return rows.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
}

export function logEvent(action, label = '') {
  const now = Date.now();
  return persist({ audit: [{ id: String(now).padStart(13, '0') + '-' + uid().slice(0, 8), at: now, user: currentUser, device, action, entity: 'system', recordId: '', label, before: null, after: null }] });
}

export function exportAll() {
  const entities = {};
  for (const e of ENTITIES) entities[e] = [...mem[e].values()].map(stripLocal);
  return { app: 'artcrm', version: 2, exportedAt: new Date().toISOString(), entities, masters };
}

// Accepts this app's backup format and the first version's (app: 'havancrm', customers + orders at top level).
export function normalizeBackup(data) {
  if (data?.app === 'havancrm') return { entities: { customers: data.customers || [], orders: data.orders || [] } };
  if (data?.app !== 'artcrm' || !data.entities) throw new Error('ไม่ใช่ไฟล์สำรองของ ART CRM');
  return { entities: data.entities, masters: data.masters };
}

// Store a full snapshot. Automatic snapshots keep the latest 14; manual and safety snapshots are kept.
export async function createBackup(reason) {
  const data = exportAll();
  const text = JSON.stringify(data);
  const counts = Object.fromEntries(ENTITIES.map((e) => [e, data.entities[e].length]));
  const row = { id: String(Date.now()).padStart(13, '0') + '-' + reason, at: Date.now(), reason, counts, bytes: text.length };
  const tx = idb.transaction(['backups', 'snapshots'], 'readwrite');
  tx.objectStore('backups').put(row);
  tx.objectStore('snapshots').put({ id: row.id, data: text });
  await done(tx);
  if (reason === 'auto') {
    const autos = (await listBackups()).filter((b) => b.reason === 'auto');
    const old = autos.slice(14);
    if (old.length) {
      const del = idb.transaction(['backups', 'snapshots'], 'readwrite');
      for (const b of old) { del.objectStore('backups').delete(b.id); del.objectStore('snapshots').delete(b.id); }
      await done(del);
    }
  }
  return row;
}

export async function listBackups() {
  const rows = await wrap(idb.transaction('backups').objectStore('backups').getAll());
  return rows.sort((a, b) => b.at - a.at);
}

export async function readBackup(id) {
  const row = await wrap(idb.transaction('snapshots').objectStore('snapshots').get(id));
  return row ? JSON.parse(row.data) : null;
}

export async function listImports() {
  const rows = await wrap(idb.transaction('imports').objectStore('imports').getAll());
  return rows.sort((a, b) => b.at - a.at);
}

export function recordImport(row) {
  const tx = idb.transaction('imports', 'readwrite');
  tx.objectStore('imports').put(row);
  return done(tx);
}

export const entityCounts = () => Object.fromEntries(ENTITIES.map((e) => [e, list(e).length]));
