// Promise wrappers for the two IndexedDB callbacks every store here waits on. Shared by
// bg/usage-history-db.js and the compare page's stores (ui/compare/history-store.js, image-store.js).

/** Resolves with req.result on success, rejects with req.error. */
export const reqPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Resolves when the transaction commits; rejects when it errors or aborts. */
export const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});
