// Orders and bills: list (รอส่ง / เปิด LINE แล้ว / เปิดบิลแล้ว), detail, history, the three-step
// order editor, the saved screen, purchase history, billing summary (แจ้งยอด), and the order image.
import * as db from '../db.js';
import * as core from '../core.js';
import { esc, money, num, thaiDate, today, orderTotal, vatBreakdown, orderText } from '../core.js';
import { icon, path, badge, empty, chips, field, area, select, openSheet, closeSheet, toast, region, confirmSheet, fmtDateTime, more } from '../ui.js';
import { customers, orders, productIdx, catalog, searchIdx, isAcrm, isSale, byDateDesc, customerName, ordersOf } from '../derived.js';

export const STATUS = {
  pending: { label: 'รอส่ง', cls: 'warn' },
  sent: { label: 'เปิด LINE แล้ว', cls: 'info' },
  billed: { label: 'เปิดบิลแล้ว', cls: 'ok' },
  paid: { label: 'ชำระแล้ว', cls: 'ok' },
  shipped: { label: 'ส่งของแล้ว', cls: 'info' },
  cancelled: { label: 'ยกเลิก', cls: 'muted' },
  excluded: { label: 'ไม่นับยอด', cls: 'muted' },
};
const EDITABLE = ['pending', 'sent'];
const CANCEL_REASONS = ['ลูกค้ายกเลิก', 'สินค้าไม่พอ', 'ราคาไม่ตรง', 'ซ้ำกับออเดอร์เดิม', 'อื่น ๆ'];
const DRAFT_KEY = 'artcrm.draft';
const TABS = [['pending', 'รอส่ง'], ['sent', 'เปิด LINE แล้ว'], ['billed', 'เปิดบิลแล้ว'], ['all', 'ทั้งหมด']];

const lineUrl = (id) => `https://line.me/ti/p/~${encodeURIComponent(String(id || '').replace(/^@/, ''))}`;
const who = () => db.getUser() || 'ผู้ใช้';
const historyOf = (o) => (o.history || []).slice();
const entry = (action, detail = '') => ({ at: Date.now(), action, by: who(), detail });
export const statusBadge = (o) => badge((STATUS[o.status] || STATUS.pending).label, (STATUS[o.status] || STATUS.pending).cls);
const billOrOrder = (o) => (o.kind === 'bill' ? 'บิล ' : '') + (o.no || '');

export function newOrderId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const be = String(d.getFullYear() + 543).slice(2);
  return `O-${be}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${Math.random().toString(36).slice(2, 4)}`;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
}

// ---------- list ----------
export function ordersPage(ctx) {
  const st = ctx.state;
  st.tab = ctx.params.get('tab') || st.tab || 'pending';
  st.limit ||= 80;
  const countOf = (k) => orders().filter((o) => (k === 'all' || o.status === k)).length;
  const render = () => {
    const q = (st.q || '').trim();
    let list = orders();
    if (q) {
      const g = core.search(searchIdx(), q, 100000);
      const ids = new Set([...g.orders, ...g.bills]);
      list = list.filter((o) => ids.has(o.id));
    }
    list = list.filter((o) => st.tab === 'all' || o.status === st.tab).sort(byDateDesc);
    const sum = list.filter(isSale).reduce((s, o) => s + orderTotal(o), 0);
    region('results', `<p class="count">${num(list.length)} รายการ · ยอด ${money(sum)}</p>
      ${list.length ? `<ul class="cards">${list.slice(0, st.limit).map(orderCard).join('')}</ul>${list.length > st.limit ? more() : ''}` : empty('ไม่มีรายการ')}`);
  };
  return {
    html: `
    <div class="page-top"><h1>${isAcrm() ? 'บิล & ออเดอร์' : 'รับออเดอร์'}</h1>
      <a class="btn primary small" href="${path('order-edit', 'new')}">${icon('cart')} รับออเดอร์</a></div>
    <input class="search" type="search" placeholder="ค้นหา เลขที่ / ร้าน / รหัส / เบอร์ / สินค้า" data-in="q" value="${esc(st.q || '')}" autocomplete="off">
    ${chips(TABS.map(([k, l]) => [k, k === 'all' ? l : `${l} ${countOf(k)}`]), st.tab, 'tab')}
    <div data-region="results"></div>`,
    on: {
      'input:q': (el) => { st.q = el.value; st.limit = 80; render(); },
      'click:tab': (el) => { st.tab = el.dataset.key; ctx.go(`orders?tab=${el.dataset.key}`); },
      'click:more': () => { st.limit += 80; render(); },
      'click:line': (el) => openLine(db.get('orders', el.dataset.id)),
      'click:menu': (el) => orderMenu(db.get('orders', el.dataset.id)),
    },
    onMount: render,
  };
}

function orderCard(o) {
  const c = db.get('customers', o.customerId);
  const editable = EDITABLE.includes(o.status);
  return `<li class="card-row">
    <a class="card-link" href="${path('order', o.id)}">
      <div class="card-top"><b>${esc(c?.name || '(ไม่ระบุลูกค้า)')}</b>${statusBadge(o)}</div>
      <small>${esc(billOrOrder(o))} · ${thaiDate(o.date)} · ${(o.items || []).length} รายการ${o.kind === 'bill' ? '' : ''}</small>
      <small>${esc((o.items || []).slice(0, 2).map((i) => i.name).join(', '))}${(o.items || []).length > 2 ? ' …' : ''}</small>
      <div class="card-meta"><b>${o.priceUnknown ? 'ไม่ทราบราคา' : money(orderTotal(o))}</b>${db.hasPending('orders', o.id) ? '<span class="warn-text">รอซิงค์</span>' : ''}</div>
    </a>
    ${editable ? `<div class="card-actions">
      <a class="btn small" href="${path('order-edit', o.id)}">${icon('edit')} แก้ไข</a>
      <button class="btn small" data-act="line" data-id="${esc(o.id)}">${icon('message')} LINE</button>
      <button class="btn small ghost" data-act="menu" data-id="${esc(o.id)}" aria-label="เมนูเพิ่มเติม">${icon('more')}</button>
    </div>` : ''}
  </li>`;
}

