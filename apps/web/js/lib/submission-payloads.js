// These snapshots exist only to resend the exact, unresolved submission. The
// upload service already holds ordinary files; never duplicate their Blob here.
const lifetime = 24 * 60 * 60 * 1000;
const collection = 'payloads';
let opening;

function database() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('sm-submission-payloads', 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore(collection, {keyPath:['owner','scope','requestId']});
      records.createIndex('expiresAt','expiresAt');
    };
    request.onblocked = () => { blocked = true; reject(new Error('提交快照数据库暂不可用')); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      const forget = () => { db.close(); opening = undefined; };
      db.onversionchange = forget;
      db.onclose = forget;
      resolve(db);
    };
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}

function keyPart(value) { return typeof value === 'string' && value.length > 0; }
function payloadCopy(payload) {
  const text = payload?.text ?? payload?.body;
  if (typeof text !== 'string') throw Error('缺少原提交正文');
  const copy = {text};
  for (const field of ['projectId','todoId']) {
    if (payload[field] == null) continue;
    if (!keyPart(payload[field])) throw Error('提交范围无效');
    copy[field] = payload[field];
  }
  copy.images = (payload.images ?? []).map(({name,mime,data,bytes,sha256}) => {
    if (!keyPart(mime) || !keyPart(data)) throw Error('图片快照不完整');
    return {mime,data,...(keyPart(name) && {name}),...(Number.isSafeInteger(bytes) && {bytes}),...(keyPart(sha256) && {sha256})};
  });
  copy.files = (payload.files ?? []).map(({name,mime,bytes,sha256,uploadId}) => {
    if (!keyPart(name) || !keyPart(mime) || !keyPart(uploadId) || !keyPart(sha256) || !Number.isSafeInteger(bytes) || bytes < 0)
      throw Error('文件上传回执不完整');
    return {name,mime,bytes,sha256,uploadId};
  });
  return copy;
}

async function transact(use) {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(collection,'readwrite'), records = tx.objectStore(collection);
    let value;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error('快照事务未完成'));
    const now = Date.now();
    const expired = records.index('expiresAt').openKeyCursor(IDBKeyRange.upperBound(now));
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (cursor) { records.delete(cursor.primaryKey); cursor.continue(); return; }
      use(records,now,result => { value=result; });
    };
  });
}

export async function saveSubmissionPayload(owner,scope,requestId,payload) {
  if (![owner,scope,requestId].every(keyPart)) return false;
  try {
    const captured = payloadCopy(payload);
    return await transact((records,now,done) => {
      const get = records.get([owner,scope,requestId]);
      get.onsuccess = () => {
        // A delayed retry, including one from another tab, cannot replace the original.
        if (!get.result || get.result.expiresAt <= now) {
          records.put({owner,scope,requestId,payload:captured,expiresAt:now+lifetime});
        }
        done(true);
      };
    });
  } catch { return false; }
}

export async function readSubmissionPayload(owner,scope,requestId) {
  if (![owner,scope,requestId].every(keyPart)) return;
  try {
    return await transact((records,now,done) => {
      const get = records.get([owner,scope,requestId]);
      get.onsuccess = () => { if (get.result?.expiresAt > now) done(get.result.payload); };
    });
  } catch { return undefined; }
}

export async function removeSubmissionPayload(owner,scope,requestId) {
  if (![owner,scope,requestId].every(keyPart)) return;
  try { await transact(records => records.delete([owner,scope,requestId])); }
  catch { /* Storage may be unavailable; the caller also clears its in-page copy. */ }
}

export async function clearSubmissionPayloads(owner,scope) {
  if (!keyPart(owner) || (scope !== undefined && !keyPart(scope))) return;
  try {
    const prefix = scope === undefined ? [owner] : [owner,scope];
    // Array keys sort after strings. A compound prefix covers only its descendants.
    await transact(records => records.delete(IDBKeyRange.bound(prefix,[...prefix,[]])));
  } catch { /* The owner and scope keys still isolate any inaccessible records. */ }
}
