/**
 * HavanCRM — ใช้ Google Sheet เป็นฐานข้อมูล
 *
 * ติดตั้ง (ทำครั้งเดียว):
 *   1. เปิด Google Sheet ใหม่ → ส่วนขยาย (Extensions) → Apps Script → วางโค้ดนี้แทนของเดิม
 *   2. เปลี่ยน SYNC_TOKEN ด้านล่างเป็นรหัสลับของทีม แล้วกดบันทึก
 *   3. เลือกฟังก์ชัน setup → กด Run → อนุญาตสิทธิ์
 *   4. Deploy → New deployment → Web app
 *        Execute as: Me   |   Who has access: Anyone
 *      คัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ในแอป (หน้า ตั้งค่า) พร้อมรหัส SYNC_TOKEN
 *
 * แก้ไขข้อมูลในชีตได้โดยตรง: เพิ่มแถวใหม่ด้านล่าง, ลบให้ติ๊กช่อง "ลบแล้ว" (อย่าลบแถว),
 * เพิ่มคอลัมน์ของตัวเองได้ทางขวาของคอลัมน์สุดท้าย และอย่าแก้คอลัมน์ที่ซ่อนไว้
 */
const SYNC_TOKEN = 'เปลี่ยนเป็นรหัสลับของทีม';
const BACKUP_FOLDER = 'HavanCRM Backups';
const BACKUP_KEEP = 30;
// Clients re-receive changes from this window before their cursor, so edits that
// raced with a sync are never missed (merging is idempotent).
const OVERLAP_MS = 60 * 1000;

const STATUS_LABELS = { pending: 'รอชำระ', paid: 'ชำระแล้ว', shipped: 'ส่งแล้ว', cancelled: 'ยกเลิก' };

// Column layout per sheet. derived = computed on write (ignored on read);
// tech = hidden bookkeeping columns.
const TABLES = {
  customers: {
    sheet: 'ลูกค้า',
    fields: ['id', 'name', 'phone', 'company', 'line', 'email', 'address', 'tags', 'note', 'deleted', 'createdAt', 'updatedAt'],
    cols: [
      { k: 'name', h: 'ชื่อลูกค้า' },
      { k: 'phone', h: 'เบอร์โทร' },
      { k: 'company', h: 'บริษัท/ร้าน' },
      { k: 'line', h: 'LINE' },
      { k: 'email', h: 'อีเมล' },
      { k: 'address', h: 'ที่อยู่' },
      { k: 'tags', h: 'แท็ก' },
      { k: 'note', h: 'บันทึก' },
      { k: 'updated', h: 'แก้ไขล่าสุด', type: 'datetime', derived: true },
      { k: 'deleted', h: 'ลบแล้ว', type: 'bool' },
      { k: 'id', h: 'id', tech: true },
      { k: 'createdAt', h: 'createdAt', type: 'num', tech: true },
      { k: 'updatedAt', h: 'updatedAt', type: 'num', tech: true },
      { k: '_seq', h: '_seq', type: 'num', tech: true },
    ],
  },
  orders: {
    sheet: 'ออเดอร์',
    fields: ['id', 'no', 'date', 'customerId', 'items', 'discount', 'status', 'note', 'deleted', 'createdAt', 'updatedAt'],
    cols: [
      { k: 'no', h: 'เลขที่' },
      { k: 'date', h: 'วันที่', type: 'date' },
      { k: 'customerName', h: 'ลูกค้า' }, // used to link manual rows; otherwise refreshed from customerId
      { k: 'itemsText', h: 'รายการสินค้า (ชื่อ × จำนวน @ ราคา)' },
      { k: 'discount', h: 'ส่วนลด', type: 'num' },
      { k: 'total', h: 'ยอดสุทธิ', type: 'num', derived: true },
      { k: 'status', h: 'สถานะ', type: 'status' },
      { k: 'note', h: 'บันทึก' },
      { k: 'updated', h: 'แก้ไขล่าสุด', type: 'datetime', derived: true },
      { k: 'deleted', h: 'ลบแล้ว', type: 'bool' },
      { k: 'id', h: 'id', tech: true },
      { k: 'customerId', h: 'customerId', tech: true },
      { k: 'createdAt', h: 'createdAt', type: 'num', tech: true },
      { k: 'updatedAt', h: 'updatedAt', type: 'num', tech: true },
      { k: '_seq', h: '_seq', type: 'num', tech: true },
    ],
  },
};
const ORDER = ['customers', 'orders'];

