import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

type Snapshot = { size: number; dev: number; ino: number };
type Range = { offset: number; snapshot?: Snapshot };
const pageBytes = 192 * 1024;
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function transcriptRange(offset: unknown, snapshot: unknown): Range {
  if (offset === undefined) offset = 0;
  if (!integer(offset)) throw new Error('无效的会话日志 offset');
  if (snapshot === undefined) {
    if (offset !== 0) throw new Error('后续页必须提供 snapshot');
    return { offset };
  }
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).some(key => !['size', 'dev', 'ino'].includes(key))) throw new Error('无效的会话日志 snapshot');
  const s = snapshot as Snapshot;
  if (!integer(s.size) || !integer(s.dev) || !integer(s.ino) || offset > s.size) throw new Error('无效的会话日志 snapshot/offset');
  return { offset, snapshot: { size: s.size, dev: s.dev, ino: s.ino } };
}

// This RPC is execution-machine -> server only. The server must decode complete
// JSONL records and remove reasoning before sending derived content to browsers.
// Keep raw bytes intact: a page may split a UTF-8 character or a JSONL record.
export async function readNativeTranscript(
  log: { path: string; dev: number; ino: number }, range: Range,
  noLinks: (path: string) => Promise<boolean>,
) {
  if (!await noLinks(log.path)) throw new Error('会话日志路径包含软链接');
  const file = await open(log.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== log.dev || before.ino !== log.ino) throw new Error('会话日志已被替换');
    const snapshot = range.snapshot ?? { size: before.size, dev: before.dev, ino: before.ino };
    if (!integer(before.size) || !integer(before.dev) || !integer(before.ino) || !integer(snapshot.size) || snapshot.size > before.size
      || snapshot.dev !== before.dev || snapshot.ino !== before.ino) throw new Error('会话日志快照无效、已被替换或截短');
    const buffer = Buffer.alloc(Math.min(pageBytes, snapshot.size - range.offset));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, range.offset + bytesRead);
      if (!read.bytesRead) throw new Error('会话日志读取不足，可能已截短');
      bytesRead += read.bytesRead;
    }
    // fstat alone cannot detect rename/replacement: check the path and every
    // ancestor again before releasing any bytes. Append beyond the snapshot is OK.
    if (!await noLinks(log.path)) throw new Error('会话日志路径包含软链接');
    const [after, pathInfo] = await Promise.all([file.stat(), lstat(log.path)]);
    if (!after.isFile() || !pathInfo.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || pathInfo.dev !== before.dev || pathInfo.ino !== before.ino) throw new Error('会话日志已被替换');
    if ([after, pathInfo].some(info => info.size < before.size
      || (info.size === before.size && (info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs)))) throw new Error('会话日志读取期间被修改或截短');
    const nextOffset = range.offset + bytesRead;
    return { data: buffer.toString('base64'), nextOffset, snapshot, eof: nextOffset === snapshot.size };
  } finally { await file.close(); }
}
