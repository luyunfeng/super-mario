import { createHash } from 'node:crypto';

/** Identifies the exact message body read by the assistant and opened from its citation. */
export function messageVersion(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
