import * as db from './db.js';
import { sync, scheduleSync, startAutoSync, onSync, syncState, getConfig, pendingCount } from './sync.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '฿' + (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const today = () => localDate(new Date());
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thaiDate = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
const PAGE = 100;

const STATUS = {
  pending: { label: 'รอชำระ', cls: 'warn' },
  paid: { label: 'ชำระแล้ว', cls: 'ok' },
  shipped: { label: 'ส่งแล้ว', cls: 'info' },
  cancelled: { label: 'ยกเลิก', cls: 'muted' },
};

// ---------- derived data ----------
const orderTotal = (o) => Math.max(0, (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0) - (Number(o.discount) || 0));
const activeOrders = () => db.list('orders').filter((o) => o.status !== 'cancelled');

function customerStats() {
  const stats = new Map();
  for (const o of activeOrders()) {
    const s = stats.get(o.customerId) || { total: 0, count: 0, last: '', unpaid: 0 };
    const t = orderTotal(o);
    s.total += t; s.count += 1;
    if (o.date > s.last) s.last = o.date;
    if (o.status === 'pending') s.unpaid += t;
    stats.set(o.customerId, s);
  }
  return stats;
}

function nextOrderNo() {
  const prefix = 'SO' + today().replace(/-/g, '').slice(2);
  let max = 0;
  for (const o of db.list('orders')) {
    if (o.no?.startsWith(prefix)) max = Math.max(max, Number(o.no.slice(prefix.length + 1)) || 0);
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

const matches = (q, ...fields) => !q || fields.some((f) => String(f ?? '').toLowerCase().includes(q));

// ---------- router ----------
const routes = {
  '': dashboard,
  customers,
  customer: customerDetail,
  'customer-edit': customerEdit,
  orders,
  order: orderDetail,
  'order-edit': orderEdit,
  settings,
};
let viewState = {};
let viewCtrl = new AbortController(); // removes listeners bound to #main when the view changes

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = path.split('/');
  return { name: name || '', id, params: new URLSearchParams(query) };
}

function render() {
  const t0 = performance.now();
  const r = parseHash();
  const view = routes[r.name] || dashboard;
  viewCtrl.abort();
  viewCtrl = new AbortController();
  main.innerHTML = view(r);
  main.querySelector('[data-init]') && bindView(r);
  for (const a of document.querySelectorAll('.tabbar a')) {
    const tab = a.dataset.tab;
    a.classList.toggle('active', tab === r.name || (tab === 'customers' && r.name.startsWith('customer')) || (tab === 'orders' && r.name.startsWith('order')));
  }
  $('#perf').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
}

const go = (hash) => { location.hash = hash; };
window.addEventListener('hashchange', () => { viewState = {}; render(); window.scrollTo(0, 0); });

// ---------- views ----------
function dashboard() {
  const orders = activeOrders();
  const t = today();
  const month = t.slice(0, 7);
  const lastMonthDate = new Date(); lastMonthDate.setDate(1); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = localDate(lastMonthDate).slice(0, 7);
  let todaySum = 0, monthSum = 0, lastMonthSum = 0, monthCount = 0, unpaid = 0;
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push({ date: localDate(d), sum: 0 }); }
  const dayIdx = new Map(days.map((d, i) => [d.date, i]));
  const byCustomer = new Map();
  for (const o of orders) {
    const v = orderTotal(o);
    if (o.date === t) todaySum += v;
    if (o.date?.startsWith(month)) {
      monthSum += v; monthCount += 1;
      byCustomer.set(o.customerId, (byCustomer.get(o.customerId) || 0) + v);
    }
    if (o.date?.startsWith(lastMonth)) lastMonthSum += v;
    if (o.status === 'pending') unpaid += v;
    if (dayIdx.has(o.date)) days[dayIdx.get(o.date)].sum += v;
  }
  const growth = lastMonthSum ? ((monthSum - lastMonthSum) / lastMonthSum) * 100 : null;
  const max = Math.max(1, ...days.map((d) => d.sum));
  const top = [...byCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const recent = db.list('orders').sort((a, b) => (b.date + b.no).localeCompare(a.date + a.no)).slice(0, 5);

  return `
  <h1>ภาพรวมยอดขาย</h1>
  <div class="kpis">
    <div class="kpi"><span>วันนี้</span><b>${money(todaySum)}</b></div>
    <div class="kpi"><span>เดือนนี้ (${monthCount} ออเดอร์)</span><b>${money(monthSum)}</b>
      ${growth === null ? '' : `<small class="${growth >= 0 ? 'up' : 'down'}">${growth >= 0 ? '▲' : '▼'} ${Math.abs(growth).toFixed(0)}% จากเดือนก่อน</small>`}</div>
    <div class="kpi"><span>ค้างชำระ</span><b class="warn-text">${money(unpaid)}</b></div>
    <div class="kpi"><span>ลูกค้าทั้งหมด</span><b>${db.list('customers').length.toLocaleString('th-TH')}</b></div>
  </div>
  <section class="card">
    <h2>ยอดขาย 7 วันล่าสุด</h2>
    <div class="bars">${days.map((d) => `
      <div class="bar" title="${esc(thaiDate(d.date))}: ${money(d.sum)}">
        <i style="height:${(d.sum / max) * 100}%"></i>
        <em>${new Date(d.date + 'T00:00:00').toLocaleDateString('th-TH', { weekday: 'short' })}</em>
      </div>`).join('')}
    </div>
  </section>
  <section class="card">
    <h2>ลูกค้ายอดซื้อสูงสุดเดือนนี้</h2>
    ${top.length ? `<ol class="rank">${top.map(([id, v]) => `<li><a href="#/customer/${id}">${esc(db.get('customers', id)?.name || '(ลบแล้ว)')}</a><b>${money(v)}</b></li>`).join('')}</ol>` : '<p class="empty">ยังไม่มียอดขายเดือนนี้</p>'}
  </section>
  <section class="card">
    <h2>ออเดอร์ล่าสุด <a class="more" href="#/orders">ทั้งหมด</a></h2>
    ${recent.length ? orderRows(recent) : '<p class="empty">ยังไม่มีออเดอร์</p>'}
  </section>
  <a class="fab" href="#/order-edit/new" aria-label="สร้างออเดอร์">＋</a>`;
}

function orderRows(list) {
  return `<ul class="list">${list.map((o) => {
    const c = db.get('customers', o.customerId);
    const st = STATUS[o.status] || STATUS.pending;
    return `<li><a href="#/order/${o.id}">
      <div><b>${esc(c?.name || '(ไม่ระบุลูกค้า)')}</b><small>${esc(o.no)} · ${thaiDate(o.date)}</small></div>
      <div class="right"><b>${money(orderTotal(o))}</b><span class="badge ${st.cls}">${st.label}</span></div>
    </a></li>`;
  }).join('')}</ul>`;
}

function customers() {
  return `
  <h1>ลูกค้า</h1>
  <input class="search" type="search" placeholder="ค้นหา ชื่อ / เบอร์ / บริษัท / แท็ก" data-init="customers" value="${esc(viewState.q || '')}" autocomplete="off">
  <div id="results"></div>
  <a class="fab" href="#/customer-edit/new" aria-label="เพิ่มลูกค้า">＋</a>`;
}

function renderCustomerResults() {
  const t0 = performance.now();
  const q = (viewState.q || '').trim().toLowerCase();
  const stats = customerStats();
  const list = db.list('customers')
    .filter((c) => matches(q, c.name, c.phone, c.company, c.tags, c.line, c.email))
    .sort((a, b) => (stats.get(b.id)?.last || '').localeCompare(stats.get(a.id)?.last || '') || a.name.localeCompare(b.name, 'th'));
  const limit = viewState.limit || PAGE;
  $('#results').innerHTML = `<p class="count">${list.length.toLocaleString('th-TH')} รายการ</p>` + (list.length ? `
    <ul class="list">${list.slice(0, limit).map((c) => {
      const s = stats.get(c.id);
      return `<li><a href="#/customer/${c.id}">
        <div><b>${esc(c.name)}</b><small>${esc([c.company, c.phone].filter(Boolean).join(' · '))}</small></div>
        <div class="right"><b>${money(s?.total)}</b><small>${s ? `${s.count} ออเดอร์` : 'ยังไม่มีออเดอร์'}</small></div>
      </a></li>`;
    }).join('')}</ul>
    ${list.length > limit ? '<button class="btn ghost wide" data-more>แสดงเพิ่ม</button>' : ''}` : '<p class="empty">ไม่พบลูกค้า</p>');
  $('#perf').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
}

function customerDetail({ id }) {
  const c = db.get('customers', id);
  if (!c) return '<p class="empty">ไม่พบลูกค้า</p>';
  const s = customerStats().get(id) || { total: 0, count: 0, last: '', unpaid: 0 };
  const orders = db.list('orders').filter((o) => o.customerId === id).sort((a, b) => (b.date + b.no).localeCompare(a.date + a.no));
  const phone = (c.phone || '').replace(/[^\d+]/g, '');
  return `
  <div class="head"><a href="#/customers" class="back">‹ ลูกค้า</a><a href="#/customer-edit/${id}" class="btn small">แก้ไข</a></div>
  <h1>${esc(c.name)}</h1>
  ${c.company ? `<p class="sub">${esc(c.company)}</p>` : ''}
  <div class="actions">
    ${phone ? `<a class="btn" href="tel:${esc(phone)}">📞 โทร</a>` : ''}
    ${c.line ? `<a class="btn" href="https://line.me/ti/p/~${encodeURIComponent(c.line)}" target="_blank" rel="noopener">💬 LINE</a>` : ''}
    <a class="btn primary" href="#/order-edit/new?customer=${id}">＋ ออเดอร์</a>
  </div>
  <div class="kpis">
    <div class="kpi"><span>ยอดซื้อรวม</span><b>${money(s.total)}</b></div>
    <div class="kpi"><span>จำนวนออเดอร์</span><b>${s.count}</b></div>
    <div class="kpi"><span>ซื้อล่าสุด</span><b>${s.last ? thaiDate(s.last) : '-'}</b></div>
    <div class="kpi"><span>ค้างชำระ</span><b class="warn-text">${money(s.unpaid)}</b></div>
  </div>
  <section class="card info">
    ${[['เบอร์โทร', c.phone], ['LINE', c.line], ['อีเมล', c.email], ['ที่อยู่', c.address], ['แท็ก', c.tags], ['บันทึก', c.note]]
      .filter(([, v]) => v).map(([k, v]) => `<div><span>${k}</span><p>${esc(v)}</p></div>`).join('') || '<p class="empty">ไม่มีข้อมูลเพิ่มเติม</p>'}
  </section>
  <section class="card"><h2>ประวัติการสั่งซื้อ</h2>${orders.length ? orderRows(orders) : '<p class="empty">ยังไม่มีออเดอร์</p>'}</section>`;
}

function field(name, label, value, attrs = '') {
  return `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
}

function customerEdit({ id }) {
  const c = id === 'new' ? {} : db.get('customers', id);
  if (!c) return '<p class="empty">ไม่พบลูกค้า</p>';
  return `
  <div class="head"><a href="${id === 'new' ? '#/customers' : `#/customer/${id}`}" class="back">‹ ยกเลิก</a></div>
  <h1>${id === 'new' ? 'เพิ่มลูกค้า' : 'แก้ไขลูกค้า'}</h1>
  <form class="form" data-init="customer-form">
    ${field('name', 'ชื่อลูกค้า *', c.name, 'required autofocus')}
    ${field('phone', 'เบอร์โทร', c.phone, 'type="tel" inputmode="tel"')}
    ${field('company', 'บริษัท / ร้าน', c.company)}
    ${field('line', 'LINE ID', c.line)}
    ${field('email', 'อีเมล', c.email, 'type="email"')}
    <label>ที่อยู่<textarea name="address" rows="2">${esc(c.address)}</textarea></label>
    ${field('tags', 'แท็ก (เช่น VIP, ขายส่ง)', c.tags)}
    <label>บันทึก<textarea name="note" rows="3">${esc(c.note)}</textarea></label>
    <button class="btn primary wide">บันทึก</button>
    ${id !== 'new' ? '<button type="button" class="btn danger wide" data-delete>ลบลูกค้า</button>' : ''}
  </form>`;
}

function orders() {
  const f = viewState.status || 'all';
  return `
  <h1>ออเดอร์</h1>
  <input class="search" type="search" placeholder="ค้นหา เลขที่ / ลูกค้า / สินค้า" data-init="orders" value="${esc(viewState.q || '')}" autocomplete="off">
  <div class="chips">${[['all', 'ทั้งหมด'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])]
    .map(([k, l]) => `<button class="chip ${f === k ? 'active' : ''}" data-status="${k}">${l}</button>`).join('')}</div>
  <div id="results"></div>
  <a class="fab" href="#/order-edit/new" aria-label="สร้างออเดอร์">＋</a>`;
}

function renderOrderResults() {
  const t0 = performance.now();
  const q = (viewState.q || '').trim().toLowerCase();
  const f = viewState.status || 'all';
  const list = db.list('orders')
    .filter((o) => (f === 'all' || o.status === f) &&
      matches(q, o.no, db.get('customers', o.customerId)?.name, ...(o.items || []).map((i) => i.name)))
    .sort((a, b) => (b.date + b.no).localeCompare(a.date + a.no));
  const sum = list.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + orderTotal(o), 0);
  const limit = viewState.limit || PAGE;
  $('#results').innerHTML = `<p class="count">${list.length.toLocaleString('th-TH')} รายการ · รวม ${money(sum)}</p>` +
    (list.length ? orderRows(list.slice(0, limit)) + (list.length > limit ? '<button class="btn ghost wide" data-more>แสดงเพิ่ม</button>' : '') : '<p class="empty">ไม่พบออเดอร์</p>');
  $('#perf').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
}

function orderDetail({ id }) {
  const o = db.get('orders', id);
  if (!o) return '<p class="empty">ไม่พบออเดอร์</p>';
  const c = db.get('customers', o.customerId);
  return `
  <div class="head"><a href="#/orders" class="back">‹ ออเดอร์</a><a href="#/order-edit/${id}" class="btn small">แก้ไข</a></div>
  <h1>${esc(o.no)}</h1>
  <p class="sub">${thaiDate(o.date)} · ${c ? `<a href="#/customer/${c.id}">${esc(c.name)}</a>` : '(ไม่ระบุลูกค้า)'}</p>
  <div class="chips" data-init="order-status">${Object.entries(STATUS)
    .map(([k, v]) => `<button class="chip ${o.status === k ? 'active' : ''}" data-set-status="${k}">${v.label}</button>`).join('')}</div>
  <section class="card">
    <table class="items"><thead><tr><th>สินค้า</th><th>จำนวน</th><th>ราคา</th><th>รวม</th></tr></thead><tbody>
    ${(o.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td>${Number(i.qty).toLocaleString('th-TH')}</td><td>${money(i.price)}</td><td>${money(i.qty * i.price)}</td></tr>`).join('')}
    </tbody>
    <tfoot>${Number(o.discount) ? `<tr><td colspan="3">ส่วนลด</td><td>-${money(o.discount)}</td></tr>` : ''}
    <tr><th colspan="3">ยอดสุทธิ</th><th>${money(orderTotal(o))}</th></tr></tfoot></table>
  </section>
  ${o.note ? `<section class="card info"><div><span>บันทึก</span><p>${esc(o.note)}</p></div></section>` : ''}`;
}

function orderEdit({ id, params }) {
  const o = id === 'new'
    ? { no: nextOrderNo(), date: today(), status: 'pending', customerId: params.get('customer') || '', items: [{ name: '', qty: 1, price: '' }], discount: '' }
    : db.get('orders', id);
  if (!o) return '<p class="empty">ไม่พบออเดอร์</p>';
  const custs = db.list('customers').sort((a, b) => a.name.localeCompare(b.name, 'th'));
  const cur = db.get('customers', o.customerId);
  // Remember product names + last price for fast entry.
  const products = new Map();
  for (const ord of db.list('orders')) for (const i of ord.items || []) if (i.name) products.set(i.name, i.price);
  viewState.products = products;
  return `
  <div class="head"><a href="${id === 'new' ? '#/orders' : `#/order/${id}`}" class="back">‹ ยกเลิก</a></div>
  <h1>${id === 'new' ? 'สร้างออเดอร์' : 'แก้ไขออเดอร์'}</h1>
  <form class="form" data-init="order-form">
    <div class="row">${field('no', 'เลขที่', o.no, 'required')}${field('date', 'วันที่', o.date, 'type="date" required')}</div>
    <label>ลูกค้า *<input name="customer" list="custlist" value="${esc(cur ? cur.name : '')}" placeholder="พิมพ์ชื่อลูกค้า" required autocomplete="off"></label>
    <datalist id="custlist">${custs.map((c) => `<option value="${esc(c.name)}">${esc(c.phone || '')}</option>`).join('')}</datalist>
    <datalist id="prodlist">${[...products.keys()].map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    <div class="items-edit" id="items">${(o.items || []).map(itemRow).join('')}</div>
    <button type="button" class="btn ghost wide" data-add-item>＋ เพิ่มรายการสินค้า</button>
    <div class="row">${field('discount', 'ส่วนลด (บาท)', o.discount, 'type="number" inputmode="decimal" min="0" step="any"')}
      <label>สถานะ<select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label></div>
    <label>บันทึก<textarea name="note" rows="2">${esc(o.note)}</textarea></label>
    <p class="total">ยอดสุทธิ <b id="total">${money(orderTotal(o))}</b></p>
    <button class="btn primary wide">บันทึกออเดอร์</button>
    ${id !== 'new' ? '<button type="button" class="btn danger wide" data-delete>ลบออเดอร์</button>' : ''}
  </form>`;
}

function itemRow(i = { name: '', qty: 1, price: '' }) {
  return `<div class="item">
    <input name="iname" list="prodlist" placeholder="ชื่อสินค้า" value="${esc(i.name)}" autocomplete="off">
    <input name="iqty" type="number" inputmode="decimal" min="0" step="any" placeholder="จำนวน" value="${esc(i.qty)}">
    <input name="iprice" type="number" inputmode="decimal" min="0" step="any" placeholder="ราคา/หน่วย" value="${esc(i.price)}">
    <button type="button" class="x" data-remove-item aria-label="ลบรายการ">✕</button>
  </div>`;
}

function settings() {
  const st = syncState();
  return `
  <h1>ตั้งค่า & สำรองข้อมูล</h1>
  <section class="card">
    <h2>ซิงค์ข้อมูลกับเซิร์ฟเวอร์</h2>
    <p class="hint">ข้อมูลทั้งหมดเก็บในเครื่องก่อน (ใช้งานออฟไลน์ได้) แล้วซิงค์อัตโนมัติเมื่อมีอินเทอร์เน็ต ทุกเครื่องที่ใช้เซิร์ฟเวอร์และรหัสเดียวกันจะเห็นข้อมูลเดียวกัน</p>
    <form class="form" data-init="settings-form">
      ${field('url', 'ที่อยู่เซิร์ฟเวอร์', '', 'type="url" placeholder="https://your-server.example.com" inputmode="url"')}
      ${field('token', 'รหัสซิงค์ (SYNC_TOKEN)', '', 'type="password" autocomplete="off"')}
      <button class="btn primary wide">บันทึก & ซิงค์ตอนนี้</button>
    </form>
    <p class="sync-status" id="sync-detail">${syncText(st)}</p>
  </section>
  <section class="card">
    <h2>สำรอง / กู้คืนข้อมูล</h2>
    <p class="hint">ดาวน์โหลดไฟล์สำรอง (.json) เก็บไว้ใน Google Drive / LINE Keep หรือเครื่องอื่น และนำเข้าเพื่อกู้คืนได้ทุกเมื่อ ข้อมูลเดิมจะไม่ถูกลบ (ใช้ข้อมูลที่ใหม่กว่า)</p>
    <button class="btn wide" data-export>⬇ ดาวน์โหลดไฟล์สำรอง</button>
    <label class="btn wide file">⬆ นำเข้าไฟล์สำรอง<input type="file" accept="application/json,.json" data-import hidden></label>
    <button class="btn ghost wide" data-server-backup>สั่งสำรองข้อมูลบนเซิร์ฟเวอร์</button>
  </section>
  <section class="card">
    <h2>ข้อมูลในเครื่อง</h2>
    <p>ลูกค้า ${db.list('customers').length.toLocaleString('th-TH')} · ออเดอร์ ${db.list('orders').length.toLocaleString('th-TH')} · รอซิงค์ ${pendingCount()}</p>
    <button class="btn ghost wide" data-demo>สร้างข้อมูลตัวอย่าง (ทดสอบความเร็ว)</button>
  </section>`;
}

function syncText(st) {
  const last = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('th-TH') : 'ยังไม่เคย';
  return {
    off: 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ — ข้อมูลเก็บในเครื่องนี้เท่านั้น',
    offline: `ออฟไลน์ — จะซิงค์เมื่อมีอินเทอร์เน็ต (ซิงค์ล่าสุด ${last})`,
    syncing: 'กำลังซิงค์…',
    ok: `ซิงค์สำเร็จ ${last}`,
    error: `ซิงค์ไม่สำเร็จ: ${esc(st.error)} (ซิงค์ล่าสุด ${last})`,
    idle: `ซิงค์ล่าสุด ${last}`,
  }[st.status] || '';
}

// ---------- event binding ----------
function bindView(r) {
  const init = main.querySelector('[data-init]').dataset.init;
  if (init === 'customers' || init === 'orders') {
    const renderResults = init === 'customers' ? renderCustomerResults : renderOrderResults;
    const input = main.querySelector('.search');
    input.addEventListener('input', () => { viewState.q = input.value; viewState.limit = PAGE; renderResults(); });
    main.addEventListener('click', (e) => {
      if (e.target.matches('[data-more]')) { viewState.limit = (viewState.limit || PAGE) + PAGE * 2; renderResults(); }
      const st = e.target.closest('[data-status]');
      if (st) {
        viewState.status = st.dataset.status;
        for (const c of main.querySelectorAll('[data-status]')) c.classList.toggle('active', c === st);
        renderResults();
      }
    }, { signal: viewCtrl.signal });
    renderResults();
  }

  if (init === 'customer-form') {
    const form = main.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      for (const k in d) d[k] = d[k].trim();
      const rec = db.save('customers', { ...(r.id !== 'new' && { id: r.id }), ...d });
      toast('บันทึกลูกค้าแล้ว');
      go(`#/customer/${rec.id}`);
    });
    form.querySelector('[data-delete]')?.addEventListener('click', () => {
      if (!confirm('ลบลูกค้ารายนี้? (ออเดอร์เดิมยังอยู่)')) return;
      db.remove('customers', r.id);
      toast('ลบลูกค้าแล้ว');
      go('#/customers');
    });
  }

  if (init === 'order-status') {
    main.addEventListener('click', (e) => {
      const b = e.target.closest('[data-set-status]');
      if (!b) return;
      db.save('orders', { id: r.id, status: b.dataset.setStatus });
      toast('อัปเดตสถานะแล้ว');
    }, { signal: viewCtrl.signal });
  }

  if (init === 'order-form') bindOrderForm(r);

  if (init === 'settings-form') {
    const form = main.querySelector('form');
    getConfig().then(({ url, token }) => { form.url.value = url || location.origin; form.token.value = token; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await db.setMeta('serverUrl', form.url.value.trim());
      await db.setMeta('token', form.token.value.trim());
      const ok = await sync();
      toast(ok ? 'ซิงค์สำเร็จ' : 'ซิงค์ไม่สำเร็จ');
    });
    main.addEventListener('click', onSettingsClick, { signal: viewCtrl.signal });
    main.querySelector('[data-import]').addEventListener('change', onImport);
  }
}