function orderMenu(o) {
  if (!o) return;
  const canCancel = !['billed', 'cancelled'].includes(o.status);
  openSheet({
    title: billOrOrder(o),
    html: `<div class="menu-list">
      <button class="menu-item" data-act="image">${icon('file')} ส่งออกรูปใบสั่งซื้อ</button>
      <a class="menu-item" href="${path('order-history', o.id)}">${icon('history')} ประวัติออเดอร์</a>
      ${o.status === 'sent' ? `<button class="menu-item" data-act="resend">${icon('refresh')} รอส่งใหม่</button>` : ''}
      ${o.status !== 'billed' && o.status !== 'cancelled' ? `<button class="menu-item" data-act="billed">${icon('check')} เปิดบิลแล้ว</button>` : ''}
      ${canCancel ? `<button class="menu-item danger" data-act="cancel">${icon('trash')} ยกเลิกออเดอร์</button>` : ''}
    </div>`,
    on: {
      'click:image': () => { closeSheet(); imageSheet(o); },
      'click:resend': () => { db.save('orders', { id: o.id, status: 'pending', history: [...historyOf(o), entry('รอส่งใหม่')] }, { action: 'รอส่งใหม่' }); closeSheet(); toast('ย้ายกลับไปรอส่งแล้ว'); },
      'click:billed': () => { markBilled(o); closeSheet(); },
      'click:cancel': () => { closeSheet(); cancelSheet(o); },
    },
  });
}

function markBilled(o) {
  db.save('orders', { id: o.id, status: 'billed', history: [...historyOf(o), entry('เปิดบิลแล้ว')] }, { action: 'เปิดบิลแล้ว' });
  toast('อัปเดตเป็นเปิดบิลแล้ว (ห้ามแก้ไขออเดอร์)');
}

// LINE hand-off: copy the order text, record the step in the history, then open the customer's LINE.
export function openLine(o) {
  if (!o || !EDITABLE.includes(o.status)) return;
  const c = db.get('customers', o.customerId);
  copyText(orderText(o, c));
  const repeat = o.status === 'sent';
  db.save('orders', {
    id: o.id, status: 'sent',
    history: [...historyOf(o), entry(repeat ? 'เปิด LINE ซ้ำ' : 'เปิด LINE', c?.line ? `LINE ${c.line}` : 'ไม่มี LINE ID')],
  }, { action: repeat ? 'เปิด LINE ซ้ำ' : 'เปิด LINE' });
  if (c?.line) window.open(lineUrl(c.line), '_blank', 'noopener');
  else toast('ร้านนี้ยังไม่มี LINE ID — คัดลอกข้อความแล้ว เปิด LINE แล้ววางได้เลย');
}

function cancelSheet(o) {
  openSheet({
    title: 'ยกเลิกออเดอร์',
    html: `<form class="form" data-form="cancel">
      <p class="hint">ออเดอร์จะถูกเก็บไว้เป็นสถานะ "ยกเลิก" ไม่ถูกลบ</p>
      ${select('reason', 'เหตุผล *', CANCEL_REASONS.map((r) => [r, r]), CANCEL_REASONS[0])}
      ${area('detail', 'รายละเอียดเพิ่มเติม', '', 2)}
      <div class="actions"><button type="button" class="btn" data-act="close-sheet">ไม่ยกเลิก</button><button class="btn danger-solid">ยืนยันยกเลิก</button></div>
    </form>`,
    on: {
      'submit:cancel': (form) => {
        const reason = form.reason.value;
        const detail = form.detail.value.trim();
        db.save('orders', {
          id: o.id, status: 'cancelled', cancelReason: reason,
          history: [...historyOf(o), entry('ยกเลิกออเดอร์', [reason, detail].filter(Boolean).join(' · '))],
        }, { action: 'ยกเลิกออเดอร์' });
        closeSheet();
        toast('ยกเลิกออเดอร์แล้ว');
      },
    },
  });
}

