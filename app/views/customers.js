// Customers (ลูกค้า), Customer 360, customer form, target shops (ร้านเป้าหมาย) and conversion to customer.
import * as db from '../db.js';
import * as core from '../core.js';
import { esc, money, num, thaiDate, customerLabel } from '../core.js';
import { icon, path, badge, empty, chips, field, area, openSheet, closeSheet, toast, region, captureGps, readPhoto, confirmSheet, more, fmtDateTime } from '../ui.js';
import { customers, leads, stats, cycleOf, openTasksOf, ordersOf, productIdx, searchIdx, activities, isAcrm, tasks } from '../derived.js';
import { logActivity, openNoteSheet, openTaskSheet, LEAD_STATUS, KIND } from './work.js';
import { openProposal } from './orders.js';

const PAGE = 80;
const CYCLE_BADGE = { overdue: 'warn', due: 'warn', near: 'info', normal: 'muted', none: 'muted' };
const telOf = (s) => String(s || '').replace(/[^\d+]/g, '').split(/[,;/]/)[0];
const mapsOf = (r) => (r.lat && r.lng ? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([r.address, r.district, r.province].filter(Boolean).join(' '))}`);
const lineOf = (r) => (r.line ? `https://line.me/ti/p/~${encodeURIComponent(String(r.line).replace(/^@/, '@'))}` : '');
const tagsOf = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean);

// ---------- list ----------
const SORTS = [['recent', 'ซื้อล่าสุด'], ['lapsed', 'ไม่ได้ซื้อนาน'], ['spend', 'ยอดซื้อสูง'], ['name', 'ชื่อ A-Z']];
const FLAGS = [['current', 'ลูกค้าปัจจุบัน (ซื้อใน 60 วัน)'], ['lapsed', 'ลูกค้าห่างหาย (ไม่ซื้อ 60+ วัน)'], ['geo', 'มีพิกัด'], ['nogeo', 'ไม่มีพิกัด'], ['photo', 'มีรูป'], ['nophoto', 'ไม่มีรูป']];

export function customersPage(ctx) {
  const st = ctx.state;
  st.sort ||= 'recent'; st.f ||= {}; st.limit ||= PAGE;
  const filterCount = Object.values(st.f).filter(Boolean).length + (st.flags?.length || 0);
  return {
    html: `
    <div class="page-top"><h1>ลูกค้า</h1><a class="btn primary small" href="${path('customer-edit', 'new')}">${icon('plus')} เพิ่มลูกค้า</a></div>
    ${chips([['customers', 'ลูกค้า'], ['leads', 'ร้านเป้าหมาย']], 'customers', 'seg')}
    <div class="searchrow">
      <input class="search" type="search" placeholder="ค้นหา ชื่อ / รหัส / เบอร์ / ถนน / ที่อยู่ / Zone / จังหวัด / Tag" data-in="q" value="${esc(st.q || '')}" autocomplete="off">
      <button class="btn ${filterCount ? 'primary' : ''} filter-btn" data-act="filter" aria-label="ตัวกรอง">${icon('filter')}${filterCount ? `<b>${filterCount}</b>` : ''}</button>
    </div>
    ${chips(SORTS, st.sort, 'sort')}
    <div data-region="results"></div>`,
    on: {
      'click:seg': (el) => ctx.go(el.dataset.key === 'leads' ? 'leads' : 'customers'),
      'input:q': (el) => { st.q = el.value; st.limit = PAGE; renderResults(); },
      'click:sort': (el) => { st.sort = el.dataset.key; ctx.rerender(); },
      'click:more': () => { st.limit += PAGE; renderResults(); },
      'click:filter': () => openFilter(ctx),
    },
    onMount: () => renderResults(),
  };

  function renderResults() {
    const list = filterCustomers(st);
    const limit = st.limit;
    const stats_ = stats();
    const rows = list.slice(0, limit).map((c) => customerCard(c, stats_));
    region('results', `<p class="count">${num(list.length)} ราย</p>
      ${list.length ? `<ul class="cards">${rows.join('')}</ul>${list.length > limit ? more() : ''}` : empty('ไม่พบลูกค้าตามเงื่อนไข')}`);
  }
}

