import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGas } from './gas-mock.js';

const FILE = '../google-apps-script/artcrm/Code.gs';
const load = () => loadGas(FILE);
const customer = (over = {}) => ({
  id: 'c1', name: 'ร้านสมชาย', phone: '0812345678', updatedAt: 1000, revision: 1, updatedBy: 'อาร์ต', opId: 'op-1', ...over,
});

test('rejects a wrong token', () => {
  const { ctx } = load();
  const res = JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token: 'nope' }) } }).text);
  assert.equal(res.error, 'unauthorized');
});

test('health and the app GET respond without changing data', () => {
  const { post, ctx } = load();
  assert.equal(post({ action: 'health' }).ok, true);
  assert.equal(JSON.parse(ctx.doGet().text).app, 'artcrm');
});

test('pushed records are acknowledged per operation and returned with their revision', () => {
  const { post } = load();
  const r = post({ since: 0, changes: { customers: [customer()] } });
  assert.deepEqual(r.acceptedIds.customers, ['op-1']);
  assert.deepEqual(r.supports, ['customers', 'leads', 'orders', 'tasks', 'activities', 'products']);
  const back = post({ since: 0, changes: {} });
  assert.equal(back.changes.customers.length, 1);
  assert.equal(back.changes.customers[0].revision, 1);
  assert.equal('baseRevision' in back.changes.customers[0], false);
});

test('each entity lands in its own readable sheet with a label column', () => {
  const { post, sheets } = load();
  post({ since: 0, changes: { customers: [customer()], tasks: [{ id: 't1', title: 'โทรติดตาม', updatedAt: 5, opId: 'op-t', revision: 1 }] } });
  assert.equal(sheets.get('ลูกค้า').data[1][1], 'ร้านสมชาย');
  assert.equal(sheets.get('งาน').data[1][1], 'โทรติดตาม');
});

test('a retried operation is acknowledged again without a second row', () => {
  const { post, sheets } = load();
  post({ since: 0, changes: { customers: [customer()] } });
  const again = post({ since: 0, changes: { customers: [customer()] } });
  assert.deepEqual(again.acceptedIds.customers, ['op-1']);
  assert.equal(sheets.get('ลูกค้า').getLastRow(), 2, 'header plus one row');
});

test('a stale edit is reported as a conflict and the cloud copy is kept', () => {
  const { post } = load();
  post({ since: 0, changes: { customers: [customer({ revision: 2, baseRevision: 1, opId: 'a', phone: '0800000001' })] } });
  const r = post({ since: 0, changes: { customers: [customer({ revision: 2, baseRevision: 1, opId: 'b', phone: '0899999999' })] } });
  assert.equal(r.conflicts.customers.length, 1);
  assert.equal(r.conflicts.customers[0].opId, 'b');
  assert.equal(r.conflicts.customers[0].current.phone, '0800000001');
  assert.equal(r.acceptedIds.customers, undefined);
});

test('an edit based on the latest revision is accepted', () => {
  const { post } = load();
  post({ since: 0, changes: { customers: [customer({ revision: 1, baseRevision: 0, opId: 'a' })] } });
  const r = post({ since: 0, changes: { customers: [customer({ revision: 2, baseRevision: 1, opId: 'b', name: 'ใหม่', updatedAt: 2000 })] } });
  assert.deepEqual(r.acceptedIds.customers, ['b']);
  assert.equal(post({ since: 0, changes: {} }).changes.customers[0].name, 'ใหม่');
});

test('the cursor returns only records changed after it', () => {
  const { post } = load();
  const first = post({ since: 0, changes: { customers: [customer()] } });
  const quiet = post({ since: first.cursor, changes: {} });
  assert.equal(quiet.changes.customers.length, 0);
  const later = post({ since: first.cursor, changes: { customers: [customer({ id: 'c2', opId: 'op-2' })] } });
  const pulled = post({ since: first.cursor, changes: {} });
  assert.deepEqual(pulled.changes.customers.map((x) => x.id), ['c2']);
  assert.ok(later.cursor > first.cursor);
});

test('soft delete reaches other phones', () => {
  const { post } = load();
  post({ since: 0, changes: { customers: [customer({ revision: 1, opId: 'a' })] } });
  post({ since: 0, changes: { customers: [customer({ revision: 2, baseRevision: 1, opId: 'b', deleted: true, updatedAt: 3000 })] } });
  assert.equal(post({ since: 0, changes: {} }).changes.customers[0].deleted, true);
});

test('a record too large for one sheet cell is refused, not truncated', () => {
  const { post } = load();
  const big = customer({ note: 'x'.repeat(50000) });
  const r = post({ since: 0, changes: { customers: [big] } });
  assert.match(r.error, /ใหญ่เกินช่อง/);
  assert.equal(post({ since: 0, changes: {} }).changes.customers.length, 0, 'nothing partial was written');
});

test('older clients without revisions keep last-write-wins', () => {
  const { post } = load();
  post({ since: 0, changes: { customers: [customer({ revision: undefined, opId: undefined, name: 'ใหม่', updatedAt: 2000 })] } });
  const r = post({ since: 0, changes: { customers: [customer({ revision: undefined, opId: undefined, name: 'เก่า', updatedAt: 500 })] } });
  assert.equal(r.acceptedIds.customers, undefined);
  assert.equal(post({ since: 0, changes: {} }).changes.customers[0].name, 'ใหม่');
});

test('text that looks like a formula is stored as plain text in the label column', () => {
  const { post, sheets } = load();
  post({ since: 0, changes: { customers: [customer({ name: '=SUM(A1)', opId: 'f' })] } });
  assert.equal(sheets.get('ลูกค้า').data[1][1], '=SUM(A1)', 'shown as text, not evaluated');
});
