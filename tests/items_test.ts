import assert from 'node:assert/strict';
import type * as THREE from 'three';
import type { HandState } from '../src/input.ts';
import { type Item, Items } from '../src/items.ts';

const left = { handedness: 'left' } as HandState;
const right = { handedness: 'right' } as HandState;

/** 消す・複製するときに Items へ届け出る、最小の物 */
function fakeItem(items: Items, log: string[] = []): Item {
  const item: Item = {
    kind: 'ball',
    object: {} as THREE.Object3D,
    remove: () => {
      log.push('remove');
      items.unregister(item);
    },
    duplicate: () => {
      const copy = fakeItem(items, log);
      items.register(copy);
      return copy;
    },
    setPose: () => {},
    grab: () => false,
  };
  return item;
}

Deno.test('Items tracks which hand holds which item until release', () => {
  const items = new Items();
  const item = fakeItem(items);
  items.register(item);
  const released: Item[][] = [];
  items.on('release', (event) => released.push([...event.items]));

  items.notifyGrab(left, [item], 'select');
  items.notifyGrab(right, [item], 'squeeze');
  assert.deepEqual(items.heldBy(left), [item]);
  assert.deepEqual(items.holdersOf(item), [left, right]);

  items.notifyRelease(left, 'select');
  assert.deepEqual(items.heldBy(left), []);
  assert.deepEqual(items.holdersOf(item), [right]);
  assert.deepEqual(released, [[item]]);
});

Deno.test('Items.remove notifies before removing and forgets held state', () => {
  const items = new Items();
  const log: string[] = [];
  const item = fakeItem(items, log);
  items.register(item);
  items.notifyGrab(left, [item], 'select');
  items.on('removing', ({ item: removing }) => log.push(items.all.includes(removing) ? 'removing' : 'too late'));

  items.remove(item);
  assert.deepEqual(log, ['removing', 'remove']);
  assert.deepEqual(items.all, []);
  assert.deepEqual(items.heldBy(left), []);
  // 2 回目は何もしない。
  items.remove(item);
  assert.deepEqual(log, ['removing', 'remove']);
});

Deno.test('Items.duplicate registers the copy and reports it', () => {
  const items = new Items();
  const item = fakeItem(items);
  items.register(item);
  let reported: { source: Item; copy: Item } | null = null;
  items.on('duplicated', (event) => (reported = event));

  const copy = items.duplicate(item);
  assert.ok(copy && copy !== item);
  assert.deepEqual(items.all, [item, copy]);
  assert.deepEqual(reported, { source: item, copy });
});

Deno.test('Items.interceptGrab stops at the first interceptor that handles it and survives errors', () => {
  const items = new Items();
  const item = fakeItem(items);
  const calls: string[] = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    items.addGrabInterceptor(() => {
      calls.push('broken');
      throw new Error('broken');
    });
    const off = items.addGrabInterceptor(() => {
      calls.push('handles');
      return true;
    });
    items.addGrabInterceptor(() => {
      calls.push('never');
      return true;
    });
    assert.equal(items.interceptGrab(left, item, 'select'), true);
    assert.deepEqual(calls, ['broken', 'handles']);

    off();
    calls.length = 0;
    assert.equal(items.interceptGrab(left, item, 'select'), true);
    assert.deepEqual(calls, ['broken', 'never']);
  } finally {
    console.error = originalError;
  }
});
