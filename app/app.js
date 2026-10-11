import * as db from './db.js';
import { sync, scheduleSync, startAutoSync, onSync, syncState, getConfig, pendingCount, callServer } from './sync.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '฿' + (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const num = (n) => (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const today = () => localDate(new Date());
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thaiDate = (s) => s ? new Date(s + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
const PAGE = 100;

const STATUS = {
  pending: { label: 'รอดำเนินการ', cls: 'warn' },
  sent: { label: 'ส่งออฟฟิศแล้ว', cls: 'info' },
  billed: { label: 'เปิดบิลแล้ว', cls: 'ok' },
  paid: { label: 'ชำระแล้ว', cls: 'ok' },
  shipped: { label: 'ส่งของแล้ว', cls: 'info' },
  cancelled: { label: 'ยกเลิก', cls: 'muted' },
  excluded: { label: 'ไม่นับยอด', cls: 'muted' },
};
const EDITABLE_STATUS = ['pending', 'paid', 'shipped', 'cancelled'];

// ---------- derived data ----------
// When connected to A-CRM, sales come only from ACTIVE bills; orders are requests to the office.
const isAcrm = () => syncState().backend === 'acrm';
const isSale = (o) => (isAcrm() ? o.kind === 'bill' && o.status === 'billed' : !['cancelled', 'excluded'].includes(o.status));
const orderTotal = (o) => typeof o.total === 'number' ? o.total
  : Math.max(0, (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0) - (Number(o.discount) || 0));
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || String(b.no).localeCompare(String(a.no));
const customerLabel = (c) => (c.code ? `${c.name} · ${c.code}` : c.name);

// Memoized per data version so list/detail screens stay fast with thousands of bills.
let dataVersion = 0;
const memo = new Map();
function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && hit.v === dataVersion) return hit.value;
  const value = fn();
  memo.set(key, { v: dataVersion, value });
  return value;
}

const saleOrders = () => cached('sales', () => db.list('orders').filter(isSale));

