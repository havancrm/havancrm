// ART CRM shell: one router, one render owner (this file), one header status, one event dispatcher.
// Each screen returns { html, on, onMount } and never touches the DOM outside its own markup.
import * as db from './db.js';
import { syncState, onSync, startAutoSync, retryFailed } from './sync.js';
import { bump, isAcrm } from './derived.js';
import { $, toast, bindDispatch, openSheet, closeSheet, path, icon, esc } from './ui.js';
import { home, searchPage } from './views/home.js';
import { customersPage, customerPage, customerEditPage, leadsPage, leadPage, leadEditPage } from './views/customers.js';
import { ordersPage, orderPage, orderEditPage, orderSavedPage, orderHistoryPage, purchasesPage, notifyPage } from './views/orders.js';
import { tasksPage, cyclesPage, activitiesPage, mapPage, storeDataPage } from './views/work.js';
import { backstagePage, productsPage, productPage, analysisPage, salesPage, importPage, settingsPage, backupPage, auditPage } from './views/backstage.js';

const main = $('#main');
const ROUTES = {
  '': home, search: searchPage,
  customers: customersPage, customer: customerPage, 'customer-edit': customerEditPage,
  leads: leadsPage, lead: leadPage, 'lead-edit': leadEditPage,
  orders: ordersPage, order: orderPage, 'order-edit': orderEditPage, 'order-saved': orderSavedPage, 'order-history': orderHistoryPage,
  purchases: purchasesPage, notify: notifyPage,
  tasks: tasksPage, cycles: cyclesPage,
  backstage: backstagePage, activities: activitiesPage, map: mapPage, 'store-data': storeDataPage,
  products: productsPage, product: productPage, analysis: analysisPage, sales: salesPage,
  import: importPage, settings: settingsPage, backup: backupPage, audit: auditPage,
};
// Which bottom tab each screen belongs to.
const TAB = {
  '': 'home', search: 'home',
  customers: 'customers', customer: 'customers', 'customer-edit': 'customers', leads: 'customers', lead: 'customers', 'lead-edit': 'customers',
  orders: 'orders', order: 'orders', 'order-edit': 'orders', 'order-saved': 'orders', 'order-history': 'orders', purchases: 'orders', notify: 'orders',
  tasks: 'tasks', cycles: 'tasks',
};

let viewStates = new Map();
let viewHandlers = {};
let deferred = false;
let lastRoute = '';

