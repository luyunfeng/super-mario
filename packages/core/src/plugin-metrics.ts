import type { Store } from '../../plugin-sdk/src/index.ts';

const minute = 60_000;
const bucketMs = 5 * minute;
const spans = { '1h': 60 * minute, '24h': 1440 * minute, '7d': 7 * 1440 * minute };
export type PluginMetricWindow = keyof typeof spans;
const bounds = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000];
const prefix = 'core.plugin-metrics.';
const inventory = prefix + 'buckets';
type Counts = { calls: number; errors: number; hist: number[]; maxMs: number };
type Bucket = { at: number; operations: Record<string, Counts> };
type RecentCall = { at: string; name: string; elapsedMs: number; status: 'ok' | 'error' };
type Index = { at: number; plugins: string[] };

function fresh(): Counts { return { calls: 0, errors: 0, hist: Array(bounds.length + 1).fill(0), maxMs: 0 }; }
function merge(to: Counts, from: Counts) {
  to.calls += from.calls;
  to.errors += from.errors;
  to.maxMs = Math.max(to.maxMs, from.maxMs);
  from.hist.forEach((n, i) => { to.hist[i] += n; });
}
function summary(counts: Counts) {
  let remaining = Math.ceil(counts.calls * .95);
  const index = counts.hist.findIndex(count => (remaining -= count) <= 0);
  const p95Ms = counts.calls ? (bounds[index] ?? counts.maxMs) : null;
  return { calls: counts.calls, errors: counts.errors, p95Ms };
}
function operation(bucket: Bucket, name: string) {
  if (!Object.hasOwn(bucket.operations, name) && Object.keys(bucket.operations).length >= 64) name = 'other';
  return bucket.operations[name] ??= fresh();
}

/** Only aggregate counters leave memory. The time index lets us purge removed plugins as well. */
export function createPluginMetrics(store: Store, now: () => number = Date.now) {
  const pending = new Map<string, Map<number, Bucket>>();
  const recent = new Map<string, RecentCall[]>();
  let closed = false;
  let lastCleanup: number | undefined;
  const current = () => Math.floor(now() / bucketMs) * bucketMs;
  const collection = (id: string) => prefix + 'plugin.' + id;
  function record(id: string, name: string, elapsed: number, error: boolean) {
    if (closed) return;
    const completedAt = now();
    const at = Math.floor(completedAt / bucketMs) * bucketMs;
    let buckets = pending.get(id);
    if (!buckets) { buckets = new Map(); pending.set(id, buckets); }
    let bucket = buckets.get(at);
    if (!bucket) { bucket = { at, operations: {} }; buckets.set(at, bucket); }
    // Never retain arbitrary names or request material in metrics.
    const operationName = /^(service|wrapper|hook):[\w.:-]{1,192}$/.test(name) ? name : 'other';
    let calls = recent.get(id);
    if (!calls) { calls = []; recent.set(id, calls); }
    if (calls.length === 200) calls.shift();
    calls.push({ at: new Date(completedAt).toISOString(), name: operationName, elapsedMs: Math.ceil(elapsed), status: error ? 'error' : 'ok' });
    const counts = operation(bucket, operationName);
    counts.calls++;
    if (error) counts.errors++;
    let i = bounds.findIndex(limit => elapsed <= limit);
    if (i === -1) i = bounds.length;
    counts.hist[i]++;
    counts.maxMs = Math.max(counts.maxMs, Math.ceil(elapsed));
  }
  function flush() {
    const at = current();
    const cutoff = at + bucketMs - spans['7d'];
    // Keep memory bounded even if repeated SQLite writes fail.
    for (const [id, buckets] of pending) {
      for (const key of buckets.keys()) if (key < cutoff) buckets.delete(key);
      if (!buckets.size) pending.delete(id);
    }
    if (!pending.size && lastCleanup === at) return;
    store.transaction(() => {
      for (const [id, buckets] of pending) {
        for (const bucket of buckets.values()) {
          if (bucket.at < cutoff) continue;
          const key = String(bucket.at);
          const row = store.get<Bucket>(collection(id), key) ?? { at: bucket.at, operations: {} };
          for (const [name, count] of Object.entries(bucket.operations)) merge(operation(row, name), count);
          store.put(collection(id), key, row);
          const index = store.get<Index>(inventory, key) ?? { at: bucket.at, plugins: [] };
          if (!index.plugins.includes(id)) {
            index.plugins.push(id);
            store.put(inventory, key, index);
          }
        }
      }
      if (lastCleanup !== at) {
        for (const index of store.list<Index>(inventory)) {
          if (index.at >= cutoff) continue;
          for (const id of index.plugins) store.remove(collection(id), String(index.at));
          store.remove(inventory, String(index.at));
        }
      }
    });
    pending.clear();
    lastCleanup = at;
  }
  function read(id: string, window: PluginMetricWindow) {
    if (!Object.hasOwn(spans, window)) throw Object.assign(new Error('统计时间范围无效'), { status: 400 });
    const at = current();
    const from = at + bucketMs - spans[window];
    const persisted = store.listAfter?.<Bucket>(collection(id), from - 1, spans['7d'] / bucketMs) ?? store.list<Bucket>(collection(id));
    const total = fresh();
    const perName = new Map<string, Counts>();
    for (const bucket of [...persisted, ...(pending.get(id)?.values() ?? [])]) {
      if (bucket.at < from || bucket.at > at) continue;
      for (const [name, count] of Object.entries(bucket.operations)) {
        const key = !perName.has(name) && perName.size >= 64 ? 'other' : name;
        const counts = perName.get(key) ?? fresh();
        perName.set(key, counts);
        merge(counts, count);
        merge(total, count);
      }
    }
    const operations = [...perName].map(([name, counts]) => ({ name, ...summary(counts) }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    return { window, ...summary(total), operations };
  }
  const timer = setInterval(() => {
    try { flush(); }
    catch { process.emitWarning('插件统计写入失败，将在下一轮重试'); }
  }, bucketMs);
  timer.unref();
  function close() {
    clearInterval(timer);
    closed = true;
    recent.clear();
    flush();
  }
  function recentCalls(id: string) {
    return { items: (recent.get(id) ?? []).map(call => ({ ...call })).reverse() };
  }
  return { record, read, recentCalls, close };
}
