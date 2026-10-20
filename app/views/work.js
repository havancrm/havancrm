// Tasks (งาน), customer cycles (รอบลูกค้า), activity timeline (กิจกรรม), map (แผนที่),
// store data collection (เก็บข้อมูลหน้าร้าน), and the shared sheets for notes, visits and tasks.
import * as db from '../db.js';
import { esc, num, thaiDate, today, addDays, customerLabel, taskBucket } from '../core.js';
import { icon, path, badge, empty, chips, field, area, select, openSheet, closeSheet, sheetBody, toast, region, captureGps, readPhoto, fmtDateTime } from '../ui.js';
import { customers, leads, tasks, activities, cycleOf, stats } from '../derived.js';

export const KIND = { call: 'โทร', visit: 'เข้าพบ', appointment: 'นัดหมาย', note: 'ติดตาม', statement: 'แจ้งยอด', order: 'รับออเดอร์', purchase: 'ซื้อสินค้า', proposal: 'เสนอสินค้า' };
const CYCLE_BADGE = { overdue: 'warn', due: 'warn', near: 'info', normal: 'muted', none: 'muted' };
export const findCustomer = (label) => {
  const v = String(label || '').trim();
  return customers().find((c) => customerLabel(c) === v || c.code === v || c.name === v) || null;
};
const telOf = (s) => String(s || '').replace(/[^\d+]/g, '').split(/[,;/]/)[0];
const mapsOf = (c) => c.mapLink || (c.lat && c.lng ? `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([c.address, c.district, c.province].filter(Boolean).join(' '))}`);

// ---------- writes shared by many screens ----------
export function logActivity(ref, kind, text = '') {
  return db.save('activities', { ...ref, kind, text, at: Date.now(), by: db.getUser() }, { action: 'บันทึกกิจกรรม' });
}

// Visit / follow-up note. For leads, the outcome can also move the lead to another status.
export function openNoteSheet({ ref, kind = 'note', title = 'บันทึกติดตาม', withStatus = false }) {
  const status = withStatus ? [['', '— ไม่เปลี่ยน —'], ...Object.entries(LEAD_STATUS).map(([k, v]) => [k, v])] : null;
  openSheet({
    title,
    html: `<form class="form" data-form="note">
      ${area('text', 'ผลการติดตาม / บันทึก', '', 4)}
      ${status ? select('status', 'สถานะร้านเป้าหมาย', status, '') : ''}
      <button class="btn primary wide">บันทึก</button>
    </form>`,
    on: {
      'submit:note': (form) => {
        const text = form.text.value.trim();
        if (!text) { toast('กรุณาพิมพ์บันทึก'); return; }
        logActivity(ref, kind, text);
        if (status && form.status.value && ref.leadId) db.save('leads', { id: ref.leadId, status: form.status.value, lastResult: text });
        closeSheet();
        toast('บันทึกแล้ว');
      },
    },
  });
}

export function openTaskSheet({ ref = null, date = '', title = '', type = '' } = {}) {
  const types = db.masters.taskTypes.map((t) => [t, t]);
  openSheet({
    title: 'นัด / สร้างงาน',
    html: `<form class="form" data-form="task">
      ${ref ? '' : `<label class="fld"><span>ร้านค้า</span><input name="customer" list="custlist" placeholder="พิมพ์ชื่อหรือรหัสลูกค้า" required autocomplete="off"></label>
        <datalist id="custlist">${customers().map((c) => `<option value="${esc(customerLabel(c))}">`).join('')}</datalist>`}
      ${select('type', 'ประเภทงาน', types, type || types[0]?.[0])}
      ${field('title', 'หัวข้อ', title, 'placeholder="เช่น นัดส่งตัวอย่าง"')}
      <div class="row2">${field('dueDate', 'วันที่', date || today(), 'type="date" required')}${field('dueTime', 'เวลา', '', 'type="time"')}</div>
      ${area('note', 'บันทึก', '', 2)}
      <button class="btn primary wide">บันทึกงาน</button>
    </form>`,
    on: {
      'submit:task': (form) => {
        const cust = ref ? null : findCustomer(form.customer?.value);
        if (!ref && !cust) { toast('ไม่พบลูกค้า — เลือกจากรายชื่อ'); return; }
        const r = ref || { customerId: cust.id };
        db.save('tasks', {
          ...r, type: form.type.value, title: form.title.value.trim() || form.type.value,
          dueDate: form.dueDate.value, dueTime: form.dueTime.value, note: form.note.value.trim(), status: 'open',
        }, { action: 'สร้างงาน' });
        closeSheet();
        toast('บันทึกงานแล้ว');
      },
    },
  });
}

