/**
 * ART CRM backend on Google Sheets (free, no card, data stays in your Google Drive).
 *
 * Setup (once):
 *   1. Create a new Google Sheet. Extensions > Apps Script. Replace the code with this file.
 *   2. Change SYNC_TOKEN below to a long random secret. Save.
 *   3. Run the function `setup` and grant permission.
 *   4. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Copy the URL ending in /exec.
 *   5. In ART CRM: หลังบ้าน > ตั้งค่า > ระบบ > paste the URL and the same token.
 *
 * Each record is stored as one row in its entity's sheet. The `data` column holds the full JSON,
 * which the app reads. Edit records in the app, not in the sheet: changes typed into the sheet are not synced.
 * Protocol matches server/store.js: per-operation opId acknowledgement, revision conflicts, sequence cursor.
 */
const SYNC_TOKEN = 'เปลี่ยนเป็นรหัสลับของทีม';
const BACKUP_FOLDER = 'ART CRM Backups';
const BACKUP_KEEP = 30;
const SEQ_KEY = 'seq';
// Google Sheets limits a cell to 50,000 characters. Photos are shrunk by the app to fit.
const CELL_LIMIT = 49000;

const ENTITIES = ['customers', 'leads', 'orders', 'tasks', 'activities', 'products'];
const SHEET_NAMES = {
  customers: 'ลูกค้า', leads: 'ร้านเป้าหมาย', orders: 'ออเดอร์', tasks: 'งาน', activities: 'กิจกรรม', products: 'สินค้า',
};
// Columns: id | label (for reading) | revision | updatedAt | updatedBy | deleted | opId | seq | data (JSON)
const COLS = ['id', 'ชื่อ / หัวข้อ', 'revision', 'updatedAt', 'updatedBy', 'deleted', 'opId', 'seq', 'data'];

// ---------------- web app entry points ----------------
function doGet() {
  return json_({ ok: true, app: 'artcrm' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad request' }); }
  if (!body || body.token !== SYNC_TOKEN) return json_({ error: 'unauthorized' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ error: 'เซิร์ฟเวอร์ไม่ว่าง ลองใหม่อีกครั้ง' });
  try {
    if (body.action === 'health') return json_({ ok: true });
    if (body.action === 'backup') return json_({ ok: true, file: backupNow() });
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
  const ss = SpreadsheetApp.getActive();
  const tables = {};
  for (const e of ENTITIES) tables[e] = loadEntity_(ss, e);

  let seq = Number(PropertiesService.getScriptProperties().getProperty(SEQ_KEY)) || 0;
  const acceptedIds = {};
  const conflicts = {};
  const touched = {};
  const ack = (e, opId) => { if (opId) (acceptedIds[e] ||= []).push(opId); };

  for (const e of ENTITIES) {
    const t = tables[e];
    for (const rec of changes[e] || []) {
      if (!rec || typeof rec.id !== 'string' || !rec.id || typeof rec.updatedAt !== 'number') continue;
      const idx = t.index.get(rec.id);
      const cur = idx === undefined ? null : t.items[idx].rec;
      // Same operation again (a retry after a lost reply): acknowledge without writing twice.
      if (cur && rec.opId && cur.opId === rec.opId) { ack(e, rec.opId); continue; }
      // The cloud moved on since this device last saw the record: report it, do not overwrite.
      if (cur && rec.baseRevision !== undefined && (cur.revision || 0) > rec.baseRevision) {
        (conflicts[e] ||= []).push({ opId: rec.opId, id: rec.id, current: cur });
        continue;
      }
      // Older clients without revisions: last write wins by updatedAt.
      if (cur && rec.baseRevision === undefined && cur.updatedAt > rec.updatedAt) continue;

      seq += 1;
      const { baseRevision, ...stored } = rec;
      if (idx === undefined) { t.index.set(rec.id, t.items.length); t.items.push({ rec: stored, seq }); }
      else t.items[idx] = { rec: stored, seq };
      touched[e] = true;
      ack(e, rec.opId);
    }
  }
  PropertiesService.getScriptProperties().setProperty(SEQ_KEY, String(seq));
  for (const e of Object.keys(touched)) writeEntity_(tables[e]);

  const out = {};
  for (const e of ENTITIES) {
    out[e] = tables[e].items.filter((it) => it.seq > since).map((it) => it.rec);
  }
  return { cursor: seq, acceptedIds, conflicts, supports: ENTITIES, changes: out };
}

// Read one entity sheet into memory. A row that cannot be read stops the sync rather than being lost on write.
function loadEntity_(ss, e) {
  const sheet = ensureSheet_(ss, e);
  const t = { sheet, items: [], index: new Map() };
  const n = sheet.getLastRow() - 1;
  if (n <= 0) return t;
  const values = sheet.getRange(2, 1, n, COLS.length).getValues();
  values.forEach((row, i) => {
    const id = String(row[0] || '');
    if (!id) return;
    let rec;
    try { rec = JSON.parse(row[8]); } catch (err) { throw new Error(`แถวที่ ${i + 2} ในแผ่น ${SHEET_NAMES[e]} อ่านข้อมูลไม่ได้ (แก้ไขในแอปแทนการแก้ในชีต)`); }
    t.index.set(id, t.items.length);
    t.items.push({ rec, seq: Number(row[7]) || 0 });
  });
  return t;
}

function writeEntity_(t) {
  if (!t.items.length) return;
  const rows = t.items.map(({ rec, seq }) => {
    const data = JSON.stringify(rec);
    if (data.length > CELL_LIMIT) throw new Error('ข้อมูลของรายการนี้ใหญ่เกินช่องของ Google Sheet (ลดขนาดรูปหน้าร้านแล้วลองใหม่)');
    return [
      rec.id, safeText_(labelOf_(rec)), rec.revision || 0, rec.updatedAt || 0, safeText_(rec.updatedBy || ''),
      rec.deleted === true, rec.opId || '', seq, data,
    ];
  });
  ensureRows_(t.sheet, rows.length + 1);
  t.sheet.getRange(2, 1, rows.length, COLS.length).setValues(rows);
}

function labelOf_(rec) {
  return String(rec.name || rec.title || rec.no || rec.sku || (rec.text || '').slice(0, 40) || '');
}

// A leading ' keeps values like "=..." or "+66..." as plain text instead of formulas.
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ensureRows_(sheet, n) {
  if (sheet.getMaxRows() < n) sheet.insertRowsAfter(sheet.getMaxRows(), n - sheet.getMaxRows());
}

// ---------------- sheet setup ----------------
function ensureSheet_(ss, e) {
  const name = SHEET_NAMES[e];
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold').setBackground('#dbe4f3');
  sheet.setFrozenRows(1);
  return sheet;
}

/** Run once from the Apps Script editor: creates the sheets and the daily backup. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  for (const e of ENTITIES) ensureSheet_(ss, e);
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'backupNow')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).create();
  if (SYNC_TOKEN === 'เปลี่ยนเป็นรหัสลับของทีม') {
    Logger.log('อย่าลืมเปลี่ยน SYNC_TOKEN เป็นรหัสลับของทีมก่อน Deploy');
  }
}

// ---------------- backup ----------------
/** Copies the whole spreadsheet into Drive folder "ART CRM Backups", keeping the latest BACKUP_KEEP. */
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
