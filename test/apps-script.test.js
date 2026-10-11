import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './gas-mock.js';

const customer = { id: 'c1', name: 'สมชาย ใจดี', phone: '0812345678', company: 'ร้านสมชาย', createdAt: 1, updatedAt: 1000 };
const order = {
  id: 'o1', no: 'SO-001', date: '2026-10-11', customerId: 'c1', status: 'paid', discount: 20,
  items: [{ name: 'กาแฟกระป๋อง (ลัง)', qty: 3, price: 360 }, { name: 'น้ำดื่ม x12', qty: 2, price: 42.5 }],
  createdAt: 1, updatedAt: 1000,
};

test('rejects a wrong token', () => {
  const { ctx } = loadCodeGs();
  const res = JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token: 'nope' }) } }).text);
  assert.equal(res.error, 'unauthorized');
});

test('pushed records are stored readably and returned to another phone unchanged', () => {
  const { post, sheets } = loadCodeGs();
  const r1 = post({ since: 0, changes: { customers: [customer], orders: [order] } });
  assert.ok(r1.cursor > 0);

  const cRow = sheets.get('ลูกค้า').data[1];
  assert.equal(cRow[0], 'สมชาย ใจดี');
  assert.equal(cRow[1], '0812345678', 'phone keeps its leading zero');
  const oRow = sheets.get('ออเดอร์').data[1];
  assert.equal(oRow[2], 'สมชาย ใจดี', 'order shows the customer name');
  assert.equal(oRow[3], 'กาแฟกระป๋อง (ลัง) × 3 @ 360\nน้ำดื่ม x12 × 2 @ 42.5');
  assert.equal(oRow[5], 1145, 'total = 1080 + 85 - 20');
  assert.equal(oRow[6], 'ชำระแล้ว');

  const r2 = post({ since: 0, changes: {} });
  assert.deepEqual(r2.changes.customers, [customer]);
  assert.deepEqual(r2.changes.orders, [order]);
});

test('last write wins and old changes are not re-sent after the overlap window', () => {
  const { post } = loadCodeGs();
  post({ since: 0, changes: { customers: [customer] } });
  post({ since: 0, changes: { customers: [{ ...customer, name: 'เก่ากว่า', updatedAt: 500 }] } });
  let res = post({ since: 0, changes: {} });
  assert.equal(res.changes.customers[0].name, 'สมชาย ใจดี');
  post({ since: 0, changes: { customers: [{ ...customer, name: 'ใหม่กว่า', updatedAt: 2000 }] } });
  res = post({ since: 0, changes: {} });
  assert.equal(res.changes.customers[0].name, 'ใหม่กว่า');
  assert.equal(post({ since: Date.now() + 120000, changes: {} }).changes.customers.length, 0);
});

test('rows typed into the sheet get ids and link orders to customers by name', () => {
  const { post, sheets, ctx } = loadCodeGs();
  post({ since: 0, changes: { customers: [customer] } });
  const cs = sheets.get('ลูกค้า');
  cs.set(3, 1, 'ลูกค้าใหม่จากชีต'); cs.set(3, 2, '0899999999');
  const os = ctx.SpreadsheetApp.getActive().getSheetByName('ออเดอร์');
  os.set(2, 2, '11/10/2569'); os.set(2, 3, 'สมชาย ใจดี'); os.set(2, 4, 'ข้าวสาร 5 กก. x 2 @ 185\nของแถม'); os.set(2, 7, 'รอชำระ');
  os.set(3, 3, 'ร้านใหม่'); os.set(3, 4, 'สบู่ × 1 @ 150');

  const res = post({ since: 0, changes: {} });
  const added = res.changes.customers.find((c) => c.name === 'ลูกค้าใหม่จากชีต');
  assert.ok(added.id && added.updatedAt, 'manual customer row got an id');
  assert.equal(added.phone, '0899999999');
  const [o1, o2] = res.changes.orders;
  assert.equal(o1.customerId, 'c1');
  assert.equal(o1.date, '2026-10-11', 'Buddhist-era d/m/yyyy converted');
  assert.deepEqual(o1.items, [{ name: 'ข้าวสาร 5 กก.', qty: 2, price: 185 }, { name: 'ของแถม', qty: 1, price: 0 }]);
  assert.equal(o1.status, 'pending');
  assert.ok(o1.no, 'order number generated');
  const shop = res.changes.customers.find((c) => c.name === 'ร้านใหม่');
  assert.ok(shop, 'unknown customer name creates a customer');
  assert.equal(o2.customerId, shop.id);
  // Stable on the next sync: no duplicate ids or customers.
  const again = post({ since: 0, changes: {} });
  assert.equal(again.changes.customers.length, 3);
  assert.equal(again.changes.orders[0].id, o1.id);
});

test('editing a cell in the sheet bumps the timestamp so phones pick it up', () => {
  const { post, sheets, ctx } = loadCodeGs();
  const first = post({ since: 0, changes: { customers: [customer] } });
  const cs = sheets.get('ลูกค้า');
  cs.set(2, 8, 'โทรหาหลังบ่าย 2');
  ctx.onEdit({ range: cs.getRange(2, 8) });
  const res = post({ since: first.cursor + 61000, changes: {} });
  assert.equal(res.changes.customers.length, 0, 'no change outside the window');
  const res2 = post({ since: first.cursor, changes: {} });
  assert.equal(res2.changes.customers[0].note, 'โทรหาหลังบ่าย 2');
  assert.ok(res2.changes.customers[0].updatedAt > customer.updatedAt);
});

test('formula-like text stays text and user columns to the right are preserved', () => {
  const { post, sheets } = loadCodeGs();
  post({ since: 0, changes: { customers: [{ ...customer, note: '=IMPORTXML("x")', phone: '+66812345678' }] } });
  const cs = sheets.get('ลูกค้า');
  cs.set(2, 16, 'คอลัมน์ของฉัน');
  post({ since: 0, changes: { customers: [{ ...customer, name: 'แก้ชื่อ', updatedAt: 5000 }] } });
  assert.equal(cs.cell(2, 16), 'คอลัมน์ของฉัน');
  const res = post({ since: 0, changes: {} });
  assert.equal(res.changes.customers[0].name, 'แก้ชื่อ');
  post({ since: 0, changes: { customers: [{ ...customer, note: '=IMPORTXML("x")', phone: '+66812345678', updatedAt: 6000 }] } });
  assert.equal(post({ since: 0, changes: {} }).changes.customers[0].note, '=IMPORTXML("x")');
});

test('soft delete via the checkbox reaches phones', () => {
  const { post, sheets, ctx } = loadCodeGs();
  post({ since: 0, changes: { customers: [customer] } });
  const cs = sheets.get('ลูกค้า');
  cs.set(2, 10, true);
  ctx.onEdit({ range: cs.getRange(2, 10) });
  assert.equal(post({ since: 0, changes: {} }).changes.customers[0].deleted, true);
});
