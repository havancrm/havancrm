// Pure logic shared by the screens, the sync engine and the tests.
// No DOM, no IndexedDB, no network: every function here is deterministic.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => '฿' + (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
export const num = (n) => (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });

export const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => localDate(new Date());
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
export function addDays(s, n) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}
export const thaiDate = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '');

// Phone numbers may be stored as "081-234-5678, 02 111 2222"; compare by digits only.
export const phoneKeys = (s) => String(s || '').split(/[,;/\n]+/).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 9);
const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

// ---------- sales ----------
export const orderTotal = (o) => (typeof o.total === 'number' ? o.total
  : Math.max(0, (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0) - (Number(o.discount) || 0)));

// VAT is shown three ways: none, already included in the price, or added on top (7%).
export function vatBreakdown(subtotal, mode = 'none') {
  if (mode === 'included') {
    const vat = (subtotal * 7) / 107;
    return { vat, total: subtotal, base: subtotal - vat };
  }
  if (mode === 'plus') {
    const vat = subtotal * 0.07;
    return { vat, total: subtotal + vat, base: subtotal };
  }
  return { vat: 0, total: subtotal, base: subtotal };
}

// Per-customer totals and purchase rhythm, computed from sale orders only.
export function buildStats(sales, t) {
  const stats = new Map();
  for (const o of sales) {
    let s = stats.get(o.customerId);
    if (!s) stats.set(o.customerId, s = { total: 0, count: 0, first: o.date, last: o.date, dates: new Set() });
    s.total += orderTotal(o);
    s.count += 1;
    if (o.date) {
      s.dates.add(o.date);
      if (o.date > s.last) s.last = o.date;
      if (o.date < s.first) s.first = o.date;
    }
  }
  for (const s of stats.values()) {
    s.days = s.last ? daysBetween(s.last, t) : null;
    // Average days between purchase days, once there are at least 3 purchase days.
    s.cycle = s.dates.size >= 3 ? Math.round(daysBetween(s.first, s.last) / (s.dates.size - 1)) : null;
  }
  return stats;
}

// Cycle status: 'overdue' (เลยรอบ), 'due' (ถึงรอบ), 'near' (ใกล้ถึงรอบ), 'normal', 'none' (never bought).
export function cycleState(s, snoozeUntil, t) {
  if (!s || !s.last) return { key: 'none', label: 'ยังไม่เคยซื้อ', days: null };
  if (snoozeUntil && snoozeUntil > t) return { key: 'normal', label: 'เลื่อนแล้ว', days: s.days, cycle: s.cycle };
  const days = s.days;
  if (s.cycle) {
    const r = days / Math.max(1, s.cycle);
    if (r >= 1.2 && days >= 7) return { key: 'overdue', label: 'เลยรอบ', days, cycle: s.cycle };
    if (r >= 1) return { key: 'due', label: 'ถึงรอบ', days, cycle: s.cycle };
    if (r >= 0.8) return { key: 'near', label: 'ใกล้ถึงรอบ', days, cycle: s.cycle };
  } else if (days >= 90) {
    return { key: 'overdue', label: 'เลยรอบ', days };
  }
  return { key: 'normal', label: 'ปกติ', days, cycle: s.cycle };
}

// Latest price, unit and code per product name, overall or for one customer.
export function productIndex(sales, customerId) {
  const map = new Map();
  const list = customerId ? sales.filter((o) => o.customerId === customerId) : sales;
  for (const o of [...list].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    for (const i of o.items || []) {
      if (!i.name) continue;
      const p = map.get(i.name) || { count: 0 };
      p.count += 1;
      p.date = o.date;
      if (i.price !== null && i.price !== undefined) p.price = i.price;
      if (i.unit) p.unit = i.unit;
      if (i.code) p.code = i.code;
      p.qty = i.qty;
      map.set(i.name, p);
    }
  }
  return map;
}

// Sales of each product in a period, grouped by SKU (or name when no SKU).
// `numeric` tells whether a line has a usable price (used for the sales totals tabs).
export function productSales(sales, { from = null, to = null, numeric = null, threshold = 0 } = {}) {
  const map = new Map();
  for (const o of sales) {
    if (from && o.date < from) continue;
    if (to && o.date > to) continue;
    for (const i of o.items || []) {
      const hasPrice = i.price !== null && i.price !== undefined && Number(i.price) >= threshold && Number(i.price) > 0;
      if (numeric !== null && hasPrice !== numeric) continue;
      const key = i.code || i.name;
      if (!key) continue;
      let p = map.get(key);
      if (!p) map.set(key, p = { key, code: i.code || '', name: i.name, unit: i.unit || '', qty: 0, amount: 0, lines: 0, customers: new Set(), last: '' });
      p.qty += Number(i.qty) || 0;
      p.amount += hasPrice ? (Number(i.qty) || 0) * Number(i.price) : 0;
      p.lines += 1;
      p.customers.add(o.customerId);
      if (o.date > p.last) p.last = o.date;
    }
  }
  return [...map.values()];
}