const LEAD_STATUS = { none: 'ยังไม่ติดตาม', follow: 'ต้องติดตาม', interested: 'สนใจ', appointed: 'นัดแล้ว', proposed: 'เข้าเสนอแล้ว', declined: 'ไม่สนใจ', converted: 'เป็นลูกค้าแล้ว' };
export { LEAD_STATUS };

// ---------- tasks ----------
export function tasksPage(ctx) {
  const tab = ctx.params.get('tab') || ctx.state.tab || 'today';
  const filter = ctx.state.filter || 'all';
  ctx.state.tab = tab;
  const t = today();
  const open = tasks().filter((x) => x.status !== 'done');
  const show = (x) => (x.status === 'done' ? 'done' : taskBucket(x, t));
  const cycles = customers().map((c) => ({ c, cy: cycleOf(c.id) })).filter(({ cy }) => cy.key !== 'normal' && cy.key !== 'none');
  // Cycle items show under the matching tab: overdue cycles under เลยกำหนด, due under วันนี้, near under ล่วงหน้า.
  const cycleTab = { overdue: 'overdue', today: 'due', upcoming: 'near' };

  let rows = [];
  if (filter !== 'cycle') {
    rows = tab === 'done'
      ? tasks().filter((x) => x.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
      : open.filter((x) => show(x) === tab).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '') || (a.dueTime || '').localeCompare(b.dueTime || ''));
  }
  const cycleRows = filter !== 'appt' && cycleTab[tab] ? cycles.filter(({ cy }) => cy.key === cycleTab[tab]) : [];
  const counts = { overdue: open.filter((x) => show(x) === 'overdue').length, today: open.filter((x) => show(x) === 'today').length, upcoming: open.filter((x) => show(x) === 'upcoming').length, done: tasks().filter((x) => x.status === 'done').length };

  const taskCard = (x) => {
    const cust = x.customerId ? db.get('customers', x.customerId) : null;
    const lead = x.leadId ? db.get('leads', x.leadId) : null;
    const name = cust?.name || lead?.name || '(ไม่ระบุร้าน)';
    const phone = telOf(cust?.phone || lead?.phone);
    const open_ = x.status !== 'done';
    return `<li class="task ${open_ && x.dueDate < t ? 'is-late' : ''}">
      <div class="task-main">
        <a class="strong" href="${path(cust ? 'customer' : 'lead', cust?.id || lead?.id)}">${esc(name)}</a>
        <small>${badge(x.type || 'งาน', 'info')} ${esc(x.title || '')} · ${thaiDate(x.dueDate)}${x.dueTime ? ' ' + esc(x.dueTime) : ''}</small>
        ${x.note ? `<small>${esc(x.note)}</small>` : ''}
      </div>
      ${open_ ? `<div class="task-actions">
        ${phone ? `<a class="btn small" href="tel:${esc(phone)}" data-act="call-log" data-ref="${cust ? 'customerId' : 'leadId'}:${esc(cust?.id || lead?.id)}">${icon('phone')}</a>` : ''}
        <a class="btn small" href="${esc(mapsOf(cust || lead || {}))}" target="_blank" rel="noopener">${icon('pin')}</a>
        <button class="btn small" data-act="task-done" data-id="${esc(x.id)}">เสร็จ</button>
        <button class="btn small ghost" data-act="task-resched" data-id="${esc(x.id)}">เลื่อน</button>
      </div>` : `<div class="task-actions"><button class="btn small ghost" data-act="task-reopen" data-id="${esc(x.id)}">เปิดใหม่</button></div>`}
    </li>`;
  };

  const cycleCard = ({ c, cy }) => `<li class="task">
    <div class="task-main">
      <a class="strong" href="${path('customer', c.id)}">${esc(c.name)}</a>
      <small>${badge(cy.label, CYCLE_BADGE[cy.key])} ${cy.cycle ? `ปกติทุก ~${cy.cycle} วัน · ` : ''}ไม่ได้ซื้อ ${cy.days ?? '-'} วัน</small>
    </div>
    <div class="task-actions">
      ${telOf(c.phone) ? `<a class="btn small" href="tel:${esc(telOf(c.phone))}" data-act="call-log" data-ref="customerId:${esc(c.id)}">${icon('phone')}</a>` : ''}
      <button class="btn small" data-act="visit" data-id="${esc(c.id)}">เข้าพบ</button>
      <button class="btn small ghost" data-act="snooze" data-id="${esc(c.id)}">เลื่อน 7 วัน</button>
    </div>
  </li>`;

  const tabItems = [['overdue', `เลยกำหนด ${counts.overdue}`], ['today', `วันนี้ ${counts.today}`], ['upcoming', `ล่วงหน้า ${counts.upcoming}`], ['done', `เสร็จแล้ว ${counts.done}`]];
  const listHtml = [
    ...rows.map(taskCard),
    ...cycleRows.map(cycleCard),
  ];
  return {
    html: `
    <div class="page-top"><h1>งาน</h1><button class="btn primary small" data-act="new-task">${icon('plus')} เพิ่มงาน</button></div>
    ${chips(tabItems, tab, 'tab')}
    ${chips([['all', 'ทั้งหมด'], ['appt', 'นัด & ติดตาม'], ['cycle', 'รอบลูกค้า']], filter, 'filter')}
    <ul class="list tasks">${listHtml.join('') || ''}</ul>
    ${listHtml.length ? '' : empty(tab === 'done' ? 'ยังไม่มีงานที่เสร็จ' : 'ไม่มีงานในรายการนี้')}`,
    on: {
      'click:tab': (el) => ctx.go(`tasks?tab=${el.dataset.key}`),
      'click:filter': (el) => { ctx.state.filter = el.dataset.key; ctx.rerender(); },
      'click:new-task': () => openTaskSheet({}),
      'click:task-done': (el) => { db.save('tasks', { id: el.dataset.id, status: 'done', doneAt: Date.now() }, { action: 'เสร็จงาน' }); toast('ทำงานเสร็จแล้ว'); },
      'click:task-reopen': (el) => { db.save('tasks', { id: el.dataset.id, status: 'open', doneAt: 0 }, { action: 'เปิดงานใหม่' }); },
      'click:task-resched': (el) => reschedule(el.dataset.id),
      'click:call-log': (el) => { const [k, v] = el.dataset.ref.split(':'); logActivity({ [k]: v }, 'call', 'โทรออก'); },
      'click:visit': (el) => openNoteSheet({ ref: { customerId: el.dataset.id }, kind: 'visit', title: 'บันทึกเข้าพบ' }),
      'click:snooze': (el) => { db.save('customers', { id: el.dataset.id, snoozeUntil: addDays(today(), 7) }, { action: 'เลื่อนรอบ' }); toast('เลื่อนรอบ 7 วันแล้ว'); },
    },
  };
}