// ---------- detail / bill ----------
export function orderPage(ctx) {
  const o = db.get('orders', ctx.id);
  if (!o) return { html: empty('ไม่พบรายการ') };
  const c = db.get('customers', o.customerId);
  const subtotal = (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const v = vatBreakdown(subtotal - (Number(o.discount) || 0), o.vat);
  const siblings = ordersOf(o.customerId).filter(isSale).sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.no).localeCompare(String(b.no)));
  const idx = siblings.findIndex((x) => x.id === o.id);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
  const meta = [['เซลล์', o.salesperson], ['ผู้เปิดบิล', o.opener], ['เงื่อนไข', o.terms], ['การชำระ', o.payment], ['ภาษี', o.vat === 'included' ? 'รวม VAT แล้ว' : o.vat === 'plus' ? 'ยังไม่รวม VAT (+7%)' : o.vat ? '' : '']].filter(([, x]) => x);

  return {
    html: `
    <div class="head"><a href="${path('orders')}" class="back">${icon('chevLeft')} รายการ</a>
      ${o.src ? '<span class="src">ข้อมูลจาก A-CRM</span>' : ''}</div>
    <h1>${esc(billOrOrder(o))}</h1>
    <p class="sub">${thaiDate(o.date)} · ${c ? `<a href="${path('customer', c.id)}">${esc(c.name)}</a>` : esc(o.customerId || '(ไม่ระบุลูกค้า)')} ${statusBadge(o)}</p>
    ${o.status === 'billed' ? '<p class="hint">เปิดบิลแล้ว ห้ามแก้ไขออเดอร์</p>' : ''}
    ${o.status === 'cancelled' ? `<p class="hint">ยกเลิกเมื่อ ${fmtDateTime((historyOf(o).filter((h) => h.action === 'ยกเลิกออเดอร์').pop() || {}).at)} · ${esc(o.cancelReason || '')}</p>` : ''}
    <div class="actions">
      ${EDITABLE.includes(o.status) && !o.src ? `<a class="btn primary" href="${path('order-edit', o.id)}">${icon('edit')} แก้ไข</a>` : ''}
      ${EDITABLE.includes(o.status) ? `<button class="btn" data-act="line">${icon('message')} ${o.status === 'sent' ? 'เปิด LINE ซ้ำ' : 'เปิด LINE'}</button>` : ''}
      <button class="btn" data-act="image">${icon('share')} ส่งรูป</button>
      ${o.customerId ? `<a class="btn" href="${path('order-edit', 'new', `?customer=${encodeURIComponent(o.customerId)}&repeat=${encodeURIComponent(o.id)}`)}">${icon('refresh')} สั่งซ้ำ</a>` : ''}
    </div>
    <section class="card">
      <table class="items"><thead><tr><th>สินค้า</th><th>จำนวน</th><th>ราคา</th><th>รวม</th></tr></thead><tbody>
      ${(o.items || []).map((i) => {
    const known = i.price !== null && i.price !== undefined;
    return `<tr><td>${esc(i.name)}${i.code ? `<small class="muted-s">${esc(i.code)}</small>` : ''}</td><td>${num(i.qty)} ${esc(i.unit || '')}</td><td>${known ? money(i.price) : '-'}</td><td>${known ? money(i.qty * i.price) : '-'}</td></tr>`;
  }).join('')}
      </tbody>
      <tfoot>
        ${Number(o.discount) ? `<tr><td colspan="3">ส่วนลด</td><td>-${money(o.discount)}</td></tr>` : ''}
        ${o.vat && o.vat !== 'none' ? `<tr><td colspan="3">ยอดก่อน VAT</td><td>${money(v.base)}</td></tr><tr><td colspan="3">VAT 7%</td><td>${money(v.vat)}</td></tr>` : ''}
        <tr><th colspan="3">ยอดสุทธิ</th><th>${o.priceUnknown ? 'ไม่ทราบราคา' : money(v.total)}</th></tr>
      </tfoot></table>
      ${o.priceUnknown ? '<p class="hint">ออเดอร์เดิมไม่มีราคาครบ ระบบจะไม่เดาราคาย้อนหลัง</p>' : ''}
    </section>
    ${meta.length || o.note ? `<section class="card info">${meta.map(([k, x]) => `<div><span>${k}</span><p>${esc(x)}</p></div>`).join('')}
      ${o.note ? `<div><span>หมายเหตุ</span><p>${esc(o.note)}</p></div>` : ''}</section>` : ''}
    <div class="actions">
      ${o.status !== 'billed' && o.status !== 'cancelled' && !o.src ? `<button class="btn danger" data-act="cancel">${icon('trash')} ยกเลิกออเดอร์</button>` : ''}
      ${o.status === 'sent' || o.status === 'pending' ? `<button class="btn" data-act="billed">${icon('check')} เปิดบิลแล้ว</button>` : ''}
    </div>
    <div class="actions">
      ${prev ? `<a class="btn ghost" href="${path('order', prev.id)}">${icon('chevLeft')} ก่อนหน้า</a>` : ''}
      ${next ? `<a class="btn ghost" href="${path('order', next.id)}">ถัดไป ${icon('chevRight')}</a>` : ''}
      ${c ? `<a class="btn ghost" href="${path('notify', undefined, '?customer=' + encodeURIComponent(c.id))}">${icon('file')} แจ้งยอด</a>` : ''}
    </div>
    <section class="card"><h2>ประวัติ <a class="more" href="${path('order-history', o.id)}">ทั้งหมด</a></h2>
      ${timeline(historyOf(o).slice(-4).reverse())}</section>`,
    on: {
      'click:line': () => openLine(o),
      'click:image': () => imageSheet(o),
      'click:cancel': () => cancelSheet(o),
      'click:billed': async () => { if (await confirmSheet('เปิดบิลแล้ว ออเดอร์นี้จะถูกล็อกไม่ให้แก้ไข', 'เปิดบิลแล้ว')) markBilled(o); },
    },
  };
}

function timeline(list) {
  return `<ul class="timeline">${list.map((h) => `<li><span class="dot"></span><div class="tl-body">
    <div class="tl-head"><b>${esc(h.action)}</b> <small>${fmtDateTime(h.at)} · ${esc(h.by || '')}</small></div>
    ${h.detail ? `<p>${esc(h.detail)}</p>` : ''}</div></li>`).join('') || '<li class="empty-li">ยังไม่มีประวัติ</li>'}</ul>`;
}

export function orderHistoryPage(ctx) {
  const o = db.get('orders', ctx.id);
  if (!o) return { html: empty('ไม่พบรายการ') };
  return {
    html: `<div class="head"><a href="${path('order', o.id)}" class="back">${icon('chevLeft')} ${esc(billOrOrder(o))}</a></div>
      <h1>ประวัติออเดอร์</h1>${timeline(historyOf(o).slice().reverse())}`,
  };
}

// ---------- editor (3 steps) ----------
function blankDraft() {
  return { id: '', no: '', date: today(), customerId: '', items: [], discount: '', vat: 'none', terms: '', payment: 'ลูกค้าโอน', note: '' };
}
function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}
function writeDraft(d) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* storage full or disabled: keep working in memory */ }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function loadDraft(ctx) {
  const st = ctx.state;
  const key = `${ctx.id}|${ctx.params.get('customer') || ''}|${ctx.params.get('repeat') || ''}`;
  if (st.key === key && st.draft) return st.draft;
  let d;
  if (ctx.id === 'new') {
    const repeat = ctx.params.get('repeat') && db.get('orders', ctx.params.get('repeat'));
    const saved = readDraft();
    if (repeat) {
      d = { ...blankDraft(), customerId: repeat.customerId, items: repeat.items.map((i) => ({ ...i, price: i.price ?? null })), terms: repeat.terms || '', payment: repeat.payment || 'ลูกค้าโอน', vat: repeat.vat || 'none' };
    } else if (ctx.params.get('customer')) {
      d = saved && saved.customerId === ctx.params.get('customer') ? saved : { ...blankDraft(), customerId: ctx.params.get('customer') };
    } else d = saved || blankDraft();
    d.id ||= newOrderId();
    d.no ||= d.id;
  } else {
    const o = db.get('orders', ctx.id);
    d = o ? { ...o, items: (o.items || []).map((i) => ({ ...i })), discount: o.discount || '' } : null;
  }
  st.key = key;
  st.draft = d;
  return d;
}