// ---------- search ----------
const SEARCH_FIELDS = {
  customers: (c) => [c.name, c.code, c.phone, c.company, c.contact, c.line, c.address, c.road, c.subdistrict, c.district, c.province, c.postcode, c.zone, c.tags, c.businessType],
  leads: (l) => [l.name, l.phone, l.line, l.address, l.road, l.area, l.province, l.zone, l.tags, l.businessType],
  orders: (o, names) => [o.no, names, ...(o.items || []).flatMap((i) => [i.name, i.code])],
  products: (p) => [p.code, p.name],
};

// One flat index per data version. Each entry is a lowercase string of every searchable field.
export function buildSearchIndex({ customers = [], leads = [], orders = [], products = [] }) {
  const custName = new Map(customers.map((c) => [c.id, c.name]));
  const entries = [];
  for (const c of customers) entries.push({ type: 'customers', id: c.id, text: SEARCH_FIELDS.customers(c).filter(Boolean).join(' ').toLowerCase() });
  for (const l of leads) entries.push({ type: 'leads', id: l.id, text: SEARCH_FIELDS.leads(l).filter(Boolean).join(' ').toLowerCase() });
  for (const o of orders) {
    const names = custName.get(o.customerId) || '';
    entries.push({ type: o.kind === 'bill' ? 'bills' : 'orders', id: o.id, text: SEARCH_FIELDS.orders(o, names).filter(Boolean).join(' ').toLowerCase() });
  }
  for (const p of products) entries.push({ type: 'products', id: p.id, text: SEARCH_FIELDS.products(p).filter(Boolean).join(' ').toLowerCase() });
  return entries;
}

// Every whitespace-separated token must appear somewhere in the entry.
// Returns ids per type (capped by limit) plus the full match count per type in `totals`.
export function search(index, query, limit = 30) {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = { customers: [], leads: [], orders: [], bills: [], products: [] };
  const totals = { customers: 0, leads: 0, orders: 0, bills: 0, products: 0 };
  if (!tokens.length) return { ...groups, totals };
  for (const e of index) {
    if (!tokens.every((t) => e.text.includes(t))) continue;
    totals[e.type] += 1;
    if (groups[e.type].length < limit) groups[e.type].push(e.id);
  }
  return { ...groups, totals };
}

// ---------- duplicates ----------
// A customer is a likely duplicate when the code matches, any phone matches, or name + province match.
export function findDuplicateCustomers(candidate, customers) {
  const phones = phoneKeys(candidate.phone);
  return customers.filter((c) => c.id !== candidate.id && !c.deleted && (
    (candidate.code && c.code === candidate.code)
    || phoneKeys(c.phone).some((p) => phones.includes(p))
    || (norm(c.name) && norm(c.name) === norm(candidate.name) && (!candidate.province || norm(c.province) === norm(candidate.province)))
  ));
}

// ---------- merging (sync conflicts) ----------
const META_FIELDS = new Set(['revision', 'baseRevision', 'updatedAt', 'updatedBy', 'createdAt', 'opId']);

// Three-way merge: base is the record both sides started from. Changes that touch
// different fields combine automatically; the same field changed on both sides is a conflict.
export function threeWayMerge(base, local, cloud) {
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(cloud || {})]);
  const localChanged = [];
  const cloudChanged = [];
  for (const k of keys) {
    if (META_FIELDS.has(k) || k.startsWith('_')) continue;
    const b = JSON.stringify(base?.[k] ?? null);
    if (JSON.stringify(local?.[k] ?? null) !== b) localChanged.push(k);
    if (JSON.stringify(cloud?.[k] ?? null) !== b) cloudChanged.push(k);
  }
  const clash = localChanged.filter((k) => cloudChanged.includes(k) && JSON.stringify(local[k] ?? null) !== JSON.stringify(cloud[k] ?? null));
  if (clash.length) return { ok: false, fields: clash };
  const record = { ...cloud };
  for (const k of localChanged) record[k] = local[k];
  return { ok: true, record, localChanged, cloudChanged };
}