// ---------------- web app entry points ----------------
function doGet() {
  return json_({ ok: true, app: 'havancrm' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad request' }); }
  if (!body || body.token !== SYNC_TOKEN) return json_({ error: 'unauthorized' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ error: 'เซิร์ฟเวอร์ไม่ว่าง ลองใหม่อีกครั้ง' });
  try {
    if (body.action === 'backup') return json_({ ok: true, file: backupNow() });
    if (body.action === 'health') return json_({ ok: true });
    return json_(sync_(Number(body.since) || 0, body.changes || {}));
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------- sync ----------------
function sync_(since, changes) {
  const now = Date.now();
  const ctx = load_();
  let changed = normalize_(ctx, now);

  for (const name of ORDER) {
    const table = ctx[name];
    for (const rec of changes[name] || []) {
      if (!rec || typeof rec.id !== 'string' || !rec.id || typeof rec.updatedAt !== 'number') continue;
      const cur = table.byId[rec.id];
      if (cur && cur.updatedAt > rec.updatedAt) continue;
      const clean = pick_(TABLES[name].fields, rec);
      clean._seq = now;
      if (cur) Object.keys(cur).forEach((k) => { if (k !== '_row') delete cur[k]; });
      const target = cur || { _row: table.recs.length };
      Object.assign(target, clean);
      if (!cur) table.recs.push(target);
      table.byId[rec.id] = target;
      changed = true;
    }
  }
  if (changed) write_(ctx);

  const out = {};
  for (const name of ORDER) {
    out[name] = ctx[name].recs
      .filter((r) => !r._empty && r.id && r._seq > since - OVERLAP_MS)
      .map((r) => pick_(TABLES[name].fields, r));
  }
  return { cursor: now, changes: out };
}

function pick_(fields, rec) {
  const o = {};
  fields.forEach((f) => { if (rec[f] !== undefined) o[f] = rec[f]; });
  return o;
}

// Rows typed directly into the sheet: give them ids, timestamps and link orders to customers.
function normalize_(ctx, now) {
  let changed = false;
  const seen = {};
  for (const name of ORDER) {
    const table = ctx[name];
    table.byId = {};
    for (const r of table.recs) {
      if (r._empty) continue;
      if (!r.id || seen[r.id]) { // new row, or a copy-pasted duplicate
        r.id = Utilities.getUuid();
        r.createdAt = r.createdAt || now;
        r.updatedAt = now;
        r._seq = now;
        changed = true;
      }
      if (!r.updatedAt) { r.updatedAt = now; r._seq = now; changed = true; }
      if (!r.createdAt) r.createdAt = r.updatedAt;
      seen[r.id] = true;
      table.byId[r.id] = r;
    }
  }
  const customers = ctx.customers;
  for (const o of ctx.orders.recs) {
    if (o._empty) continue;
    if (!o.customerId && o.customerName) {
      let c = customers.recs.find((x) => !x._empty && !x.deleted && x.name === o.customerName);
      if (!c) {
        c = { _row: customers.recs.length, id: Utilities.getUuid(), name: o.customerName, createdAt: now, updatedAt: now, _seq: now };
        customers.recs.push(c);
        customers.byId[c.id] = c;
      }
      o.customerId = c.id;
      o.updatedAt = Math.max(o.updatedAt, now);
      o._seq = now;
      changed = true;
    }
    if (!o.no) { o.no = 'S-' + o.id.slice(0, 6).toUpperCase(); o._seq = now; changed = true; }
    if (!o.date) { o.date = Utilities.formatDate(new Date(now), ctx.tz, 'yyyy-MM-dd'); o._seq = now; changed = true; }
  }
  return changed;
}

// ---------------- sheet <-> records ----------------
function load_() {
  const ss = SpreadsheetApp.getActive();
  const ctx = { ss: ss, tz: ss.getSpreadsheetTimeZone() };
  for (const name of ORDER) {
    const t = TABLES[name];
    const sheet = ensureSheet_(ss, t);
    const n = sheet.getLastRow() - 1;
    const values = n > 0 ? sheet.getRange(2, 1, n, t.cols.length).getValues() : [];
    ctx[name] = { sheet: sheet, recs: values.map((row, i) => fromRow_(name, row, i, ctx.tz)), byId: {} };
  }
  return ctx;
}

function write_(ctx) {
  for (const name of ORDER) {
    const t = TABLES[name];
    const table = ctx[name];
    if (!table.recs.length) continue;
    const rows = table.recs.map((r) => r._empty ? t.cols.map(() => '') : toRow_(name, r, ctx));
    const sheet = table.sheet;
    const need = rows.length + 1;
    if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
    sheet.getRange(2, 1, rows.length, t.cols.length).setValues(rows);
  }
}

function fromRow_(name, row, index, tz) {
  const t = TABLES[name];
  const r = { _row: index };
  let content = false;
  t.cols.forEach((col, i) => {
    const v = row[i];
    if (!col.tech && !col.derived && col.type !== 'bool' && v !== '' && v !== null) content = true;
    if (col.derived) return;
    if (col.type === 'num') r[col.k] = Number(String(v).replace(/,/g, '')) || 0;
    else if (col.type === 'bool') r[col.k] = v === true || String(v).toUpperCase() === 'TRUE';
    else if (col.type === 'date') r[col.k] = toIsoDate_(v, tz);
    else if (col.type === 'status') r[col.k] = toStatus_(v);
    else if (v !== null && v !== undefined && String(v).trim() !== '') r[col.k] = String(v).trim();
  });
  if (!content && !r.id) return { _row: index, _empty: true };
  if (name === 'orders') {
    r.items = parseItems_(r.itemsText);
    delete r.itemsText;
  }
  if (!r.deleted) delete r.deleted;
  return r;
}

function toRow_(name, r, ctx) {
  const t = TABLES[name];
  return t.cols.map((col) => {
    switch (col.k) {
      case 'updated': return r.updatedAt ? new Date(r.updatedAt) : '';
      case 'customerName': { const c = ctx.customers.byId[r.customerId]; return safeText_(c ? c.name : r.customerName || ''); }
      case 'itemsText': return safeText_(itemsText_(r.items));
      case 'total': return orderTotal_(r);
      case 'status': return STATUS_LABELS[r.status] || STATUS_LABELS.pending;
      case 'deleted': return r.deleted === true;
    }
    const v = r[col.k];
    if (col.type === 'num') return Number(v) || 0;
    return safeText_(v === undefined || v === null ? '' : String(v));
  });
}

// A leading ' keeps values like "=..." or "+66..." as plain text instead of formulas.
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function itemsText_(items) {
  return (items || []).map((i) => `${i.name} × ${Number(i.qty) || 0} @ ${Number(i.price) || 0}`).join('\n');
}

function parseItems_(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(.*\S)\s*[×xX*]\s*([\d.,]+)\s*@\s*([\d.,]+)$/);
    if (!m) return { name: line, qty: 1, price: 0 };
    return { name: m[1], qty: Number(m[2].replace(/,/g, '')) || 0, price: Number(m[3].replace(/,/g, '')) || 0 };
  });
}

function orderTotal_(o) {
  const sum = (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  return Math.max(0, sum - (Number(o.discount) || 0));
}

function toStatus_(v) {
  const s = String(v || '').trim();
  if (STATUS_LABELS[s]) return s;
  for (const k in STATUS_LABELS) if (STATUS_LABELS[k] === s) return k;
  return 'pending';
}

// Accepts Date cells, yyyy-mm-dd, or d/m/yyyy (Buddhist-era years are converted).
function toIsoDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y > 2400) y -= 543;
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return '';
}

