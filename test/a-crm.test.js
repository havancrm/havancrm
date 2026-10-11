import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGas, Sheet } from './gas-mock.js';

// Synthetic rows laid out with the real A-CRM header names (no real customer data).
const HEADERS = {
  CUSTOMERS: ['customer_code', 'shop_name', 'business_type', 'primary_phone', 'phone_all', 'shipping_address', 'line_id',
    'active_flag', 'updated_at', 'contact_name', 'province', 'customer_note', 'owner_staff_name', 'id', 'name', 'phones', 'note'],
  BILLS: ['invoice_no', 'customer_code', 'invoice_date', 'header_total_original', 'final_total', 'bill_vat_type', 'status',
    'payment_terms_snapshot', 'updated_at', 'bill_opener', 'salesperson'],
  BILL_ITEMS: ['item_id', 'invoice_no', 'line_no', 'product_code', 'product_name', 'qty', 'unit_price', 'line_total', 'unit', 'product_name_snapshot'],
  PRODUCTS: ['product_code', 'product_name', 'unit', 'last_unit_price', 'sku', 'name'],
  ORDERS: ['order_id', 'customer_code', 'order_date', 'status', 'discount_total', 'subtotal', 'final_total', 'note', 'sales_user',
    'created_at', 'updated_at', 'current_version', 'sync_status', '', '', 'id', 'cid', 'created', 'items', 'last_request_id'],
  ORDER_ITEMS: ['order_item_id', 'order_id', 'line_no', 'product_code', 'product_name_snapshot', 'qty', 'unit', 'unit_price',
    'discount', 'line_total', 'created_at', 'updated_at', 'version_no', 'gift_qty', 'item_note', 'active_flag', 'sync_status'],
};

function table(name, rows, { shuffle = false } = {}) {
  let headers = HEADERS[name];
  if (shuffle) headers = [...headers].reverse();
  const s = new Sheet(name);
  s.data = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))];
  return s;
}

function fixture(opts) {
  const sheets = new Map();
  const add = (s) => sheets.set(s.name, s);
  add(table('CUSTOMERS', [
    { customer_code: '10001', shop_name: 'ร้านทดสอบ ก', business_type: 'นวด/สปา', primary_phone: 812345678, phone_all: '0812345678, 0898765432',
      shipping_address: 'ถนนทดสอบ 1', active_flag: 'TRUE', updated_at: 46263.02083, province: 'กรุงเทพมหานคร', owner_staff_name: 'เซลล์ A' },
    { customer_code: '10002', shop_name: '', name: 'ร้านชื่อสำรอง', primary_phone: '21234567', active_flag: 'FALSE', updated_at: '2026-08-29 10:30:00' },
    { customer_code: '' },
  ], opts));
  add(table('PRODUCTS', [
    { product_code: '2002', product_name: 'ครีมทดสอบ A2', unit: 'ชุด' },
    { product_code: '8710', product_name: 'น้ำมันทดสอบ 1 ลิตร', unit: 'แกลลอน' },
  ], opts));
  add(table('BILLS', [
    { invoice_no: '500001', customer_code: '10001', invoice_date: '2025-01-02', final_total: '360.0', status: 'ACTIVE', salesperson: 'เซลล์ A', bill_opener: 'แอดมิน' },
    { invoice_no: '500002', customer_code: '10001', invoice_date: new Date('2026-10-01T00:00:00Z'), final_total: '1,045', status: 'ACTIVE' },
    { invoice_no: '500003', customer_code: '10002', invoice_date: '02/10/2569', final_total: '99', status: 'EXCLUDED' },
  ], opts));
  add(table('BILL_ITEMS', [
    { item_id: '500001-001', invoice_no: '500001', line_no: 1, product_code: '2002', product_name: 'ครีมทดสอบ A2', qty: '12.0', unit_price: '30.0', unit: 'ชุด', product_name_snapshot: 'ครีมทดสอบ A2' },
    { item_id: '500002-002', invoice_no: '500002', line_no: 2, product_code: '8710', product_name: 'ชื่อตอนขาย', qty: '1', unit_price: '220', unit: 'แกลลอน' },
    { item_id: '500002-001', invoice_no: '500002', line_no: 1, product_code: '9999', product_name: 'สินค้านอกแคตตาล็อก', qty: '5', unit_price: '165', unit: 'ขวด' },
  ], opts));
  add(table('ORDERS', [
    { order_id: 'O-691001-083112hl', customer_code: '10001', order_date: '2026-10-01 8:31', status: 'sent', id: 'O-691001-083112hl', cid: '10001',
      items: JSON.stringify([{ sku: '2002', q: 6, u: 'ชุด' }, { sku: '8710', q: 1, g: 1, u: 'แกลลอน', p: 220 }]) },
    { order_id: 'O-TEST_ORDER_x', customer_code: '10001', status: 'sent' },
  ], opts));
  add(table('ORDER_ITEMS', [], opts));
  return loadGas('../google-apps-script/a-crm/Code.gs', { sheets });
}

