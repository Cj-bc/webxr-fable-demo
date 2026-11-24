import assert from 'node:assert/strict';
import { putBlob } from '../src/blobStore.ts';

class IDBEvents extends EventTarget {
  emit(type: string) {
    const handler = Reflect.get(this, 'on' + type);
    if (handler) this.addEventListener(type, handler, { once: true });
    this.dispatchEvent(new Event(type));
  }
}

Deno.test('putBlob stays pending until its transaction commits or aborts', async () => {
  const blob = new Blob(['photo']);
  const key = 'photo-id';
  const abortError = new DOMException('Storage write rolled back', 'QuotaExceededError');
  const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  async function write(finish: 'abort' | 'complete') {
    const tx = Object.assign(new IDBEvents(), {
      error: null as DOMException | null,
      objectStore: () => ({
        put(value: Blob, id: string): IDBEvents {
          assert.strictEqual(value, blob);
          assert.equal(id, key);
          return request;
        },
      }),
    });
    const request = Object.assign(new IDBEvents(), { result: key, transaction: tx });
    transaction = tx;

    let outcome: unknown = 'pending';
    putBlob(key, blob).then(
      (result) => { outcome = { result }; },
      (error) => { outcome = { error }; },
    );
    // 各イベントの後に Promise の継続をすべて走らせてから、決着したかを観測する。
    await nextTurn();
    request.emit('success');
    await nextTurn();
    const afterRequest = outcome;
    if (finish === 'abort') tx.error = abortError;
    tx.emit(finish);
    await nextTurn();
    return { afterRequest, afterTransaction: outcome };
  }

  let transaction: IDBEvents;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      const open = Object.assign(new IDBEvents(), { result: { transaction: () => transaction } });
      queueMicrotask(() => open.emit('success'));
      return open;
    },
  } });
  try {
    const aborted = await write('abort');
    const committed = await write('complete');
    assert.deepEqual([aborted.afterRequest, committed.afterRequest], ['pending', 'pending'],
      'putBlob must stay pending after request success');
    assert.deepEqual(aborted.afterTransaction, { error: abortError });
    assert.deepEqual(committed.afterTransaction, { result: undefined });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
