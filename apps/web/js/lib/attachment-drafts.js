export function attachmentDraftStore(databaseName, collection) {
  let database;
  function draftDatabase() {
    return database ??= new Promise((resolve,reject) => {
      const req = indexedDB.open(databaseName,1);
      req.onupgradeneeded = () => req.result.createObjectStore(collection);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return async function storedDraft(key, change) {
    const db = await draftDatabase();
    return new Promise((resolve,reject) => {
      const tx = db.transaction(collection,change ? 'readwrite' : 'readonly');
      const rows = tx.objectStore(collection);
      const lookup = rows.get(key);
      let next;
      lookup.onsuccess = () => {
        next = lookup.result || [];
        if (change) {
          next = change(next);
          if (next.length) rows.put(next,key); else rows.delete(key);
        }
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = () => reject(tx.error);
    });
  }
}
