// Saves one attachment of the owner's mail as a file on this machine. The bytes come from
// the server over HTTP, under a claim the server handed over when it asked for the save.
// The agent chooses only a relative subfolder and the name comes from the sender, so both
// are cleaned here: nothing is written outside the mail folder and nothing is overwritten.
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { Json, NodeHandler } from '../../../packages/plugin-sdk/src/index.ts';

/** The most one attachment may be. It is the most most providers let a mail carry. */
export const MAX_SAVED_ATTACHMENT = 25 * 1024 * 1024;

/** Why a save was refused, in words the owner can act on. */
export type SaveRefusal = 'bad-dir' | 'too-large' | 'incomplete' | 'write-failed' | 'fetch-failed';
export class SaveError extends Error {
  readonly kind: SaveRefusal;
  constructor(kind: SaveRefusal) {
    super({
      'bad-dir': 'dir 须为相对子目录，例如 bills/2026-10，不能是绝对路径、~、..、隐藏目录或含反斜杠。',
      'too-large': '附件超过 25 MB，没有保存。',
      'incomplete': '附件没有完整到达，没有保存。',
      'write-failed': '附件写不进磁盘，没有保存。',
      'fetch-failed': '没有取到附件，没有保存。',
    }[kind]);
    this.name = 'SaveError';
    this.kind = kind;
  }
}

/** A subfolder as the agent may name one: relative, plain names, nothing hidden. */
export function cleanSubdir(dir: unknown): string {
  if (dir === undefined || dir === null || dir === '') return '';
  const bad = () => new SaveError('bad-dir');
  // Trimmed first, so that a stray space around the name does not make it another name.
  const value = typeof dir === 'string' ? dir.trim() : '';
  if (!value || value.length > 512 || value.startsWith('~') || value.includes('\\') || value.includes(':')) throw bad();
  if (/[\u0000-\u001f\u007f]/.test(value) || isAbsolute(value)) throw bad();
  const parts = value.split('/');
  if (parts.some(part => !part || part.startsWith('.') || part.trim() !== part)) throw bad();
  return parts.join('/');
}

/** The sender's file name as one plain name: no path, no control character, not hidden. */
export function cleanFilename(name: string): string {
  // Only the last component is kept, so that a name with a path cannot leave the folder.
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  // A control character or a colon becomes an underscore.
  const cleaned = base.replace(/[\u0000-\u001f\u007f:]/g, '_').trim().replace(/^\.+/, '').trim();
  const whole = cleaned || 'attachment';
  const ext = extname(whole);
  // The name is kept under the 255 bytes file systems allow, with room for a number.
  if (Buffer.byteLength(whole) <= 200) return whole;
  // A long extension is not worth keeping whole.
  const kept = ext.length > 16 ? '' : ext;
  const bytes = Buffer.from(whole.slice(0, whole.length - ext.length), 'utf8');
  // The cut is made on the bytes, because that is what the file system counts. It is moved
  // back to the start of a character, so that no half character is left.
  let cut = 200 - Buffer.byteLength(kept);
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString('utf8') + kept;
}

/** Whether path is inside root, for two real paths. The root itself is not inside itself. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/**
 * Writes the bytes under the mail folder, in the subfolder if there is one. A file that
 * exists is never overwritten: the new one gets " (2)", " (3)" and so on in its name.
 */
export async function writeAttachment(root: string, subdir: string, name: string, data: Uint8Array): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // The root is resolved once. Each folder below it is checked to be inside, so a link
  // someone made inside the folder cannot send the file elsewhere.
  const realRoot = await realpath(root);
  let dir = realRoot;
  for (const part of subdir.split('/').filter(Boolean)) {
    const next = join(dir, part);
    await mkdir(next, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const resolved = await realpath(next);
    if (!inside(realRoot, resolved)) throw new SaveError('write-failed');
    dir = resolved;
  }
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 1; index <= 99; index++) {
    const candidate = index === 1 ? name : stem + ' (' + index + ')' + ext;
    const path = join(dir, candidate);
    // "wx" never overwrites and does not follow a link already at the path.
    const file = await open(path, 'wx', 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    });
    if (!file) continue;
    try {
      await file.writeFile(data);
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    return path;
  }
  throw new SaveError('write-failed');
}

/** Where the bytes of one save are taken from. The claim is good once and for a short time.
 *  The machine's own credential goes with it, so a claim alone is worth nothing. */
