/**
 * HavanCRM ↔ A-CRM connector
 *
 * Standalone Apps Script project: it opens the A-CRM spreadsheet by ID and never touches
 * the legacy script bound to that file. Columns are found by header name, not position.
 *
 * Read (always): CUSTOMERS, BILLS (+ BILL_ITEMS), ORDERS (+ ORDER_ITEMS), PRODUCTS.
 *   Sales figures come from BILLS.final_total where status = ACTIVE.
 * Write (only when enabled): appends new orders to ORDERS + ORDER_ITEMS, after a daily backup.
 *   Never edits CUSTOMERS, BILLS or BILL_ITEMS.
 *
 * Install: see README, section "เชื่อมกับ A-CRM".
 */
const SPREADSHEET_ID = '1jsL6KoQbkDz1J6w0uRT2QXF0UM3GopsHYbmILX6Puxw'; // A-CRM
const SYNC_TOKEN = 'เปลี่ยนเป็นรหัสลับของทีม';
const BACKUP_FOLDER_ID = '1M-k10kXPiaNf2jo1f_VZG4SYHiwpSzy6'; // A-CRM Backups
const SALES_BILL_STATUS = 'ACTIVE';
const NEW_ORDER_STATUS = 'sent'; // same value the existing ORDERS rows use for "sent to office"

// Writing stays off until it has been tested on a copy (APP_INTEGRATION_AUDIT item 12).
// Turn on with Script Properties: WRITE_ENABLED = true (no code change needed).
function writeEnabled_() {
  return PropertiesService.getScriptProperties().getProperty('WRITE_ENABLED') === 'true';
}

