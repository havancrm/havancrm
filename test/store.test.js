import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyChanges, changesSince } from '../server/store.js';

test('new records are accepted and returned to other devices', () => {
  const s = emptyState();
  applyChanges(s, { customers: [{ id: 'c1', name: 'A', updatedAt: 1 }] });
  assert.deepEqual(changesSince(s, 0).customers, [{ id: 'c1', name: 'A', updatedAt: 1 }]);
  assert.equal(changesSince(s, s.seq).customers.length, 0);
});

test('last write wins: older update is ignored', () => {
  const s = emptyState();
  applyChanges(s, { orders: [{ id: 'o1', status: 'paid', updatedAt: 10 }] });
  const accepted = applyChanges(s, { orders: [{ id: 'o1', status: 'pending', updatedAt: 5 }] });
  assert.equal(accepted, 0);
  assert.equal(s.orders.o1.status, 'paid');
  applyChanges(s, { orders: [{ id: 'o1', status: 'shipped', updatedAt: 20 }] });
  assert.equal(s.orders.o1.status, 'shipped');
});

test('soft deletes propagate and invalid records are skipped', () => {
  const s = emptyState();
  applyChanges(s, { customers: [{ id: 'c1', updatedAt: 1 }, { id: 'bad' }, null] });
  const cursor = s.seq;
  applyChanges(s, { customers: [{ id: 'c1', deleted: true, updatedAt: 2 }] });
  assert.equal(cursor, 1);
  assert.deepEqual(changesSince(s, cursor).customers, [{ id: 'c1', deleted: true, updatedAt: 2 }]);
});
