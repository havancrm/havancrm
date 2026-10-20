import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyChanges, changesSince, COLLECTIONS } from '../server/store.js';

test('every collection the app syncs is known to the server', () => {
  for (const c of ['customers', 'orders', 'leads', 'tasks', 'activities', 'products']) assert.ok(COLLECTIONS.includes(c));
});

test('per-operation ack: accepted opIds are reported per collection', () => {
  const s = emptyState();
  const result = {};
  applyChanges(s, { leads: [{ id: 'l1', name: 'A', updatedAt: 1, revision: 1, baseRevision: 0, opId: 'op-1' }] }, result);
  assert.deepEqual(result.acceptedIds, { leads: ['op-1'] });
});

test('retrying the same operation is safe: it is acknowledged again without a second write', () => {
  const s = emptyState();
  applyChanges(s, { customers: [{ id: 'c1', name: 'A', updatedAt: 1, revision: 1, baseRevision: 0, opId: 'op-1' }] });
  const seqBefore = s.seq;
  const result = {};
  const n = applyChanges(s, { customers: [{ id: 'c1', name: 'A', updatedAt: 1, revision: 1, baseRevision: 0, opId: 'op-1' }] }, result);
  assert.equal(n, 0);
  assert.equal(s.seq, seqBefore);
  assert.deepEqual(result.acceptedIds, { customers: ['op-1'] });
});

test('stale base revision is a conflict: the cloud record is returned and not overwritten', () => {
  const s = emptyState();
  applyChanges(s, { customers: [{ id: 'c1', name: 'from-A', updatedAt: 5, revision: 2, baseRevision: 1, opId: 'a' }] });
  const result = {};
  applyChanges(s, { customers: [{ id: 'c1', name: 'from-B', updatedAt: 6, revision: 2, baseRevision: 1, opId: 'b' }] }, result);
  assert.equal(s.customers.c1.name, 'from-A');
  assert.equal(result.conflicts.customers.length, 1);
  assert.equal(result.conflicts.customers[0].opId, 'b');
  assert.equal(result.conflicts.customers[0].current.name, 'from-A');
  assert.deepEqual(result.acceptedIds ?? {}, {});
});

test('edit based on the latest revision is accepted', () => {
  const s = emptyState();
  applyChanges(s, { customers: [{ id: 'c1', name: 'v1', updatedAt: 1, revision: 1, baseRevision: 0, opId: 'a' }] });
  const result = {};
  applyChanges(s, { customers: [{ id: 'c1', name: 'v2', updatedAt: 2, revision: 2, baseRevision: 1, opId: 'b' }] }, result);
  assert.equal(s.customers.c1.name, 'v2');
  assert.deepEqual(result.acceptedIds, { customers: ['b'] });
});

test('baseRevision is not stored on the server record', () => {
  const s = emptyState();
  applyChanges(s, { orders: [{ id: 'o1', updatedAt: 1, revision: 1, baseRevision: 0, opId: 'x' }] });
  assert.equal('baseRevision' in s.orders.o1, false);
  assert.deepEqual(changesSince(s, 0).orders[0].revision, 1);
});

test('legacy records without baseRevision keep last-write-wins behaviour', () => {
  const s = emptyState();
  applyChanges(s, { orders: [{ id: 'o1', status: 'paid', updatedAt: 10 }] });
  assert.equal(applyChanges(s, { orders: [{ id: 'o1', status: 'pending', updatedAt: 5 }] }), 0);
  assert.equal(s.orders.o1.status, 'paid');
});