// Which records a restore would add, update, or keep untouched (local-only records are never deleted).
export function diffCollections(current, incoming) {
  const out = { add: 0, update: 0, same: 0, keep: 0 };
  for (const [entity, list] of Object.entries(incoming)) {
    const cur = current[entity] || new Map();
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      const c = cur.get(r.id);
      if (!c) out.add += 1;
      else if (JSON.stringify(stripMeta(c)) === JSON.stringify(stripMeta(r))) out.same += 1;
      else out.update += 1;
    }
    for (const id of cur.keys()) if (!seen.has(id)) out.keep += 1;
  }
  return out;
}
const stripMeta = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));

// ---------- tasks ----------
export function taskBucket(task, t) {
  if (task.status === 'done') return 'done';
  if (!task.dueDate || task.dueDate < t) return 'overdue';
  if (task.dueDate === t) return 'today';
  return 'upcoming';
}

// Date range for a period chip; null means "all".
export function periodRange(key, t) {
  if (key === 'all') return null;
  if (key === 'month') return { from: t.slice(0, 7) + '-01', to: t };
  if (key === '3m') return { from: addDays(t, -90), to: t };
  if (key === 'year') return { from: t.slice(0, 4) + '-01-01', to: t };
  return null;
}

// ---------- CSV ----------
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