// ---------------- sheet setup ----------------
function ensureSheet_(ss, t) {
  let sheet = ss.getSheetByName(t.sheet);
  if (sheet) return sheet;
  sheet = ss.insertSheet(t.sheet);
  formatSheet_(sheet, t);
  return sheet;
}

function formatSheet_(sheet, t) {
  const rows = sheet.getMaxRows();
  sheet.getRange(1, 1, 1, t.cols.length).setValues([t.cols.map((c) => c.h)]).setFontWeight('bold').setBackground('#ccfbf1');
  sheet.setFrozenRows(1);
  t.cols.forEach((col, i) => {
    const range = sheet.getRange(2, i + 1, Math.max(1, rows - 1), 1);
    if (col.type === 'num') range.setNumberFormat(col.tech ? '0' : '#,##0.##');
    else if (col.type === 'datetime') range.setNumberFormat('dd/MM/yyyy HH:mm');
    else if (col.type === 'bool') range.insertCheckboxes();
    else range.setNumberFormat('@');
  });
  const firstTech = t.cols.findIndex((c) => c.tech) + 1;
  sheet.hideColumns(firstTech, t.cols.length - firstTech + 1);
}

/** Run once from the Apps Script editor: creates sheets, menu and the daily backup. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  for (const name of ORDER) ensureSheet_(ss, TABLES[name]);
  const blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'backupNow')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).create();
  if (SYNC_TOKEN === 'เปลี่ยนเป็นรหัสลับของทีม') {
    Logger.log('⚠️ อย่าลืมเปลี่ยน SYNC_TOKEN เป็นรหัสลับของทีมก่อน Deploy');
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('HavanCRM')
    .addItem('สำรองข้อมูลตอนนี้', 'backupNow')
    .addToUi();
}

// Manual edits in the sheet get a fresh timestamp so they sync to every phone.
function onEdit(e) {
  const sheet = e.range.getSheet();
  let t = null;
  for (const name of ORDER) if (TABLES[name].sheet === sheet.getName()) t = TABLES[name];
  if (!t) return;
  const start = Math.max(2, e.range.getRow());
  const end = e.range.getRow() + e.range.getNumRows() - 1;
  if (end < start || e.range.getColumn() > t.cols.length) return;
  const now = Date.now();
  const iUpdated = t.cols.findIndex((c) => c.k === 'updatedAt') + 1;
  const n = end - start + 1;
  const stamp = [];
  for (let i = 0; i < n; i++) stamp.push([now, now]); // updatedAt, _seq are adjacent
  sheet.getRange(start, iUpdated, n, 2).setValues(stamp);
}

// ---------------- backup ----------------
/** Copies the whole spreadsheet into Drive folder "HavanCRM Backups", keeping the latest BACKUP_KEEP. */
function backupNow() {
  const ss = SpreadsheetApp.getActive();
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const name = `${ss.getName()} ${Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HHmm')}`;
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(BACKUP_KEEP).forEach((f) => f.setTrashed(true));
  return name;
}
