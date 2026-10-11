// Minimal in-memory stand-in for the Google Apps Script services used by Code.gs.
import fs from 'node:fs';
import vm from 'node:vm';

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.rows; }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.cols }, (_, c) => this.sheet.cell(this.row + r, this.col + c)));
  }
  setValues(values) {
    if (values.length !== this.rows || values.some((v) => v.length !== this.cols)) throw new Error('dimension mismatch');
    // Sheets drops a leading apostrophe (it only marks the cell as text).
    values.forEach((rowVals, r) => rowVals.forEach((v, c) =>
      this.sheet.set(this.row + r, this.col + c, typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v)));
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  insertCheckboxes() { return this; }
}

export class Sheet {
  constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; }
  getName() { return this.name; }
  cell(r, c) { const v = this.data[r - 1]?.[c - 1]; return v === undefined ? '' : v; }
  set(r, c, v) { (this.data[r - 1] ||= [])[c - 1] = v; }
  getLastColumn() { return Math.max(0, ...this.data.map((r) => (r || []).length)); }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some((v) => v !== '' && v !== undefined)) return r;
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  getRange(row, col, rows = 1, cols = 1) {
    if (row + rows - 1 > this.maxRows) throw new Error('Range out of bounds');
    return new Range(this, row, col, rows, cols);
  }
  setFrozenRows() {}
  hideColumns() {}
}

// Builds a sandbox with the Apps Script globals Code.gs files use, then runs the given file in it.
const HOUR_AGO = Date.now() - 3600000;

export function loadGas(file, { sheets = new Map(), lastUpdated = () => HOUR_AGO } = {}) {
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new Sheet(n); sheets.set(n, s); return s; },
    getSpreadsheetTimeZone: () => 'UTC',
    getSheets: () => [...sheets.values()],
    getName: () => 'HavanCRM',
    getId: () => 'sheet-id',
  };
  const props = new Map();
  const drive = { copies: [] };
  let uuid = 0;
  const ctx = vm.createContext({
    SpreadsheetApp: { getActive: () => ss, openById: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, String(v)) }),
    },
    DriveApp: {
      getFileById: () => ({ getLastUpdated: () => new Date(lastUpdated()), makeCopy: (name) => drive.copies.push(name) }),
      getFolderById: () => ({}),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: {
      getUuid: () => `uuid-${++uuid}`,
      formatDate: (d, _tz, fmt) => fmt === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString(),
    },
    Logger: { log() {} },
    console,
  });
  vm.runInContext(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), ctx);
  const token = vm.runInContext('SYNC_TOKEN', ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token, ...body }) } }).text);
  return { ctx, ss, sheets, post, token, props, drive };
}

export const loadCodeGs = () => loadGas('../google-apps-script/Code.gs');
