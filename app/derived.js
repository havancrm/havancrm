// Derived data for the screens. Everything here is memoized per data version, so a list screen
// that is re-rendered many times does not recompute the sales index each time.
import * as db from './db.js';
import { syncState } from './sync.js';
import * as core from './core.js';

let version = 0;
const memo = new Map();
export const bump = () => { version += 1; memo.clear(); };
function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && hit.v === version) return hit.value;
  const value = fn();
  memo.set(key, { v: version, value });
  return value;
}

// A-CRM is the source of truth for sales: only ACTIVE bills count. Local orders count unless cancelled.
export const isAcrm = () => syncState().backend === 'acrm';
export const isSale = (o) => (isAcrm() ? o.kind === 'bill' && o.status === 'billed' : !['cancelled', 'excluded'].includes(o.status));
export const sales = () => cached('sales', () => db.list('orders').filter(isSale));
export const stats = () => cached('stats', () => core.buildStats(sales(), core.today()));
export const customers = () => cached('customers', () => db.list('customers'));
export const leads = () => cached('leads', () => db.list('leads').filter((l) => !l.convertedTo));
export const orders = () => cached('orders', () => db.list('orders'));
export const products = () => cached('products', () => db.list('products'));
export const tasks = () => cached('tasks', () => db.list('tasks'));
export const activities = () => cached('activities', () => db.list('activities').filter((a) => !a.hidden));

export const productIdx = (customerId) => cached('pidx:' + (customerId || ''), () => core.productIndex(sales(), customerId));
export const productSalesOf = (opts) => core.productSales(sales(), opts);

export function cycleOf(customerId) {
  const c = db.get('customers', customerId);
  return core.cycleState(stats().get(customerId), c?.snoozeUntil, core.today());
}

export function openTasksOf(customerId) {
  return cached('openTasks:' + customerId, () => tasks().filter((t) => t.customerId === customerId && t.status !== 'done'));
}

// Product catalog: every SKU seen on sales lines, overlaid with master data (standard price, unit).
// A product is keyed by its SKU, or by name when it has none.
export const catalog = () => cached('catalog', () => {
  const map = new Map();
  for (const o of sales()) {
    for (const i of o.items || []) {
      const key = i.code || i.name;
      if (!key || map.has(key)) continue;
      map.set(key, { id: key, code: i.code || '', name: i.name, unit: i.unit || '' });
    }
  }
  for (const p of products()) map.set(p.id, { ...map.get(p.id), ...p, id: p.id });
  return [...map.values()];
});

export const searchIdx = () => cached('search', () => core.buildSearchIndex({
  customers: customers(), leads: leads(), orders: orders(), products: catalog(),
}));

// Customer-centred helpers.
export const customerName = (id) => db.get('customers', id)?.name || '(ไม่ระบุลูกค้า)';
export const lastSaleOf = (customerId) => sales().filter((o) => o.customerId === customerId).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
export const ordersOf = (customerId) => orders().filter((o) => o.customerId === customerId).sort(byDateDesc);

export const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || String(b.no).localeCompare(String(a.no));

// Sales counted in a date range (inclusive), plus the buyers in that range.
export function salesIn(range) {
  let sum = 0; let count = 0; const buyers = new Set();
  for (const o of sales()) {
    if (range && (o.date < range.from || o.date > range.to)) continue;
    sum += core.orderTotal(o); count += 1; buyers.add(o.customerId);
  }
  return { sum, count, buyers: buyers.size };
}
