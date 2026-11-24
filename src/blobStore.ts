/**
 * 画像などの大きなデータを、ブラウザに保存しておく (IndexedDB)。
 * localStorage は文字列しか入らず容量も小さいので、写真の画像はこちらに置く。
 */
const DATABASE = 'mr-playroom';
const STORE = 'blobs';

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    // 要求が成功しても、トランザクションの完了前に書き込みが取り消されることがある。
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new DOMException('トランザクションが中断されました', 'AbortError'));
    request.onerror = () => reject(request.error);
  });
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await run('readwrite', (store) => store.put(blob, key));
}

export function getBlob(key: string): Promise<Blob | undefined> {
  return run<Blob | undefined>('readonly', (store) => store.get(key));
}

export async function deleteBlob(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key));
}

export async function clearBlobs(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}