function reschedule(id) {
  const x = tasks().find((r) => r.id === id);
  if (!x) return;
  const t = today();
  openSheet({
    title: 'เลื่อนงาน',
    html: `<form class="form" data-form="resched">
      ${field('dueDate', 'วันที่ใหม่', x.dueDate || t, 'type="date" required')}
      <div class="chips"><button type="button" class="chip" data-act="quick" data-days="1">พรุ่งนี้</button>
        <button type="button" class="chip" data-act="quick" data-days="7">อีก 7 วัน</button></div>
      <button class="btn primary wide">บันทึก</button></form>`,
    on: {
      'click:quick': (el) => { sheetBody().querySelector('[name=dueDate]').value = addDays(t, +el.dataset.days); },
      'submit:resched': (form) => { db.save('tasks', { id, dueDate: form.dueDate.value }, { action: 'เลื่อนงาน' }); closeSheet(); toast('เลื่อนงานแล้ว'); },
    },
  });
}

// ---------- cycles ----------
export function cyclesPage(ctx) {
  const t = today();
  const groups = { overdue: [], due: [], near: [], normal: [] };
  for (const c of customers()) {
    const cy = cycleOf(c.id);
    if (cy.key === 'none') continue;
    (groups[cy.key] || groups.normal).push({ c, cy });
  }
  for (const g of Object.values(groups)) g.sort((a, b) => (b.cy.days ?? 0) - (a.cy.days ?? 0));
  const card = ({ c, cy }) => `<li class="task">
    <div class="task-main">
      <a class="strong" href="${path('customer', c.id)}">${esc(c.name)}</a>
      <small>ซื้อล่าสุด ${thaiDate(stats().get(c.id)?.last)} · รอบเฉลี่ย ${cy.cycle ? cy.cycle + ' วัน' : '-'} · ผ่านมา ${cy.days ?? '-'} วัน</small>
      <small>${badge(cy.label, CYCLE_BADGE[cy.key])}</small>
    </div>
    <div class="task-actions">
      ${telOf(c.phone) ? `<a class="btn small" href="tel:${esc(telOf(c.phone))}" data-act="call-log" data-ref="customerId:${esc(c.id)}">${icon('phone')}</a>` : ''}
      <a class="btn small" href="${esc(mapsOf(c))}" target="_blank" rel="noopener">${icon('pin')}</a>
      <button class="btn small" data-act="visit" data-id="${esc(c.id)}">เข้าพบ</button>
      <button class="btn small ghost" data-act="snooze" data-id="${esc(c.id)}">เลื่อน</button>
    </div>
  </li>`;
  const section = (key, title) => `<section class="card"><h2>${title} <span class="count">${num(groups[key].length)}</span></h2>
    ${groups[key].length ? `<ul class="list tasks">${groups[key].slice(0, 60).map(card).join('')}</ul>${groups[key].length > 60 ? `<p class="hint">แสดง 60 รายการแรก</p>` : ''}` : empty('ไม่มีร้านในกลุ่มนี้')}</section>`;
  return {
    html: `<h1>รอบลูกค้า</h1>
      <p class="sub">วันนี้ ${thaiDate(t)} · เรียงจากร้านที่ไม่ได้ซื้อนานที่สุด</p>
      ${section('overdue', 'เลยรอบ')}${section('due', 'ถึงรอบ')}${section('near', 'ใกล้ถึงรอบ')}${section('normal', 'ปกติ')}`,
    on: {
      'click:call-log': (el) => { const [k, v] = el.dataset.ref.split(':'); logActivity({ [k]: v }, 'call', 'โทรออก'); },
      'click:visit': (el) => openNoteSheet({ ref: { customerId: el.dataset.id }, kind: 'visit', title: 'บันทึกเข้าพบ' }),
      'click:snooze': (el) => { db.save('customers', { id: el.dataset.id, snoozeUntil: addDays(t, 7) }, { action: 'เลื่อนรอบ' }); toast('เลื่อนรอบ 7 วันแล้ว'); },
    },
  };
}

