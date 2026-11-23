import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';

const byMachine = 'core.admin-auth.machine-credentials';
const byDigest = 'core.admin-auth.machine-credential-digests';
type Credential = { id: string; digest: string };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createMachineCredentials(store: Store) {
  function issue(id: string) {
    if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('执行机 ID 不能为空'), { status: 400 });
    return store.transaction(() => {
      if (store.get(byMachine, id)) throw Object.assign(new Error('此执行机已有专用凭据'), { status: 409 });
      const token = 'smmc_' + randomBytes(32).toString('base64url');
      const digest = hash(token);
      store.put<Credential>(byMachine, id, { id, digest });
      store.put(byDigest, digest, id);
      return { id, token };
    });
  }
  function resolve(token: string) {
    if (typeof token !== 'string' || !/^smmc_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return store.get<string>(byDigest, hash(token));
  }
  function revoke(id: string) {
    return store.transaction(() => {
      const row = store.get<Credential>(byMachine, id);
      if (!row) return false;
      store.remove(byDigest, row.digest);
      return store.remove(byMachine, id);
    });
  }
  function list() {
    return store.list<Credential>(byMachine).map(({ id }) => ({ id }));
  }
  return { issue, list, resolve, revoke };
}