function customerStats() {
  return cached('stats', () => {
    const stats = new Map();
    for (const o of saleOrders()) {
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
    const t = today();
    for (const s of stats.values()) {
      s.days = s.last ? daysBetween(s.last, t) : null;
      // Average days between purchases, once there are at least 3 purchase days.
      s.cycle = s.dates.size >= 3 ? Math.round(daysBetween(s.first, s.last) / (s.dates.size - 1)) : null;
    }
    return stats;
  });
}

// Customers whose gap since the last purchase is clearly longer than their usual cycle.
function followUps(limit = 8) {
  const stats = customerStats();
  const out = [];
  for (const c of db.list('customers')) {
    const s = stats.get(c.id);
    if (c.inactive || !s?.cycle || s.days < 7 || s.days < s.cycle * 1.2) continue;
    out.push({ c, s, ratio: s.days / Math.max(1, s.cycle) });
  }
  return out.sort((a, b) => b.ratio - a.ratio).slice(0, limit);
}

// Latest price/unit/code per product name, overall or for one customer.
function productIndex(customerId) {
  return cached('products:' + (customerId || ''), () => {
    const map = new Map();
    const list = customerId ? saleOrders().filter((o) => o.customerId === customerId) : saleOrders();
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
  });
}

function newOrderId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const be = String(d.getFullYear() + 543).slice(2);
  return `O-${be}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${Math.random().toString(36).slice(2, 4)}`;
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
  return { name: name || '', id: id && decodeURIComponent(id), params: new URLSearchParams(query) };
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
const link = (name, id, query = '') => `#/${name}/${encodeURIComponent(id)}${query}`;
window.addEventListener('hashchange', () => { viewState = {}; render(); window.scrollTo(0, 0); });

// ---------- views ----------
function dashboard() {
  const t = today();
  const month = t.slice(0, 7);
  const year = t.slice(0, 4);
  const lastMonthDate = new Date(); lastMonthDate.setDate(1); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = localDate(lastMonthDate).slice(0, 7);
  let todaySum = 0, monthSum = 0, lastMonthSum = 0, monthCount = 0, yearSum = 0;
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push({ date: localDate(d), sum: 0 }); }
  const dayIdx = new Map(days.map((d, i) => [d.date, i]));
  const byCustomer = new Map();
  for (const o of saleOrders()) {
    const v = orderTotal(o);
    if (o.date === t) todaySum += v;
    if (o.date?.startsWith(month)) {
      monthSum += v; monthCount += 1;
      byCustomer.set(o.customerId, (byCustomer.get(o.customerId) || 0) + v);
    }
    if (o.date?.startsWith(lastMonth)) lastMonthSum += v;
    if (o.date?.startsWith(year)) yearSum += v;
    if (dayIdx.has(o.date)) days[dayIdx.get(o.date)].sum += v;
  }
  const growth = lastMonthSum ? ((monthSum - lastMonthSum) / lastMonthSum) * 100 : null;
  const max = Math.max(1, ...days.map((d) => d.sum));
  const top = [...byCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const follow = followUps();
  const recent = [...db.list('orders')].sort(byDateDesc).slice(0, 5);
  const unit = isAcrm() ? 'บิล' : 'ออเดอร์';

  return `
  <h1>ภาพรวมยอดขาย</h1>
  <div class="kpis">
    <div class="kpi"><span>วันนี้</span><b>${money(todaySum)}</b></div>
    <div class="kpi"><span>เดือนนี้ (${monthCount} ${unit})</span><b>${money(monthSum)}</b>
      ${growth === null ? '' : `<small class="${growth >= 0 ? 'up' : 'down'}">${growth >= 0 ? '▲' : '▼'} ${Math.abs(growth).toFixed(0)}% จากเดือนก่อน</small>`}</div>
    <div class="kpi"><span>ปีนี้</span><b>${money(yearSum)}</b></div>
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
    <h2>ลูกค้าที่ควรติดตาม</h2>
    ${follow.length ? `<ul class="list">${follow.map(({ c, s }) => `<li><a href="${link('customer', c.id)}">
      <div><b>${esc(c.name)}</b><small>ปกติซื้อทุก ~${s.cycle} วัน · ซื้อล่าสุด ${thaiDate(s.last)}</small></div>
      <div class="right"><b class="warn-text">${s.days} วัน</b><small>ไม่ได้ซื้อ</small></div>
    </a></li>`).join('')}</ul>` : '<p class="empty">ยังไม่มีลูกค้าที่ขาดการสั่งซื้อผิดปกติ</p>'}
  </section>
  <section class="card">
    <h2>ลูกค้ายอดซื้อสูงสุดเดือนนี้</h2>
    ${top.length ? `<ol class="rank">${top.map(([id, v]) => `<li><a href="${link('customer', id)}">${esc(db.get('customers', id)?.name || id || '(ไม่ระบุ)')}</a><b>${money(v)}</b></li>`).join('')}</ol>` : '<p class="empty">ยังไม่มียอดขายเดือนนี้</p>'}
  </section>
  <section class="card">
    <h2>ล่าสุด <a class="more" href="#/orders">ทั้งหมด</a></h2>
    ${recent.length ? orderRows(recent) : '<p class="empty">ยังไม่มีข้อมูล</p>'}
  </section>
  <a class="fab" href="#/order-edit/new" aria-label="สร้างออเดอร์">＋</a>`;
}

function orderRows(list, { showCustomer = true } = {}) {
  return `<ul class="list">${list.map((o) => {
    const c = db.get('customers', o.customerId);
    const st = STATUS[o.status] || STATUS.pending;
    const kind = o.kind === 'bill' ? 'บิล ' : '';
    const title = showCustomer ? esc(c?.name || o.customerId || '(ไม่ระบุลูกค้า)') : `${kind}${esc(o.no)}`;
    const sub = showCustomer ? `${kind}${esc(o.no)} · ${thaiDate(o.date)}` : `${thaiDate(o.date)} · ${(o.items || []).length} รายการ`;
    return `<li><a href="${link('order', o.id)}">
      <div><b>${title}</b><small>${sub}${o._dirty ? ' · ⟳ รอซิงค์' : ''}</small></div>
      <div class="right"><b>${o.priceUnknown ? 'ไม่ทราบราคา' : money(orderTotal(o))}</b><span class="badge ${st.cls}">${st.label}</span></div>
    </a></li>`;
  }).join('')}</ul>`;
}

function customers() {
  return `
  <h1>ลูกค้า</h1>
  <input class="search" type="search" placeholder="ค้นหา ชื่อ / รหัส / เบอร์ / จังหวัด / ประเภท" data-init="customers" value="${esc(viewState.q || '')}" autocomplete="off">
  <div id="results"></div>
  ${isAcrm() ? '' : '<a class="fab" href="#/customer-edit/new" aria-label="เพิ่มลูกค้า">＋</a>'}`;
}

function renderCustomerResults() {
  const t0 = performance.now();
  const q = (viewState.q || '').trim().toLowerCase();
  const stats = customerStats();
  const list = db.list('customers')
    .filter((c) => matches(q, c.name, c.code, c.phones || c.phone, c.company, c.tags, c.line, c.email, c.province, c.businessType, c.contact))
    .sort((a, b) => (stats.get(b.id)?.last || '').localeCompare(stats.get(a.id)?.last || '') || a.name.localeCompare(b.name, 'th'));
  const limit = viewState.limit || PAGE;
  $('#results').innerHTML = `<p class="count">${list.length.toLocaleString('th-TH')} รายการ</p>` + (list.length ? `
    <ul class="list">${list.slice(0, limit).map((c) => {
      const s = stats.get(c.id);
      const sub = [c.code, c.businessType || c.company, c.province, c.phone].filter(Boolean).join(' · ');
      return `<li><a href="${link('customer', c.id)}">
        <div><b>${esc(c.name)}${c.inactive ? ' <span class="badge muted">ไม่ใช้งาน</span>' : ''}</b><small>${esc(sub)}</small></div>
        <div class="right"><b>${money(s?.total)}</b><small>${s?.last ? `ล่าสุด ${thaiDate(s.last)}` : 'ยังไม่มียอดซื้อ'}</small></div>
      </a></li>`;
    }).join('')}</ul>
    ${list.length > limit ? '<button class="btn ghost wide" data-more>แสดงเพิ่ม</button>' : ''}` : '<p class="empty">ไม่พบลูกค้า</p>');
  $('#perf').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
}

function customerDetail({ id }) {
  const c = db.get('customers', id);
  if (!c) return '<p class="empty">ไม่พบลูกค้า</p>';
  const s = customerStats().get(id);
  const all = db.list('orders').filter((o) => o.customerId === id).sort(byDateDesc);
  const lastSale = all.find(isSale) || all[0];
  const phone = (c.phone || '').replace(/[^\d+]/g, '');
  const map = c.mapLink || (c.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([c.address, c.district, c.province].filter(Boolean).join(' '))}` : '');
  const regular = [...productIndex(id).entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  const info = [
    ['รหัสลูกค้า', c.code], ['ผู้ติดต่อ', c.contact], ['เบอร์โทร', c.phones || c.phone], ['LINE', c.line], ['อีเมล', c.email],
    ['ที่อยู่', [c.address, c.district, c.province].filter(Boolean).join(' ')], ['ประเภทธุรกิจ', c.businessType || c.company],
    ['เซลล์ผู้ดูแล', c.owner], ['แท็ก', c.tags], ['บันทึก', c.note],
  ].filter(([, v]) => v);
  return `
  <div class="head"><a href="#/customers" class="back">‹ ลูกค้า</a>${c.src ? '<span class="src">ข้อมูลจาก A-CRM</span>' : `<a href="${link('customer-edit', id)}" class="btn small">แก้ไข</a>`}</div>
  <h1>${esc(c.name)}</h1>
  ${c.code || c.businessType ? `<p class="sub">${esc([c.code, c.businessType].filter(Boolean).join(' · '))}</p>` : ''}
  <div class="actions">
    ${phone ? `<a class="btn" href="tel:${esc(phone)}">📞 โทร</a>` : ''}
    ${c.line ? `<a class="btn" href="https://line.me/ti/p/~${encodeURIComponent(c.line)}" target="_blank" rel="noopener">💬 LINE</a>` : ''}
    ${map ? `<a class="btn" href="${esc(map)}" target="_blank" rel="noopener">📍 แผนที่</a>` : ''}
  </div>
  <div class="actions">
    <a class="btn primary" href="#/order-edit/new?customer=${encodeURIComponent(id)}">＋ ออเดอร์ใหม่</a>
    ${lastSale ? `<a class="btn" href="#/order-edit/new?customer=${encodeURIComponent(id)}&repeat=${encodeURIComponent(lastSale.id)}">↻ สั่งซ้ำล่าสุด</a>` : ''}
  </div>
  <div class="kpis">
    <div class="kpi"><span>ยอดซื้อรวม</span><b>${money(s?.total)}</b></div>
    <div class="kpi"><span>จำนวน${isAcrm() ? 'บิล' : 'ออเดอร์'}</span><b>${s?.count || 0}</b></div>
    <div class="kpi"><span>ซื้อล่าสุด</span><b>${s?.last ? thaiDate(s.last) : '-'}</b>${s?.last ? `<small>${s.days} วันก่อน</small>` : ''}</div>
    <div class="kpi"><span>ซื้อเฉลี่ยทุก</span><b>${s?.cycle ? `${s.cycle} วัน` : '-'}</b>${s?.cycle && s.days > s.cycle * 1.2 ? '<small class="down">เลยรอบแล้ว</small>' : ''}</div>
  </div>
  ${regular.length ? `<section class="card"><h2>สินค้าที่ซื้อประจำ</h2><ul class="plain">${regular.map(([name, p]) => `
    <li><span>${esc(name)}</span><small>${p.count} ครั้ง · ล่าสุด ${num(p.qty)} ${esc(p.unit || '')}${p.price != null ? ` @ ${money(p.price)}` : ''}</small></li>`).join('')}</ul></section>` : ''}
  <section class="card info">
    ${info.map(([k, v]) => `<div><span>${k}</span><p>${esc(v)}</p></div>`).join('') || '<p class="empty">ไม่มีข้อมูลเพิ่มเติม</p>'}
  </section>
  <section class="card"><h2>ประวัติการสั่งซื้อ (${all.length})</h2>${all.length ? orderRows(all.slice(0, 100), { showCustomer: false }) : '<p class="empty">ยังไม่มีประวัติ</p>'}</section>`;
}

function field(name, label, value, attrs = '') {
  return `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
}

function customerEdit({ id }) {
  const c = id === 'new' ? {} : db.get('customers', id);
  if (!c) return '<p class="empty">ไม่พบลูกค้า</p>';
  if (c.src || (id === 'new' && isAcrm())) return '<p class="empty">ข้อมูลลูกค้าแก้ไขได้ในระบบ A-CRM เท่านั้น</p>';
  return `
  <div class="head"><a href="${id === 'new' ? '#/customers' : link('customer', id)}" class="back">‹ ยกเลิก</a></div>
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
  const present = new Set(db.list('orders').map((o) => o.status));
  const chips = [['all', 'ทั้งหมด'], ...Object.entries(STATUS).filter(([k]) => present.has(k)).map(([k, v]) => [k, v.label])];
  return `
  <h1>${isAcrm() ? 'บิล & ออเดอร์' : 'ออเดอร์'}</h1>
  <input class="search" type="search" placeholder="ค้นหา เลขที่ / ลูกค้า / สินค้า" data-init="orders" value="${esc(viewState.q || '')}" autocomplete="off">
  <div class="chips">${chips.map(([k, l]) => `<button class="chip ${f === k ? 'active' : ''}" data-status="${k}">${l}</button>`).join('')}</div>
  <div id="results"></div>
  <a class="fab" href="#/order-edit/new" aria-label="สร้างออเดอร์">＋</a>`;
}

function renderOrderResults() {
  const t0 = performance.now();
  const q = (viewState.q || '').trim().toLowerCase();
  const f = viewState.status || 'all';
  const list = db.list('orders')
    .filter((o) => (f === 'all' || o.status === f) &&
      matches(q, o.no, o.customerId, db.get('customers', o.customerId)?.name, ...(o.items || []).map((i) => i.name)))
    .sort(byDateDesc);
  const sum = list.filter(isSale).reduce((s, o) => s + orderTotal(o), 0);
  const limit = viewState.limit || PAGE;
  $('#results').innerHTML = `<p class="count">${list.length.toLocaleString('th-TH')} รายการ · ยอดขาย ${money(sum)}</p>` +
    (list.length ? orderRows(list.slice(0, limit)) + (list.length > limit ? '<button class="btn ghost wide" data-more>แสดงเพิ่ม</button>' : '') : '<p class="empty">ไม่พบรายการ</p>');
  $('#perf').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
}

function orderDetail({ id }) {
  const o = db.get('orders', id);
  if (!o) return '<p class="empty">ไม่พบรายการ</p>';
  const c = db.get('customers', o.customerId);
  const meta = [['เซลล์', o.salesperson], ['ผู้เปิดบิล', o.opener], ['เงื่อนไขชำระ', o.terms]].filter(([, v]) => v);
  return `
  <div class="head"><a href="#/orders" class="back">‹ รายการ</a>${o.src ? '<span class="src">ข้อมูลจาก A-CRM</span>' : `<a href="${link('order-edit', id)}" class="btn small">แก้ไข</a>`}</div>
  <h1>${o.kind === 'bill' ? 'บิล ' : ''}${esc(o.no)}</h1>
  <p class="sub">${thaiDate(o.date)} · ${c ? `<a href="${link('customer', c.id)}">${esc(c.name)}</a>` : esc(o.customerId || '(ไม่ระบุลูกค้า)')}</p>
  ${o.src ? `<p><span class="badge ${(STATUS[o.status] || STATUS.pending).cls}">${(STATUS[o.status] || STATUS.pending).label}</span></p>`
    : `<div class="chips" data-init="order-status">${EDITABLE_STATUS.map((k) => `<button class="chip ${o.status === k ? 'active' : ''}" data-set-status="${k}">${STATUS[k].label}</button>`).join('')}</div>`}
  ${o._dirty && isAcrm() ? `<p class="hint">⟳ ยังไม่ได้ส่งเข้า A-CRM${syncState().readOnly ? ' (ฐานข้อมูลเปิดแบบอ่านอย่างเดียว)' : ''}</p>` : ''}
  <section class="card">
    <table class="items"><thead><tr><th>สินค้า</th><th>จำนวน</th><th>ราคา</th><th>รวม</th></tr></thead><tbody>
    ${(o.items || []).map((i) => {
      const known = i.price !== null && i.price !== undefined;
      return `<tr><td>${esc(i.name)}</td><td>${num(i.qty)} ${esc(i.unit || '')}</td><td>${known ? money(i.price) : '-'}</td><td>${known ? money(i.qty * i.price) : '-'}</td></tr>`;
    }).join('')}
    </tbody>
    <tfoot>${Number(o.discount) ? `<tr><td colspan="3">ส่วนลด</td><td>-${money(o.discount)}</td></tr>` : ''}
    <tr><th colspan="3">ยอดสุทธิ</th><th>${o.priceUnknown ? 'ไม่ทราบราคา' : money(orderTotal(o))}</th></tr></tfoot></table>
    ${o.priceUnknown ? '<p class="hint">ออเดอร์เดิมไม่มีราคาครบ ระบบจะไม่เดาราคาย้อนหลัง</p>' : ''}
  </section>
  ${meta.length || o.note ? `<section class="card info">${meta.map(([k, v]) => `<div><span>${k}</span><p>${esc(v)}</p></div>`).join('')}
    ${o.note ? `<div><span>บันทึก</span><p>${esc(o.note)}</p></div>` : ''}</section>` : ''}
  ${o.customerId ? `<a class="btn wide" href="#/order-edit/new?customer=${encodeURIComponent(o.customerId)}&repeat=${encodeURIComponent(o.id)}">↻ สั่งซ้ำรายการนี้</a>` : ''}`;
}

function orderEdit({ id, params }) {
  let o;
  if (id === 'new') {
    const repeat = params.get('repeat') && db.get('orders', params.get('repeat'));
    const oid = newOrderId();
    o = {
      id: oid, no: oid, date: today(), status: 'pending', customerId: params.get('customer') || '', discount: '',
      items: repeat ? repeat.items.map(({ name, qty, price, unit, code }) => ({ name, qty, price: price ?? '', unit, code })) : [{ name: '', qty: 1, price: '' }],
    };
  } else {
    o = db.get('orders', id);
    if (o?.src) return '<p class="empty">รายการจาก A-CRM แก้ไขได้ในระบบ A-CRM เท่านั้น</p>';
  }
  if (!o) return '<p class="empty">ไม่พบออเดอร์</p>';
  const custs = db.list('customers').filter((c) => !c.inactive).sort((a, b) => a.name.localeCompare(b.name, 'th'));
  const cur = db.get('customers', o.customerId);
  const products = productIndex();
  viewState.newId = o.id;
  return `
  <div class="head"><a href="${id === 'new' ? '#/orders' : link('order', id)}" class="back">‹ ยกเลิก</a></div>
  <h1>${id === 'new' ? 'สร้างออเดอร์' : 'แก้ไขออเดอร์'}</h1>
  <form class="form" data-init="order-form">
    <div class="row">${field('no', 'เลขที่', o.no, 'required')}${field('date', 'วันที่', o.date, 'type="date" required')}</div>
    <label>ลูกค้า *<input name="customer" list="custlist" value="${esc(cur ? customerLabel(cur) : '')}" placeholder="พิมพ์ชื่อหรือรหัสลูกค้า" required autocomplete="off"></label>
    <datalist id="custlist">${custs.map((c) => `<option value="${esc(customerLabel(c))}">${esc(c.phone || '')}</option>`).join('')}</datalist>
    <datalist id="prodlist">${[...products.entries()].sort((a, b) => b[1].count - a[1].count).map(([n]) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    <div class="items-edit" id="items">${(o.items || []).map(itemRow).join('')}</div>
    <button type="button" class="btn ghost wide" data-add-item>＋ เพิ่มรายการสินค้า</button>
    <div class="row">${field('discount', 'ส่วนลด (บาท)', o.discount, 'type="number" inputmode="decimal" min="0" step="any"')}
      <label>สถานะ<select name="status">${EDITABLE_STATUS.map((k) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${STATUS[k].label}</option>`).join('')}</select></label></div>
    <label>บันทึก<textarea name="note" rows="2">${esc(o.note)}</textarea></label>
    <p class="total">ยอดสุทธิ <b id="total">${money(orderTotal(o))}</b></p>
    <button class="btn primary wide">บันทึกออเดอร์</button>
    ${id !== 'new' ? '<button type="button" class="btn danger wide" data-delete>ลบออเดอร์</button>' : ''}
  </form>`;
}

function itemRow(i = { name: '', qty: 1, price: '' }) {
  return `<div class="item">
    <input name="iname" list="prodlist" placeholder="ชื่อสินค้า" value="${esc(i.name)}" autocomplete="off">
    <input name="iqty" type="number" inputmode="decimal" min="0" step="any" placeholder="จำนวน${i.unit ? ` (${esc(i.unit)})` : ''}" value="${esc(i.qty)}">
    <input name="iprice" type="number" inputmode="decimal" min="0" step="any" placeholder="ราคา/หน่วย" value="${esc(i.price)}">
    <input name="iunit" type="hidden" value="${esc(i.unit || '')}"><input name="icode" type="hidden" value="${esc(i.code || '')}">
    <button type="button" class="x" data-remove-item aria-label="ลบรายการ">✕</button>
  </div>`;
}

function settings() {
  const st = syncState();
  const counts = db.list('orders').reduce((a, o) => { a[o.kind === 'bill' ? 'bills' : 'orders'] += 1; return a; }, { bills: 0, orders: 0 });
  return `
  <h1>ตั้งค่า & สำรองข้อมูล</h1>
  <section class="card">
    <h2>เชื่อมต่อฐานข้อมูล</h2>
    <p class="hint">ใส่ URL ของ Apps Script (ลงท้ายด้วย <code>/exec</code>) สำหรับ A-CRM หรือ Google Sheet หรือที่อยู่เซิร์ฟเวอร์ HavanCRM ข้อมูลเก็บในเครื่องก่อน (ใช้งานออฟไลน์ได้) แล้วซิงค์อัตโนมัติ</p>
    <form class="form" data-init="settings-form">
      ${field('url', 'URL ฐานข้อมูล', '', 'type="url" placeholder="https://script.google.com/macros/s/…/exec" inputmode="url"')}
      ${field('token', 'รหัสซิงค์ (SYNC_TOKEN)', '', 'type="password" autocomplete="off"')}
      ${field('user', 'ชื่อผู้ใช้ (บันทึกเป็นผู้สร้างออเดอร์)', '', 'autocomplete="name"')}
      <button class="btn primary wide">บันทึก & ซิงค์ตอนนี้</button>
    </form>
    <p class="sync-status" id="sync-detail">${syncText(st)}</p>
  </section>
  <section class="card">
    <h2>สำรอง / กู้คืนข้อมูล</h2>
    <p class="hint">ดาวน์โหลดไฟล์สำรอง (.json) เก็บไว้ใน Google Drive / LINE Keep หรือเครื่องอื่น และนำเข้าเพื่อกู้คืนได้ทุกเมื่อ ข้อมูลเดิมจะไม่ถูกลบ (ใช้ข้อมูลที่ใหม่กว่า)</p>
    <button class="btn wide" data-export>⬇ ดาวน์โหลดไฟล์สำรอง</button>
    <label class="btn wide file">⬆ นำเข้าไฟล์สำรอง<input type="file" accept="application/json,.json" data-import hidden></label>
    <button class="btn ghost wide" data-server-backup>สำรองข้อมูลบน Google Drive / เซิร์ฟเวอร์ตอนนี้</button>
  </section>
  <section class="card">
    <h2>ข้อมูลในเครื่อง</h2>
    <p>ลูกค้า ${num(db.list('customers').length)} · ${counts.bills ? `บิล ${num(counts.bills)} · ` : ''}ออเดอร์ ${num(counts.orders)} · รอซิงค์ ${pendingCount()}</p>
    ${isAcrm() ? '' : '<button class="btn ghost wide" data-demo>สร้างข้อมูลตัวอย่าง (ทดสอบความเร็ว)</button>'}
  </section>`;
}

function syncText(st) {
  const last = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('th-TH') : 'ยังไม่เคย';
  const text = {
    off: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล — ข้อมูลเก็บในเครื่องนี้เท่านั้น',
    offline: `ออฟไลน์ — จะซิงค์เมื่อมีอินเทอร์เน็ต (ซิงค์ล่าสุด ${last})`,
    syncing: 'กำลังซิงค์…',
    ok: `ซิงค์สำเร็จ ${last}`,
    error: `ซิงค์ไม่สำเร็จ: ${esc(st.error)} (ซิงค์ล่าสุด ${last})`,
    idle: `ซิงค์ล่าสุด ${last}`,
  }[st.status] || '';
  if (st.backend !== 'acrm') return text;
  const mode = st.readOnly
    ? `เชื่อมต่อ A-CRM แบบอ่านอย่างเดียว${st.rejected ? ` — ออเดอร์ใหม่ ${st.rejected} รายการเก็บไว้ในเครื่อง รอเปิดสิทธิ์เขียน` : ''}`
    : 'เชื่อมต่อ A-CRM (ส่งออเดอร์ใหม่เข้า ORDERS ได้)';
  return `${text}<br>${mode}`;
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
      go(link('customer', rec.id));
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
    Promise.all([getConfig(), db.getMeta('user')]).then(([{ url, token }, user]) => {
      form.url.value = url; form.token.value = token; form.user.value = user || '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = form.url.value.trim();
      if (url !== (await getConfig()).url) await db.setMeta('cursor', 0); // new database: start from scratch
      await db.setMeta('serverUrl', url);
      await db.setMeta('token', form.token.value.trim());
      await db.setMeta('user', form.user.value.trim());
      const ok = await sync();
      toast(ok ? 'ซิงค์สำเร็จ' : 'ซิงค์ไม่สำเร็จ');
      render();
    });
    main.addEventListener('click', onSettingsClick, { signal: viewCtrl.signal });
    main.querySelector('[data-import]').addEventListener('change', onImport);
  }
}

function findCustomer(input) {
  const v = input.trim();
  return db.list('customers').find((c) => customerLabel(c) === v || c.code === v)
    || db.list('customers').find((c) => c.name === v);
}

function bindOrderForm(r) {
  const form = main.querySelector('form');
  const items = $('#items', form);
  const readItems = () => [...items.querySelectorAll('.item')].map((el) => {
    const val = (n) => el.querySelector(`[name=${n}]`).value.trim();
    const it = { name: val('iname'), qty: Number(val('iqty')) || 0, price: Number(val('iprice')) || 0 };
    if (val('iunit')) it.unit = val('iunit');
    if (val('icode')) it.code = val('icode');
    return it;
  }).filter((i) => i.name);
  const updateTotal = () => {
    $('#total').textContent = money(orderTotal({ items: readItems(), discount: form.discount.value }));
  };
  form.addEventListener('input', (e) => {
    // Picking a known product fills this customer's last price (or the latest price overall).
    if (e.target.name === 'iname') {
      const row = e.target.closest('.item');
      const cust = findCustomer(form.customer.value);
      const p = (cust && productIndex(cust.id).get(e.target.value)) || productIndex().get(e.target.value);
      row.querySelector('[name=iunit]').value = p?.unit || '';
      row.querySelector('[name=icode]').value = p?.code || '';
      if (p) {
        const price = row.querySelector('[name=iprice]');
        if (!price.value && p.price != null) price.value = p.price;
        row.querySelector('[name=iqty]').placeholder = `จำนวน${p.unit ? ` (${p.unit})` : ''}`;
      }
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
    let cust = findCustomer(name);
    if (!cust) {
      if (isAcrm()) { toast('ไม่พบลูกค้านี้ใน A-CRM — เลือกจากรายชื่อ'); return; }
      if (!confirm(`ยังไม่มีลูกค้า "${name}" — เพิ่มเป็นลูกค้าใหม่?`)) return;
      cust = db.save('customers', { name });
    }
    const list = readItems();
    if (!list.length) { toast('กรุณาใส่สินค้าอย่างน้อย 1 รายการ'); return; }
    const rec = db.save('orders', {
      id: r.id === 'new' ? viewState.newId : r.id,
      kind: 'order',
      no: form.no.value.trim(),
      date: form.date.value,
      customerId: cust.id,
      items: list,
      discount: Number(form.discount.value) || 0,
      status: form.status.value,
      note: form.note.value.trim(),
    });
    toast('บันทึกออเดอร์แล้ว');
    go(link('order', rec.id));
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
    try {
      await sync();
      const res = await callServer('backup');
      toast(`สำรองข้อมูลแล้ว ${res.file || ''}`);
    } catch (err) { toast('สำรองไม่สำเร็จ: ' + err.message); }
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
  await startAutoSync();
  render();
  db.onChange((source) => {
    dataVersion += 1;
    if (source === 'local') scheduleSync();
    updateSyncBadge();
    // Re-render views that show data, but never clobber a form being edited.
    if (source !== 'local' && main.querySelector('form.form')) return;
    const r = parseHash();
    if (source === 'local' && r.name.endsWith('-edit')) return;
    if (['customers', 'orders'].includes(r.name)) (r.name === 'customers' ? renderCustomerResults : renderOrderResults)();
    else render();
  });
  let backend = syncState().backend;
  onSync((st) => {
    updateSyncBadge(st);
    // The backend type decides how sales are counted; recompute when it changes.
    if (st.backend !== backend) {
      backend = st.backend;
      dataVersion += 1;
      if (!main.querySelector('form.form')) render();
    }
  });
  $('#sync').addEventListener('click', () => { sync(); toast('กำลังซิงค์…'); });
  updateSyncBadge();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