const ctx = {};
function parseHash() {
  const [p, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = p.split('/');
  return { name: name || '', id: id !== undefined ? decodeURIComponent(id) : undefined, params: new URLSearchParams(query) };
}

const go = (p) => { location.hash = '#/' + p; };

function render() {
  const t0 = performance.now();
  const r = parseHash();
  const view = ROUTES[r.name] || home;
  if (!viewStates.has(r.name)) viewStates.set(r.name, {});
  Object.assign(ctx, { ...r, state: viewStates.get(r.name), go, rerender: render });
  let out;
  try {
    out = view(ctx);
  } catch (e) {
    console.error(e);
    out = { html: '<p class="empty">หน้านี้เปิดไม่ได้ชั่วคราว ข้อมูลในเครื่องยังอยู่ ลองกลับไปหน้าหลัก</p>', on: {} };
  }
  viewHandlers = out.on || {};
  const conflict = conflictFor(r.id);
  main.innerHTML = (conflict ? conflictBanner(conflict) : '') + out.html;
  if (lastRoute !== r.name) { main.scrollTop = 0; lastRoute = r.name; }
  updateTabs(r.name);
  out.onMount?.();
  $('#perf').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
  deferred = false;
}

// Screens not listed in TAB belong to the backstage menu.
function updateTabs(name) {
  const active = TAB[name] || (name === '' ? 'home' : 'menu');
  for (const a of document.querySelectorAll('.tabbar a')) a.classList.toggle('active', a.dataset.tab === active);
}

// ---------- header status (the only status the user must learn) ----------
export function statusInfo() {
  const st = syncState();
  // Without a cloud database, everything lives on this device and there is nothing to send.
  if (st.status === 'off') return ['ok', 'พร้อมใช้'];
  if (st.status === 'syncing') return ['syncing', 'กำลังบันทึก'];
  if (!navigator.onLine) return ['offline', 'ออฟไลน์'];
  if (db.failedCount() || st.status === 'error') return ['error', 'บันทึกไม่สำเร็จ'];
  if (db.pendingCount()) return ['pending', 'รอบันทึก'];
  return ['ok', 'พร้อมใช้'];
}

const STATUS_TEXT = {
  ok: 'ข้อมูลทั้งหมดซิงก์แล้ว',
  pending: 'มีข้อมูลในเครื่องที่ยังไม่ได้ส่ง ระบบจะส่งให้อัตโนมัติ',
  syncing: 'ระบบกำลังส่งข้อมูล',
  offline: 'ออฟไลน์ ระบบใช้ข้อมูลในเครื่องต่อได้ตามปกติ',
  error: 'มีบางรายการส่งไม่สำเร็จ ระบบจะลองใหม่ให้ หรือกดลองใหม่ได้เลย',
};

function updateHeader() {
  const [key, label] = statusInfo();
  const el = $('#status');
  el.dataset.status = key;
  el.querySelector('span').textContent = label;
  el.title = STATUS_TEXT[key];
  const detail = $('#status-detail');
  if (detail) detail.innerHTML = statusDetail();
}

function statusDetail() {
  const st = syncState();
  const pend = db.pendingCount();
  const failed = db.failedCount();
  const conflicts = db.conflictList().length;
  const last = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('th-TH') : 'ยังไม่เคย';
  return `<p>${STATUS_TEXT[statusInfo()[0]]}</p>
    <ul class="plain"><li><span>รอส่ง</span><small>${pend} รายการ</small></li>
    <li><span>ไม่สำเร็จ</span><small>${failed} รายการ</small></li>
    <li><span>ความขัดแย้ง</span><small>${conflicts} รายการ</small></li>
    <li><span>ซิงก์ล่าสุด</span><small>${last}</small></li></ul>
    ${isAcrm() ? '<p class="hint">เชื่อมต่อ A-CRM</p>' : ''}`;
}

function openStatus() {
  openSheet({
    title: 'สถานะการบันทึก',
    html: `<div id="status-detail">${statusDetail()}</div>
      <div class="actions"><button class="btn primary" data-act="retry">ลองใหม่</button><a class="btn" href="${path('settings')}" data-act="close-sheet">รายละเอียด</a></div>`,
    on: {
      'click:retry': async () => { toast('กำลังลองส่งใหม่…'); await retryFailed(); if (db.failedCount() === 0) toast('ส่งข้อมูลสำเร็จ'); updateHeader(); },
    },
  });
}

// ---------- conflicts (ข้อมูลนี้ถูกแก้จากอีกเครื่อง) ----------
const CONFLICT_ENTITIES = ['customers', 'leads', 'orders'];
const conflictFor = (id) => {
  if (!id) return null;
  for (const e of CONFLICT_ENTITIES) {
    const c = db.conflictFor(e, id);
    if (c) return c;
  }
  return null;
};

function conflictBanner(c) {
  return `<section class="conflict" role="alert">
    <div><b>ข้อมูลนี้ถูกแก้จากอีกเครื่อง</b><small>เครื่องนี้และเครื่องอื่นแก้ข้อมูลส่วนเดียวกัน ระบบรวมให้อัตโนมัติไม่ได้</small></div>
    <div class="actions">
      <button class="btn small" data-act="cf-view" data-id="${esc(c.id)}">ดูเวอร์ชัน Cloud</button>
      <button class="btn small primary" data-act="cf-mine" data-id="${esc(c.id)}">ใช้ข้อมูลของฉัน</button>
      <button class="btn small" data-act="cf-cloud" data-id="${esc(c.id)}">ใช้ข้อมูลล่าสุด</button>
    </div></section>`;
}

const FIELD_LABEL = {
  name: 'ชื่อ', phone: 'เบอร์โทร', line: 'LINE', address: 'ที่อยู่', note: 'บันทึก', status: 'สถานะ', tags: 'แท็ก', zone: 'Zone',
  businessType: 'ประเภท', province: 'จังหวัด', contact: 'ผู้ติดต่อ', owner: 'ผู้ดูแล', terms: 'เงื่อนไข', credit: 'เครดิต',
  no: 'เลขที่', discount: 'ส่วนลด', date: 'วันที่', items: 'รายการสินค้า', payment: 'การชำระ', vat: 'VAT', area: 'พื้นที่',
};
const valueText = (v) => (v === undefined || v === null || v === '' ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function showCloudVersion(id) {
  const c = db.conflictList().find((x) => x.id === id);
  if (!c) return;
  const skip = (k) => k.startsWith('_') || ['revision', 'baseRevision', 'updatedAt', 'updatedBy', 'createdAt', 'opId', 'id', 'deleted'].includes(k);
  const keys = [...new Set([...Object.keys(c.local), ...Object.keys(c.cloud)])].filter((k) => !skip(k));
  const rows = keys.filter((k) => valueText(c.local[k]) !== valueText(c.cloud[k]));
  openSheet({
    title: 'ข้อมูลที่ต่างกัน',
    html: `<p class="hint-lg">ค่าที่ต่างกันระหว่างเครื่องนี้กับ Cloud</p>
      ${rows.length ? `<ul class="list">${rows.map((k) => `<li><div><b>${esc(FIELD_LABEL[k] || k)}</b>
        <small>เครื่องนี้: ${esc(valueText(c.local[k]))}</small><small>Cloud: ${esc(valueText(c.cloud[k]))}</small></div></li>`).join('')}</ul>` : '<p class="hint">ไม่มีค่าที่ต่างกัน</p>'}
      <div class="actions"><button class="btn primary" data-act="cf-mine" data-id="${esc(id)}">ใช้ข้อมูลของฉัน</button>
        <button class="btn" data-act="cf-cloud" data-id="${esc(id)}">ใช้ข้อมูลล่าสุด</button></div>`,
    on: { 'click:cf-mine': (el) => resolve(el.dataset.id, 'mine'), 'click:cf-cloud': (el) => resolve(el.dataset.id, 'cloud') },
  });
}

function resolve(id, choice) {
  closeSheet();
  if (!db.resolveConflict(id, choice)) { toast('รวมข้อมูลอัตโนมัติไม่ได้ เลือกใช้ข้อมูลของฉัน หรือข้อมูลล่าสุด'); return; }
  toast(choice === 'mine' ? 'ใช้ข้อมูลของเครื่องนี้แล้ว' : 'ใช้ข้อมูลล่าสุดจากฐานกลางแล้ว');
}

// ---------- events ----------
// The shell dispatches clicks, submits, inputs and changes for whatever screen is mounted.
const shellHandlers = { 'click:status': openStatus };
const shellMain = {
  'click:cf-view': (el) => showCloudVersion(el.dataset.id),
  'click:cf-mine': (el) => resolve(el.dataset.id, 'mine'),
  'click:cf-cloud': (el) => resolve(el.dataset.id, 'cloud'),
};
bindDispatch(main, () => ({ ...shellMain, ...viewHandlers }));
bindDispatch($('.topbar'), () => shellHandlers);
// A rerender that arrived while the user was typing is applied when focus leaves the field.
main.addEventListener('focusout', () => { if (deferred) setTimeout(() => { if (deferred) render(); }, 0); });

function busyInput() {
  const el = document.activeElement;
  return !!el && main.contains(el) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

async function maybeAutoBackup() {
  const last = (await db.getMeta('lastAutoBackupAt')) || 0;
  if (Date.now() - last < 24 * 3600000) return;
  await db.createBackup('auto');
  await db.setMeta('lastAutoBackupAt', Date.now());
}

function showError(message) {
  toast(message);
}

async function boot() {
  for (const a of document.querySelectorAll('.tabbar a')) a.insertAdjacentHTML('afterbegin', icon(a.dataset.icon));
  await db.init();
  await startAutoSync();
  db.onWriteError(() => showError('บันทึกในเครื่องไม่สำเร็จ อย่าเพิ่งปิดแอป แล้วลองอีกครั้ง'));
  window.addEventListener('error', () => showError('เกิดข้อผิดพลาดชั่วคราว ข้อมูลในเครื่องยังอยู่'));
  window.addEventListener('unhandledrejection', () => showError('เกิดข้อผิดพลาดชั่วคราว ข้อมูลในเครื่องยังอยู่'));
  window.addEventListener('hashchange', () => render());
  render();
  updateHeader();

  db.onChange((source) => {
    bump();
    updateHeader();
    if (source !== 'local' && busyInput()) { deferred = true; return; }
    render();
  });

  let backend = syncState().backend;
  onSync((st) => {
    updateHeader();
    if (st.backend !== backend) {
      backend = st.backend;
      bump();
      if (!busyInput()) render();
    }
  });
  window.addEventListener('online', updateHeader);
  window.addEventListener('offline', updateHeader);
  maybeAutoBackup().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch((e) => {
  console.error(e);
  main.innerHTML = '<p class="empty">เปิดข้อมูลในเครื่องไม่สำเร็จ ลองปิดแล้วเปิดแอปใหม่ (ข้อมูลเดิมยังไม่ถูกลบ)</p>';
});
