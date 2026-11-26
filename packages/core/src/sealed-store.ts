import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** A value that could not be unsealed. The text says nothing about what was in it. */
export class SealError extends Error {
  constructor(message: string) { super(message); this.name = 'SealError'; }
}

const version = 'smseal1';
const algorithm = 'aes-256-gcm';
const keyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;

/**
 * Seals values with a key that lives in the data directory and never leaves it.
 *
 * A mail password has to be read back to sign in with it, so a hash will not do: it is
 * encrypted. The key is made the first time it is needed and is then the only way to read
 * what was sealed. Losing it loses the passwords, which is the trade for not having them
 * readable in the database.
 */
export async function createSealedStore(dataDirectory: string) {
  const directory = resolve(dataDirectory);
  const file = join(directory, 'secrets.key');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  async function key(): Promise<Buffer> {
    let raw: Buffer;
    try {
      const info = await lstat(file);
      // The key must be a plain file. A link would let it be pointed somewhere else.
      if (!info.isFile() || info.isSymbolicLink()) throw new SealError('密钥文件不是普通文件。');
      raw = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return await make();
    }
    if (raw.length !== keyBytes) throw new SealError('密钥文件损坏，长度不对。');
    return raw;
  }
  /** Makes the key. It is written under a temporary name and linked into place, so a reader
   *  never sees half of one. A link refuses to replace an existing file, so of two starts that
   *  race here the second cannot overwrite the first key: anything already sealed with the
   *  first key would then be unreadable. */
  async function make(): Promise<Buffer> {
    const fresh = randomBytes(keyBytes);
    // The temporary name is random, so stores opened at the same time in one process, which
    // share a process id, do not write over each other's file.
    const temporary = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(fresh); } finally { await handle.close(); }
      await link(temporary, file);
    } catch (error) {
      // The key already exists: another start made it, or it was there all along. That key is
      // the one to use. The temporary file name carries this process's id, so it is only the
      // key that can already exist here.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return key();
      throw error;
    } finally { await unlink(temporary).catch(() => {}); }
    return fresh;
  }
  return {
    /** Seals a value. The result is one text that can be stored anywhere. */
    async seal(value: string): Promise<string> {
      const iv = randomBytes(ivBytes);
      const cipher = createCipheriv(algorithm, await key(), iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [version, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    /** Reads back what seal wrote. What was not written here, or was altered, is refused. */
    async unseal(sealed: string): Promise<string> {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== version) throw new SealError('这段内容不是本工作台加密的，或者已经损坏。');
      let iv: Buffer, tag: Buffer, body: Buffer;
      try {
        [iv, tag, body] = parts.slice(1).map(part => Buffer.from(part, 'base64url'));
        // The body may be empty: an empty value is sealed to an empty body.
        if (iv.length !== ivBytes || tag.length !== tagBytes) throw new Error('length');
        const decipher = createDecipheriv(algorithm, await key(), iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(body), decipher.final()]);
        return plain.toString('utf8');
      } catch { throw new SealError('这段内容无法解开，密钥可能已经更换。'); }
    },
  };
}

