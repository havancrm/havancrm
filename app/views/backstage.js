// Backstage (หลังบ้าน): menu, products, customer analysis, sales totals, import wizard,
// settings, backup and restore, and the audit log.
import * as db from '../db.js';
import * as core from '../core.js';
import { esc, money, num, thaiDate, today, toCsv, parseCsv, mapColumns, CUSTOMER_COLUMNS, BILL_COLUMNS, planCustomerImport, planBillImport, hashText, periodRange } from '../core.js';
import { icon, path, empty, chips, field, select, openSheet, closeSheet, toast, region, confirmSheet, fmtDateTime, more } from '../ui.js';
import { customers, orders, sales, stats, cycleOf, catalog, productSalesOf, customerName } from '../derived.js';
import { openTaskSheet, logActivity } from './work.js';
import { printHtml } from './orders.js';
import { sync, syncState, retryFailed } from '../sync.js';

const MENU = [
  ['งานขาย', [['map', 'แผนที่ลูกค้า', 'map'], ['store-data', 'เก็บข้อมูลหน้าร้าน', 'camera'], ['purchases', 'ประวัติซื้อ', 'history'], ['activities', 'กิจกรรม', 'note'], ['products', 'สินค้า', 'box']]],
  ['วิเคราะห์', [['analysis', 'วิเคราะห์ลูกค้า', 'users'], ['sales', 'ยอดขายรวม', 'chart']]],
  ['ข้อมูลและระบบ', [['import', 'นำเข้าข้อมูล', 'upload'], ['backup', 'สำรอง / กู้คืน', 'database'], ['audit', 'ประวัติการเปลี่ยนแปลง', 'list'], ['settings', 'ตั้งค่า', 'settings']]],
];

export function backstagePage(ctx) {
  return {
    html: `<h1>หลังบ้าน</h1>
      ${MENU.map(([title, items]) => `<section class="card menu-card"><h2>${title}</h2>
        <div class="menu-list">${items.map(([p, label, ic]) => `<a class="menu-item" href="${path(p)}">${icon(ic)} ${label}${icon('chevRight')}</a>`).join('')}</div></section>`).join('')}
      <button class="btn wide" data-act="reload">${icon('refresh')} โหลดข้อมูลใหม่</button>
      <p class="hint">ข้อมูลทั้งหมดอยู่ในเครื่องนี้ก่อน การโหลดใหม่จะซิงก์กับฐานกลางเพิ่มเติม ไม่ลบข้อมูลในเครื่อง</p>`,
    on: {
      'click:reload': async () => { toast('กำลังโหลดข้อมูลใหม่…'); await sync({ manual: true }); ctx.rerender(); },
    },
  };
}

// ---------- products ----------
const PERIODS = [['month', 'เดือนนี้'], ['3m', '3 เดือน'], ['year', 'ปีนี้'], ['all', 'ทั้งหมด']];
const PSORT = [['amount', 'ยอดขาย'], ['qty', 'จำนวน'], ['name', 'ชื่อ']];

export function productsPage(ctx) {
  const st = ctx.state;
  st.period ||= 'month'; st.sort ||= 'amount';
  const render = () => {
    const q = (st.q || '').trim().toLowerCase();
    const range = periodRange(st.period, today());
    const master = new Map(db.list('products').map((p) => [p.id, p]));
    let list = productSalesOf({ from: range?.from, to: range?.to, numeric: null });
    if (q) list = list.filter((p) => `${p.code} ${p.name}`.toLowerCase().includes(q));
    const key = { amount: (a, b) => b.amount - a.amount, qty: (a, b) => b.qty - a.qty, name: (a, b) => a.name.localeCompare(b.name, 'th') }[st.sort];
    list.sort(key);
    region('results', `<p class="count">${num(list.length)} รายการ</p>
      <ul class="cards">${list.slice(0, st.limit || 100).map((p) => `<li class="card-row"><a class="card-link" href="${path('product', p.key)}">
        <div class="card-top"><b>${esc(p.name)}</b></div>
        <small>${esc(p.code || 'ไม่มีรหัส')}${master.get(p.key)?.standardPrice ? ` · มาตรฐาน ${money(master.get(p.key).standardPrice)}` : ''}</small>
        <div class="card-meta"><span>ยอด <b>${money(p.amount)}</b></span><span>จำนวน ${num(p.qty)} ${esc(p.unit)}</span><span>ลูกค้า ${num(p.customers.size)} ราย</span></div>
      </a></li>`).join('')}</ul>
      ${list.length > (st.limit || 100) ? more() : ''}`);
  };
  return {
    html: `<h1>สินค้า</h1>
      <input class="search" type="search" placeholder="ค้นหาสินค้า / SKU" data-in="q" value="${esc(st.q || '')}" autocomplete="off">
      ${chips(PERIODS, st.period, 'period')}
      ${chips(PSORT.map(([k, l]) => [k, `เรียง: ${l}`]), st.sort, 'sort')}
      <div data-region="results"></div>`,
    on: {
      'input:q': (el) => { st.q = el.value; render(); },
      'click:period': (el) => { st.period = el.dataset.key; ctx.rerender(); },
      'click:sort': (el) => { st.sort = el.dataset.key; ctx.rerender(); },
      'click:more': () => { st.limit = (st.limit || 100) + 100; render(); },
    },
    onMount: render,
  };
}

