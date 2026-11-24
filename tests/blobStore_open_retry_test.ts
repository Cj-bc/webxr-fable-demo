import assert from 'node:assert/strict';
import { getBlob } from '../src/blobStore.ts';

class IDBEvents extends EventTarget {
  emit(type: string) {
    const handler = Reflect.get(this, 'on' + type);
    if (handler) this.addEventListener(type, handler, { once: true });
    this.dispatchEvent(new Event(type));
  }
}

Deno.test('getBlob retries opening the database after a transient open error', async () => {
  const key = 'saved-photo';
  const saved = new Blob(['saved contents']);
  const openError = new DOMException('Database temporarily unavailable', 'UnknownError');
  let attempts = 0;
  const db = {
    transaction() {
      const tx = Object.assign(new IDBEvents(), {
        objectStore: () => ({
          get(id: string): IDBEvents {
            const request = Object.assign(new IDBEvents(), {
              result: id === key ? saved : undefined,
              transaction: tx,
            });
            queueMicrotask(() => {
              request.emit('success');
              queueMicrotask(() => tx.emit('complete'));
            });
            return request;
          },
        }),
      });
      return tx;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      const failed = ++attempts === 1;
      const request = Object.assign(new IDBEvents(), {
        error: failed ? openError : null,
        result: failed ? undefined : db,
      });
      queueMicrotask(() => request.emit(failed ? 'error' : 'success'));
      return request;
    },
  } });
  try {
    await assert.rejects(getBlob(key), (error) => error === openError);
    assert.equal(attempts, 1);
    const [retry] = await Promise.allSettled([getBlob(key)]);
    assert.equal(attempts, 2, 'the next getBlob must issue a fresh indexedDB.open');
    assert.equal(retry.status, 'fulfilled');
    assert.strictEqual(retry.value, saved);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