export function filterCustomers(st) {
  const f = st.f || {};
  const flags = st.flags || [];
  const stats_ = stats();
  let list = customers();
  const q = (st.q || '').trim();
  if (q) {
    const ids = new Set(core.search(searchIdx(), q, 100000).customers);
    list = list.filter((c) => ids.has(c.id));
  }
  list = list.filter((c) => {
    if (f.biz && c.businessType !== f.biz) return false;
    if (f.prov && c.province !== f.prov) return false;
    if (f.zone && c.zone !== f.zone) return false;
    if (f.owner && c.owner !== f.owner) return false;
    if (f.tag && !tagsOf(c.tags).includes(f.tag)) return false;
    if (f.cycle && cycleOf(c.id).key !== f.cycle) return false;
    const s = stats_.get(c.id);
    if (flags.includes('current') && !(s && s.days <= 60)) return false;
    if (flags.includes('lapsed') && !(s && s.days >= 60)) return false;
    if (flags.includes('geo') && !(c.lat && c.lng)) return false;
    if (flags.includes('nogeo') && (c.lat && c.lng)) return false;
    if (flags.includes('photo') && !c.photo) return false;
    if (flags.includes('nophoto') && c.photo) return false;
    return true;
  });
  const sortFn = {
    recent: (a, b) => (stats_.get(b.id)?.last || '').localeCompare(stats_.get(a.id)?.last || ''),
    lapsed: (a, b) => (stats_.get(b.id)?.days ?? 99999) - (stats_.get(a.id)?.days ?? 99999),
    spend: (a, b) => (stats_.get(b.id)?.total || 0) - (stats_.get(a.id)?.total || 0),
    name: (a, b) => a.name.localeCompare(b.name, 'th'),
  }[st.sort || 'recent'];
  return list.sort(sortFn);
}

function customerCard(c, stats_) {
  const s = stats_.get(c.id);
  const cy = cycleOf(c.id);
  const open = openTasksOf(c.id).length;
  const sub = [c.code, c.phone && telOf(c.phone), c.zone].filter(Boolean).join(' · ');
  const tags = tagsOf(c.tags);
  return `<li class="card-row">
    <a class="card-link" href="${path('customer', c.id)}">
      <div class="card-top"><b>${esc(c.name)}</b>${cy.key !== 'normal' && cy.key !== 'none' ? badge(cy.label, CYCLE_BADGE[cy.key]) : ''}</div>
      <small>${esc(sub)}</small>
      <div class="card-meta">
        <span>ซื้อล่าสุด ${s?.last ? thaiDate(s.last) : '-'}</span>
        ${open ? `<span class="warn-text">งานค้าง ${open}</span>` : ''}
        ${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>
    </a>
    <div class="card-actions">
      ${telOf(c.phone) ? `<a class="btn small" href="tel:${esc(telOf(c.phone))}" data-act="call-log" data-ref="customerId:${esc(c.id)}">${icon('phone')} โทร</a>` : ''}
      <a class="btn small" href="${esc(mapsOf(c))}" target="_blank" rel="noopener">${icon('pin')} นำทาง</a>
      <a class="btn small primary" href="${path('order-edit', 'new', '?customer=' + encodeURIComponent(c.id))}">${icon('cart')} รับออเดอร์</a>
    </div>
  </li>`;
}

