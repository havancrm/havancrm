import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, parseDate, threeWayMerge, cycleState, findDuplicateCustomers, planCustomerImport, planBillImport,
  vatBreakdown, search, buildSearchIndex, diffCollections, taskBucket, periodRange, mapColumns, CUSTOMER_COLUMNS, hashText,
  buildStats, orderTotal, toCsv,
} from '../app/core.js';

test('CSV: quoted commas, escaped quotes, CRLF and a BOM', () => {
  const rows = parseCsv('﻿ชื่อ,ที่อยู่\r\n"ร้าน A, B","บ้าน ""เลขที่"" 1"\r\n');
  assert.deepEqual(rows, [['ชื่อ', 'ที่อยู่'], ['ร้าน A, B', 'บ้าน "เลขที่" 1']]);
});

test('CSV: toCsv round-trips values that need quoting', () => {
  const text = toCsv([['a', 'b,c'], ['x"y', 'z']]);
  assert.deepEqual(parseCsv(text), [['a', 'b,c'], ['x"y', 'z']]);
});

test('dates: ISO and Thai Buddhist-year day/month/year, invalid dates rejected', () => {
  assert.equal(parseDate('2026-10-20'), '2026-10-20');
  assert.equal(parseDate('20/10/2569'), '2026-10-20');
  assert.equal(parseDate('20/10/26'), '2026-10-20');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('soon'), null);
});

test('mapColumns matches Thai and English headers regardless of case and spacing', () => {
  const map = mapColumns([' ชื่อร้าน ', 'phone', 'LINE'], CUSTOMER_COLUMNS);
  assert.equal(map.name, 0);
  assert.equal(map.phone, 1);
  assert.equal(map.line, 2);
});

test('three-way merge: different fields combine, same field clashes', () => {
  const base = { name: 'A', phone: '081', note: '' };
  const local = { name: 'A', phone: '082', note: '' };
  const cloud = { name: 'A', phone: '081', note: 'VIP' };
  const ok = threeWayMerge(base, local, cloud);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.record, { name: 'A', phone: '082', note: 'VIP' });

  const clash = threeWayMerge(base, { ...base, phone: '082' }, { ...base, phone: '083' });
  assert.equal(clash.ok, false);
  assert.deepEqual(clash.fields, ['phone']);
});

test('three-way merge: identical edits on both sides are not a conflict', () => {
  const base = { phone: '081' };
  assert.equal(threeWayMerge(base, { phone: '082' }, { phone: '082' }).ok, true);
});

test('cycle state: overdue, due, near, normal, never bought, snoozed', () => {
  const s = { days: 40, cycle: 20, last: '2026-09-10' };
  assert.equal(cycleState(s, null, '2026-10-20').key, 'overdue');
  assert.equal(cycleState({ ...s, days: 21 }, null, '2026-10-20').key, 'due');
  assert.equal(cycleState({ ...s, days: 17 }, null, '2026-10-20').key, 'near');
  assert.equal(cycleState({ ...s, days: 5 }, null, '2026-10-20').key, 'normal');
  assert.equal(cycleState(undefined, null, '2026-10-20').key, 'none');
  assert.equal(cycleState(s, '2026-10-25', '2026-10-20').key, 'normal');
});

test('duplicates: same phone digits, same code, or same name in the same province', () => {
  const customers = [
    { id: '1', name: 'ร้านดี', phone: '081-234-5678, 02 111 2222', code: 'C1', province: 'ชลบุรี' },
    { id: '2', name: 'ร้านอื่น', phone: '', code: 'C2', province: 'ระยอง' },
  ];
  assert.deepEqual(findDuplicateCustomers({ id: 'x', name: 'ร้านใหม่', phone: '0812345678' }, customers).map((c) => c.id), ['1']);
  assert.deepEqual(findDuplicateCustomers({ id: 'x', name: 'x', code: 'C2' }, customers).map((c) => c.id), ['2']);
  assert.deepEqual(findDuplicateCustomers({ id: 'x', name: 'ร้านดี ', province: 'ชลบุรี' }, customers).map((c) => c.id), ['1']);
  assert.deepEqual(findDuplicateCustomers({ id: 'x', name: 'ร้านดี', province: 'ตราด' }, customers), []);
});

test('customer import: creates new rows, updates matches, reports bad rows and in-file duplicates', () => {
  const existing = [{ id: 'k1', name: 'เดิม', phone: '0811111111', code: '' }];
  const items = [
    { line: 2, name: 'ใหม่', phone: '0822222222' },
    { line: 3, name: 'เดิมแก้', phone: '0811111111' },
    { line: 4, name: '', phone: '0833333333' },
    { line: 5, name: 'เบอร์ผิด', phone: 'abc' },
    { line: 6, name: 'ซ้ำในไฟล์', phone: '0822222222' },
  ];
  const plan = planCustomerImport(items, existing);
  assert.equal(plan.create.length, 1);
  assert.equal(plan.update[0].id, 'k1');
  assert.deepEqual(plan.errors.map((e) => e.line), [4, 5, 6]);
});