function bindOrderForm(r) {
  const form = main.querySelector('form');
  const items = $('#items', form);
  const readItems = () => [...items.querySelectorAll('.item')].map((el) => ({
    name: el.querySelector('[name=iname]').value.trim(),
    qty: Number(el.querySelector('[name=iqty]').value) || 0,
    price: Number(el.querySelector('[name=iprice]').value) || 0,
  })).filter((i) => i.name);
  const updateTotal = () => {
    $('#total').textContent = money(orderTotal({ items: readItems(), discount: form.discount.value }));
  };
  form.addEventListener('input', (e) => {
    // Auto-fill last used price when a known product is picked.
    if (e.target.name === 'iname') {
      const price = e.target.closest('.item').querySelector('[name=iprice]');
      if (!price.value && viewState.products?.has(e.target.value)) price.value = viewState.products.get(e.target.value);
    }
    updateTotal();
  });
  form.addEventListener('click', (e) => {
    if (e.target.matches('[data-add-item]')) {
      items.insertAdjacentHTML('beforeend', itemRow());
      items.lastElementChild.querySelector('input').focus();
    }
    if (e.target.matches('[data-remove-item]')) {
      e.target.closest('.item').remove();
      if (!items.children.length) items.insertAdjacentHTML('beforeend', itemRow());
      updateTotal();
    }
  });
  form.querySelector('[data-delete]')?.addEventListener('click', () => {
    if (!confirm('ลบออเดอร์นี้?')) return;
    db.remove('orders', r.id);
    toast('ลบออเดอร์แล้ว');
    go('#/orders');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.customer.value.trim();
    let cust = db.list('customers').find((c) => c.name === name);
    if (!cust) {
      if (!confirm(`ยังไม่มีลูกค้า "${name}" — เพิ่มเป็นลูกค้าใหม่?`)) return;
      cust = db.save('customers', { name });
    }
    const list = readItems();
    if (!list.length) { toast('กรุณาใส่สินค้าอย่างน้อย 1 รายการ'); return; }
    const rec = db.save('orders', {
      ...(r.id !== 'new' && { id: r.id }),
      no: form.no.value.trim(),
      date: form.date.value,
      customerId: cust.id,
      items: list,
      discount: Number(form.discount.value) || 0,
      status: form.status.value,
      note: form.note.value.trim(),
    });
    toast('บันทึกออเดอร์แล้ว');
    go(`#/order/${rec.id}`);
  });
}

