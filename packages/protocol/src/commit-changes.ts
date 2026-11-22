// Both endpoints are the HEAD observed in the task directory, never a mutable branch name.
export type CommitChanges = { base: string; head: string; files: number; added: number; deleted: number };

export function commitChanges(value: unknown): CommitChanges | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  const oid = (v: unknown): v is string => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (oid(row.base) && oid(row.head) && row.base.length === row.head.length
    && count(row.files) && count(row.added) && count(row.deleted)) {
    return { base: row.base, head: row.head, files: row.files, added: row.added, deleted: row.deleted };
  }
}
