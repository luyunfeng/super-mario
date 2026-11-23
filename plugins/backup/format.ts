// Both archive directions use the same limits. File contents are streamed.
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 250_000;

export function safeBackupPath(path: string): boolean {
  return path.length > 0 && Buffer.byteLength(path) <= 4095 && !/[\\\p{Cc}\p{Cs}]/u.test(path) &&
    !/^[A-Za-z]:/.test(path) && path.split('/').every(part =>
      part.length > 0 && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
}

// Only deliberately public operator messages should cross the CLI boundary.
export class BackupError extends Error {}