function itemPrice(d, cat) {
  const cust = d.customerId ? productIdx(d.customerId).get(cat.name) : null;
  if (cust?.price != null) return { price: cust.price, src: 'ราคาลูกค้า' };
  const master = db.get('products', cat.id);
  if (master?.standardPrice != null && master.standardPrice !== '') return { price: +master.standardPrice, src: 'ราคามาตรฐาน' };
  const last = productIdx().get(cat.name);
  if (last?.price != null) return { price: last.price, src: 'ราคาล่าสุด' };
  return { price: null, src: 'ยังไม่มีราคา' };
}

function addItem(d, cat) {
  const existing = d.items.find((i) => (i.code || i.name) === cat.id);
  if (existing) { existing.qty = (Number(existing.qty) || 0) + 1; return; }
  const p = itemPrice(d, cat);
  d.items.push({ code: cat.code || '', name: cat.name, unit: cat.unit || '', qty: 1, price: p.price, src: p.src });
}

function subtotal(d) {
  return d.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
}

export function orderEditPage(ctx) {
  const d = loadDraft(ctx);
  if (!d) return { html: empty('ไม่พบออเดอร์') };
  const existing = ctx.id !== 'new' ? db.get('orders', ctx.id) : null;
  if (existing && !EDITABLE.includes(existing.status)) return { html: `<div class="head"><a href="${path('order', existing.id)}" class="back">${icon('chevLeft')} ย้อนกลับ</a></div><p class="hint">ออเดอร์นี้${existing.status === 'billed' ? 'เปิดบิลแล้ว' : 'ถูกยกเลิก'} แก้ไขไม่ได้</p>` };
  if (existing?.src) return { html: empty('รายการจาก A-CRM แก้ไขได้ในระบบ A-CRM เท่านั้น') };
  const cust = d.customerId ? db.get('customers', d.customerId) : null;
  const custList = customers().filter((c) => !c.inactive);
  const mostUsed = cust ? [...productIdx(cust.id).entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3) : [];
  const lastOrder = cust ? ordersOf(cust.id).filter(isSale)[0] : null;
  const sub = subtotal(d);
  const net = sub - (Number(d.discount) || 0);
  const v = vatBreakdown(net, d.vat);
  const unknown = d.items.some((i) => i.price === null || i.price === undefined || i.price === '');
  const count = d.items.filter((i) => i.name).length;

  const itemsHtml = () => d.items.map((i, n) => itemRow(i, n)).join('') || empty('ยังไม่มีสินค้า — เลือกจากด้านบนหรือค้นหาสินค้า');
  const totals = () => {
    const s = subtotal(d); const nt = s - (Number(d.discount) || 0); const vv = vatBreakdown(nt, d.vat);
    const unk = d.items.some((i) => i.price === null || i.price === undefined || i.price === '');
    return { total: unk ? null : vv.total, count: d.items.filter((i) => i.name).length, unk, v: vv };
  };
  const bar = () => {
    const t = totals();
    region('bar', `<span>${num(t.count)} รายการ</span><b>${t.unk ? 'ไม่ทราบราคาบางรายการ' : money(t.total)}</b>`);
  };
  const save = () => {
    const t = totals();
    const items = d.items.filter((i) => i.name).map(({ src, ...i }) => ({ ...i, qty: Number(i.qty) || 0, price: i.price === '' || i.price === null || i.price === undefined ? null : Number(i.price) }));
    const cust2 = d.customerId ? db.get('customers', d.customerId) : null;
    if (!cust2) { toast('เลือกร้านค้าก่อนบันทึก'); return; }
    if (!items.length) { toast('กรุณาใส่สินค้าอย่างน้อย 1 รายการ'); return; }
    if (items.some((i) => !(i.qty > 0))) { toast('จำนวนสินค้าต้องมากกว่า 0'); return; }
    const base = existing || null;
    const isNew = !base;
    const rec = {
      id: d.id, no: d.no || d.id, kind: 'order', date: d.date || today(), customerId: cust2.id, items,
      discount: Number(d.discount) || 0, vat: d.vat, terms: d.terms, payment: d.payment, note: d.note,
      status: base ? base.status : 'pending',
      total: t.unk ? null : t.total, priceUnknown: t.unk,
      history: [...(base ? historyOf(base) : []), entry(isNew ? 'สร้างออเดอร์' : 'แก้ไขออเดอร์', `${items.length} รายการ`)],
    };
    db.save('orders', rec, { action: isNew ? 'สร้างออเดอร์' : 'แก้ไขออเดอร์' });
    if (isNew) { clearDraft(); ctx.state.draft = null; }
    toast(isNew ? 'บันทึกออเดอร์แล้ว' : 'บันทึกการแก้ไขแล้ว');
    ctx.go('order-saved/' + encodeURIComponent(rec.id));
  };
  const persist = () => { if (ctx.id === 'new') writeDraft(d); };

  return {
    html: `
    <div class="head"><a href="${ctx.id === 'new' ? path('orders') : path('order', ctx.id)}" class="back">${icon('chevLeft')} ยกเลิก</a></div>
    <h1>${ctx.id === 'new' ? 'รับออเดอร์ใหม่' : 'แก้ไขออเดอร์'}</h1>
    <form class="form order-form" data-form="order" id="order-form">
      <section class="card">
        <h2><span class="step">1</span> ร้านค้า</h2>
        <div data-region="cust">${cust ? `<div class="picked">
          <div><b>${esc(cust.name)}</b><small>${esc([cust.code, cust.phone, cust.zone].filter(Boolean).join(' · '))}</small></div>
          <button type="button" class="btn small ghost" data-act="change-cust">เปลี่ยนร้าน</button></div>` : `
          <input class="search" type="search" placeholder="ค้นหาชื่อร้าน / รหัส / เบอร์" data-in="cust" autocomplete="off">
          <div data-region="cust-results"></div>`}
        </div>
      </section>

      <section class="card">
        <h2><span class="step">2</span> สินค้า</h2>
        <div class="quick-row">
          ${lastOrder ? `<button type="button" class="btn small" data-act="last-order">ใช้ออเดอร์ล่าสุด</button>` : ''}
          ${mostUsed.map(([name, p], n) => `<button type="button" class="chip" data-act="add-known" data-name="${esc(name)}">+ ${esc(name)}</button>`).join('')}
        </div>
        <input class="search" type="search" placeholder="ค้นหาสินค้า / SKU" data-in="prod" autocomplete="off">
        <div data-region="prod-results"></div>
        <div class="items-edit" data-region="items">${itemsHtml()}</div>
      </section>

      <section class="card">
        <h2><span class="step">3</span> เงื่อนไขและการชำระ</h2>
        <div class="fld"><span>VAT</span><div class="chips">${[['none', 'ไม่มี'], ['included', 'รวม VAT'], ['plus', '+ VAT']].map(([k, l]) => `<button type="button" class="chip ${d.vat === k ? 'active' : ''}" data-act="vat" data-key="${k}">${l}</button>`).join('')}</div></div>
        <div class="row2">
          <label class="fld"><span>เงื่อนไข (พิมพ์เองได้)</span><input name="terms" list="termlist" value="${esc(d.terms)}" autocomplete="off"><datalist id="termlist">${db.masters.terms.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
          ${field('discount', 'ส่วนลด (บาท)', d.discount, 'type="number" inputmode="decimal" min="0" step="any"')}
        </div>
        <div class="fld"><span>การชำระเงิน</span><div class="chips">${db.masters.payments.map((p) => `<button type="button" class="chip ${d.payment === p ? 'active' : ''}" data-act="pay" data-key="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
        ${field('date', 'วันที่', d.date, 'type="date" required')}
        ${area('note', 'หมายเหตุ', d.note, 2)}
        <p class="total">ยอดสุทธิ <b data-region="total">${unknown ? 'ไม่ทราบราคาบางรายการ' : money(v.total)}</b></p>
      </section>
    </form>
    <div class="sticky-bar">
      <div class="bar-info" data-region="bar"><span>${num(count)} รายการ</span><b>${unknown ? 'ไม่ทราบราคาบางรายการ' : money(v.total)}</b></div>
      <button class="btn primary" type="submit" form="order-form">บันทึกออเดอร์</button>
    </div>`,
    on: {
      'click:change-cust': async () => {
        if (d.items.length && !(await confirmSheet('เปลี่ยนร้านจะล้างรายการสินค้าเดิม ต้องการเปลี่ยนไหม?', 'เปลี่ยนร้าน'))) return;
        d.customerId = '';
        d.items = [];
        persist();
        ctx.rerender();
      },
      'click:pick-cust': async (el) => {
        const id = el.dataset.id;
        if (d.items.length && d.customerId && d.customerId !== id
          && !(await confirmSheet('เปลี่ยนร้านจะล้างรายการสินค้าเดิม ต้องการเปลี่ยนไหม?', 'เปลี่ยนร้าน'))) return;
        if (d.customerId !== id) d.items = [];
        d.customerId = id;
        persist();
        ctx.rerender();
      },
      'input:cust': (el) => {
        const q = el.value.trim().toLowerCase();
        const hits = q ? custList.filter((c) => (c.name + ' ' + (c.code || '') + ' ' + (c.phone || '')).toLowerCase().includes(q)).slice(0, 8) : [];
        region('cust-results', hits.map((c) => `<button type="button" class="pick-row" data-act="pick-cust" data-id="${esc(c.id)}"><b>${esc(c.name)}</b><small>${esc([c.code, c.phone].filter(Boolean).join(' · '))}</small></button>`).join('')
          || (q ? '<p class="hint">ไม่พบร้านนี้ — เลือกจากรายชื่อลูกค้า</p>' : ''));
      },
      'click:last-order': async () => {
        if (!lastOrder) return;
        if (d.items.length && !(await confirmSheet('แทนที่รายการสินค้าด้วยออเดอร์ล่าสุดของร้านนี้?', 'ใช้ออเดอร์ล่าสุด'))) return;
        d.items = lastOrder.items.map((i) => ({ ...i, price: i.price ?? null, src: 'ออเดอร์ล่าสุด' }));
        persist(); ctx.rerender();
      },
      'click:add-known': (el) => {
        const name = el.dataset.name;
        const cat = catalog().find((p) => p.name === name) || { id: name, name, code: '', unit: '' };
        addItem(d, cat);
        persist(); ctx.rerender();
      },
      'input:prod': (el) => {
        const q = el.value.trim().toLowerCase();
        const hits = q ? catalog().filter((p) => (p.name + ' ' + (p.code || '')).toLowerCase().includes(q)).slice(0, 12) : [];
        region('prod-results', hits.map((p) => `<button type="button" class="pick-row" data-act="add-prod" data-key="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc([p.code, p.unit].filter(Boolean).join(' · '))}</small></button>`).join(''));
      },
      'click:add-prod': (el) => {
        const cat = catalog().find((p) => p.id === el.dataset.key);
        if (!cat) return;
        addItem(d, cat);
        persist();
        region('items', itemsHtml());
        region('prod-results', '');
        bar();
        toast(`เพิ่ม ${cat.name} แล้ว`);
      },
      'click:qty': (el) => {
        const i = d.items[+el.dataset.i];
        if (!i) return;
        i.qty = Math.max(0, (Number(i.qty) || 0) + Number(el.dataset.d));
        persist();
        region('items', itemsHtml());
        bar();
      },
      'click:rm-item': (el) => {
        d.items.splice(+el.dataset.i, 1);
        persist();
        region('items', itemsHtml());
        bar();
      },
      'input:qty': (el) => { const i = d.items[+el.dataset.i]; if (i) i.qty = el.value; persist(); bar(); },
      'input:price': (el) => { const i = d.items[+el.dataset.i]; if (i) { i.price = el.value === '' ? null : el.value; i.src = 'แก้ไขเอง'; } persist(); bar(); },
      'input:unit': (el) => { const i = d.items[+el.dataset.i]; if (i) i.unit = el.value; persist(); },
      'click:vat': (el) => { d.vat = el.dataset.key; persist(); ctx.rerender(); },
      'click:pay': (el) => { d.payment = el.dataset.key; persist(); ctx.rerender(); },
      'submit:order': () => save(),
    },
    onMount: () => {
      // Plain fields (terms, date, discount, note) are read straight into the draft on input.
      const f = document.getElementById('order-form');
      if (!f) return;
      f.addEventListener('input', (e) => {
        const name = e.target.getAttribute('name');
        if (!['terms', 'date', 'note', 'discount'].includes(name)) return;
        d[name] = e.target.value;
        persist();
        if (name === 'discount') bar();
      });
    },
  };
}