test('bill import: groups lines, skips existing bill numbers, flags unknown customers and mismatched lines', () => {
  const customers = [{ id: 'c1', name: 'ร้าน A', code: 'A1' }];
  const products = [{ id: 'P1', code: 'P1', name: 'น้ำ', unit: 'ขวด' }];
  const items = [
    { line: 2, no: 'B1', date: '2026-10-01', customer: 'ร้าน A', sku: 'P1', qty: '2', price: '10' },
    { line: 3, no: 'B1', date: '2026-10-01', customer: 'ร้าน A', sku: 'P1', qty: '1', price: '' },
    { line: 4, no: 'B2', date: '2026-10-02', customer: 'ไม่มี', qty: '1', price: '5' },
    { line: 5, no: 'B3', date: '2026-10-03', customer: 'ร้าน A', qty: '1', price: '5' },
    { line: 6, no: 'B3', date: '2026-10-04', customer: 'ร้าน A', qty: '1', price: '5' },
    { line: 7, no: 'OLD', date: '2026-10-01', customer: 'ร้าน A', qty: '1', price: '5' },
  ];
  const plan = planBillImport(items, { customers, products, existingNos: new Set(['OLD']) });
  assert.equal(plan.bills.length, 2);
  assert.equal(plan.bills[0].lines.length, 2);
  assert.equal(plan.bills[0].lines[1].price, null);
  assert.deepEqual(plan.skipped.map((s) => s.line), [7]);
  assert.ok(plan.errors.some((e) => e.line === 4 && e.message.includes('ไม่พบลูกค้า')));
  assert.ok(plan.errors.some((e) => e.line === 6 && e.message.includes('ไม่ตรงกับ')));
});

test('VAT: included in price (7/107) and added on top (7%)', () => {
  const inc = vatBreakdown(107, 'included');
  assert.equal(Math.round(inc.vat * 100) / 100, 7);
  assert.equal(inc.total, 107);
  const plus = vatBreakdown(100, 'plus');
  assert.equal(plus.total, 107);
  assert.equal(vatBreakdown(100, 'none').vat, 0);
});

test('search: every token must match, results grouped by type with a total', () => {
  const customers = [{ id: 'c1', name: 'ร้านสมชาย', province: 'ชลบุรี', phone: '0811' }, { id: 'c2', name: 'ร้านสมหญิง', province: 'ระยอง' }];
  const orders = [{ id: 'o1', no: 'O-1', customerId: 'c1', items: [{ code: 'P1', name: 'น้ำดื่ม' }] }, { id: 'b1', kind: 'bill', no: 'B-9', customerId: 'c2', items: [] }];
  const index = buildSearchIndex({ customers, orders, products: [{ id: 'P1', code: 'P1', name: 'น้ำดื่ม' }] });
  assert.deepEqual(search(index, 'สมชาย ชลบุรี').customers, ['c1']);
  assert.deepEqual(search(index, 'สมชาย ระยอง').customers, []);
  assert.deepEqual(search(index, 'น้ำดื่ม').orders, ['o1']);
  assert.deepEqual(search(index, 'B-9').bills, ['b1']);
  assert.deepEqual(search(index, 'P1').products, ['P1']);
  assert.equal(search(index, 'ร้าน').totals.customers, 2);
});

test('restore preview: adds, updates, same, and local-only records kept', () => {
  const current = { customers: new Map([['a', { id: 'a', name: 'A', _base: 3 }], ['b', { id: 'b', name: 'B' }]]) };
  const diff = diffCollections(current, { customers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B2' }, { id: 'c', name: 'C' }] });
  assert.deepEqual(diff, { add: 1, update: 1, same: 1, keep: 0 });
  const diff2 = diffCollections(current, { customers: [{ id: 'a', name: 'A' }] });
  assert.equal(diff2.keep, 1);
});

test('task buckets and period ranges', () => {
  assert.equal(taskBucket({ status: 'open', dueDate: '2026-10-19' }, '2026-10-20'), 'overdue');
  assert.equal(taskBucket({ status: 'open', dueDate: '2026-10-20' }, '2026-10-20'), 'today');
  assert.equal(taskBucket({ status: 'open', dueDate: '2026-10-25' }, '2026-10-20'), 'upcoming');
  assert.equal(taskBucket({ status: 'done', dueDate: '2026-10-01' }, '2026-10-20'), 'done');
  assert.deepEqual(periodRange('month', '2026-10-20'), { from: '2026-10-01', to: '2026-10-20' });
  assert.equal(periodRange('all', '2026-10-20'), null);
});

test('stats: totals, purchase cycle from at least three purchase days', () => {
  const sales = [
    { customerId: 'c', date: '2026-01-01', items: [{ qty: 1, price: 100 }] },
    { customerId: 'c', date: '2026-01-11', items: [{ qty: 1, price: 100 }] },
    { customerId: 'c', date: '2026-01-21', items: [{ qty: 1, price: 50 }] },
  ];
  const s = buildStats(sales, '2026-02-01').get('c');
  assert.equal(s.total, 250);
  assert.equal(s.cycle, 10);
  assert.equal(orderTotal({ items: [{ qty: 2, price: 10 }], discount: 5 }), 15);
});

test('hash: stable fingerprint, changes with content', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
});