// ---------- activity timeline ----------
export function activitiesPage(ctx) {
  const f = ctx.state.filter || 'all';
  const rows = activities()
    .filter((a) => f === 'all' || a.kind === f || (f === 'order' && (a.kind === 'order' || a.kind === 'purchase')))
    .sort((a, b) => b.at - a.at)
    .slice(0, 300);
  return {
    html: `
    <div class="page-top"><h1>กิจกรรม</h1><button class="btn primary small" data-act="new-activity">${icon('plus')} เพิ่มกิจกรรม</button></div>
    ${chips([['all', 'ทั้งหมด'], ...Object.entries(KIND).filter(([k]) => ['call', 'visit', 'appointment', 'note', 'statement', 'order', 'proposal'].includes(k)).map(([k, v]) => [k, v])], f, 'filter')}
    <ul class="timeline">${rows.map((a) => {
      const cust = a.customerId ? db.get('customers', a.customerId) : null;
      const lead = a.leadId ? db.get('leads', a.leadId) : null;
      const who = cust?.name || lead?.name || '';
      return `<li>
        <span class="dot"></span>
        <div class="tl-body">
          <div class="tl-head"><b>${esc(KIND[a.kind] || a.kind)}</b> <small>${fmtDateTime(a.at)}</small></div>
          <a href="${path(cust ? 'customer' : 'lead', cust?.id || lead?.id)}">${esc(who || '(ไม่ระบุร้าน)')}</a>
          ${a.text ? `<p>${esc(a.text)}</p>` : ''}
          <div class="tl-actions"><button class="btn small ghost" data-act="edit-act" data-id="${esc(a.id)}">แก้ไข</button>
          <button class="btn small ghost" data-act="hide-act" data-id="${esc(a.id)}">ซ่อน</button></div>
        </div>
      </li>`;
    }).join('') || '<li class="empty-li">ยังไม่มีกิจกรรม</li>'}</ul>`,
    on: {
      'click:filter': (el) => { ctx.state.filter = el.dataset.key; ctx.rerender(); },
      'click:new-activity': () => openActivitySheet(),
      'click:edit-act': (el) => {
        const a = db.get('activities', el.dataset.id);
        if (!a) return;
        openSheet({
          title: 'แก้ไขกิจกรรม',
          html: `<form class="form" data-form="edit-act">${area('text', 'ข้อความ', a.text, 4)}<button class="btn primary wide">บันทึก</button></form>`,
          on: { 'submit:edit-act': (form) => { db.save('activities', { id: a.id, text: form.text.value.trim() }, { action: 'แก้ไขกิจกรรม' }); closeSheet(); toast('แก้ไขแล้ว'); } },
        });
      },
      'click:hide-act': (el) => { db.save('activities', { id: el.dataset.id, hidden: true }, { action: 'ซ่อนกิจกรรม' }); toast('ซ่อนกิจกรรมแล้ว'); },
    },
  };
}