async function onSettingsClick(e) {
  if (e.target.matches('[data-export]')) {
    const blob = new Blob([JSON.stringify(db.exportAll())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `havancrm-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    await db.setMeta('lastExportAt', Date.now());
  }
  if (e.target.matches('[data-server-backup]')) {
    const { url, token } = await getConfig();
    if (!url) return toast('ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์');
    try {
      await sync();
      const res = await fetch(url.replace(/\/+$/, '') + '/api/backup', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
      toast(res.ok ? 'สำรองข้อมูลบนเซิร์ฟเวอร์แล้ว' : 'สำรองไม่สำเร็จ');
    } catch { toast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); }
  }
  if (e.target.matches('[data-demo]')) {
    if (!confirm('เพิ่มลูกค้าตัวอย่าง 500 ราย และออเดอร์ 3,000 รายการ?')) return;
    const t0 = performance.now();
    await seedDemo();
    toast(`สร้างข้อมูลตัวอย่างแล้ว (${(performance.now() - t0).toFixed(0)} ms)`);
    render();
  }
}

async function onImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'havancrm') throw new Error('ไม่ใช่ไฟล์สำรองของแอปนี้');
    const n = await db.mergeRecords(data, { markDirty: true, source: 'import' });
    toast(`นำเข้าแล้ว ${n} รายการ`);
    scheduleSync(500);
    render();
  } catch (err) { toast('นำเข้าไม่สำเร็จ: ' + err.message); }
}

async function seedDemo() {
  const first = ['สมชาย', 'สมหญิง', 'วิชัย', 'มาลี', 'ประเสริฐ', 'สุดา', 'อนันต์', 'กมล', 'ปิยะ', 'รัตนา', 'ธนา', 'จันทร์เพ็ญ'];
  const last = ['ใจดี', 'รุ่งเรือง', 'ศรีสุข', 'มั่นคง', 'ทองดี', 'แสงทอง', 'พานิช', 'บุญมา'];
  const shops = ['ร้านค้าส่ง', 'มินิมาร์ท', 'บจก.', 'หจก.', 'ร้าน'];
  const products = [['น้ำดื่ม 600ml (แพ็ค)', 42], ['กาแฟกระป๋อง (ลัง)', 360], ['ข้าวสาร 5 กก.', 185], ['น้ำมันพืช 1 ลิตร', 52], ['สบู่ก้อน (โหล)', 150], ['ผงซักฟอก 3 กก.', 210], ['บะหมี่กึ่งฯ (ลัง)', 190], ['นมกล่อง (ลัง)', 420]];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const now = Date.now();
  const custs = Array.from({ length: 500 }, (_, i) => ({
    id: db.uid(), name: `${pick(first)} ${pick(last)} ${i + 1}`, company: `${pick(shops)}${pick(last)}`,
    phone: '08' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), tags: Math.random() < 0.1 ? 'VIP' : '',
    createdAt: now, updatedAt: now, _dirty: 1,
  }));
  const statuses = ['paid', 'paid', 'paid', 'shipped', 'pending', 'cancelled'];
  const orders = Array.from({ length: 3000 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - Math.floor(Math.random() * 90));
    const items = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => {
      const [name, price] = pick(products);
      return { name, qty: 1 + Math.floor(Math.random() * 20), price };
    });
    return { id: db.uid(), no: `DEMO-${String(i + 1).padStart(5, '0')}`, date: localDate(d), customerId: pick(custs).id, items, discount: 0, status: pick(statuses), note: '', createdAt: now, updatedAt: now, _dirty: 1 };
  });
  await db.putMany('customers', custs);
  await db.putMany('orders', orders);
  scheduleSync();
}

// ---------- chrome ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function updateSyncBadge(st = syncState()) {
  const el = $('#sync');
  const pending = pendingCount();
  const map = { syncing: ['⟳', 'กำลังซิงค์'], error: ['!', 'ซิงค์ไม่สำเร็จ'], offline: ['⦸', 'ออฟไลน์'], off: ['●', 'ยังไม่ตั้งค่าซิงค์'] };
  const [icon, title] = map[st.status] || ['✓', 'ซิงค์แล้ว'];
  el.dataset.status = st.status;
  el.textContent = pending && st.status !== 'syncing' ? `${icon} ${pending}` : icon;
  el.title = pending ? `${title} · รอซิงค์ ${pending} รายการ` : title;
  const detail = $('#sync-detail');
  if (detail) detail.innerHTML = syncText(st);
}

async function boot() {
  await db.init();
  render();
  db.onChange((source) => {
    if (source === 'local') scheduleSync();
    updateSyncBadge();
    // Re-render views that show data, but never clobber a form being edited.
    if (source !== 'local' && main.querySelector('form.form')) return;
    const r = parseHash();
    if (source === 'local' && r.name.endsWith('-edit')) return;
    if (['customers', 'orders'].includes(r.name)) (r.name === 'customers' ? renderCustomerResults : renderOrderResults)();
    else render();
  });
  onSync(updateSyncBadge);
  $('#sync').addEventListener('click', () => { sync(); toast('กำลังซิงค์…'); });
  updateSyncBadge();
  startAutoSync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
