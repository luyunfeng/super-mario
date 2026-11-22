import { StringDecoder } from 'node:string_decoder';
import type { Json, JsonObject } from '../../protocol/src/index.ts';

interface Snapshot { size: number; dev: number; ino: number }

/** Decode a single append-stable JSONL snapshot. Page boundaries may split UTF-8 or a record. */
export async function readNativeRecords(
  pageAt: (offset: number, snapshot?: JsonObject) => Promise<Json>,
  consume: (row: unknown) => void,
  signal: AbortSignal,
  onPage?: (offset: number, total: number) => void,
) {
  const decoder = new StringDecoder('utf8');
  let pending = '', offset = 0;
  let snapshot: Snapshot | undefined;
  function line(text: string) {
    if (!text.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error('会话日志含不完整或损坏记录，无法确认全量覆盖，请稍后重试。'); }
    consume(raw);
  }
  while (true) {
    signal.throwIfAborted();
    const page = await pageAt(offset, snapshot && { ...snapshot });
    signal.throwIfAborted();
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('会话分页无效');
    const next = page.snapshot;
    if (!next || typeof next !== 'object' || Array.isArray(next) ||
        ![next.size, next.dev, next.ino].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) ||
        (snapshot && (next.size !== snapshot.size || next.dev !== snapshot.dev || next.ino !== snapshot.ino))) {
      throw new Error('会话快照无效或读取期间已改变');
    }
    snapshot = { size: Number(next.size), dev: Number(next.dev), ino: Number(next.ino) };
    if (typeof page.data !== 'string') throw new Error('会话分页无效');
    const bytes = Buffer.from(page.data, 'base64');
    offset += bytes.length;
    if (bytes.toString('base64') !== page.data || page.nextOffset !== offset || offset > snapshot.size ||
        page.eof !== (offset === snapshot.size) || (!page.eof && !bytes.length)) throw new Error('会话分页不连续，无法确认全量覆盖');
    const lines = (pending + decoder.write(bytes)).split('\n');
    pending = lines.pop()!;
    for (const record of lines) line(record);
    onPage?.(offset, snapshot.size);
    if (page.eof) { line(pending + decoder.end()); return; }
  }
}