// ---------------- web app entry points ----------------
function doGet() {
  return json_({ ok: true, app: 'havancrm-acrm' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad request' }); }
  if (!body || body.token !== SYNC_TOKEN) return json_({ error: 'unauthorized' });
  try {
    if (body.action === 'health') return json_({ ok: true, write: writeEnabled_() });
    if (body.action === 'backup') return json_({ ok: true, file: backupNow() });
    return json_(sync_(body));
  } catch (err) {
    return json_({ error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------- sync ----------------
function sync_(body) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const canWrite = writeEnabled_();
  const result = {
    backend: 'acrm',
    readOnly: !canWrite,
    accepted: { customers: [], orders: [] },
    rejected: { customers: [], orders: [] },
  };
  const changes = body.changes || {};
  // Customer master data is maintained in A-CRM itself.
  (changes.customers || []).forEach((r) => { if (r && r.id) result.rejected.customers.push(r.id); });

  const incoming = (changes.orders || []).filter((r) => r && typeof r.id === 'string' && r.id);
  if (incoming.length) {
    if (!canWrite) {
      incoming.forEach((r) => result.rejected.orders.push(r.id));
    } else {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) throw new Error('ระบบไม่ว่าง ลองใหม่อีกครั้ง');
      try {
        backupBeforeWrite_(tz);
        writeOrders_(ss, tz, incoming, String(body.user || ''), result);
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }
    }
  }

  // since = 0 asks for everything (first sync, daily full sync); otherwise only rows changed since then.
  const since = Math.max(0, Number(body.since) || 0);
  const snap = snapshot_(ss, tz, since);
  result.snapshot = since === 0;
  result.cursor = snap.cursor;
  result.dict = snap.dict;
  result.changes = snap.changes;
  return result;
}

// ---------------- reading ----------------
function readTable_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 1) return { sheet: sheet, header: [], col: {}, rows: [] };
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const header = values[0].map((h) => String(h).trim());
  const col = {};
  header.forEach((h, i) => { if (h && !(h in col)) col[h] = i; });
  return { sheet: sheet, header: header, col: col, rows: values.slice(1) };
}

function getter_(table) {
  return (row, name) => (name in table.col ? row[table.col[name]] : '');
}

// Rows changed within this window before the cursor are sent again: a late write in the sheet can
// carry an updated_at slightly older than the newest row the phone already has.
const OVERLAP_MS = 10 * 60000;

// Only rows changed since `since` are returned (with their bill/order items). `cursor` is the newest
// updated_at seen in the sheet, capped at now, and becomes the next `since`.
function snapshot_(ss, tz, since) {
  const from = since - OVERLAP_MS;
  let newest = 0;
  const fresh = (ts) => { if (ts > newest) newest = ts; return ts >= from; };

  // Products: code → [name, unit]; bill/order items reference it to keep the payload small.
  // Always sent in full: the product list is small.
  const pr = readTable_(ss, 'PRODUCTS');
  const pg = getter_(pr);
  const dict = {};
  pr.rows.forEach((row) => {
    const code = str_(pg(row, 'product_code')) || str_(pg(row, 'sku'));
    if (code) dict[code] = [str_(pg(row, 'product_name')) || str_(pg(row, 'name')), str_(pg(row, 'unit'))];
  });
  const item = (code, qty, price, name, unit) => {
    const d = dict[code];
    const it = [code, qty, price];
    if (!d || (name && d[0] !== name) || (unit && d[1] !== unit)) it.push(name || (d ? d[0] : code), unit || (d ? d[1] : ''));
    return it;
  };

  // Customers
  const cu = readTable_(ss, 'CUSTOMERS');
  const cg = getter_(cu);
  const customers = [];
  cu.rows.forEach((row) => {
    const code = str_(cg(row, 'customer_code'));
    if (!code) return;
    const updatedAt = ms_(cg(row, 'updated_at'), tz) || ms_(cg(row, 'field_updated_at'), tz) || ms_(cg(row, 'last_synced_at'), tz);
    if (!fresh(updatedAt)) return;
    const phones = phones_(cg(row, 'phone_all'), cg(row, 'primary_phone'));
    customers.push(compact_({
      id: code,
      code: code,
      src: 'acrm',
      name: str_(cg(row, 'shop_name')) || str_(cg(row, 'ชื่อรวมวงเล็บ')) || str_(cg(row, 'name')) || code,
      phone: phones[0],
      phones: phones.join(', '),
      contact: str_(cg(row, 'contact_name')),
      line: str_(cg(row, 'line_id')) || str_(cg(row, 'line')),
      email: str_(cg(row, 'email')),
      address: str_(cg(row, 'shipping_address')) || str_(cg(row, 'address')),
      province: str_(cg(row, 'province')),
      district: str_(cg(row, 'district')),
      businessType: str_(cg(row, 'business_type')) || str_(cg(row, 'type')),
      owner: str_(cg(row, 'owner_staff_name')) || str_(cg(row, 'owner')),
      mapLink: str_(cg(row, 'map_link')),
      tags: str_(cg(row, 'tags')),
      note: str_(cg(row, 'customer_note')) || str_(cg(row, 'note')),
      inactive: isFalse_(cg(row, 'active_flag')) || undefined,
      updatedAt: updatedAt,
    }));
  });

  // Bills (sales history). A bill is sent when its header or one of its items changed.
  const bi = readTable_(ss, 'BILL_ITEMS');
  const big = getter_(bi);
  const billItems = {};
  const billItemFresh = new Set();
  bi.rows.forEach((row) => {
    const inv = str_(big(row, 'invoice_no'));
    if (!inv) return;
    if (fresh(ms_(big(row, 'updated_at'), tz))) billItemFresh.add(inv);
    if (!billItems[inv]) billItems[inv] = [];
    billItems[inv].push([num_(big(row, 'line_no')) || 0, item(
      str_(big(row, 'product_code')),
      num_(big(row, 'qty')) || 0,
      num_(big(row, 'unit_price')),
      str_(big(row, 'product_name_snapshot')) || str_(big(row, 'product_name')),
      str_(big(row, 'unit')),
    )]);
  });
  const byLine = (a, b) => a[0] - b[0];
  const orders = [];
  const bl = readTable_(ss, 'BILLS');
  const bg = getter_(bl);
  bl.rows.forEach((row) => {
    const inv = str_(bg(row, 'invoice_no'));
    if (!inv) return;
    const updatedAt = ms_(bg(row, 'updated_at'), tz) || ms_(bg(row, 'created_at'), tz);
    const headerFresh = fresh(updatedAt);
    if (!headerFresh && !billItemFresh.has(inv)) return;
    const total = num_(bg(row, 'final_total'));
    orders.push(compact_({
      id: 'B' + inv,
      no: inv,
      kind: 'bill',
      src: 'acrm',
      date: date_(bg(row, 'invoice_date'), tz),
      customerId: str_(bg(row, 'customer_code')),
      items: (billItems[inv] || []).sort(byLine).map((x) => x[1]),
      total: total === null ? 0 : total,
      status: str_(bg(row, 'status')).toUpperCase() === SALES_BILL_STATUS ? 'billed' : 'excluded',
      salesperson: str_(bg(row, 'salesperson')) || str_(bg(row, 'sales_user')),
      opener: str_(bg(row, 'bill_opener')),
      terms: str_(bg(row, 'payment_terms_snapshot')),
      updatedAt: updatedAt,
    }));
  });

  // Orders (requests sent to the office; not counted as sales)
  const oi = readTable_(ss, 'ORDER_ITEMS');
  const oig = getter_(oi);
  const orderItems = {};
  const orderItemFresh = new Set();
  oi.rows.forEach((row) => {
    const oid = str_(oig(row, 'order_id'));
    if (!oid) return;
    // A removed item still changes its order, so it counts as fresh too.
    if (fresh(ms_(oig(row, 'updated_at'), tz) || ms_(oig(row, 'created_at'), tz))) orderItemFresh.add(oid);
    if (isFalse_(oig(row, 'active_flag'))) return;
    if (!orderItems[oid]) orderItems[oid] = [];
    orderItems[oid].push([num_(oig(row, 'line_no')) || 0, item(
      str_(oig(row, 'product_code')),
      num_(oig(row, 'qty')) || 0,
      num_(oig(row, 'unit_price')),
      str_(oig(row, 'product_name_snapshot')),
      str_(oig(row, 'unit')),
    )]);
  });
  const od = readTable_(ss, 'ORDERS');
  const og = getter_(od);
  od.rows.forEach((row) => {
    const oid = str_(og(row, 'order_id')) || str_(og(row, 'id'));
    if (!oid || /TEST/i.test(oid)) return;
    const updatedAt = ms_(og(row, 'updated_at'), tz) || ms_(og(row, 'created_at'), tz) || ms_(og(row, 'order_date'), tz);
    if (!fresh(updatedAt) && !orderItemFresh.has(oid)) return;
    let items = (orderItems[oid] || []).sort(byLine).map((x) => x[1]);
    if (!items.length) items = legacyItems_(og(row, 'items'), item, dict);
    const total = num_(og(row, 'final_total'));
    const priceUnknown = total === null && items.some((i) => i[2] === null);
    orders.push(compact_({
      id: oid,
      no: oid,
      kind: 'order',
      src: 'acrm',
      date: date_(og(row, 'order_date'), tz) || date_(og(row, 'created'), tz),
      customerId: str_(og(row, 'customer_code')) || str_(og(row, 'cid')),
      items: items,
      total: total === null ? undefined : total,
      discount: num_(og(row, 'discount_total')) || undefined,
      priceUnknown: priceUnknown || undefined,
      status: orderStatus_(og(row, 'status')),
      note: str_(og(row, 'note')),
      salesperson: str_(og(row, 'sales_user')),
      updatedAt: updatedAt,
    }));
  });

  return { dict: dict, changes: { customers: customers, orders: orders }, cursor: Math.min(newest, Date.now()) };
}

// Legacy ORDERS.items JSON: [{sku, q, u, p?, g?}] — a missing p means the price is unknown;
// g is a free-gift quantity, listed as its own zero-price line.
function legacyItems_(json, item, dict) {
  let list;
  try { list = JSON.parse(String(json || '[]')); } catch (err) { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((x) => {
    if (!x || x.sku === undefined) return;
    const sku = String(x.sku);
    const price = x.p === undefined || x.p === '' || x.p === null ? null : Number(x.p);
    out.push(item(sku, Number(x.q) || 0, price, '', str_(x.u)));
    if (Number(x.g) > 0) {
      const d = dict[sku];
      out.push([sku, Number(x.g), 0, (d ? d[0] : sku) + ' (แถม)', str_(x.u) || (d ? d[1] : '')]);
    }
  });
  return out;
}

function orderStatus_(v) {
  const s = str_(v).toLowerCase();
  if (!s) return 'pending';
  if (/cancel|ยกเลิก/.test(s)) return 'cancelled';
  if (s === 'sent') return 'sent';
  if (/bill/.test(s)) return 'billed';
  return 'pending';
}

// ---------------- writing (new orders only) ----------------
function writeOrders_(ss, tz, recs, user, result) {
  const od = readTable_(ss, 'ORDERS');
  const oi = readTable_(ss, 'ORDER_ITEMS');
  if (!od.sheet || !oi.sheet || !('order_id' in od.col) || !('order_id' in oi.col)) throw new Error('ไม่พบชีต ORDERS / ORDER_ITEMS');
  const og = getter_(od);
  const existing = {};
  od.rows.forEach((row) => {
    const a = str_(og(row, 'order_id'));
    const b = str_(og(row, 'id'));
    if (a) existing[a] = true;
    if (b) existing[b] = true;
  });
  const cu = readTable_(ss, 'CUSTOMERS');
  const cg = getter_(cu);
  const customers = {};
  cu.rows.forEach((row) => { const c = str_(cg(row, 'customer_code')); if (c) customers[c] = true; });
  const pr = readTable_(ss, 'PRODUCTS');
  const pg = getter_(pr);
  const codeByName = {};
  pr.rows.forEach((row) => {
    const code = str_(pg(row, 'product_code')) || str_(pg(row, 'sku'));
    ['product_name', 'name', 'short_name'].forEach((h) => { const n = str_(pg(row, h)); if (code && n && !codeByName[n]) codeByName[n] = code; });
  });

  const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const orderRows = [];
  const itemRows = [];
  recs.forEach((r) => {
    if (existing[r.id]) { result.accepted.orders.push(r.id); return; } // retry of an order already written
    if (r.src === 'acrm' || r.kind === 'bill') { result.rejected.orders.push(r.id); return; } // edits go through A-CRM
    if (r.deleted) { result.accepted.orders.push(r.id); return; } // deleted before it ever reached the sheet
    if (!customers[r.customerId]) { result.rejected.orders.push(r.id); return; }
    const items = (r.items || []).filter((i) => i && str_(i.name));
    const subtotal = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
    const discount = Number(r.discount) || 0;
    orderRows.push(od.header.map((h) => ({
      order_id: r.id,
      customer_code: r.customerId,
      order_date: str_(r.date),
      status: NEW_ORDER_STATUS,
      discount_total: discount,
      subtotal: subtotal,
      final_total: Math.max(0, subtotal - discount),
      note: safeText_(str_(r.note)),
      sales_user: safeText_(user),
      created_at: stamp,
      updated_at: stamp,
      current_version: 1,
      sync_status: 'SYNCED',
      last_request_id: 'HAVANCRM-' + r.id,
    }[h])).map(blank_));
    items.forEach((i, n) => {
      const name = str_(i.name);
      const qty = Number(i.qty) || 0;
      const price = Number(i.price) || 0;
      itemRows.push(oi.header.map((h) => ({
        order_item_id: r.id + '-' + (n + 1),
        order_id: r.id,
        line_no: n + 1,
        product_code: str_(i.code) || codeByName[name] || '',
        product_name_snapshot: safeText_(name),
        qty: qty,
        unit: safeText_(str_(i.unit)),
        unit_price: price,
        discount: 0,
        line_total: qty * price,
        created_at: stamp,
        updated_at: stamp,
        version_no: 1,
        gift_qty: 0,
        item_note: '',
        active_flag: true,
        sync_status: 'SYNCED',
      }[h])).map(blank_));
    });
    existing[r.id] = true;
    result.accepted.orders.push(r.id);
  });
  appendRows_(od.sheet, orderRows, od.header.length);
  appendRows_(oi.sheet, itemRows, oi.header.length);
}

function appendRows_(sheet, rows, width) {
  if (!rows.length) return;
  const start = sheet.getLastRow() + 1;
  const need = start + rows.length - 1;
  if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
  sheet.getRange(start, 1, rows.length, width).setValues(rows);
}

// ---------------- backup ----------------
/** Copies A-CRM into the "A-CRM Backups" folder. Existing backups are never deleted. */
function backupNow() {
  const file = DriveApp.getFileById(SPREADSHEET_ID);
  const tz = SpreadsheetApp.openById(SPREADSHEET_ID).getSpreadsheetTimeZone();
  const name = 'A-CRM BACKUP HavanCRM ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HHmm');
  file.makeCopy(name, DriveApp.getFolderById(BACKUP_FOLDER_ID));
  return name;
}

function backupBeforeWrite_(tz) {
  const props = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (props.getProperty('LAST_WRITE_BACKUP_DAY') === day) return;
  backupNow();
  props.setProperty('LAST_WRITE_BACKUP_DAY', day);
}

/** Run from the editor to check the connection and counts without changing anything. */
function testRead() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const t0 = Date.now();
  const snap = snapshot_(ss, ss.getSpreadsheetTimeZone());
  const bills = snap.changes.orders.filter((o) => o.kind === 'bill');
  const active = bills.filter((o) => o.status === 'billed');
  Logger.log('ลูกค้า %s | บิล %s (ACTIVE %s) | ออเดอร์ %s | ยอด ACTIVE %s | %s ms | ขนาด %s KB',
    snap.changes.customers.length, bills.length, active.length, snap.changes.orders.length - bills.length,
    active.reduce((s, o) => s + o.total, 0), Date.now() - t0, Math.round(JSON.stringify(snap).length / 1024));
}

// ---------------- value helpers ----------------
function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function isFalse_(v) {
  return v === false || /^(false|0|no|n)$/i.test(str_(v));
}

function blank_(v) {
  return v === undefined || v === null ? '' : v;
}

function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function compact_(o) {
  Object.keys(o).forEach((k) => { if (o[k] === undefined || o[k] === '' || o[k] === null) delete o[k]; });
  return o;
}

// Fixes phone numbers that lost their leading 0 when stored as numbers.
function phones_(all, primary) {
  const fix = (s) => {
    const d = String(s).replace(/[^\d+]/g, '');
    return /^[1-9]\d{7,8}$/.test(d) ? '0' + d : d;
  };
  const list = [];
  [primary].concat(String(all || '').split(/[,;\/\n]+/)).forEach((p) => {
    const f = fix(p || '');
    if (f && list.indexOf(f) < 0) list.push(f);
  });
  return list;
}

// Dates arrive as Date objects, sheet serial numbers, or text (yyyy-mm-dd, d/m/yyyy, Buddhist era).
function date_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  if (typeof v === 'number' && v > 20000 && v < 80000) return Utilities.formatDate(serialToDate_(v), tz, 'yyyy-MM-dd');
  const s = str_(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd_(Number(m[1]), m[2], m[3]);
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/);
  if (m) return ymd_(Number(m[3]), m[2], m[1]);
  if (/^\d{5}(\.\d+)?$/.test(s)) return date_(Number(s), tz);
  return '';
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function ymd_(y, m, d) {
  if (y > 2400) y -= 543;
  return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
}

function ms_(v, tz) {
  if (isDate_(v)) return v.getTime();
  if (typeof v === 'number' && v > 20000 && v < 80000) return serialToDate_(v).getTime();
  const s = str_(v);
  if (/^\d{5}(\.\d+)?$/.test(s)) return serialToDate_(Number(s)).getTime();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return 0;
  const iso = ymd_(Number(m[1]), m[2], m[3]) + 'T' + ('0' + (m[4] || '0')).slice(-2) + ':' + (m[5] || '00') + ':' + (m[6] || '00') + (m[7] || '+07:00');
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

// Sheet serial date (days since 1899-12-30, Bangkok local time) → Date.
function serialToDate_(n) {
  return new Date(Math.round((n - 25569) * 86400000) - 7 * 3600000);
}
