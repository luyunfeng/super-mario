import type { Json } from './index.ts';

/** A successful RPC can still return an incomplete or contradictory input acknowledgement. */
export function executorInputReceipt(result?: Json): 'sent' | 'unsent' | 'unknown' {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown';
  if (result.state === 'unknown') return 'unknown';
  if (result.accepted === false || result.requested === false || result.state === 'not-sent') {
    return result.requested === true || result.accepted === true ? 'unknown' : 'unsent';
  }
  // The executor sets requested only after writing the input and submitting it.
  return result.requested === true ? 'sent' : 'unknown';
}