const expand = (res) => res.changes.orders.map((o) => ({
  ...o,
  items: (o.items || []).map(([code, qty, price, name, unit]) => ({ code, qty, price, name: name ?? res.dict[code]?.[0], unit: unit ?? res.dict[code]?.[1] })),
}));

for (const shuffle of [false, true]) {
  test(`snapshot maps A-CRM customers, bills and orders by header name${shuffle ? ' (columns reordered)' : ''}`, () => {
    const { post } = fixture({ shuffle });
    const res = post({ action: 'sync', since: 0, changes: {} });
    assert.equal(res.backend, 'acrm');
    assert.equal(res.readOnly, true);
    assert.equal(res.snapshot, true);

    const [a, b] = res.changes.customers;
    assert.equal(res.changes.customers.length, 2, 'rows without customer_code are skipped');
    assert.equal(a.id, '10001');
    assert.equal(a.name, 'ร้านทดสอบ ก');
    assert.equal(a.phone, '0812345678', 'leading zero restored');
    assert.equal(a.phones, '0812345678, 0898765432');
    assert.equal(a.owner, 'เซลล์ A');
    assert.equal(a.src, 'acrm');
    assert.ok(a.updatedAt > Date.UTC(2026, 0, 1), 'serial date parsed');
    assert.equal(b.name, 'ร้านชื่อสำรอง');
    assert.equal(b.phone, '021234567', 'landline zero restored');
    assert.equal(b.inactive, true);

    const orders = expand(res);
    const bill1 = orders.find((o) => o.id === 'B500001');
    assert.deepEqual(bill1.items, [{ code: '2002', qty: 12, price: 30, name: 'ครีมทดสอบ A2', unit: 'ชุด' }]);
    assert.equal(bill1.total, 360);
    assert.equal(bill1.status, 'billed');
    assert.equal(bill1.date, '2025-01-02');
    assert.equal(bill1.salesperson, 'เซลล์ A');
    const bill2 = orders.find((o) => o.id === 'B500002');
    assert.equal(bill2.total, 1045, 'final_total is the sales figure');
    assert.equal(bill2.date, '2026-10-01');
    assert.deepEqual(bill2.items.map((i) => [i.name, i.qty, i.price, i.unit]),
      [['สินค้านอกแคตตาล็อก', 5, 165, 'ขวด'], ['ชื่อตอนขาย', 1, 220, 'แกลลอน']], 'sorted by line_no; snapshot names kept');
    const bill3 = orders.find((o) => o.id === 'B500003');
    assert.equal(bill3.status, 'excluded', 'non-ACTIVE bills are not sales');
    assert.equal(bill3.date, '2026-10-02', 'Buddhist-era date converted');

    const legacy = orders.find((o) => o.kind === 'order');
    assert.equal(legacy.id, 'O-691001-083112hl');
    assert.equal(legacy.status, 'sent');
    assert.equal(legacy.date, '2026-10-01');
    assert.equal(legacy.priceUnknown, true, 'legacy order without prices is not guessed');
    assert.deepEqual(legacy.items.map((i) => [i.name, i.qty, i.price]),
      [['ครีมทดสอบ A2', 6, null], ['น้ำมันทดสอบ 1 ลิตร', 1, 220], ['น้ำมันทดสอบ 1 ลิตร (แถม)', 1, 0]]);
    assert.ok(!orders.some((o) => /TEST/.test(o.id)), 'test orders are hidden');
  });
}