export interface AttachmentClaim {
  /** Where the bytes are taken from, on the server the machine is connected to. */
  url: string;
  /** A one-time credential for the claim, sent as a header and never in the link. */
  token: string;
  /** How many bytes the server said the attachment has. */
  size: number;
  /** This machine's credential for the server. */
  machineToken: string;
}

/** Reads the bytes of one claim. The answer must be exactly as many bytes as was said. */
export async function fetchClaim(claim: AttachmentClaim, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Uint8Array> {
  if (typeof claim.url !== 'string' || !/^https?:\/\//.test(claim.url) || typeof claim.token !== 'string' || !claim.token) throw new SaveError('fetch-failed');
  if (!Number.isSafeInteger(claim.size) || claim.size < 0 || claim.size > MAX_SAVED_ATTACHMENT) throw new SaveError('too-large');
  // The server keeps a claim for a minute. The read is cut well before that, so that a
  // server that stops answering does not hold the save for good, and the claim is still good.
  const timeout = AbortSignal.timeout(45_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let answer: Response;
  try {
    answer = await fetcher(claim.url, { headers: { authorization: 'Bearer ' + claim.token, 'x-machine-credential': 'Bearer ' + claim.machineToken }, signal: combined });
  } catch {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new SaveError('fetch-failed');
    throw new SaveError('fetch-failed');
  }
  if (answer.status !== 200) {
    await answer.body?.cancel().catch(() => {});
    throw new SaveError('fetch-failed');
  }
  // The body is read with a bound a little above the size that was said, so that a server
  // that sends more than it said is caught and does not fill the memory.
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = answer.body?.getReader();
  if (!reader) throw new SaveError('fetch-failed');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > claim.size) throw new SaveError('incomplete');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SaveError) throw error;
    // A read that was cut by the caller or by the clock never got the whole of it.
    throw new SaveError(combined.aborted ? 'fetch-failed' : 'incomplete');
  }
  if (received !== claim.size) throw new SaveError('incomplete');
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

/**
 * The handler a machine offers for saving one mail attachment. The server has already read
 * the message and found the attachment; it hands over a claim, and the bytes are taken here
 * so that they do not cross the machine channel, which carries small messages only.
 *
 * Each handler answers with the outcome in its result instead of throwing, because the
 * machine channel carries one message string and would lose the kind of a refusal.
 */
export function createMailAttachmentNode(options: { dataDir: string; serverUrl: string; machineToken: string; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  const root = join(options.dataDir, 'attachments', 'mail');
  // The server's address without a trailing slash, so that a claim path can be added to it.
  const server = options.serverUrl.replace(/\/+$/, '');
  const failed = (error: unknown): Json => error instanceof SaveError
    ? { ok: false, reason: error.kind, message: error.message }
    // Anything else is a bug or an unexpected failure. Its text is not the owner's to read.
    : { ok: false, reason: 'write-failed', message: new SaveError('write-failed').message };
  const handlers: Record<string, NodeHandler> = {
    'mail.save-attachment': async params => {
      const input = params as Record<string, unknown>;
      const allowed = ['dir', 'path', 'token', 'filename', 'mimeType', 'size'];
      if (Object.keys(input).some(key => !allowed.includes(key))) return failed(new SaveError('fetch-failed'));
      if (typeof input.filename !== 'string' || typeof input.mimeType !== 'string') return failed(new SaveError('fetch-failed'));
      // Only a claim of this server is taken. The path is fixed by the server, so a call
      // cannot turn the machine into a client for some other address.
      const path = input.path;
      if (typeof path !== 'string' || !/^\/api\/v1\/mail\/claims\/[A-Za-z0-9_-]{1,64}$/.test(path)) return failed(new SaveError('fetch-failed'));
      try {
        // The folder is cleaned before anything is taken, so a bad folder costs nothing.
        const subdir = cleanSubdir(input.dir);
        const data = await fetchClaim({ url: server + path, token: String(input.token ?? ''), size: Number(input.size), machineToken: options.machineToken }, fetcher);
        const saved = await writeAttachment(root, subdir, cleanFilename(input.filename), data);
        return { ok: true, path: saved, size: data.byteLength, mimeType: input.mimeType || 'unknown type' } as Json;
      } catch (error) { return failed(error); }
    },
  };
  return { handlers };
}