export function productPage(ctx) {
  const key = ctx.id;
  const cat = catalog().find((p) => p.id === key);
  if (!cat) return { html: empty('ไม่พบสินค้า') };
  const m = db.get('products', key) || {};
  const sum = productSalesOf({}).find((p) => p.key === key);
  const buyers = new Map();
  for (const o of sales()) {
    for (const i of o.items || []) {
      if ((i.code || i.name) !== key) continue;
      const b = buyers.get(o.customerId) || { qty: 0, last: '', price: null };
      b.qty += Number(i.qty) || 0;
      if (o.date > b.last) { b.last = o.date; b.price = i.price ?? null; }
      buyers.set(o.customerId, b);
    }
  }
  const rows = [...buyers.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 100);
  return {
    html: `
    <div class="head"><a href="${path('products')}" class="back">${icon('chevLeft')} สินค้า</a></div>
    <h1>${esc(cat.name)}</h1>
    <p class="sub">${esc(cat.code || 'ไม่มีรหัส SKU')} · ${esc(m.unit || cat.unit || '')}</p>
    <div class="kpis">
      <div class="kpi"><span>ยอดขายรวม</span><b>${money(sum?.amount || 0)}</b></div>
      <div class="kpi"><span>จำนวนขาย</span><b>${num(sum?.qty || 0)}</b></div>
      <div class="kpi"><span>จำนวนลูกค้า</span><b>${num(buyers.size)}</b></div>
      <div class="kpi"><span>ราคามาตรฐาน</span><b>${m.standardPrice ? money(m.standardPrice) : '-'}</b></div>
    </div>
    <section class="card"><h2>แก้ไขข้อมูลสินค้า</h2>
      <form class="form" data-form="product">
        ${field('unit', 'หน่วย', m.unit || cat.unit || '')}
        ${field('standardPrice', 'ราคามาตรฐาน (บาท)', m.standardPrice ?? '', 'type="number" inputmode="decimal" min="0" step="any"')}
        <button class="btn primary wide">บันทึก</button>
      </form>
    </section>
    <section class="card"><h2>รายชื่อลูกค้าที่ซื้อ <span class="count">${num(buyers.size)}</span></h2>
      ${rows.length ? `<ul class="list">${rows.map(([cid, b]) => `<li><a href="${path('customer', cid)}"><div><b>${esc(customerName(cid))}</b><small>ซื้อล่าสุด ${thaiDate(b.last)} · ${num(b.qty)} ${esc(cat.unit || '')}</small></div>
        <div class="right">${b.price != null ? `<b>${money(b.price)}</b>` : ''}<small>ราคาล่าสุด</small></div></a></li>`).join('')}</ul>` : empty('ยังไม่มีลูกค้าที่ซื้อสินค้านี้')}
    </section>`,
    on: {
      'submit:product': (form) => {
        db.save('products', { id: key, code: cat.code || '', name: cat.name, unit: form.unit.value.trim(), standardPrice: form.standardPrice.value ? +form.standardPrice.value : '' }, { action: 'แก้ไขสินค้า' });
        toast('บันทึกสินค้าแล้ว');
        ctx.rerender();
      },
    },
  };
}