function openFilter(ctx) {
  const st = ctx.state;
  const f = st.f || {};
  const flags = st.flags || [];
  const opt = (list, cur) => [['', 'ทั้งหมด'], ...list.map((v) => [v, v])].map(([v, l]) => `<option value="${esc(v)}" ${v === (cur || '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const provinces = [...new Set(customers().map((c) => c.province).filter(Boolean))].sort();
  const tags = [...new Set(customers().flatMap((c) => tagsOf(c.tags)))].sort();
  const owners = [...new Set(customers().map((c) => c.owner).filter(Boolean))].sort();
  openSheet({
    title: 'ตัวกรองลูกค้า',
    html: `<form class="form" data-form="filter">
      <label class="fld"><span>ประเภทธุรกิจ</span><select name="biz">${opt(db.masters.businessTypes, f.biz)}</select></label>
      <label class="fld"><span>จังหวัด</span><select name="prov">${opt(provinces, f.prov)}</select></label>
      <label class="fld"><span>Zone</span><select name="zone">${opt(db.masters.zones, f.zone)}</select></label>
      <label class="fld"><span>ผู้ดูแล</span><select name="owner">${opt(owners, f.owner)}</select></label>
      <label class="fld"><span>Tag</span><select name="tag">${opt(tags, f.tag)}</select></label>
      <label class="fld"><span>สถานะรอบ</span><select name="cycle">${[['', 'ทั้งหมด'], ['overdue', 'เลยรอบ'], ['due', 'ถึงรอบ'], ['near', 'ใกล้ถึงรอบ'], ['normal', 'ปกติ']].map(([v, l]) => `<option value="${v}" ${v === (f.cycle || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <fieldset class="checks"><legend>เงื่อนไขเพิ่มเติม</legend>
        ${FLAGS.map(([k, l]) => `<label class="check"><input type="checkbox" name="flag" value="${k}" ${flags.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}
      </fieldset>
      <div class="actions"><button type="button" class="btn" data-act="clear">ล้างตัวกรอง</button><button class="btn primary">ใช้ตัวกรอง</button></div>
    </form>`,
    on: {
      'click:clear': () => { st.f = {}; st.flags = []; closeSheet(); ctx.rerender(); },
      'submit:filter': (form) => {
        const d = Object.fromEntries(new FormData(form));
        st.f = { biz: d.biz, prov: d.prov, zone: d.zone, owner: d.owner, tag: d.tag, cycle: d.cycle };
        st.flags = [...form.querySelectorAll('input[name=flag]:checked')].map((i) => i.value);
        st.limit = PAGE;
        closeSheet();
        ctx.rerender();
      },
    },
  });
}

// ---------- Customer 360 ----------
export function customerPage(ctx) {
  const c = db.get('customers', ctx.id);
  if (!c) return { html: empty('ไม่พบลูกค้า') };
  const tab = ctx.params.get('tab') || 'info';
  const s = stats().get(c.id);
  const cy = cycleOf(c.id);
  const all = ordersOf(c.id);
  const phone = telOf(c.phone);
  const open = openTasksOf(c.id).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  const tabs = [['info', 'ข้อมูลร้าน'], ['purchases', `ประวัติซื้อ ${all.length}`], ['products', 'สินค้าประจำ'], ['activity', 'กิจกรรม']];
  const lineUrl = lineOf(c);

  let body = '';
  if (tab === 'info') {
    const rows = [
      ['รหัสลูกค้า', c.code], ['ประเภทธุรกิจ', c.businessType], ['ผู้ติดต่อ', c.contact], ['เบอร์โทร', c.phone], ['LINE', c.line],
      ['ที่อยู่', c.address], ['ถนน', c.road], ['แขวง/ตำบล', c.subdistrict], ['เขต/อำเภอ', c.district], ['จังหวัด', c.province], ['รหัสไปรษณีย์', c.postcode],
      ['Zone', c.zone], ['ผู้ดูแล', c.owner], ['เงื่อนไข', c.terms], ['เครดิต', c.credit], ['แท็ก', c.tags], ['บันทึก', c.note],
    ].filter(([, v]) => v);
    body = `
      ${c.photo ? `<img class="photo" alt="รูปหน้าร้าน" src="${esc(c.photo)}">` : ''}
      <section class="card info">${rows.map(([k, v]) => `<div><span>${k}</span><p>${esc(v)}</p></div>`).join('') || empty('ยังไม่มีข้อมูลเพิ่มเติม')}
        ${c.lat ? `<div><span>พิกัด</span><p>${num(c.lat)}, ${num(c.lng)} (±${c.accuracy ?? '-'} ม.)</p></div>` : ''}</section>
      <div class="actions"><a class="btn" href="${path('customer-edit', c.id)}">${icon('edit')} แก้ไขข้อมูล</a>
        <a class="btn" href="${path('store-data', c.id, '?k=customers')}">${icon('camera')} เก็บข้อมูลหน้าร้าน</a></div>
      <section class="card"><h2>งานค้าง <span class="count">${num(open.length)}</span></h2>
        ${open.length ? `<ul class="plain">${open.map((x) => `<li><span>${esc(x.title || x.type || 'งาน')}</span><small>${thaiDate(x.dueDate)} ${esc(x.dueTime || '')}</small></li>`).join('')}</ul>` : empty('ไม่มีงานค้าง')}</section>`;
  } else if (tab === 'purchases') {
    body = `<div class="actions"><a class="btn" href="${path('notify', undefined, '?customer=' + encodeURIComponent(c.id))}">${icon('file')} แจ้งยอดซื้อ</a></div>
      ${all.length ? `<ul class="list">${all.slice(0, 200).map((o) => orderRow(o)).join('')}</ul>` : empty('ยังไม่มีประวัติซื้อ')}`;
  } else if (tab === 'products') {
    const prod = [...productIdx(c.id).entries()].sort((a, b) => b[1].count - a[1].count);
    body = prod.length ? `<ul class="list">${prod.map(([name, p]) => `<li><a href="${path('product', p.code || name)}">
      <div><b>${esc(name)}</b><small>ซื้อ ${p.count} ครั้ง · ล่าสุด ${thaiDate(p.date)}</small></div>
      <div class="right"><b>${p.price != null ? money(p.price) : '-'}</b><small>${num(p.qty)} ${esc(p.unit || '')}</small></div></a></li>`).join('')}</ul>` : empty('ยังไม่มีสินค้าที่ซื้อประจำ');
  } else {
    const acts = activities().filter((a) => a.customerId === c.id).sort((a, b) => b.at - a.at);
    body = `<div class="actions"><button class="btn" data-act="act-note" data-kind="note">${icon('note')} ติดตาม</button>
        <button class="btn" data-act="act-note" data-kind="visit">${icon('pin')} เข้าพบ</button></div>
      <ul class="timeline">${acts.map((a) => `<li><span class="dot"></span><div class="tl-body"><div class="tl-head"><b>${esc(KIND[a.kind] || a.kind)}</b> <small>${fmtDateTime(a.at)}</small></div>${a.text ? `<p>${esc(a.text)}</p>` : ''}</div></li>`).join('') || '<li class="empty-li">ยังไม่มีกิจกรรม</li>'}</ul>`;
  }

  return {
    html: `
    <div class="head"><a href="${path('customers')}" class="back">${icon('chevLeft')} ลูกค้า</a>
      ${c.src ? '<span class="src">ข้อมูลจาก A-CRM</span>' : ''}</div>
    <h1>${esc(c.name)}</h1>
    <p class="sub">${esc([c.code, c.businessType, c.zone].filter(Boolean).join(' · '))} ${cy.key !== 'normal' && cy.key !== 'none' ? badge(cy.label, CYCLE_BADGE[cy.key]) : ''}</p>
    <div class="actions">
      ${phone ? `<a class="btn" href="tel:${esc(phone)}" data-act="call-log" data-ref="customerId:${esc(c.id)}">${icon('phone')} โทร</a>` : ''}
      ${lineUrl ? `<a class="btn" href="${esc(lineUrl)}" target="_blank" rel="noopener">${icon('message')} LINE</a>` : ''}
      <a class="btn" href="${esc(mapsOf(c))}" target="_blank" rel="noopener">${icon('pin')} นำทาง</a>
    </div>
    <div class="quick-row">
      <button class="btn small" data-act="new-task">${icon('calendar')} นัด</button>
      <button class="btn small" data-act="act-note" data-kind="visit">${icon('pin')} เข้าพบ</button>
      <button class="btn small" data-act="act-note" data-kind="note">${icon('note')} ติดตาม</button>
      <a class="btn small" href="${path('notify', undefined, '?customer=' + encodeURIComponent(c.id))}">${icon('file')} แจ้งยอด</a>
    </div>
    <div class="kpis">
      <div class="kpi"><span>ยอดซื้อรวม</span><b>${money(s?.total)}</b></div>
      <div class="kpi"><span>จำนวน${isAcrm() ? 'บิล' : 'ออเดอร์'}</span><b>${num(s?.count || 0)}</b></div>
      <div class="kpi"><span>ซื้อล่าสุด</span><b>${s?.last ? thaiDate(s.last) : '-'}</b>${s?.days != null ? `<small>${s.days} วันก่อน</small>` : ''}</div>
      <div class="kpi"><span>ซื้อเฉลี่ยทุก</span><b>${s?.cycle ? `${s.cycle} วัน` : '-'}</b></div>
    </div>
    ${chips(tabs, tab, 'tab')}
    ${body}
    <a class="btn primary wide sticky-cta" href="${path('order-edit', 'new', '?customer=' + encodeURIComponent(c.id))}">${icon('cart')} รับออเดอร์</a>`,
    on: {
      'click:tab': (el) => ctx.go(`customer/${encodeURIComponent(c.id)}?tab=${el.dataset.key}`),
      'click:new-task': () => openTaskSheet({ ref: { customerId: c.id } }),
      'click:act-note': (el) => openNoteSheet({ ref: { customerId: c.id }, kind: el.dataset.kind, title: el.dataset.kind === 'visit' ? 'บันทึกเข้าพบ' : 'บันทึกติดตาม' }),
      'click:call-log': (el) => { const [k, v] = el.dataset.ref.split(':'); logActivity({ [k]: v }, 'call', 'โทรออก'); },
    },
  };
}

function orderRow(o) {
  const tot = core.orderTotal(o);
  return `<li><a href="${path('order', o.id)}">
    <div><b>${o.kind === 'bill' ? 'บิล ' : ''}${esc(o.no)}</b><small>${thaiDate(o.date)} · ${(o.items || []).length} รายการ</small></div>
    <div class="right"><b>${o.priceUnknown ? 'ไม่ทราบราคา' : money(tot)}</b></div></a></li>`;
}

// ---------- customer form ----------
export function customerEditPage(ctx) {
  const isNew = ctx.id === 'new';
  const c = isNew ? {} : db.get('customers', ctx.id);
  if (!isNew && !c) return { html: empty('ไม่พบลูกค้า') };
  if (c?.src || (isNew && isAcrm())) return { html: empty('ข้อมูลลูกค้าแก้ไขได้ในระบบ A-CRM เท่านั้น') };
  const extra = String(c.phone || '').split(',').map((p) => p.trim()).filter(Boolean).slice(1);
  const provinces = [...new Set([...db.masters.provinces, ...customers().map((x) => x.province).filter(Boolean)])].sort();
  const opts = (list, v) => [['', '— เลือก —'], ...list.map((x) => [x, x])].map(([val, l]) => `<option value="${esc(val)}" ${val === (v || '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
  return {
    html: `
    <div class="head"><a href="${isNew ? path('customers') : path('customer', c.id)}" class="back">${icon('chevLeft')} ยกเลิก</a></div>
    <h1>${isNew ? 'เพิ่มลูกค้า' : 'แก้ไขลูกค้า'}</h1>
    <form class="form" data-form="customer">
      ${field('name', 'ชื่อร้าน *', c.name, 'required autocomplete="off"')}
      <label class="fld"><span>ประเภทธุรกิจ</span><select name="businessType">${opts(db.masters.businessTypes, c.businessType)}</select></label>
      ${field('contact', 'ชื่อผู้ติดต่อ', c.contact)}
      <div class="fld-group">
        ${field('phone', 'เบอร์โทร', c.phone, 'type="tel" inputmode="tel"')}
        <div data-region="extra-phones">${extra.map((p) => field('extraPhone', 'เบอร์เพิ่มเติม', p, 'type="tel" inputmode="tel"')).join('')}</div>
        <button type="button" class="btn small ghost" data-act="add-phone">${icon('plus')} เพิ่มเบอร์</button>
      </div>
      ${field('line', 'LINE', c.line)}
      ${area('address', 'ที่อยู่', c.address, 2)}
      <div class="row2">${field('road', 'ถนน', c.road)}${field('subdistrict', 'แขวง/ตำบล', c.subdistrict)}</div>
      <div class="row2">${field('district', 'เขต/อำเภอ', c.district)}
        <label class="fld"><span>จังหวัด</span><input name="province" list="provlist" value="${esc(c.province || '')}" autocomplete="off"><datalist id="provlist">${provinces.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label></div>
      <div class="row2">${field('postcode', 'รหัสไปรษณีย์', c.postcode, 'inputmode="numeric"')}
        <label class="fld"><span>Zone</span><select name="zone">${opts(db.masters.zones, c.zone)}</select></label></div>
      <div class="row2"><label class="fld"><span>ผู้ดูแล</span><select name="owner">${opts(db.masters.owners, c.owner)}</select></label>
        <label class="fld"><span>เงื่อนไข</span><select name="terms">${opts(db.masters.terms, c.terms)}</select></label></div>
      ${field('credit', 'เครดิต (บาท)', c.credit, 'type="number" inputmode="decimal" min="0"')}
      ${field('tags', 'แท็ก (คั่นด้วยจุลภาค)', c.tags, 'placeholder="VIP, ขายส่ง"')}
      <section class="card">
        <h2>รูปหน้าร้านและพิกัด</h2>
        <input type="hidden" name="photo" value="${esc(c.photo || '')}">
        <input type="hidden" name="lat" value="${esc(c.lat ?? '')}"><input type="hidden" name="lng" value="${esc(c.lng ?? '')}">
        <input type="hidden" name="accuracy" value="${esc(c.accuracy ?? '')}"><input type="hidden" name="gpsAt" value="${esc(c.gpsAt ?? '')}">
        <div data-region="photo">${c.photo ? `<img class="photo" alt="รูปหน้าร้าน" src="${esc(c.photo)}">` : ''}</div>
        <div class="actions"><label class="btn file">${icon('camera')} ถ่ายรูป<input type="file" accept="image/*" capture="environment" data-ch="photo" hidden></label>
          <button type="button" class="btn" data-act="gps">${icon('pin')} เก็บพิกัด</button></div>
        <p class="hint" data-region="gps">${c.lat ? `Latitude ${num(c.lat)} · Longitude ${num(c.lng)} (±${c.accuracy ?? '-'} ม.)` : 'ยังไม่มีพิกัด'}</p>
      </section>
      ${area('note', 'บันทึก', c.note, 3)}
      <button class="btn primary wide">บันทึก</button>
      ${isNew ? '' : '<button type="button" class="btn danger wide" data-act="delete">ลบลูกค้า</button>'}
    </form>`,
    on: {
      'click:add-phone': () => document.querySelector('[data-region=extra-phones]')
        .insertAdjacentHTML('beforeend', field('extraPhone', 'เบอร์เพิ่มเติม', '', 'type="tel" inputmode="tel"')),
      'change:photo': async (el) => {
        const file = el.files?.[0];
        if (!file) return;
        try {
          const data = await readPhoto(file);
          el.form.photo.value = data;
          region('photo', `<img class="photo" alt="รูปหน้าร้าน" src="${esc(data)}">`);
        } catch (e) { toast(e.message); }
      },
      'click:gps': async () => {
        region('gps', 'กำลังหาตำแหน่ง…');
        try {
          const g = await captureGps();
          const f = document.querySelector('form[data-form=customer]');
          f.lat.value = g.lat; f.lng.value = g.lng; f.accuracy.value = g.accuracy; f.gpsAt.value = g.at;
          region('gps', `Latitude ${num(g.lat)} · Longitude ${num(g.lng)} (±${g.accuracy} ม.)${g.accuracy > 50 ? ' · ความแม่นยำต่ำ' : ''}`);
        } catch (e) { region('gps', e.message); }
      },
      'click:delete': async () => {
        if (!(await confirmSheet('ลบลูกค้ารายนี้? ออเดอร์เดิมยังอยู่', 'ลบลูกค้า', true))) return;
        db.remove('customers', c.id);
        toast('ลบลูกค้าแล้ว');
        ctx.go('customers');
      },
      'submit:customer': async (form) => {
        const d = Object.fromEntries(new FormData(form));
        const phones = [d.phone, ...[...form.querySelectorAll('[name=extraPhone]')].map((el) => el.value)].map((p) => p.trim()).filter(Boolean);
        const data = {
          name: d.name.trim(), businessType: d.businessType, contact: d.contact.trim(), phone: phones.join(', '), line: d.line.trim(),
          address: d.address.trim(), road: d.road.trim(), subdistrict: d.subdistrict.trim(), district: d.district.trim(),
          province: d.province.trim(), postcode: d.postcode.trim(), zone: d.zone, owner: d.owner, terms: d.terms,
          credit: d.credit ? +d.credit : '', tags: d.tags.trim(), note: d.note.trim(), photo: d.photo,
          lat: d.lat ? +d.lat : '', lng: d.lng ? +d.lng : '', accuracy: d.accuracy ? +d.accuracy : '', gpsAt: d.gpsAt ? +d.gpsAt : '',
        };
        if (!data.name) { toast('กรุณาใส่ชื่อร้าน'); return; }
        const dups = core.findDuplicateCustomers({ ...data, id: isNew ? '' : c.id }, customers());
        if (dups.length && !(await confirmSheet(`พบลูกค้าที่อาจซ้ำ: ${dups.slice(0, 3).map((x) => customerLabel(x)).join(', ')} — บันทึกต่อไหม?`, 'บันทึกต่อ'))) return;
        const rec = db.save('customers', isNew ? data : { ...data, id: c.id }, { action: isNew ? 'เพิ่มลูกค้า' : 'แก้ไขลูกค้า' });
        toast('บันทึกลูกค้าแล้ว');
        ctx.go('customer/' + encodeURIComponent(rec.id));
      },
    },
  };
}

// ---------- target shops ----------
export function leadsPage(ctx) {
  const st = ctx.state;
  st.status ||= 'all';
  const render = () => {
    const q = (st.q || '').trim();
    let list = leads();
    if (q) { const ids = new Set(core.search(searchIdx(), q, 100000).leads); list = list.filter((l) => ids.has(l.id)); }
    if (st.status !== 'all') list = list.filter((l) => (l.status || 'none') === st.status);
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const next = nextTaskByLead();
    region('results', `<p class="count">${num(list.length)} ร้าน</p>
      ${list.length ? `<ul class="cards">${list.slice(0, st.limit || PAGE).map((l) => `<li class="card-row">
        <a class="card-link" href="${path('lead', l.id)}">
          <div class="card-top"><b>${esc(l.name)}</b>${badge(LEAD_STATUS[l.status || 'none'] || 'ยังไม่ติดตาม', l.status === 'declined' ? 'muted' : 'info')}</div>
          <small>${esc([l.businessType, l.area || l.province, telOf(l.phone)].filter(Boolean).join(' · '))}</small>
          <div class="card-meta">${next[l.id] ? `<span>นัดถัดไป ${thaiDate(next[l.id])}</span>` : ''}${l.lastResult ? `<span>ผล: ${esc(l.lastResult)}</span>` : ''}</div>
        </a>
        <div class="card-actions">
          ${telOf(l.phone) ? `<a class="btn small" href="tel:${esc(telOf(l.phone))}" data-act="call-log" data-ref="leadId:${esc(l.id)}">${icon('phone')} โทร</a>` : ''}
          <a class="btn small" href="${esc(mapsOf(l))}" target="_blank" rel="noopener">${icon('pin')} นำทาง</a>
        </div></li>`).join('')}</ul>` : empty('ยังไม่มีร้านในรายการนี้')}`);
  };
  return {
    html: `
    <div class="page-top"><h1>ลูกค้า</h1><a class="btn primary small" href="${path('lead-edit', 'new')}">${icon('plus')} เพิ่มร้าน</a></div>
    ${chips([['customers', 'ลูกค้า'], ['leads', 'ร้านเป้าหมาย']], 'leads', 'seg')}
    <input class="search" type="search" placeholder="ค้นหาร้าน ชื่อ / เบอร์ / ถนน / พื้นที่" data-in="q" value="${esc(st.q || '')}" autocomplete="off">
    ${chips([['all', 'ทั้งหมด'], ...Object.entries(LEAD_STATUS).filter(([k]) => k !== 'converted').map(([k, v]) => [k, v])], st.status, 'status')}
    <div data-region="results"></div>`,
    on: {
      'click:seg': (el) => ctx.go(el.dataset.key === 'leads' ? 'leads' : 'customers'),
      'input:q': (el) => { st.q = el.value; render(); },
      'click:status': (el) => { st.status = el.dataset.key; ctx.rerender(); },
      'click:call-log': (el) => { const [k, v] = el.dataset.ref.split(':'); logActivity({ [k]: v }, 'call', 'โทรออก'); },
    },
    onMount: render,
  };
}

function nextTaskByLead() {
  const out = {};
  for (const t of tasks()) {
    if (!t.leadId || t.status === 'done' || !t.dueDate) continue;
    if (!out[t.leadId] || t.dueDate < out[t.leadId]) out[t.leadId] = t.dueDate;
  }
  return out;
}

export function leadPage(ctx) {
  const l = db.get('leads', ctx.id);
  if (!l) return { html: empty('ไม่พบร้านนี้') };
  const acts = activities().filter((a) => a.leadId === l.id).sort((a, b) => b.at - a.at);
  const open = tasks().filter((t) => t.leadId === l.id && t.status !== 'done');
  const dups = core.findDuplicateCustomers(l, customers());
  return {
    html: `
    <div class="head"><a href="${path('leads')}" class="back">${icon('chevLeft')} ร้านเป้าหมาย</a></div>
    <h1>${esc(l.name)}</h1>
    <p class="sub">${esc([l.businessType, l.area].filter(Boolean).join(' · '))} ${badge(LEAD_STATUS[l.status || 'none'] || '', 'info')}</p>
    <div class="actions">
      ${telOf(l.phone) ? `<a class="btn" href="tel:${esc(telOf(l.phone))}" data-act="call-log" data-ref="leadId:${esc(l.id)}">${icon('phone')} โทร</a>` : ''}
      ${l.line ? `<a class="btn" href="https://line.me/ti/p/~${encodeURIComponent(l.line)}" target="_blank" rel="noopener">${icon('message')} LINE</a>` : ''}
      <a class="btn" href="${esc(mapsOf(l))}" target="_blank" rel="noopener">${icon('pin')} นำทาง</a>
    </div>
    <div class="quick-row">
      <a class="btn small" href="${path('lead-edit', l.id)}">${icon('edit')} แก้ไข</a>
      <button class="btn small" data-act="follow">${icon('note')} ติดตาม</button>
      <button class="btn small" data-act="task">${icon('calendar')} นัด</button>
      <button class="btn small" data-act="visit">${icon('pin')} เข้าพบ</button>
      <button class="btn small" data-act="propose">${icon('box')} เสนอสินค้า</button>
    </div>
    <section class="card info">
      ${[['เบอร์โทร', l.phone], ['LINE', l.line], ['ที่อยู่', l.address], ['พื้นที่', l.area], ['Zone', l.zone], ['แท็ก', l.tags], ['ผลติดตามล่าสุด', l.lastResult], ['บันทึก', l.note]]
    .filter(([, v]) => v).map(([k, v]) => `<div><span>${k}</span><p>${esc(v)}</p></div>`).join('') || empty('ยังไม่มีข้อมูลเพิ่มเติม')}
    </section>
    ${open.length ? `<section class="card"><h2>นัดถัดไป</h2><ul class="plain">${open.map((x) => `<li><span>${esc(x.title || x.type)}</span><small>${thaiDate(x.dueDate)} ${esc(x.dueTime || '')}</small></li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>ประวัติ</h2>
      <ul class="timeline">${acts.map((a) => `<li><span class="dot"></span><div class="tl-body"><div class="tl-head"><b>${esc(KIND[a.kind] || a.kind)}</b></div>${a.text ? `<p>${esc(a.text)}</p>` : ''}</div></li>`).join('') || '<li class="empty-li">ยังไม่มีประวัติ</li>'}</ul></section>
    <button class="btn primary wide" data-act="convert">เปลี่ยนเป็นลูกค้า${dups.length ? ' (มีรายการที่อาจซ้ำ)' : ''}</button>`,
    on: {
      'click:call-log': (el) => { const [k, v] = el.dataset.ref.split(':'); logActivity({ [k]: v }, 'call', 'โทรออก'); },
      'click:follow': () => openNoteSheet({ ref: { leadId: l.id }, title: 'บันทึกผลติดตาม', withStatus: true }),
      'click:task': () => openTaskSheet({ ref: { leadId: l.id } }),
      'click:visit': () => openNoteSheet({ ref: { leadId: l.id }, kind: 'visit', title: 'บันทึกเข้าพบ', withStatus: true }),
      'click:propose': () => openProposal(l.id),
      'click:convert': () => convertLead(ctx, l),
    },
  };
}

function convertLead(ctx, l) {
  const dups = core.findDuplicateCustomers(l, customers());
  const create = () => {
    const rec = db.save('customers', {
      name: l.name, businessType: l.businessType, phone: l.phone, line: l.line, address: l.address, road: l.road,
      district: l.district, province: l.province || l.area || '', zone: l.zone, tags: l.tags, note: l.note, photo: l.photo,
      lat: l.lat ?? '', lng: l.lng ?? '', accuracy: l.accuracy ?? '', gpsAt: l.gpsAt ?? '', convertedFrom: l.id,
    }, { action: 'แปลงเป็นลูกค้า' });
    db.save('leads', { id: l.id, convertedTo: rec.id, status: 'converted' }, { action: 'แปลงเป็นลูกค้า' });
    toast('เป็นลูกค้าแล้ว');
    ctx.go('customer/' + encodeURIComponent(rec.id));
  };
  if (!dups.length) { create(); return; }
  openSheet({
    title: 'พบลูกค้าที่อาจซ้ำ',
    html: `<p class="hint-lg">ตรวจพบข้อมูลที่ตรงกับ เบอร์ รหัส หรือชื่อ + จังหวัด เลือกว่าจะใช้ลูกค้าเดิมหรือสร้างใหม่</p>
      <ul class="list">${dups.map((c) => `<li><a href="${path('customer', c.id)}"><div><b>${esc(c.name)}</b><small>${esc([c.code, c.phone].filter(Boolean).join(' · '))}</small></div><div class="right"><button class="btn small" data-act="use" data-id="${esc(c.id)}">ใช้รายนี้</button></div></a></li>`).join('')}</ul>
      <div class="actions"><button class="btn" data-act="new">สร้างลูกค้าใหม่</button></div>`,
    on: {
      'click:use': (el) => {
        db.save('leads', { id: l.id, convertedTo: el.dataset.id, status: 'converted' }, { action: 'เชื่อมกับลูกค้าเดิม' });
        closeSheet();
        toast('เชื่อมกับลูกค้าเดิมแล้ว');
        ctx.go('customer/' + encodeURIComponent(el.dataset.id));
      },
      'click:new': () => { closeSheet(); create(); },
    },
  });
}

export function leadEditPage(ctx) {
  const isNew = ctx.id === 'new';
  const l = isNew ? {} : db.get('leads', ctx.id);
  if (!isNew && !l) return { html: empty('ไม่พบร้านนี้') };
  const opts = (list, v) => [['', '— เลือก —'], ...list.map((x) => [x, x])].map(([val, lb]) => `<option value="${esc(val)}" ${val === (v || '') ? 'selected' : ''}>${esc(lb)}</option>`).join('');
  return {
    html: `
    <div class="head"><a href="${isNew ? path('leads') : path('lead', l.id)}" class="back">${icon('chevLeft')} ยกเลิก</a></div>
    <h1>${isNew ? 'เพิ่มร้านเป้าหมาย' : 'แก้ไขร้าน'}</h1>
    <form class="form" data-form="lead">
      ${field('name', 'ชื่อร้าน *', l.name, 'required autocomplete="off"')}
      ${field('phone', 'เบอร์โทร', l.phone, 'type="tel" inputmode="tel"')}
      ${field('line', 'LINE', l.line)}
      <label class="fld"><span>ประเภทร้าน</span><select name="businessType">${opts(db.masters.businessTypes, l.businessType)}</select></label>
      ${field('area', 'พื้นที่ (เขต/จังหวัด)', l.area || l.province)}
      <label class="fld"><span>Zone</span><select name="zone">${opts(db.masters.zones, l.zone)}</select></label>
      ${area('address', 'ที่อยู่ / ถนน', l.address, 2)}
      <label class="fld"><span>สถานะ</span><select name="status">${Object.entries(LEAD_STATUS).filter(([k]) => k !== 'converted').map(([k, v]) => `<option value="${k}" ${(l.status || 'none') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${field('tags', 'แท็ก', l.tags)}
      ${area('note', 'บันทึก', l.note, 3)}
      <button class="btn primary wide">บันทึก</button>
    </form>`,
    on: {
      'submit:lead': (form) => {
        const d = Object.fromEntries(new FormData(form));
        if (!d.name.trim()) { toast('กรุณาใส่ชื่อร้าน'); return; }
        const rec = db.save('leads', {
          ...(isNew ? {} : { id: l.id }), name: d.name.trim(), phone: d.phone.trim(), line: d.line.trim(), businessType: d.businessType,
          area: d.area.trim(), zone: d.zone, address: d.address.trim(), status: d.status, tags: d.tags.trim(), note: d.note.trim(),
        }, { action: isNew ? 'เพิ่มร้านเป้าหมาย' : 'แก้ไขร้านเป้าหมาย' });
        toast('บันทึกแล้ว');
        ctx.go('lead/' + encodeURIComponent(rec.id));
      },
    },
  };
}