function itemRow(i, n) {
  const known = i.price !== null && i.price !== undefined && i.price !== '';
  return `<div class="item">
    <div class="item-head"><div><b>${esc(i.name)}</b><small>${esc([i.code, i.src].filter(Boolean).join(' · '))}</small></div>
      <button type="button" class="icon-btn" data-act="rm-item" data-i="${n}" aria-label="ลบรายการ">${icon('x')}</button></div>
    <div class="item-row">
      <div class="stepper">
        <button type="button" class="btn small" data-act="qty" data-i="${n}" data-d="-1" aria-label="ลดจำนวน">−</button>
        <input name="qty-${n}" type="number" inputmode="decimal" min="0" step="any" value="${esc(i.qty)}" data-in="qty" data-i="${n}" aria-label="จำนวน">
        <button type="button" class="btn small" data-act="qty" data-i="${n}" data-d="1" aria-label="เพิ่มจำนวน">+</button>
      </div>
      <input class="unit" value="${esc(i.unit || '')}" placeholder="หน่วย" data-in="unit" data-i="${n}" aria-label="หน่วย">
      <input type="number" inputmode="decimal" min="0" step="any" value="${known ? esc(i.price) : ''}" placeholder="ราคา/หน่วย" data-in="price" data-i="${n}" aria-label="ราคา">
    </div>
    <small class="muted-s">รวม ${known ? money(i.qty * i.price) : 'ยังไม่มีราคา'}</small>
  </div>`;
}