test('unchanged spreadsheet returns no data', () => {
  const { post } = fixture();
  const first = post({ since: 0, changes: {} });
  const again = post({ since: first.cursor, changes: {} });
  assert.equal(again.unchanged, true);
  assert.equal(again.changes, undefined);
});

test('read-only by default: orders and customer edits are rejected, sheets untouched', () => {
  const { post, sheets } = fixture();
  const before = JSON.stringify(sheets.get('ORDERS').data);
  const res = post({
    since: 0,
    changes: {
      orders: [{ id: 'O-691011-101010ab', customerId: '10001', date: '2026-10-11', items: [{ name: 'ครีมทดสอบ A2', qty: 1, price: 30 }], updatedAt: 1 }],
      customers: [{ id: '10001', name: 'แก้ชื่อ', updatedAt: 1 }],
    },
  });
  assert.deepEqual(res.rejected, { customers: ['10001'], orders: ['O-691011-101010ab'] });
  assert.equal(JSON.stringify(sheets.get('ORDERS').data), before);
});

test('with WRITE_ENABLED new orders are appended once, after a backup', () => {
  const { post, sheets, props, drive } = fixture({ shuffle: true });
  props.set('WRITE_ENABLED', 'true');
  const order = {
    id: 'O-691011-101010ab', no: 'O-691011-101010ab', customerId: '10001', date: '2026-10-11', status: 'pending', discount: 10, note: '=ส่งด่วน',
    items: [{ name: 'ครีมทดสอบ A2', qty: 2, price: 30, unit: 'ชุด' }, { name: 'ของใหม่', qty: 1, price: 50 }], updatedAt: 1,
  };
  const res = post({ since: 0, user: 'เซลล์ A', changes: { orders: [order, { ...order, id: 'O-x', customerId: 'ไม่มีรหัสนี้' }, { id: 'B500001', src: 'acrm', kind: 'bill', updatedAt: 1 }] } });
  assert.deepEqual(res.accepted.orders, ['O-691011-101010ab']);
  assert.deepEqual(res.rejected.orders, ['O-x', 'B500001']);
  assert.equal(drive.copies.length, 1, 'backup taken before the first write of the day');

  const os = sheets.get('ORDERS');
  const h = os.data[0];
  const row = os.data[os.data.length - 1];
  const v = (k) => row[h.indexOf(k)];
  assert.equal(v('order_id'), 'O-691011-101010ab');
  assert.equal(v('customer_code'), '10001');
  assert.equal(v('status'), 'sent');
  assert.equal(v('subtotal'), 110);
  assert.equal(v('final_total'), 100);
  assert.equal(v('sales_user'), 'เซลล์ A');
  assert.equal(v('note'), '=ส่งด่วน', 'stored as text (apostrophe prefix)');
  const items = sheets.get('ORDER_ITEMS');
  const ih = items.data[0];
  assert.deepEqual(items.data.slice(1).map((r) => [r[ih.indexOf('order_item_id')], r[ih.indexOf('product_code')], r[ih.indexOf('line_total')]]),
    [['O-691011-101010ab-1', '2002', 60], ['O-691011-101010ab-2', '', 50]]);

  const written = expand(res).find((o) => o.id === order.id);
  assert.equal(written.total, 100, 'the new order comes back in the snapshot');

  const rows = os.data.length;
  const retry = post({ since: 0, user: 'เซลล์ A', changes: { orders: [order] } });
  assert.deepEqual(retry.accepted.orders, [order.id]);
  assert.equal(os.data.length, rows, 'retry does not duplicate');
  assert.equal(drive.copies.length, 1, 'one backup per day');
});