// ---------- analysis (วิเคราะห์ลูกค้า) ----------
export function analysisPage(ctx) {
  const st = ctx.state;
  st.period ||= 'year';
  const range = periodRange(st.period, today()) || { from: '0000-00-00', to: '9999-99-99' };
  const s = stats();
  const inRange = sales().filter((o) => o.date >= range.from && o.date <= range.to);
  const byCust = new Map();
  for (const o of inRange) {
    const b = byCust.get(o.customerId) || { total: 0, bills: 0 };
    b.total += core.orderTotal(o); b.bills += 1;
    byCust.set(o.customerId, b);
  }
  const top = [...byCust.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  const lost = customers().filter((c) => { const x = s.get(c.id); return x && x.days >= 60; })
    .sort((a, b) => (s.get(b.id).days) - (s.get(a.id).days)).slice(0, 30);
  const risk = customers().filter((c) => ['due', 'overdue'].includes(cycleOf(c.id).key) && !lost.includes(c)).slice(0, 30);
  const total = inRange.reduce((x, o) => x + core.orderTotal(o), 0);

  const row = (c, extra) => `<li><a href="${path('customer', c.id)}"><div><b>${esc(c.name)}</b><small>${esc(extra)}</small></div></a>
    <div class="row-actions">${c.phone ? `<a class="btn small" href="tel:${esc(String(c.phone).split(',')[0].replace(/[^\d+]/g, ''))}" data-act="call-log" data-id="${esc(c.id)}">${icon('phone')}</a>` : ''}
      <button class="btn small" data-act="add-task" data-id="${esc(c.id)}">${icon('calendar')}</button></div></li>`;
  const csvRows = () => [['ร้าน', 'รหัส', 'เบอร์', 'ยอดซื้อ', 'จำนวนบิล', 'ซื้อล่าสุด', 'วันที่ไม่ได้ซื้อ'],
    ...top.map(([id, b]) => { const c = db.get('customers', id); return [c?.name, c?.code, c?.phone, b.total, b.bills, s.get(id)?.last || '', s.get(id)?.days ?? '']; })];

  return {
    html: `
    <div class="head"><a href="${path('backstage')}" class="back">${icon('chevLeft')} หลังบ้าน</a></div>
    <h1>วิเคราะห์ลูกค้า</h1>
    ${chips(PERIODS, st.period, 'period')}
    <div class="kpis">
      <div class="kpi"><span>ลูกค้าที่ซื้อ</span><b>${num(byCust.size)}</b></div>
      <div class="kpi"><span>จำนวนบิล</span><b>${num(inRange.length)}</b></div>
      <div class="kpi"><span>ยอดรวม</span><b>${money(total)}</b></div>
      <div class="kpi"><span>ห่างหาย</span><b class="warn-text">${num(lost.length)}</b></div>
    </div>
    <div class="actions"><button class="btn" data-act="csv">${icon('download')} CSV</button>
      <button class="btn" data-act="copy-csv">${icon('copy')} คัดลอก CSV</button>
      <button class="btn" data-act="pdf">${icon('print')} PDF</button></div>
    <section class="card"><h2>ลูกค้ายอดซื้อสูงสุด</h2>
      ${top.length ? `<ol class="rank">${top.map(([id, b]) => `<li><a href="${path('customer', id)}">${esc(customerName(id))}</a><b>${money(b.total)}</b></li>`).join('')}</ol>` : empty('ยังไม่มียอดซื้อในช่วงนี้')}</section>
    <section class="card"><h2>ลูกค้าห่างหาย <span class="count">${num(lost.length)}</span></h2>
      ${lost.length ? `<ul class="list">${lost.map((c) => row(c, `ไม่ได้ซื้อ ${s.get(c.id).days} วัน`)).join('')}</ul>` : empty('ไม่มีลูกค้าห่างหาย')}</section>
    <section class="card"><h2>ลูกค้าเสี่ยง (ถึง/เลยรอบ) <span class="count">${num(risk.length)}</span></h2>
      ${risk.length ? `<ul class="list">${risk.map((c) => row(c, `${cycleOf(c.id).label} · ไม่ได้ซื้อ ${cycleOf(c.id).days} วัน`)).join('')}</ul>` : empty('ไม่มีลูกค้าเสี่ยง')}</section>`,
    on: {
      'click:period': (el) => { st.period = el.dataset.key; ctx.rerender(); },
      'click:add-task': (el) => openTaskSheet({ ref: { customerId: el.dataset.id } }),
      'click:call-log': (el) => logActivity({ customerId: el.dataset.id }, 'call', 'โทรออก'),
      'click:csv': () => download(`analysis-${today()}.csv`, toCsv(csvRows()), 'text/csv'),
      'click:copy-csv': () => { navigator.clipboard?.writeText(toCsv(csvRows())).catch(() => {}); toast('คัดลอก CSV แล้ว'); },
      'click:pdf': () => printHtml(`<h2>วิเคราะห์ลูกค้า</h2><table border="1" cellspacing="0" cellpadding="6">${csvRows().map((r, i) => `<tr>${r.map((v) => `<${i ? 'td' : 'th'}>${esc(v)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`),
    },
  };
}

export function download(name, text, type = 'text/plain') {
  const blob = new Blob(['﻿' + text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- sales totals (ยอดขายรวม) ----------
export function salesPage(ctx) {
  const st = ctx.state;
  const now = today();
  st.year ||= now.slice(0, 4);
  st.month ??= '';
  st.tab ||= 'numeric';
  const years = [...new Set(sales().map((o) => o.date?.slice(0, 4)).filter(Boolean).concat([now.slice(0, 4)]))].sort().reverse();
  const from = st.month ? `${st.year}-${st.month}-01` : `${st.year}-01-01`;
  const to = st.month ? `${st.year}-${st.month}-31` : `${st.year}-12-31`;
  const th = db.masters.priceThreshold || 0;
  const numeric = st.tab === 'numeric';
  const lines = productSalesOf({ from, to, numeric, threshold: th });
  const billsIn = sales().filter((o) => o.date >= from && o.date <= to);
  const amount = lines.reduce((s, p) => s + p.amount, 0);
  const customersIn = new Set(lines.flatMap((p) => [...p.customers]));
  const byMonth = Array.from({ length: 12 }, (_, i) => ({ m: String(i + 1).padStart(2, '0'), v: 0 }));
  for (const o of sales()) {
    if (!o.date?.startsWith(st.year)) continue;
    const mm = +o.date.slice(5, 7) - 1;
    byMonth[mm].v += core.orderTotal(o);
  }
  const max = Math.max(1, ...byMonth.map((x) => x.v));

  return {
    html: `
    <div class="head"><a href="${path('backstage')}" class="back">${icon('chevLeft')} หลังบ้าน</a></div>
    <h1>ยอดขายรวม</h1>
    <div class="row2">
      <label class="fld"><span>ปี</span><select data-ch="year">${years.map((y) => `<option ${y === st.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label class="fld"><span>เดือน</span><select data-ch="month"><option value="">ทั้งปี</option>${Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => `<option value="${m}" ${m === st.month ? 'selected' : ''}>${new Date(2000, +m - 1, 1).toLocaleDateString('th-TH', { month: 'long' })}</option>`).join('')}</select></label>
    </div>
    ${chips([['numeric', 'ได้ตัวเลข'], ['text', 'ไม่ได้ตัวเลข']], st.tab, 'tab')}
    <p class="hint">"ได้ตัวเลข" คือรายการที่มีราคาตั้งแต่เกณฑ์ราคา (${money(th)}) ขึ้นไป · "ไม่ได้ตัวเลข" คือรายการไม่มีราคาหรือต่ำกว่าเกณฑ์</p>
    <div class="kpis">
      <div class="kpi"><span>ยอดขาย</span><b>${numeric ? money(amount) : '-'}</b></div>
      <div class="kpi"><span>จำนวนบิล</span><b>${num(billsIn.length)}</b></div>
      <div class="kpi"><span>จำนวนสินค้า</span><b>${num(lines.length)}</b></div>
      <div class="kpi"><span>จำนวนลูกค้า</span><b>${num(customersIn.size)}</b></div>
    </div>
    <section class="card"><h2>ยอดรายเดือน ${st.year}</h2>
      <div class="bars">${byMonth.map((x) => `<div class="bar" title="${x.m}: ${money(x.v)}"><i style="height:${(x.v / max) * 100}%"></i><em>${x.m}</em></div>`).join('')}</div></section>
    <section class="card"><h2>แยกตามสินค้า</h2>
      ${lines.length ? `<ul class="list">${lines.sort((a, b) => b.amount - a.amount).slice(0, 100).map((p) => `<li><a href="${path('product', p.key)}"><div><b>${esc(p.name)}</b><small>${esc(p.code)} · ${num(p.qty)} ${esc(p.unit)}</small></div><div class="right"><b>${numeric ? money(p.amount) : '-'}</b></div></a></li>`).join('')}</ul>` : empty('ไม่มีรายการ')}</section>
    <div class="actions"><button class="btn" data-act="threshold">${icon('settings')} ตั้งค่าเกณฑ์ราคา</button></div>`,
    on: {
      'change:year': (el) => { st.year = el.value; ctx.rerender(); },
      'change:month': (el) => { st.month = el.value; ctx.rerender(); },
      'click:tab': (el) => { st.tab = el.dataset.key; ctx.rerender(); },
      'click:threshold': () => openThreshold(ctx),
    },
  };
}

function openThreshold(ctx) {
  openSheet({
    title: 'เกณฑ์ราคา',
    html: `<form class="form" data-form="threshold">
      ${field('priceThreshold', 'ราคาต่ำสุดที่นับเป็นตัวเลข (บาท)', db.masters.priceThreshold || 0, 'type="number" inputmode="decimal" min="0" step="any"')}
      <p class="hint">รายการที่ราคาต่ำกว่าค่านี้ หรือไม่มีราคา จะไปอยู่ในแท็บ "ไม่ได้ตัวเลข"</p>
      <button class="btn primary wide">บันทึก</button></form>`,
    on: {
      'submit:threshold': (form) => {
        db.setMasters({ ...db.masters, priceThreshold: +form.priceThreshold.value || 0 });
        closeSheet();
        toast('บันทึกเกณฑ์ราคาแล้ว');
        ctx.rerender();
      },
    },
  });
}

// ---------- import wizard (นำเข้าข้อมูล) ----------
const STEPS = ['เลือกไฟล์', 'ตรวจโครงสร้าง', 'Preview', 'สำรองและนำเข้า', 'ผลลัพธ์'];
const TYPES = { customers: 'ลูกค้า', bills: 'บิลและรายการสินค้า' };

export function importPage(ctx) {
  const view = importView(ctx);
  if (ctx.state.step === 1) view.onMount = fillImportHistory;
  return view;
}

function importView(ctx) {
  const st = ctx.state;
  st.step ||= 1; st.type ||= 'customers'; st.excluded ||= [];
  const stepHead = `<ol class="steps">${STEPS.map((s, i) => `<li class="${i + 1 === st.step ? 'on' : i + 1 < st.step ? 'done' : ''}"><span>${i + 1}</span>${s}</li>`).join('')}</ol>`;
  const back = `<div class="head"><a href="${path('backstage')}" class="back">${icon('chevLeft')} หลังบ้าน</a></div>`;

  if (st.step === 1) {
    return {
      html: `${back}<h1>นำเข้าข้อมูล</h1>${stepHead}
        <section class="card"><form class="form" data-form="import-file">
          ${select('type', 'ประเภทข้อมูล', Object.entries(TYPES), st.type)}
          <p class="hint">ไฟล์ CSV (ส่งออกจาก Excel เป็น CSV UTF-8) บรรทัดแรกเป็นชื่อคอลัมน์ ชื่อคอลัมน์ภาษาไทยหรืออังกฤษใช้ได้
          ${st.type === 'customers' ? 'คอลัมน์: ชื่อลูกค้า, เบอร์โทร, รหัสลูกค้า, ประเภทธุรกิจ, จังหวัด, Zone, LINE, ที่อยู่, แท็ก, ผู้ดูแล, เงื่อนไข, บันทึก' : 'คอลัมน์: เลขที่บิล, วันที่, ลูกค้า (หรือรหัสลูกค้า), SKU, สินค้า, จำนวน, ราคา, หน่วย (บรรทัดละ 1 รายการ)'}</p>
          <label class="btn wide file">${icon('upload')} เลือกไฟล์ CSV<input type="file" accept=".csv,text/csv" data-ch="file" hidden></label>
          ${st.fileName ? `<p class="hint">ไฟล์: ${esc(st.fileName)}</p>` : ''}
        </form></section>
        <section class="card"><h2>นำเข้าที่ผ่านมา</h2>${importHistory()}</section>`,
      on: {
        'change:type': (el) => { st.type = el.value; ctx.rerender(); },
        'change:file': async (el) => {
          const file = el.files?.[0];
          if (!file) return;
          const text = await file.text();
          const table = parseCsv(text);
          if (table.length < 2) { toast('ไฟล์ว่างหรือมีแค่หัวตาราง'); return; }
          const dict = st.type === 'customers' ? CUSTOMER_COLUMNS : BILL_COLUMNS;
          const headers = table[0];
          const map = mapColumns(headers, dict);
          const required = st.type === 'customers' ? ['name'] : ['no', 'date', 'qty'];
          const missing = required.filter((k) => map[k] === undefined);
          const hash = hashText(text);
          // The same file imported before is flagged, so a repeat import is a deliberate choice.
          const fileHashSeen = (await db.listImports()).some((i) => i.fileHash === hash);
          Object.assign(st, { fileName: file.name, text, hash, fileHashSeen, headers, map, missing, table, step: 2, excluded: [] });
          ctx.rerender();
        },
      },
    };
  }

  const items = rowsOf(st);
  const plan = st.type === 'customers'
    ? planCustomerImport(items, customers())
    : planBillImport(items, { customers: customers(), products: catalog(), existingNos: new Set(orders().map((o) => o.no)) });
  st.plan = plan;

  if (st.step === 2) {
    return {
      html: `${back}<h1>ตรวจโครงสร้างไฟล์</h1>${stepHead}
        <section class="card"><h2>${esc(st.fileName)}</h2>
          <p>พบ ${num(items.length)} แถวข้อมูล</p>
          <ul class="plain">${Object.entries(st.map).map(([k, i]) => `<li><span>${esc(headerLabel(k))}</span><small>คอลัมน์ "${esc(st.headers[i])}"</small></li>`).join('')}</ul>
          ${st.missing.length ? `<p class="warn-text">ไม่พบคอลัมน์ที่จำเป็น: ${esc(st.missing.map(headerLabel).join(', '))}</p>` : '<p class="hint">คอลัมน์ครบ พร้อมตรวจข้อมูล</p>'}
          ${st.missing.length ? '' : ''}
        </section>
        <div class="actions"><button class="btn" data-act="back" data-to="1">ย้อนกลับ</button>
          <button class="btn primary" data-act="go" data-to="3" ${st.missing.length ? 'disabled' : ''}>ตรวจข้อมูล</button></div>`,
      on: {
        'click:back': (el) => { st.step = +el.dataset.to; ctx.rerender(); },
        'click:go': (el) => { st.step = +el.dataset.to; ctx.rerender(); },
      },
    };
  }

  if (st.step === 3) {
    const creates = st.type === 'customers' ? plan.create.length : plan.bills.length;
    const updates = st.type === 'customers' ? plan.update.length : 0;
    const skipped = (plan.skipped || []).length;
    const errs = plan.errors.filter((e) => !e.warning);
    return {
      html: `${back}<h1>Preview ก่อนนำเข้า</h1>${stepHead}
        <div class="kpis">
          <div class="kpi"><span>นำเข้าใหม่</span><b class="up">${num(creates)}</b></div>
          ${st.type === 'customers' ? `<div class="kpi"><span>อัปเดตข้อมูลเดิม</span><b>${num(updates)}</b></div>` : ''}
          <div class="kpi"><span>ข้าม</span><b>${num(skipped)}</b></div>
          <div class="kpi"><span>ต้องตรวจสอบ</span><b class="${errs.length ? 'down' : ''}">${num(errs.length)}</b></div>
        </div>
        ${plan.errors.length ? `<section class="card"><h2>รายการที่ต้องตรวจสอบ <span class="count">${num(plan.errors.length)}</span></h2>
          <ul class="list">${plan.errors.slice(0, 60).map((e) => `<li><div><b>แถว ${e.line}</b><small class="${e.warning ? '' : 'down'}">${esc(e.message)}</small></div>
            <div class="right"><button class="btn small ghost" data-act="exclude" data-line="${e.line}">${st.excluded.includes(e.line) ? 'ยกเลิกการข้าม' : 'ข้ามแถวนี้'}</button></div></li>`).join('')}</ul>
          ${plan.errors.length > 60 ? `<p class="hint">แสดง 60 รายการแรก · ดาวน์โหลดรายการทั้งหมดได้ด้านล่าง</p>` : ''}
          <button class="btn ghost wide" data-act="dl-errors">${icon('download')} ดาวน์โหลดรายการที่มีปัญหา (CSV)</button></section>` : '<p class="hint">ไม่พบข้อผิดพลาด</p>'}
        ${st.excluded.length ? `<p class="hint">ข้ามด้วยตนเอง ${num(st.excluded.length)} แถว</p>` : ''}
        <div class="actions"><button class="btn" data-act="back" data-to="2">ย้อนกลับ</button>
          <button class="btn primary" data-act="go" data-to="4" ${creates + updates === 0 ? 'disabled' : ''}>ยืนยันตรวจแล้ว</button></div>`,
      on: {
        'click:back': (el) => { st.step = +el.dataset.to; ctx.rerender(); },
        'click:go': (el) => { st.step = +el.dataset.to; ctx.rerender(); },
        'click:exclude': (el) => {
          const line = +el.dataset.line;
          st.excluded = st.excluded.includes(line) ? st.excluded.filter((x) => x !== line) : [...st.excluded, line];
          ctx.rerender();
        },
        'click:dl-errors': () => download(`import-errors-${today()}.csv`, toCsv([['แถว', 'ข้อความ'], ...plan.errors.map((e) => [e.line, e.message])]), 'text/csv'),
      },
    };
  }

  if (st.step === 4) {
    return {
      html: `${back}<h1>สำรองและนำเข้า</h1>${stepHead}
        <section class="card"><p>ระบบจะสำรองข้อมูลทั้งหมดก่อนนำเข้า แล้วจึงบันทึกข้อมูลใหม่ ไฟล์เดิมไม่ถูกลบ</p>
          ${st.fileHashSeen ? '<p class="warn-text">ไฟล์นี้เคยนำเข้าแล้ว การนำเข้าซ้ำจะไม่สร้างรายการซ้ำ แต่ควรตรวจสอบก่อน</p>' : ''}
          <button class="btn primary wide" data-act="run">สำรองข้อมูลแล้วนำเข้า</button></section>
        <div class="actions"><button class="btn" data-act="back" data-to="3">ย้อนกลับ</button></div>`,
      on: {
        'click:back': (el) => { st.step = +el.dataset.to; ctx.rerender(); },
        'click:run': async () => {
          if (!(await confirmSheet(`นำเข้า ${TYPES[st.type]} ${num(creates(plan, st.type))} รายการ?`, 'นำเข้า'))) return;
          const importId = db.uid();
          await db.createBackup('before-import');
          const res = runImport(plan, st.type, importId);
          await db.recordImport({
            id: importId, fileName: st.fileName, fileHash: st.hash, at: Date.now(), type: st.type, user: db.getUser(),
            total: items.length, success: res.success, errors: plan.errors.length, skipped: st.excluded.length + (plan.skipped || []).length,
          });
          await db.logEvent('นำเข้าข้อมูล', `${st.fileName} · สำเร็จ ${res.success}`);
          st.result = { ...res, importId, errors: plan.errors.length };
          st.step = 5;
          ctx.rerender();
        },
      },
    };
  }

  // Step 5: result
  const r = st.result || { success: 0, errors: 0 };
  return {
    html: `${back}<h1>นำเข้าเสร็จแล้ว</h1>${stepHead}
      <section class="card info">
        <div><span>ไฟล์</span><p>${esc(st.fileName)}</p></div>
        <div><span>สำเร็จ</span><p>${num(r.success)} รายการ</p></div>
        <div><span>ต้องตรวจสอบ / ข้าม</span><p>${num(r.errors)} / ${num(st.excluded.length)}</p></div>
        <div><span>รหัสการนำเข้า</span><p>${esc(r.importId || '-')}</p></div>
      </section>
      <div class="actions"><button class="btn primary" data-act="again">นำเข้าไฟล์ใหม่</button><a class="btn" href="${path('backstage')}">หลังบ้าน</a></div>`,
    on: { 'click:again': () => { Object.assign(st, { step: 1, fileName: '', result: null }); ctx.rerender(); } },
  };
}

async function fillImportHistory() {
  const rows = await db.listImports();
  region('imports', rows.length ? `<ul class="list">${rows.slice(0, 20).map((r) => `<li><div><b>${esc(r.fileName)}</b>
    <small>${fmtDateTime(r.at)} · ${esc(TYPES[r.type] || r.type)} · ${esc(r.user || '')}</small></div>
    <div class="right"><b>${num(r.success)}</b><small>ผิด ${num(r.errors)} · ข้าม ${num(r.skipped)}</small></div></li>`).join('')}</ul>`
    : empty('ยังไม่เคยนำเข้า'));
}

function creates(plan, type) {
  return type === 'customers' ? plan.create.length + plan.update.length : plan.bills.length;
}

function headerLabel(k) {
  return {
    name: 'ชื่อลูกค้า', phone: 'เบอร์โทร', code: 'รหัสลูกค้า', no: 'เลขที่บิล', date: 'วันที่', customer: 'ลูกค้า', qty: 'จำนวน', sku: 'SKU', product: 'สินค้า', price: 'ราคา',
  }[k] || k;
}

// Rows of the parsed file as objects, skipping rows excluded in the preview.
function rowsOf(st) {
  const dict = st.type === 'customers' ? CUSTOMER_COLUMNS : BILL_COLUMNS;
  const rows = parseCsv(st.text).slice(1);
  const out = [];
  rows.forEach((cells, n) => {
    const line = n + 2;
    if (st.excluded.includes(line)) return;
    const it = { line };
    for (const k of Object.keys(dict)) {
      const idx = st.map[k];
      it[k] = idx === undefined ? '' : String(cells[idx] ?? '').trim();
    }
    out.push(it);
  });
  return out;
}

function runImport(plan, type, importId) {
  if (type === 'customers') {
    const created = db.writeRecords('customers', plan.create.map((c) => ({ ...c.fields, tags: c.fields.tags || '' })), { action: 'นำเข้าลูกค้า', source: 'import', importId, audit: false });
    const updated = db.writeRecords('customers', plan.update.map((u) => ({ id: u.id, ...u.fields })), { action: 'นำเข้า (อัปเดตลูกค้าเดิม)', source: 'import', importId, audit: false });
    return { success: created.length + updated.length };
  }
  const recs = plan.bills.map((b) => {
    const priced = b.lines.every((l) => l.price !== null);
    return {
      no: b.no, kind: 'bill', status: 'billed', date: b.date, customerId: b.customerId, src: '', priceUnknown: !priced,
      items: b.lines, discount: 0, vat: 'none',
      history: [{ at: Date.now(), action: 'นำเข้าจากไฟล์', by: db.getUser() || 'ระบบ', detail: importId }],
    };
  });
  const written = db.writeRecords('orders', recs, { action: 'นำเข้าบิล', source: 'import', importId, audit: false });
  return { success: written.length };
}

function importHistory() {
  return `<div data-region="imports"></div>`;
}

// ---------- settings ----------
const MASTER_LISTS = [
  ['zones', 'Zone'], ['provinces', 'จังหวัด'], ['businessTypes', 'ประเภทธุรกิจ'], ['owners', 'ผู้ดูแล'],
  ['tags', 'Tag'], ['terms', 'เงื่อนไข'], ['payments', 'การชำระเงิน'], ['taskTypes', 'ประเภทงาน'],
];

export function settingsPage(ctx) {
  const st = ctx.state;
  st.tab ||= 'general';
  const cs = syncState();
  const counts = Object.fromEntries(db.ENTITIES.map((e) => [e, db.list(e).length]));
  const body = {
    general: `
      <section class="card"><h2>ผู้ใช้งาน</h2>
        <form class="form" data-form="user">${field('user', 'ชื่อผู้ใช้ (บันทึกเป็นผู้ทำรายการ)', db.getUser(), 'autocomplete="name"')}<button class="btn primary wide">บันทึก</button></form></section>
      ${MASTER_LISTS.map(([key, label]) => `<section class="card"><h2>${label} <span class="count">${num(db.masters[key]?.length || 0)}</span></h2>
        <div class="chips wrap" data-region="m-${key}">${(db.masters[key] || []).map((v) => `<span class="chip">${esc(v)}<button type="button" class="chip-x" data-act="rm-master" data-list="${key}" data-v="${esc(v)}" aria-label="ลบ ${esc(v)}">${icon('x')}</button></span>`).join('') || '<span class="hint">ยังไม่มีรายการ</span>'}</div>
        <form class="form inline" data-form="add-master" data-list="${key}"><input name="v" placeholder="เพิ่ม${label}" autocomplete="off"><button class="btn small">${icon('plus')} เพิ่ม</button></form></section>`).join('')}`,
    data: `
      <section class="card"><h2>สถานะฐานข้อมูล</h2>
        <div class="info">${db.ENTITIES.map((e) => `<div><span>${esc(entityLabel(e))}</span><p>${num(counts[e])} รายการ</p></div>`).join('')}
          <div><span>รอซิงค์</span><p>${num(db.pendingCount())} รายการ${db.failedCount() ? ` · ไม่สำเร็จ ${num(db.failedCount())}` : ''}</p></div>
          <div><span>ความขัดแย้ง</span><p>${num(db.conflictList().length)} รายการ</p></div></div>
        <div class="actions"><button class="btn" data-act="check">${icon('shield')} ตรวจฐานข้อมูล</button></div>
        <div data-region="check"></div></section>
      <section class="card"><h2>สำรองข้อมูล</h2>
        <p class="hint">สำรองอัตโนมัติวันละครั้ง เก็บ 14 ชุดล่าสุด ก่อนนำเข้าและก่อนกู้คืนระบบจะสำรองให้เสมอ</p>
        <div class="actions"><a class="btn primary" href="${path('backup')}">${icon('database')} สำรอง / กู้คืน</a>
          <button class="btn" data-act="export">${icon('download')} ดาวน์โหลดไฟล์สำรอง</button></div></section>
      <section class="card"><h2>ข้อมูลทดสอบ</h2>
        <button class="btn ghost wide" data-act="demo">สร้างข้อมูลตัวอย่าง (ทดสอบความเร็ว)</button></section>`,
    system: `
      <section class="card"><h2>ฐานข้อมูลกลาง</h2>
        <p class="hint">ใส่ URL ของ Apps Script (ลงท้าย /exec) หรือที่อยู่เซิร์ฟเวอร์ ข้อมูลเก็บในเครื่องก่อนเสมอ แล้วซิงก์อัตโนมัติ</p>
        <form class="form" data-form="conn">
          ${field('url', 'URL ฐานข้อมูล', '', 'type="url" placeholder="https://…" inputmode="url"')}
          ${field('token', 'รหัสซิงค์ (SYNC_TOKEN)', '', 'type="password" autocomplete="off"')}
          <button class="btn primary wide">บันทึกและซิงก์ตอนนี้</button>
        </form>
        <p class="sync-status" data-region="sync-detail">${syncText(cs)}</p>
        <div class="actions"><button class="btn" data-act="sync">${icon('refresh')} ซิงก์ตอนนี้</button>
          <button class="btn" data-act="retry">${icon('refresh')} ลองใหม่ (เฉพาะที่ไม่สำเร็จ)</button></div></section>
      <section class="card"><h2>เครื่องนี้</h2>
        <div class="info"><div><span>รหัสเครื่อง</span><p>${esc(db.getDevice())}</p></div>
          <div><span>พื้นที่ที่ใช้</span><p data-region="storage">กำลังคำนวณ…</p></div></div></section>`,
  };
  return {
    html: `<h1>ตั้งค่า</h1>
      ${chips([['general', 'ทั่วไป'], ['data', 'ข้อมูล'], ['system', 'ระบบ']], st.tab, 'tab')}
      ${body[st.tab]}`,
    on: {
      'click:tab': (el) => { st.tab = el.dataset.key; ctx.rerender(); },
      'submit:user': async (form) => { await db.setUser(form.user.value.trim()); toast('บันทึกชื่อผู้ใช้แล้ว'); },
      'submit:add-master': (form) => {
        const v = form.v.value.trim();
        if (!v) return;
        const list = db.masters[form.dataset.list] || [];
        if (!list.includes(v)) db.setMasters({ ...db.masters, [form.dataset.list]: [...list, v] });
        ctx.rerender();
      },
      'click:rm-master': (el) => {
        const key = el.dataset.list;
        db.setMasters({ ...db.masters, [key]: (db.masters[key] || []).filter((x) => x !== el.dataset.v) });
        ctx.rerender();
      },
      'click:check': () => region('check', integrityReport()),
      'click:export': () => download(`artcrm-backup-${today()}.json`, JSON.stringify(db.exportAll()), 'application/json'),
      'click:demo': async () => {
        if (!(await confirmSheet('เพิ่มลูกค้าตัวอย่าง 500 ราย และออเดอร์ 3,000 รายการ?', 'สร้างข้อมูล'))) return;
        const t0 = performance.now();
        await seedDemo();
        toast(`สร้างข้อมูลตัวอย่างแล้ว (${(performance.now() - t0).toFixed(0)} ms)`);
        ctx.rerender();
      },
      'submit:conn': async (form) => {
        const url = form.url.value.trim();
        if (url !== (await db.getMeta('serverUrl'))) await db.setMeta('cursor', 0);
        await db.setMeta('serverUrl', url);
        await db.setMeta('token', form.token.value.trim());
        const ok = await sync({ manual: true });
        toast(ok ? 'ซิงก์สำเร็จ' : 'ซิงก์ไม่สำเร็จ ดูสถานะด้านล่าง');
        ctx.rerender();
      },
      'click:sync': async () => { toast('กำลังซิงก์…'); await sync({ manual: true }); ctx.rerender(); },
      'click:retry': async () => { toast('ลองส่งรายการที่ไม่สำเร็จ…'); await retryFailed(); ctx.rerender(); },
    },
    onMount: () => {
      if (st.tab === 'system') {
        db.getMeta('serverUrl').then((url) => { const f = document.querySelector('form[data-form=conn]'); if (f) f.url.value = url || ''; });
        db.getMeta('token').then((tk) => { const f = document.querySelector('form[data-form=conn]'); if (f) f.token.value = tk || ''; });
        navigator.storage?.estimate?.().then((e) => region('storage', `${(e.usage / 1048576).toFixed(1)} MB จาก ${(e.quota / 1048576).toFixed(0)} MB`)).catch(() => region('storage', 'ไม่ทราบ'));
      }
    },
  };
}

function entityLabel(e) {
  return { customers: 'ลูกค้า', leads: 'ร้านเป้าหมาย', orders: 'ออเดอร์ / บิล', tasks: 'งาน', activities: 'กิจกรรม', products: 'สินค้า' }[e] || e;
}

function syncText(st) {
  const last = st.lastSyncAt ? fmtDateTime(st.lastSyncAt) : 'ยังไม่เคย';
  const text = {
    off: 'ยังไม่ได้เชื่อมต่อฐานกลาง — ข้อมูลเก็บในเครื่องนี้',
    offline: `ออฟไลน์ — จะซิงก์เมื่อมีอินเทอร์เน็ต (ซิงก์ล่าสุด ${last})`,
    syncing: 'กำลังซิงก์…',
    ok: `ซิงก์สำเร็จ ${last}`,
    error: `${esc(st.error || 'ซิงก์ไม่สำเร็จ')} (ซิงก์ล่าสุด ${last})`,
    idle: `ซิงก์ล่าสุด ${last}`,
  }[st.status] || '';
  return st.backend === 'acrm' ? `${text}<br>เชื่อมต่อ A-CRM ${st.readOnly ? '(อ่านอย่างเดียว)' : ''}` : text;
}

function integrityReport() {
  const custIds = new Set(db.list('customers').map((c) => c.id));
  const orphanOrders = db.list('orders').filter((o) => o.customerId && !custIds.has(o.customerId)).length;
  const orphanTasks = db.list('tasks').filter((t) => (t.customerId && !custIds.has(t.customerId))).length;
  const phones = new Map();
  for (const c of db.list('customers')) for (const p of core.phoneKeys(c.phone)) phones.set(p, (phones.get(p) || 0) + 1);
  const dupPhones = [...phones.values()].filter((n) => n > 1).length;
  const bills = new Map();
  for (const o of db.list('orders')) if (o.kind === 'bill') bills.set(o.no, (bills.get(o.no) || 0) + 1);
  const dupBills = [...bills.values()].filter((n) => n > 1).length;
  const rows = [
    ['ออเดอร์ที่ลูกค้าไม่มีในระบบ', orphanOrders],
    ['งานที่ลูกค้าไม่มีในระบบ', orphanTasks],
    ['เบอร์โทรซ้ำกันหลายร้าน', dupPhones],
    ['เลขที่บิลซ้ำ', dupBills],
    ['รายการรอซิงค์', db.pendingCount()],
    ['รายการความขัดแย้ง', db.conflictList().length],
  ];
  const bad = rows.slice(0, 4).some(([, n]) => n > 0);
  return `<p class="${bad ? 'warn-text' : 'up'}">${bad ? 'พบสิ่งที่ควรตรวจสอบ' : 'ไม่พบปัญหาในข้อมูล'}</p>
    <ul class="plain">${rows.map(([k, n]) => `<li><span>${k}</span><small>${num(n)}</small></li>`).join('')}</ul>`;
}

async function seedDemo() {
  const first = ['สมชาย', 'สมหญิง', 'วิชัย', 'มาลี', 'ประเสริฐ', 'สุดา', 'อนันต์', 'กมล', 'ปิยะ', 'รัตนา', 'ธนา', 'จันทร์เพ็ญ'];
  const last = ['ใจดี', 'รุ่งเรือง', 'ศรีสุข', 'มั่นคง', 'ทองดี', 'แสงทอง', 'พานิช', 'บุญมา'];
  const shops = ['ร้านค้าส่ง', 'มินิมาร์ท', 'บจก.', 'หจก.', 'ร้าน'];
  const products = [['น้ำดื่ม 600ml (แพ็ค)', 42], ['กาแฟกระป๋อง (ลัง)', 360], ['ข้าวสาร 5 กก.', 185], ['น้ำมันพืช 1 ลิตร', 52], ['สบู่ก้อน (โหล)', 150], ['ผงซักฟอก 3 กก.', 210], ['บะหมี่กึ่งฯ (ลัง)', 190], ['นมกล่อง (ลัง)', 420]];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const custs = Array.from({ length: 500 }, (_, i) => ({
    name: `${pick(first)} ${pick(last)} ${i + 1}`, company: `${pick(shops)}${pick(last)}`,
    phone: '08' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), tags: Math.random() < 0.1 ? 'VIP' : '',
    zone: pick(db.masters.zones),
  }));
  const savedCusts = db.writeRecords('customers', custs, { action: 'ข้อมูลตัวอย่าง', audit: false });
  const orderRecs = Array.from({ length: 3000 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - Math.floor(Math.random() * 90));
    const items = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => {
      const [name, price] = pick(products);
      return { name, qty: 1 + Math.floor(Math.random() * 20), price, unit: '' };
    });
    return { no: `DEMO-${String(i + 1).padStart(5, '0')}`, date: core.localDate(d), customerId: pick(savedCusts).id, items, discount: 0, status: pick(['paid', 'paid', 'pending', 'sent', 'billed']), kind: 'order', vat: 'none', history: [] };
  });
  db.writeRecords('orders', orderRecs, { action: 'ข้อมูลตัวอย่าง', audit: false });
}

// ---------- backup & restore ----------
const REASON = { auto: 'อัตโนมัติ', manual: 'สำรองเอง', 'before-import': 'ก่อนนำเข้า', 'before-restore': 'ก่อนกู้คืน' };

export function backupPage() {
  const render = async () => {
    const rows = await db.listBackups();
    region('list', rows.length ? `<ul class="list">${rows.map((b) => `<li>
        <div><b>${fmtDateTime(b.at)}</b><small>${esc(REASON[b.reason] || b.reason)} · ${Object.entries(b.counts).map(([k, v]) => `${entityLabel(k)} ${num(v)}`).join(' · ')} · ${(b.bytes / 1024).toFixed(0)} KB</small></div>
        <div class="right"><button class="btn small" data-act="view" data-id="${esc(b.id)}">รายละเอียด</button>
          <button class="btn small ghost" data-act="restore" data-id="${esc(b.id)}">กู้คืน</button></div></li>`).join('')}</ul>` : empty('ยังไม่มีไฟล์สำรอง'));
  };
  return {
    html: `<div class="head"><a href="${path('backstage')}" class="back">${icon('chevLeft')} หลังบ้าน</a></div>
      <h1>สำรอง / กู้คืน</h1>
      <div class="actions"><button class="btn primary" data-act="backup">${icon('database')} สำรองตอนนี้</button></div>
      <section class="card"><h2>ไฟล์สำรองในเครื่อง</h2><div data-region="list"></div></section>
      <section class="card"><h2>กู้คืนจากไฟล์ .json</h2>
        <p class="hint">กู้คืนไม่ลบข้อมูลที่มีอยู่ รายการในไฟล์จะทับเฉพาะรายการที่ตรงกัน ระบบจะสำรองข้อมูลปัจจุบันก่อนเสมอ</p>
        <label class="btn wide file">${icon('upload')} เลือกไฟล์สำรอง<input type="file" accept="application/json,.json" data-ch="file" hidden></label></section>`,
    on: {
      'click:backup': async () => { await db.createBackup('manual'); toast('สำรองข้อมูลแล้ว'); render(); },
      'click:view': async (el) => {
        const b = (await db.listBackups()).find((x) => x.id === el.dataset.id);
        openSheet({ title: 'รายละเอียดไฟล์สำรอง', html: `<p>${fmtDateTime(b.at)} · ${esc(REASON[b.reason] || b.reason)}</p>
          <ul class="plain">${Object.entries(b.counts).map(([k, v]) => `<li><span>${entityLabel(k)}</span><small>${num(v)}</small></li>`).join('')}</ul>` });
      },
      'click:restore': async (el) => {
        const data = await db.readBackup(el.dataset.id);
        if (data) previewRestore(normalize(data), render);
      },
      'change:file': async (el) => {
        const file = el.files?.[0];
        if (!file) return;
        try { previewRestore(db.normalizeBackup(JSON.parse(await file.text())), render); } catch (e) { toast(e.message); }
      },
    },
    onMount: render,
  };
}

function normalize(data) {
  return db.normalizeBackup(data.app ? data : { app: 'artcrm', entities: data.entities || data });
}

function previewRestore(parsed, afterRestore) {
  const current = Object.fromEntries(db.ENTITIES.map((e) => [e, db.mem[e]]));
  const diff = core.diffCollections(current, parsed.entities);
  openSheet({
    title: 'ตรวจสอบก่อนกู้คืน',
    html: `<div class="kpis">
        <div class="kpi"><span>รายการใหม่</span><b class="up">${num(diff.add)}</b></div>
        <div class="kpi"><span>จะทับ (ต่างจากปัจจุบัน)</span><b class="warn-text">${num(diff.update)}</b></div>
        <div class="kpi"><span>เหมือนเดิม</span><b>${num(diff.same)}</b></div>
        <div class="kpi"><span>เก็บไว้ (ไม่อยู่ในไฟล์)</span><b>${num(diff.keep)}</b></div>
      </div>
      <p class="hint">ระบบจะสำรองข้อมูลปัจจุบันก่อน แล้วจึงกู้คืน ข้อมูลที่ไม่อยู่ในไฟล์จะไม่ถูกลบ</p>
      <div class="actions"><button class="btn" data-act="close-sheet">ยกเลิก</button><button class="btn primary" data-act="do">ยืนยันกู้คืน</button></div>`,
    on: {
      'click:do': async () => {
        await db.createBackup('before-restore');
        let n = 0;
        for (const e of db.ENTITIES) {
          const list = (parsed.entities[e] || []).map(stripUnderscore);
          const changed = list.filter((r) => JSON.stringify(stripUnderscore(db.mem[e].get(r.id) || {})) !== JSON.stringify(r));
          if (changed.length) { db.writeRecords(e, changed, { action: 'กู้คืนจากสำรอง', source: 'restore', audit: false }); n += changed.length; }
        }
        if (parsed.masters) await db.setMasters({ ...db.masters, ...parsed.masters });
        await db.logEvent('กู้คืนข้อมูล', `${num(n)} รายการ`);
        closeSheet();
        toast(`กู้คืนแล้ว ${num(n)} รายการ`);
        afterRestore();
      },
    },
  });
}

const stripUnderscore = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) o[k] = v; return o; };

// ---------- audit log (ประวัติการเปลี่ยนแปลง) ----------
export function auditPage(ctx) {
  const st = ctx.state;
  st.f ||= 'all';
  const render = async () => {
    const q = (st.q || '').trim().toLowerCase();
    let rows = await db.listAudit(800);
    if (st.f !== 'all') rows = rows.filter((r) => r.entity === st.f);
    if (q) rows = rows.filter((r) => `${r.action} ${r.label} ${r.user}`.toLowerCase().includes(q));
    region('rows', rows.length ? `<ul class="timeline">${rows.slice(0, 300).map((r) => `<li><span class="dot"></span><div class="tl-body">
      <div class="tl-head"><b>${esc(r.action)}</b> <small>${fmtDateTime(r.at)} · ${esc(r.user || '-')} · ${esc(r.device || '')}</small></div>
      <p>${esc(r.label || '')}</p>${r.before || r.after ? `<small class="muted-s">${esc(diffText(r.before, r.after))}</small>` : ''}</div></li>`).join('')}</ul>`
      : empty('ไม่มีประวัติ'));
  };
  return {
    html: `<div class="head"><a href="${path('backstage')}" class="back">${icon('chevLeft')} หลังบ้าน</a></div>
      <h1>ประวัติการเปลี่ยนแปลง</h1>
      <input class="search" type="search" placeholder="ค้นหาการกระทำ ชื่อ ผู้ทำรายการ" data-in="q" value="${esc(st.q || '')}" autocomplete="off">
      ${chips([['all', 'ทั้งหมด'], ['customers', 'ลูกค้า'], ['orders', 'ออเดอร์'], ['tasks', 'งาน'], ['activities', 'กิจกรรม'], ['system', 'ระบบ']], st.f, 'f')}
      <div data-region="rows"></div>`,
    on: {
      'input:q': (el) => { st.q = el.value; render(); },
      'click:f': (el) => { st.f = el.dataset.key; ctx.rerender(); },
    },
    onMount: render,
  };
}

function diffText(before, after) {
  if (!before) return 'สร้างใหม่';
  if (!after) return '';
  const keys = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).slice(0, 4);
  return keys.map((k) => `${k}: ${before[k] ?? '-'} → ${after[k] ?? '-'}`).join(' · ');
}