function openActivitySheet() {
  openSheet({
    title: 'เพิ่มกิจกรรม',
    html: `<form class="form" data-form="new-act">
      <label class="fld"><span>ร้านค้า</span><input name="customer" list="custlist" required autocomplete="off" placeholder="พิมพ์ชื่อหรือรหัสลูกค้า"></label>
      <datalist id="custlist">${customers().map((c) => `<option value="${esc(customerLabel(c))}">`).join('')}</datalist>
      ${select('kind', 'ประเภท', Object.entries(KIND).filter(([k]) => k !== 'order' && k !== 'purchase').map(([k, v]) => [k, v]), 'note')}
      ${area('text', 'รายละเอียด', '', 3)}
      <button class="btn primary wide">บันทึก</button></form>`,
    on: {
      'submit:new-act': (form) => {
        const c = findCustomer(form.customer.value);
        if (!c) { toast('ไม่พบลูกค้า — เลือกจากรายชื่อ'); return; }
        logActivity({ customerId: c.id }, form.kind.value, form.text.value.trim());
        closeSheet();
        toast('บันทึกกิจกรรมแล้ว');
      },
    },
  });
}

// ---------- map ----------
const W = 360; const H = 420;
export function mapPage(ctx) {
  const st = ctx.state;
  st.kind ||= 'all'; st.zoom ||= 1;
  const pins = [];
  for (const c of customers()) if (c.lat && c.lng) pins.push({ kind: 'customers', id: c.id, name: c.name, lat: +c.lat, lng: +c.lng, cy: cycleOf(c.id).key, phone: c.phone });
  for (const l of leads()) if (l.lat && l.lng) pins.push({ kind: 'leads', id: l.id, name: l.name, lat: +l.lat, lng: +l.lng, cy: 'lead', phone: l.phone });
  const list = pins.filter((p) => st.kind === 'all' || p.kind === st.kind);

  const here = st.here;
  const ref = here || (list.length ? { lat: list.reduce((s, p) => s + p.lat, 0) / list.length, lng: list.reduce((s, p) => s + p.lng, 0) / list.length } : null);
  const minLat = Math.min(...list.map((p) => p.lat), ref?.lat ?? 0);
  const maxLat = Math.max(...list.map((p) => p.lat), ref?.lat ?? 0);
  const minLng = Math.min(...list.map((p) => p.lng), ref?.lng ?? 0);
  const maxLng = Math.max(...list.map((p) => p.lng), ref?.lng ?? 0);
  const spanLat = Math.max(maxLat - minLat, 0.01);
  const spanLng = Math.max(maxLng - minLng, 0.01);
  const project = (lat, lng) => [((lng - minLng) / spanLng) * W, ((maxLat - lat) / spanLat) * H];
  const vw = W / st.zoom; const vh = H / st.zoom;
  const [cx, cy] = ref ? project(ref.lat, ref.lng) : [W / 2, H / 2];
  const vx = Math.min(Math.max(cx - vw / 2, 0), Math.max(0, W - vw));
  const vy = Math.min(Math.max(cy - vh / 2, 0), Math.max(0, H - vh));

  const dist = (p) => (here ? haversine(here, p) : null);
  const near = [...list].sort((a, b) => (here ? dist(a) - dist(b) : a.name.localeCompare(b.name, 'th'))).slice(0, 40);
  const pinCls = (p) => (p.kind === 'leads' ? 'pin-lead' : ['overdue', 'due'].includes(p.cy) ? 'pin-warn' : 'pin-ok');

  return {
    html: `
    <div class="head"><a href="${path('backstage')}" class="back">${icon('chevLeft')} หลังบ้าน</a></div>
    <h1>แผนที่ลูกค้า</h1>
    ${chips([['all', 'ทั้งหมด'], ['customers', 'ลูกค้า'], ['leads', 'ร้านเป้าหมาย']], st.kind, 'kind')}
    <div class="map-tools">
      <button class="btn small" data-act="near">${icon('pin')} ใกล้ฉัน</button>
      <button class="btn small" data-act="zoom" data-d="1" aria-label="ซูมเข้า">+</button>
      <button class="btn small" data-act="zoom" data-d="-1" aria-label="ซูมออก">−</button>
      <span class="hint-inline">${list.length ? `${num(list.length)} จุด` : 'ยังไม่มีพิกัด'}</span>
    </div>
    <div class="map-wrap">
      ${list.length ? `<svg class="map" viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="แผนที่จุดลูกค้า">
        ${here ? `<circle cx="${project(here.lat, here.lng)[0]}" cy="${project(here.lat, here.lng)[1]}" r="${6 / st.zoom}" class="pin-here"/>` : ''}
        ${list.filter((p) => { const [x, y] = project(p.lat, p.lng); return x >= vx - 10 && x <= vx + vw + 10 && y >= vy - 10 && y <= vy + vh + 10; })
    .map((p) => { const [x, y] = project(p.lat, p.lng); return `<circle class="pin ${pinCls(p)}" cx="${x}" cy="${y}" r="${7 / st.zoom}" data-act="pin" data-kind="${p.kind}" data-id="${esc(p.id)}"/>`; }).join('')}
      </svg>` : empty('เก็บพิกัดร้านก่อน จึงจะแสดงบนแผนที่')}
      <p class="legend"><span class="pin-ok">●</span> ลูกค้าปกติ <span class="pin-warn">●</span> ถึง/เลยรอบ <span class="pin-lead">●</span> ร้านเป้าหมาย</p>
    </div>
    <p class="hint">แผนที่แบบเรียบจากพิกัดที่เก็บไว้ ใช้ได้ออฟไลน์ กดปุ่มนำทางเพื่อเปิดแผนที่จริง</p>
    <ul class="list">${near.map((p) => `<li><a href="${path(p.kind === 'leads' ? 'lead' : 'customer', p.id)}">
      <div><b>${esc(p.name)}</b><small>${esc(p.phone || '')}${here ? ` · ${(dist(p) / 1000).toFixed(1)} กม.` : ''}</small></div>
      <div class="right">${badge(p.kind === 'leads' ? 'ร้านเป้าหมาย' : 'ลูกค้า', p.kind === 'leads' ? 'info' : 'muted')}</div></a></li>`).join('')}</ul>`,
    on: {
      'click:kind': (el) => { st.kind = el.dataset.key; ctx.rerender(); },
      'click:zoom': (el) => { st.zoom = Math.min(8, Math.max(1, st.zoom * (el.dataset.d === '1' ? 2 : 0.5))); ctx.rerender(); },
      'click:near': async () => {
        try { st.here = await captureGps(); ctx.rerender(); } catch (e) { toast(e.message); }
      },
      'click:pin': (el) => pinSheet(el.dataset.kind, el.dataset.id),
    },
  };
}