// ---------- saved ----------
export function orderSavedPage(ctx) {
  const o = db.get('orders', ctx.id);
  if (!o) return { html: empty('ไม่พบรายการ') };
  const c = db.get('customers', o.customerId);
  const subtotal_ = orderTotal(o);
  return {
    html: `<div class="saved">
      <span class="saved-mark">${icon('circleCheck')}</span>
      <h1>บันทึกออเดอร์แล้ว</h1>
      <p class="hint-lg">บันทึกในเครื่องแล้ว ระบบจะซิงก์ให้เมื่อมีอินเทอร์เน็ต</p>
      <section class="card info">
        <div><span>เลขที่</span><p>${esc(o.no)}</p></div>
        <div><span>ร้าน</span><p>${esc(c?.name || '-')}</p></div>
        <div><span>จำนวนรายการ</span><p>${num((o.items || []).length)}</p></div>
        <div><span>ยอดรวม</span><p>${o.priceUnknown ? 'ไม่ทราบราคาบางรายการ' : money(subtotal_)}</p></div>
      </section>
      <div class="actions"><button class="btn primary" data-act="line">${icon('message')} เปิด LINE</button>
        <button class="btn" data-act="image">${icon('share')} ส่งออกรูป</button></div>
      <a class="btn wide" href="${path('orders')}">ปิด</a>
    </div>`,
    on: {
      'click:line': () => openLine(db.get('orders', o.id)),
      'click:image': () => imageSheet(db.get('orders', o.id)),
    },
  };
}

// ---------- order image (drawn from data, not a screenshot) ----------
export function drawOrderImage(o, c) {
  const rows = o.items || [];
  const W = 1080; const rowH = 62;
  const H = 420 + rows.length * rowH + 360;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const font = (s, w = 400) => `${w} ${s}px "Noto Sans Thai", "Sukhumvit Set", system-ui, sans-serif`;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1e3a5f'; g.fillRect(0, 0, W, 16);
  let y = 90;
  g.fillStyle = '#1e3a5f'; g.font = font(46, 700); g.fillText('ART CRM', 60, y);
  g.textAlign = 'right'; g.fillStyle = '#17202a'; g.font = font(40, 600); g.fillText('ใบสั่งซื้อ', W - 60, y); g.textAlign = 'left';
  y += 60;
  g.font = font(28); g.fillStyle = '#4b5563';
  g.fillText(`เลขที่ ${o.no}`, 60, y); g.fillText(`วันที่ ${thaiDate(o.date)}`, 620, y);
  y += 56;
  g.fillStyle = '#17202a'; g.font = font(32, 600); g.fillText(c?.name || '-', 60, y);
  y += 42; g.font = font(26); g.fillStyle = '#4b5563';
  g.fillText([c?.code, c?.phone, c?.province].filter(Boolean).join('  ·  ') || ' ', 60, y);
  y += 40; g.fillStyle = '#1e3a5f'; g.fillRect(60, y, W - 120, 3);
  y += 40;
  g.font = font(26, 600); g.fillStyle = '#17202a';
  g.fillText('สินค้า', 60, y); g.textAlign = 'right';
  g.fillText('จำนวน', 640, y); g.fillText('ราคา', 820, y); g.fillText('รวม', W - 60, y); g.textAlign = 'left';
  y += 18; g.fillStyle = '#e3e8ee'; g.fillRect(60, y, W - 120, 2);
  g.font = font(26);
  for (const i of rows) {
    y += rowH;
    const known = i.price !== null && i.price !== undefined;
    g.fillStyle = '#17202a';
    g.fillText(String(i.name).slice(0, 26), 60, y);
    g.textAlign = 'right';
    g.fillText(`${num(i.qty)} ${i.unit || ''}`, 640, y);
    g.fillText(known ? num(i.price) : '-', 820, y);
    g.fillText(known ? num(i.qty * i.price) : '-', W - 60, y);
    g.textAlign = 'left';
    y += 16; g.fillStyle = '#eef2f6'; g.fillRect(60, y, W - 120, 1);
  }
  y += 60;
  const sub = rows.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0) - (Number(o.discount) || 0);
  const v = vatBreakdown(sub, o.vat);
  g.font = font(28); g.fillStyle = '#4b5563';
  const line = (label, value, bold = false) => {
    g.font = font(bold ? 36 : 28, bold ? 700 : 400);
    g.fillStyle = bold ? '#1e3a5f' : '#4b5563';
    g.fillText(label, 560, y); g.textAlign = 'right'; g.fillText(value, W - 60, y); g.textAlign = 'left';
    y += bold ? 60 : 44;
  };
  if (Number(o.discount)) line('ส่วนลด', `-${money(o.discount)}`);
  if (o.vat && o.vat !== 'none') { line('ยอดก่อน VAT', money(v.base)); line('VAT 7%', money(v.vat)); }
  line('ยอดสุทธิ', o.priceUnknown ? 'ไม่ทราบราคาบางรายการ' : money(v.total), true);
  g.font = font(26); g.fillStyle = '#4b5563';
  for (const t of [o.terms && `เงื่อนไข: ${o.terms}`, o.payment && `ชำระเงิน: ${o.payment}`, o.note && `หมายเหตุ: ${o.note}`].filter(Boolean)) {
    g.fillText(t, 60, y); y += 40;
  }
  return cv;
}

