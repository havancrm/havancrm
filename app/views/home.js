// Home (หน้าหลัก) and the global search results page.
import * as db from '../db.js';
import * as core from '../core.js';
import { esc, money, num, thaiDate, today } from '../core.js';
import { icon, path, badge, empty, region } from '../ui.js';
import { sales, stats, tasks, customers, orders, cycleOf, searchIdx, catalog, customerName, salesIn, isAcrm } from '../derived.js';

export function home(ctx) {
  const t = today();
  const month = salesIn({ from: t.slice(0, 7) + '-01', to: t });
  const todaySum = salesIn({ from: t, to: t });
  const open = tasks().filter((x) => x.status !== 'done');
  const overdue = open.filter((x) => x.dueDate < t).length;
  const dueToday = open.filter((x) => x.dueDate === t).length;
  const cycleDue = customers().filter((c) => ['due', 'overdue'].includes(cycleOf(c.id).key)).length;
  const waiting = orders().filter((o) => o.status === 'pending').length;

  const days = [];
  for (let i = 6; i >= 0; i--) days.push({ date: core.addDays(t, -i), sum: 0 });
  const idx = new Map(days.map((d, i) => [d.date, i]));
  for (const o of sales()) if (idx.has(o.date)) days[idx.get(o.date)].sum += core.orderTotal(o);
  const max = Math.max(1, ...days.map((d) => d.sum));
  const unit = isAcrm() ? 'บิล' : 'ออเดอร์';

  const work = [
    ['tasks?tab=overdue', 'งานเลยกำหนด', overdue, overdue ? 'warn-text' : ''],
    ['tasks?tab=today', 'งานวันนี้', dueToday, ''],
    ['cycles', 'ลูกค้าถึงรอบ', cycleDue, cycleDue ? 'warn-text' : ''],
    ['orders?tab=pending', 'ออเดอร์รอส่ง', waiting, ''],
  ];

  return {
    html: `
    <form class="searchbar" data-form="search" role="search">
      ${icon('search')}
      <input name="q" type="search" placeholder="ค้นหาชื่อร้าน รหัส เบอร์ ที่อยู่ เลขออเดอร์ SKU" autocomplete="off" enterkeyhint="search">
    </form>

    <section class="card">
      <h2>งานวันนี้</h2>
      <div class="tiles">${work.map(([p, l, n, cls]) => `<a class="tile" href="${path(p.split('?')[0], undefined, p.includes('?') ? '?' + p.split('?')[1] : '')}">
        <span>${l}</span><b class="${cls}">${num(n)}</b></a>`).join('')}</div>
    </section>

    <div class="quick">
      <a class="quick-btn primary-quick" href="${path('order-edit', 'new')}">${icon('cart')}<span>รับออเดอร์</span></a>
      <a class="quick-btn" href="${path('lead-edit', 'new')}">${icon('store')}<span>เพิ่มร้าน</span></a>
      <a class="quick-btn" href="${path('customers')}">${icon('users')}<span>ลูกค้า</span></a>
      <a class="quick-btn" href="${path('map')}">${icon('map')}<span>แผนที่</span></a>
    </div>

    <section class="card">
      <h2>ยอดขาย <a class="more" href="${path('sales')}">ดูรายละเอียด</a></h2>
      <div class="kpis">
        <div class="kpi"><span>วันนี้</span><b>${money(todaySum.sum)}</b><small>${num(todaySum.count)} ${unit}</small></div>
        <div class="kpi"><span>เดือนนี้</span><b>${money(month.sum)}</b><small>${num(month.count)} ${unit} · ${num(month.buyers)} ราย</small></div>
      </div>
      <div class="bars">${days.map((d) => `
        <div class="bar" title="${esc(thaiDate(d.date))}: ${money(d.sum)}">
          <i style="height:${(d.sum / max) * 100}%"></i>
          <em>${new Date(d.date + 'T00:00:00').toLocaleDateString('th-TH', { weekday: 'short' })}</em>
        </div>`).join('')}
      </div>
    </section>`,
    on: {
      'submit:search': (form) => {
        const q = form.q.value.trim();
        ctx.go(q ? `search?q=${encodeURIComponent(q)}` : 'search');
      },
    },
  };
}

const GROUPS = [
  ['customers', 'ลูกค้า', (id) => path('customer', id)],
  ['leads', 'ร้านเป้าหมาย', (id) => path('lead', id)],
  ['orders', 'ออเดอร์', (id) => path('order', id)],
  ['bills', 'บิล', (id) => path('order', id)],
  ['products', 'สินค้า', (id) => path('product', id)],
];

export function searchPage(ctx) {
  const q = ctx.params.get('q') || '';
  const render = (value) => {
    const groups = core.search(searchIdx(), value, 20);
    const html = GROUPS.map(([key, label, href]) => {
      const ids = groups[key];
      if (!ids.length) return '';
      const rows = ids.map((id) => {
        const row = rowFor(key, id);
        return `<li><a href="${href(id)}"><div><b>${esc(row.title)}</b><small>${esc(row.sub)}</small></div><div class="right">${row.right}</div></a></li>`;
      }).join('');
      const extra = groups.totals[key] - ids.length;
      return `<section class="card"><h2>${label} <span class="count">${num(groups.totals[key])}</span></h2>
        <ul class="list">${rows}</ul>${extra > 0 ? `<p class="hint">และอีก ${num(extra)} รายการ — พิมพ์คำค้นให้เฉพาะขึ้น</p>` : ''}</section>`;
    }).join('');
    region('results', value.trim() ? (html || empty('ไม่พบข้อมูลที่ตรงกับคำค้น')) : empty('พิมพ์ชื่อร้าน เบอร์ เลขออเดอร์ หรือ SKU'));
  };
  return {
    html: `
    <div class="head"><a href="${path('')}" class="back">${icon('chevLeft')} หน้าหลัก</a></div>
    <form class="searchbar" data-form="noop" role="search">
      ${icon('search')}
      <input name="q" type="search" value="${esc(q)}" placeholder="ค้นหา" autocomplete="off" autofocus data-in="q">
    </form>
    <div data-region="results"></div>`,
    on: {
      'input:q': (el) => {
        ctx.state.q = el.value;
        render(el.value);
        history.replaceState(null, '', '#/search' + (el.value ? '?q=' + encodeURIComponent(el.value) : ''));
      },
      'submit:noop': () => {},
    },
    onMount: () => render(q),
  };
}

function rowFor(key, id) {
  if (key === 'customers') {
    const c = db.get('customers', id);
    const s = stats().get(id);
    return { title: c?.name || '', sub: [c?.code, c?.phone, c?.province].filter(Boolean).join(' · '), right: `<b>${money(s?.total)}</b><small>${s?.last ? thaiDate(s.last) : 'ยังไม่มียอด'}</small>` };
  }
  if (key === 'leads') {
    const l = db.get('leads', id);
    return { title: l?.name || '', sub: [l?.phone, l?.area || l?.province].filter(Boolean).join(' · '), right: badge(l?.status || 'none', 'info') };
  }
  if (key === 'products') {
    const p = catalog().find((x) => x.id === id);
    return { title: p?.name || id, sub: p?.code || '', right: '' };
  }
  const o = db.get('orders', id);
  return {
    title: `${o?.kind === 'bill' ? 'บิล ' : ''}${o?.no || id}`,
    sub: `${customerName(o?.customerId)} · ${thaiDate(o?.date)}`,
    right: `<b>${money(core.orderTotal(o || {}))}</b>`,
  };
}