function haversine(a, b) {
  const R = 6371000; const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pinSheet(kind, id) {
  const rec = db.get(kind, id);
  if (!rec) return;
  const phone = telOf(rec.phone);
  openSheet({
    title: rec.name,
    html: `<p class="hint-lg">${esc(rec.phone || '')}</p>
      <div class="actions">
        ${phone ? `<a class="btn" href="tel:${esc(phone)}">${icon('phone')} โทร</a>` : ''}
        <a class="btn" href="${esc(mapsOf(rec))}" target="_blank" rel="noopener">${icon('pin')} นำทาง</a>
      </div>
      <div class="actions">
        <a class="btn primary" href="${path(kind === 'leads' ? 'lead' : 'customer', id)}">เปิดรายละเอียด</a>
        <a class="btn" href="${path('store-data', id, '?k=' + kind)}">เก็บข้อมูล</a>
      </div>`,
  });
}

// ---------- store data collection ----------
export function storeDataPage(ctx) {
  const id = ctx.id;
  if (id) return storeDetail(ctx, id);
  const st = ctx.state; st.filter ||= 'all';
  const rows = [...customers().map((c) => ({ kind: 'customers', rec: c })), ...leads().map((l) => ({ kind: 'leads', rec: l }))];
  const ok = (r) => !!(r.rec.photo && r.rec.lat && r.rec.lng);
  const counts = { total: rows.length, photo: rows.filter((r) => r.rec.photo).length, geo: rows.filter((r) => r.rec.lat && r.rec.lng).length, complete: rows.filter(ok).length };
  counts.missing = counts.total - counts.complete;
  const list = rows.filter((r) => st.filter === 'all' || !ok(r)).slice(0, 200);
  return {
    html: `
    <div class="head"><a href="${path('backstage')}" class="back">${icon('chevLeft')} หลังบ้าน</a></div>
    <h1>เก็บข้อมูลหน้าร้าน</h1>
    <div class="kpis">
      <div class="kpi"><span>ร้านทั้งหมด</span><b>${num(counts.total)}</b></div>
      <div class="kpi"><span>ครบแล้ว</span><b class="up">${num(counts.complete)}</b></div>
      <div class="kpi"><span>มีรูป</span><b>${num(counts.photo)}</b></div>
      <div class="kpi"><span>มีพิกัด</span><b>${num(counts.geo)}</b></div>
    </div>
    ${chips([['all', 'ทั้งหมด'], ['missing', `ยังขาด ${num(counts.missing)}`]], st.filter, 'filter')}
    <ul class="list">${list.map((r) => `<li><a href="${path('store-data', r.rec.id, '?k=' + r.kind)}">
      <div><b>${esc(r.rec.name)}</b><small>${esc(r.kind === 'leads' ? 'ร้านเป้าหมาย' : 'ลูกค้า')} · ${esc(r.rec.area || r.rec.province || '')}</small></div>
      <div class="right">${badge(r.rec.photo ? 'มีรูป' : 'ไม่มีรูป', r.rec.photo ? 'ok' : 'warn')} ${badge(r.rec.lat ? 'มีพิกัด' : 'ไม่มีพิกัด', r.rec.lat ? 'ok' : 'warn')}</div>
    </a></li>`).join('') || '<li class="empty-li">ไม่มีรายการ</li>'}</ul>`,
    on: { 'click:filter': (el) => { st.filter = el.dataset.key; ctx.rerender(); } },
  };
}

function storeDetail(ctx, id) {
  const entity = db.get('customers', id) ? 'customers' : 'leads';
  const rec = db.get(entity, id);
  if (!rec) return { html: empty('ไม่พบร้านนี้') };
  const acc = rec.accuracy;
  return {
    html: `
    <div class="head"><a href="${path('store-data')}" class="back">${icon('chevLeft')} รายการ</a></div>
    <h1>${esc(rec.name)}</h1>
    <form class="form" data-form="store">
      <input type="hidden" name="photo" value="${esc(rec.photo || '')}">
      <input type="hidden" name="lat" value="${esc(rec.lat ?? '')}">
      <input type="hidden" name="lng" value="${esc(rec.lng ?? '')}">
      <input type="hidden" name="accuracy" value="${esc(acc ?? '')}">
      <input type="hidden" name="gpsAt" value="${esc(rec.gpsAt ?? '')}">
      <section class="card">
        <h2>รูปหน้าร้าน</h2>
        <div data-region="photo">${rec.photo ? `<img class="photo" alt="รูปหน้าร้าน" src="${esc(rec.photo)}">` : empty('ยังไม่มีรูป')}</div>
        <label class="btn wide file">${icon('camera')} ถ่ายรูปหน้าร้าน<input type="file" accept="image/*" capture="environment" data-ch="photo" hidden></label>
      </section>
      <section class="card">
        <h2>พิกัด</h2>
        <div data-region="gps">${rec.lat ? `<p>${num(rec.lat)}, ${num(rec.lng)}</p><p class="hint">ความแม่นยำ ${acc ?? '-'} เมตร · ${fmtDateTime(rec.gpsAt)}${acc > 50 ? ' · <b class="warn-text">ค่าความแม่นยำต่ำ ลองใหม่ที่กลางแจ้ง</b>' : ''}</p>` : '<p class="hint">ยังไม่มีพิกัด</p>'}</div>
        <button type="button" class="btn wide" data-act="gps">${icon('pin')} ${rec.lat ? 'หาพิกัดใหม่' : 'เก็บพิกัดตอนนี้'}</button>
      </section>
      <button class="btn primary wide">บันทึกหน้าร้าน</button>
    </form>`,
    on: {
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
        region('gps', '<p class="hint">กำลังหาตำแหน่ง…</p>');
        try {
          const g = await captureGps();
          const f = document.querySelector('form[data-form=store]');
          f.lat.value = g.lat; f.lng.value = g.lng; f.accuracy.value = g.accuracy; f.gpsAt.value = g.at;
          region('gps', `<p>${num(g.lat)}, ${num(g.lng)}</p><p class="hint">ความแม่นยำ ${g.accuracy} เมตร${g.accuracy > 50 ? ' · <b class="warn-text">ค่าความแม่นยำต่ำ ลองใหม่ที่กลางแจ้ง</b>' : ''}</p>`);
        } catch (e) { region('gps', `<p class="warn-text">${esc(e.message)}</p>`); }
      },
      'submit:store': (form) => {
        const v = Object.fromEntries(new FormData(form));
        db.save(entity, {
          id, photo: v.photo || '', lat: v.lat ? +v.lat : '', lng: v.lng ? +v.lng : '',
          accuracy: v.accuracy ? +v.accuracy : '', gpsAt: v.gpsAt ? +v.gpsAt : '',
        }, { action: 'เก็บข้อมูลหน้าร้าน' });
        toast('บันทึกหน้าร้านแล้ว');
        ctx.go('store-data');
      },
    },
  };
}