function imageBlob(o) {
  const c = db.get('customers', o.customerId);
  return new Promise((resolve) => drawOrderImage(o, c).toBlob((b) => resolve(b), 'image/png'));
}

export function imageSheet(o) {
  if (!o) return;
  openSheet({
    title: 'ส่งออกรูปใบสั่งซื้อ',
    html: `<p class="hint">รูปสร้างจากข้อมูลออเดอร์โดยตรง ไม่ใช่การแคปหน้าจอ</p>
      <div class="actions">
        <button class="btn primary" data-act="share-img">${icon('share')} แชร์รูป</button>
        <button class="btn" data-act="save-img">${icon('download')} บันทึกรูป</button>
        <button class="btn" data-act="open-img">${icon('eye')} เปิดรูปเต็ม</button>
      </div>`,
    on: {
      'click:share-img': async () => {
        const blob = await imageBlob(o);
        const file = new File([blob], `${o.no}.png`, { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) {
          try { await navigator.share({ files: [file], title: o.no }); } catch { /* user dismissed the share sheet */ }
        } else toast('เครื่องนี้แชร์รูปไม่ได้ — กด "เปิดรูปเต็ม" แล้วบันทึกรูป');
      },
      'click:save-img': async () => {
        const blob = await imageBlob(o);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${o.no}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      },
      'click:open-img': async () => {
        const blob = await imageBlob(o);
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      },
    },
  });
}

// ---------- purchase history (ประวัติซื้อ) ----------
export function purchasesPage(ctx) {
  const st = ctx.state;
  st.sort ||= 'new';
  st.status ||= 'all';
  const customerId = ctx.params.get('customer') || '';
  const cust = customerId ? db.get('customers', customerId) : null;
  const rows = () => {
    const sku = (st.sku || '').trim().toLowerCase();
    let list = customerId ? ordersOf(customerId) : orders();
    if (st.from) list = list.filter((o) => o.date >= st.from);
    if (st.to) list = list.filter((o) => o.date <= st.to);
    if (st.status !== 'all') list = list.filter((o) => o.status === st.status);
    if (sku) list = list.filter((o) => (o.items || []).some((i) => `${i.code} ${i.name}`.toLowerCase().includes(sku)));
    list.sort(byDateDesc);
    if (st.sort === 'old') list.reverse();
    return list;
  };
  const render = () => {
    const list = rows();
    region('results', `<p class="count">${num(list.length)} รายการ · ยอด ${money(list.reduce((s, o) => s + (isSale(o) ? orderTotal(o) : 0), 0))}</p>
      ${list.length ? `<ul class="cards">${list.slice(0, 200).map((o) => `<li class="card-row"><a class="card-link" href="${path('order', o.id)}">
        <div class="card-top"><b>${esc(billOrOrder(o))}</b>${statusBadge(o)}</div>
        <small>${thaiDate(o.date)} · ${esc(customerName(o.customerId))}</small>
        <div class="card-meta"><b>${o.priceUnknown ? 'ไม่ทราบราคา' : money(orderTotal(o))}</b></div></a>
        <div class="card-actions">${o.customerId ? `<a class="btn small" href="${path('order-edit', 'new', `?customer=${encodeURIComponent(o.customerId)}&repeat=${encodeURIComponent(o.id)}`)}">${icon('refresh')} สั่งซ้ำ</a>` : ''}</div></li>`).join('')}</ul>` : empty('ไม่พบประวัติตามเงื่อนไข')}`);
  };
  return {
    html: `
    ${cust ? `<div class="head"><a href="${path('customer', cust.id, '?tab=purchases')}" class="back">${icon('chevLeft')} ${esc(cust.name)}</a></div>` : ''}
    <h1>ประวัติซื้อ</h1>
    <div class="row2"><label class="fld"><span>วันที่เริ่ม</span><input type="date" data-in="from" value="${esc(st.from || '')}"></label>
      <label class="fld"><span>วันที่สิ้นสุด</span><input type="date" data-in="to" value="${esc(st.to || '')}"></label></div>
    <div class="row2"><label class="fld"><span>สถานะ</span><select data-ch="status">${[['all', 'ทั้งหมด'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])].map(([k, l]) => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>SKU / สินค้า</span><input data-in="sku" value="${esc(st.sku || '')}" placeholder="ค้นหา"></label></div>
    ${chips([['new', 'เรียงล่าสุด'], ['old', 'เรียงเก่าสุด']], st.sort, 'sort')}
    <div data-region="results"></div>`,
    on: {
      'input:from': (el) => { st.from = el.value; render(); },
      'input:to': (el) => { st.to = el.value; render(); },
      'input:sku': (el) => { st.sku = el.value; render(); },
      'change:status': (el) => { st.status = el.value; render(); },
      'click:sort': (el) => { st.sort = el.dataset.key; ctx.rerender(); },
    },
    onMount: render,
  };
}

// ---------- billing summary (แจ้งยอดซื้อ) ----------
export function notifyPage(ctx) {
  const st = ctx.state;
  const customerId = ctx.params.get('customer') || st.customerId || '';
  const cust = customerId ? db.get('customers', customerId) : null;
  if (st.customerId !== customerId) { Object.assign(st, { customerId, from: today().slice(0, 7) + '-01', to: today(), selected: null, edited: false, msg: '' }); }
  const t = today();
  st.from ||= t.slice(0, 7) + '-01';
  st.to ||= t;
  const bills = cust ? ordersOf(cust.id).filter((o) => isSale(o) && o.date >= st.from && o.date <= st.to).sort((a, b) => (a.date || '').localeCompare(b.date || '')) : [];
  st.selected ||= bills.map((b) => b.id);
  const chosen = bills.filter((b) => st.selected.includes(b.id));
  const total = chosen.reduce((s, b) => s + orderTotal(b), 0);
  const auto = () => [
    `แจ้งยอดซื้อ ${cust?.name || ''}${cust?.code ? ` (${cust.code})` : ''}`,
    `ช่วงวันที่ ${thaiDate(st.from)} - ${thaiDate(st.to)}`,
    ...chosen.map((b) => `${b.no} · ${thaiDate(b.date)} · ${money(orderTotal(b))}`),
    `รวม ${chosen.length} บิล ยอด ${money(total)}`,
  ].join('\n');
  if (!st.edited) st.msg = auto();

  return {
    html: `
    <div class="head"><a href="${cust ? path('customer', cust.id) : path('customers')}" class="back">${icon('chevLeft')} ${esc(cust?.name || 'กลับ')}</a></div>
    <h1>แจ้งยอดซื้อ</h1>
    ${cust ? '' : `<p class="hint">เลือกร้านจากหน้าลูกค้า</p>${empty('ยังไม่ได้เลือกร้าน')}`}
    ${cust ? `
    <div class="row2"><label class="fld"><span>จากวันที่</span><input type="date" data-in="from" value="${esc(st.from)}"></label>
      <label class="fld"><span>ถึงวันที่</span><input type="date" data-in="to" value="${esc(st.to)}"></label></div>
    <section class="card"><h2>บิลในช่วงนี้ <button class="btn small ghost" data-act="all">เลือกทั้งหมด</button></h2>
      ${bills.length ? `<ul class="plain checks-list">${bills.map((b) => `<li><label class="check"><input type="checkbox" data-ch="pick" data-id="${esc(b.id)}" ${st.selected.includes(b.id) ? 'checked' : ''}>
        <span>${esc(b.no)} · ${thaiDate(b.date)}</span><b>${money(orderTotal(b))}</b></label></li>`).join('')}</ul>` : empty('ไม่มียอดซื้อในช่วงนี้')}
      <p class="total">ยอดรวมที่เลือก <b data-region="ntotal">${money(total)}</b></p></section>
    <form class="form" data-form="notify"><label class="fld"><span>ข้อความแจ้งยอด (แก้ไขได้)</span><textarea name="msg" rows="9" data-in="msg">${esc(st.msg)}</textarea></label></form>
    <div class="actions">
      <button class="btn" data-act="copy">${icon('copy')} คัดลอก</button>
      <button class="btn" data-act="share">${icon('share')} แชร์</button>
      <button class="btn primary" data-act="pdf">${icon('print')} PDF</button>
    </div>` : ''}`,
    on: {
      'input:from': (el) => { st.from = el.value; st.selected = null; st.edited = false; ctx.rerender(); },
      'input:to': (el) => { st.to = el.value; st.selected = null; st.edited = false; ctx.rerender(); },
      'change:pick': (el) => {
        st.selected = [...document.querySelectorAll('[data-ch=pick]')].filter((i) => i.checked).map((i) => i.dataset.id);
        st.edited = false;
        ctx.rerender();
      },
      'input:msg': (el) => { st.msg = el.value; st.edited = true; },
      'click:all': () => { st.selected = bills.map((b) => b.id); st.edited = false; ctx.rerender(); },
      'click:copy': () => { copyText(st.msg); toast('คัดลอกข้อความแล้ว'); },
      'click:share': () => {
        if (navigator.share) navigator.share({ text: st.msg, title: 'แจ้งยอดซื้อ' }).catch(() => {});
        else { copyText(st.msg); toast('เครื่องนี้แชร์ไม่ได้ — คัดลอกข้อความแล้ว'); }
      },
      'click:pdf': () => printHtml(`<h2>แจ้งยอดซื้อ</h2><pre>${esc(st.msg)}</pre>`),
    },
  };
}

export function printHtml(body) {
  const w = window.open('', '_blank');
  if (!w) { toast('เปิดหน้าพิมพ์ไม่ได้ — อนุญาตป๊อปอัปแล้วลองใหม่'); return; }
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ART CRM</title>
    <style>body{font-family:"Noto Sans Thai",system-ui,sans-serif;padding:24px;color:#17202a}pre{white-space:pre-wrap;font:inherit;font-size:15px}</style>
    </head><body>${body}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

// ---------- proposals to a lead (เสนอสินค้า) ----------
export function openProposal(leadId) {
  const picked = new Set();
  const list = (q) => {
    const s = (q || '').trim().toLowerCase();
    return catalog().filter((p) => !s || (p.name + ' ' + p.code).toLowerCase().includes(s)).slice(0, 40);
  };
  const render = (q) => {
    const el = document.querySelector('#sheet-root [data-region=prodlist]');
    if (el) el.innerHTML = list(q).map((p) => `<label class="check"><input type="checkbox" data-ch="pp" value="${esc(p.id)}" ${picked.has(p.id) ? 'checked' : ''}> ${esc(p.name)} <small>${esc(p.code)}</small></label>`).join('') || empty('ไม่พบสินค้า');
  };
  openSheet({
    title: 'เสนอสินค้า',
    html: `<form class="form" data-form="propose">
      <input class="search" type="search" placeholder="ค้นหาสินค้า" data-in="pq" autocomplete="off">
      <fieldset class="checks" data-region="prodlist"></fieldset>
      ${area('note', 'บันทึกการเสนอ', '', 2)}
      <button class="btn primary wide">บันทึกการเสนอสินค้า</button></form>`,
    on: {
      'input:pq': (el) => render(el.value),
      'change:pp': (el) => { el.checked ? picked.add(el.value) : picked.delete(el.value); },
      'submit:propose': (form) => {
        const names = catalog().filter((p) => picked.has(p.id)).map((p) => p.name);
        if (!names.length) { toast('เลือกสินค้าอย่างน้อย 1 รายการ'); return; }
        db.save('activities', { leadId, kind: 'proposal', text: `${names.join(', ')}${form.note.value.trim() ? ` — ${form.note.value.trim()}` : ''}`, at: Date.now(), by: who() }, { action: 'เสนอสินค้า' });
        db.save('leads', { id: leadId, status: 'proposed', lastResult: `เสนอ ${names.length} รายการ` });
        closeSheet();
        toast('บันทึกการเสนอสินค้าแล้ว');
      },
    },
  });
  render('');
}
