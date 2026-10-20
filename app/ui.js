// Shared UI pieces: the minimal line icon set, one delegated event dispatcher, bottom sheets and toasts.
import { esc } from './core.js';

export { esc };
export const $ = (sel, root = document) => root.querySelector(sel);

// One icon set, one stroke weight, no emoji.
const P = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 010 6.8M18.5 14.8c1.5.9 2.4 2.7 2.7 5.2"/>',
  cart: '<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  check: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  sort: '<path d="M7 4v16M3.5 7.5L7 4l3.5 3.5M17 20V4m-3.5 3.5L17 4l3.5 3.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 006 6L16 14l5 2v4a1.5 1.5 0 01-1.5 1.5A16.5 16.5 0 013.5 5.5 1.5 1.5 0 015 4z"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  message: '<path d="M4 5h16v11H9l-5 4V5z"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  share: '<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v8h14v-8"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  history: '<path d="M4 12a8 8 0 108-8 8 8 0 00-6.3 3.1"/><path d="M4 4v4h4M12 8v4l3 2"/>',
  refresh: '<path d="M20 11a8 8 0 00-14.6-4.5M4 13a8 8 0 0014.6 4.5"/><path d="M20 4v7h-7M4 20v-7h7"/>',
  upload: '<path d="M12 20V8M7 13l5-5 5 5"/><path d="M4 4h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  chevLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevRight: '<path d="M9 5l7 7-7 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1.5 1.5 0 00-1.5-1.5h-9A1.5 1.5 0 004 5v9.5A1.5 1.5 0 005.5 16H8"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.6A9.6 9.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 01-3 3.7M6.4 6.5A16 16 0 002.5 12s3.5 6.5 9.5 6.5c1.7 0 3.2-.5 4.5-1.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v11H4zM9.5 20v-6h5v6"/>',
  box: '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16V11M12 16V7M17 16v-3"/>',
  alert: '<path d="M12 3.5l9.5 17h-19z"/><path d="M12 10v4.5M12 17.5v.5"/>',
  circleCheck: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="18" r=".8"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.8-4 3.8-6.5 7.5-6.5s6.7 2.5 7.5 6.5"/>',
  note: '<path d="M5 3.5h10l4 4V20.5H5z"/><path d="M8.5 11h7M8.5 15h7"/>',
  barcode: '<path d="M4 6v12M7 6v12M10 6v12M14 6v12M17 6v12M20 6v12"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
};
export const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;

// Delegated events: one listener per root. Elements declare intent with data attributes:
//   data-act="name"  -> handler "click:name"       data-form="name" -> "submit:name"
//   data-in="name"   -> "input:name"               data-ch="name"   -> "change:name"
export function dispatch(e, map) {
  if (e.type === 'click') {
    const el = e.target.closest?.('[data-act]');
    if (el) map[`click:${el.dataset.act}`]?.(el, e);
  } else if (e.type === 'submit') {
    e.preventDefault();
    const name = e.target.dataset?.form;
    if (name) map[`submit:${name}`]?.(e.target, e);
  } else if (e.type === 'input') {
    const el = e.target.closest?.('[data-in]');
    if (el) map[`input:${el.dataset.in}`]?.(el, e);
  } else if (e.type === 'change') {
    const el = e.target.closest?.('[data-ch]');
    if (el) map[`change:${el.dataset.ch}`]?.(el, e);
  }
}

export function bindDispatch(root, getMap) {
  for (const type of ['click', 'submit', 'input', 'change']) {
    root.addEventListener(type, (e) => dispatch(e, getMap()));
  }
}

// Replace the innerHTML of a named region without re-rendering the whole view (keeps focus in inputs).
export function region(name, html) {
  const el = document.querySelector(`[data-region="${name}"]`);
  if (el) el.innerHTML = html;
}

// ---------- toast ----------
let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- bottom sheet ----------
// A sheet is a self-contained overlay with its own handlers. Closing removes it and its listeners.
export function openSheet({ title = '', html = '', on = {}, size = '' }) {
  closeSheet();
  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.id = 'sheet-root';
  root.innerHTML = `<div class="sheet-back" data-act="close-sheet"></div>
    <section class="sheet ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="ปิด">${icon('x')}</button></header>
      <div class="sheet-body">${html}</div>
    </section>`;
  document.body.append(root);
  const handlers = { 'click:close-sheet': () => closeSheet(), ...on };
  bindDispatch(root, () => handlers);
  document.body.classList.add('lock');
  return root;
}

export function closeSheet() {
  document.getElementById('sheet-root')?.remove();
  document.body.classList.remove('lock');
}

export const sheetBody = () => document.querySelector('#sheet-root .sheet-body');

// Confirmation that cannot be bypassed by a stray tap. Resolves true only on the confirm button.
export function confirmSheet(message, okLabel = 'ยืนยัน', danger = false) {
  return new Promise((resolve) => {
    openSheet({
      title: 'ยืนยันการทำรายการ',
      html: `<p class="hint-lg">${esc(message)}</p>
        <div class="actions"><button class="btn" data-act="no">ยกเลิก</button>
        <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-act="yes">${esc(okLabel)}</button></div>`,
      on: {
        'click:no': () => { closeSheet(); resolve(false); },
        'click:yes': () => { closeSheet(); resolve(true); },
        'click:close-sheet': () => { closeSheet(); resolve(false); },
      },
    });
  });
}

// ---------- small markup helpers ----------
export const field = (name, label, value = '', attrs = '') =>
  `<label class="fld"><span>${label}</span><input name="${name}" value="${esc(value)}" ${attrs}></label>`;
export const area = (name, label, value = '', rows = 2) =>
  `<label class="fld"><span>${label}</span><textarea name="${name}" rows="${rows}">${esc(value)}</textarea></label>`;
export const select = (name, label, options, value = '') =>
  `<label class="fld"><span>${label}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
export const badge = (label, cls = 'muted') => `<span class="badge ${cls}">${esc(label)}</span>`;
export const empty = (text) => `<p class="empty">${esc(text)}</p>`;
export const more = (label = 'แสดงเพิ่ม') => `<button class="btn ghost wide" data-act="more">${label}</button>`;

export function chips(items, active, act) {
  return `<div class="chips" role="tablist">${items.map(([k, l]) =>
    `<button type="button" class="chip ${active === k ? 'active' : ''}" data-act="${act}" data-key="${esc(k)}">${esc(l)}</button>`).join('')}</div>`;
}

// Route link: path('customer', id, '?tab=purchases') -> '#/customer/<id>?tab=purchases'.
export const path = (name, id, query = '') => `#/${name}${id !== undefined ? '/' + encodeURIComponent(id) : ''}${query}`;

// Browser-side geolocation with accuracy, resolved once. Rejects with a Thai message.
export function captureGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('เครื่องนี้ไม่รองรับการระบุพิกัด')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy), at: Date.now() }),
      () => reject(new Error('ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง หรือหาพิกัดไม่ได้')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

// Shrink a photo before storing it in the record so sync payloads stay small.
export function readPhoto(file, max = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('อ่านรูปไม่สำเร็จ')); };
    img.src = url;
  });
}

export function fmtDateTime(ms) {
  return ms ? new Date(ms).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
}