export const toCsv = (rows) => rows.map((r) => r.map((v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\r\n');

// Header names are matched loosely (case and spacing do not matter) so Thai and English exports both work.
export function mapColumns(headers, dict) {
  const clean = (s) => String(s || '').trim().toLowerCase();
  const map = {};
  for (const [field, names] of Object.entries(dict)) {
    const idx = headers.findIndex((h) => names.map(clean).includes(clean(h)));
    if (idx >= 0) map[field] = idx;
  }
  return map;
}

export const CUSTOMER_COLUMNS = {
  name: ['ชื่อลูกค้า', 'ชื่อร้าน', 'name'], code: ['รหัสลูกค้า', 'รหัส', 'code'], phone: ['เบอร์โทร', 'เบอร์', 'phone'],
  businessType: ['ประเภทธุรกิจ', 'ประเภทร้าน'], contact: ['ชื่อผู้ติดต่อ', 'ผู้ติดต่อ'], line: ['LINE', 'ไลน์'],
  address: ['ที่อยู่', 'address'], province: ['จังหวัด', 'province'], zone: ['Zone', 'โซน'], tags: ['แท็ก', 'tag', 'tags'],
  owner: ['ผู้ดูแล'], terms: ['เงื่อนไข'], note: ['บันทึก', 'note'],
};
export const BILL_COLUMNS = {
  no: ['เลขที่บิล', 'เลขที่', 'bill_no', 'no'], date: ['วันที่', 'date'], customer: ['ลูกค้า', 'ชื่อลูกค้า', 'customer'],
  customerCode: ['รหัสลูกค้า'], sku: ['SKU', 'รหัสสินค้า'], product: ['สินค้า', 'ชื่อสินค้า', 'product'],
  qty: ['จำนวน', 'qty'], price: ['ราคา', 'ราคาต่อหน่วย', 'price'], unit: ['หน่วย', 'unit'],
};

// Accepts 2026-10-20 and 20/10/2569 (Thai Buddhist year) or 20/10/2026.
export function parseDate(s) {
  const v = String(s || '').trim();
  let y; let m; let d;
  let r = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (r) { [, y, m, d] = r.map(Number); }
  else if ((r = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    [, d, m, y] = r.map(Number);
    if (y < 100) y += 2000;
    if (y > 2400) y -= 543;
  } else return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return localDate(dt);
}

// items: [{ line, ...column values }]. Returns records to create, records to update, and per-line errors.
export function planCustomerImport(items, customers) {
  const create = [];
  const update = [];
  const errors = [];
  const seenPhones = new Set();
  for (const it of items) {
    if (!it.name) { errors.push({ line: it.line, message: 'ไม่มีชื่อลูกค้า' }); continue; }
    if (it.phone && !phoneKeys(it.phone).length) { errors.push({ line: it.line, message: 'เบอร์โทรไม่ถูกรูปแบบ' }); continue; }
    const keys = phoneKeys(it.phone);
    if (keys.some((k) => seenPhones.has(k))) { errors.push({ line: it.line, message: 'เบอร์ซ้ำในไฟล์เดียวกัน (ข้ามรายการนี้)' }); continue; }
    keys.forEach((k) => seenPhones.add(k));
    const existing = customers.find((c) => (it.code && c.code === it.code) || phoneKeys(c.phone).some((p) => keys.includes(p)));
    if (existing) update.push({ line: it.line, id: existing.id, fields: pickFilled(it) });
    else create.push({ line: it.line, fields: pickFilled(it) });
  }
  return { create, update, errors };
}

function pickFilled(it) {
  const out = {};
  for (const [k, v] of Object.entries(it)) if (k !== 'line' && v !== '' && v !== undefined) out[k] = v;
  return out;
}

// Groups bill lines by bill number. Lines of the same bill must agree on date and customer.
export function planBillImport(items, { customers, products, existingNos }) {
  const bills = new Map();
  const errors = [];
  const skipped = [];
  for (const it of items) {
    if (!it.no) { errors.push({ line: it.line, message: 'ไม่มีเลขที่บิล' }); continue; }
    if (existingNos.has(it.no) && !bills.has(it.no)) { skipped.push({ line: it.line, message: `บิล ${it.no} มีอยู่แล้ว` }); continue; }
    const date = parseDate(it.date);
    if (!date) { errors.push({ line: it.line, message: 'วันที่ไม่ถูกรูปแบบ (ใช้ 2026-10-20 หรือ 20/10/2569)' }); continue; }
    const cust = customers.find((c) => (it.customerCode && c.code === it.customerCode) || (it.customer && (c.name === it.customer || customerLabel(c) === it.customer)));
    if (!cust) { errors.push({ line: it.line, message: `ไม่พบลูกค้า: ${it.customer || it.customerCode || '-'}` }); continue; }
    const qty = Number(it.qty);
    if (!(qty > 0)) { errors.push({ line: it.line, message: 'จำนวนต้องเป็นตัวเลขมากกว่า 0' }); continue; }
    const price = it.price === '' || it.price === undefined ? null : Number(it.price);
    if (price !== null && Number.isNaN(price)) { errors.push({ line: it.line, message: 'ราคาไม่ใช่ตัวเลข' }); continue; }
    const prod = products.find((p) => (it.sku && p.code === it.sku));
    if (it.sku && !prod) errors.push({ line: it.line, message: `SKU ไม่พบ: ${it.sku} (ใช้ชื่อจากไฟล์แทน)`, warning: true });
    let bill = bills.get(it.no);
    if (!bill) bills.set(it.no, bill = { no: it.no, date, customerId: cust.id, lines: [], line: it.line });
    else if (bill.date !== date || bill.customerId !== cust.id) {
      errors.push({ line: it.line, message: `บรรทัดนี้ของบิล ${it.no} มีวันที่หรือลูกค้าไม่ตรงกับบรรทัดแรก` });
      continue;
    }
    bill.lines.push({ code: it.sku || prod?.code || '', name: it.product || prod?.name || it.sku || '', unit: it.unit || prod?.unit || '', qty, price });
  }
  return { bills: [...bills.values()], errors, skipped };
}

export function customerLabel(c) {
  return c.code ? `${c.name} · ${c.code}` : c.name;
}

// FNV-1a: a stable fingerprint of a file, used to warn when the same file is imported twice.
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + '-' + text.length;
}

// Plain-text order summary used for LINE messages and the copy button.
export function orderText(o, customer) {
  const lines = (o.items || []).map((i) => `- ${i.name} ${num(i.qty)} ${i.unit || ''}${i.price != null ? ` @ ${money(i.price)}` : ''}`.trim());
  const sub = (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0) - (Number(o.discount) || 0);
  const v = vatBreakdown(sub, o.vat);
  return [
    `ใบสั่งซื้อ ${o.no}`,
    `วันที่ ${thaiDate(o.date)}`,
    customer ? `ร้าน ${customer.name}${customer.code ? ` (${customer.code})` : ''}` : '',
    '',
    ...lines,
    '',
    o.vat && o.vat !== 'none' ? `ยอดก่อน VAT ${money(v.base)}  VAT ${money(v.vat)}` : '',
    `ยอดสุทธิ ${money(v.total)}`,
    o.terms ? `เงื่อนไข ${o.terms}` : '',
    o.payment ? `ชำระเงิน ${o.payment}` : '',
    o.note ? `หมายเหตุ ${o.note}` : '',
  ].filter((l) => l !== '').join('\n');
}
