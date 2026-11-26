// Holds the bytes of one mail attachment for the moment between the server reading it and
// a machine taking it to save. A claim is good once and for a short time: the bytes stay
// on the server only while a save is under way, and are not kept afterwards.
import { randomUUID } from 'node:crypto';
import type { AttachmentFile } from './mail-message.ts';

/** How long a claim waits for its machine before the bytes are dropped. */
export const CLAIM_TTL_MS = 60_000;
/** The most one attachment may be. It is the most most providers let a mail carry. */
export const MAX_SAVED_ATTACHMENT = 25 * 1024 * 1024;
/** The most claims held at one time. Each holds a whole attachment in memory, so a burst of
 *  saves is answered with a refusal rather than by growing without bound. */
export const MAX_CLAIMS = 8;

type Claim = { file: AttachmentFile; token: string; machineId: string; expiresAt: number };

/** The claim a machine is handed, without the bytes. The path is on the server the machine
 *  is connected to; the machine adds the server it knows. */
export interface AttachmentClaim {
  id: string;
  token: string;
  /** Where the bytes are taken from. */
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Claims for the attachments being saved. Each is bound to the machine that asked, so a
 * claim one machine was given cannot be used from another.
 */
export function createAttachmentClaims(options: { ttlMs?: number } = {}) {
  const ttlMs = options.ttlMs ?? CLAIM_TTL_MS;
  const claims = new Map<string, Claim>();

  function sweep() {
    const now = Date.now();
    for (const [id, claim] of claims) {
      if (claim.expiresAt <= now) claims.delete(id);
    }
  }

  return {
    /** Puts one attachment up for its machine. The bytes are held until the claim is taken. */
    put(file: AttachmentFile, machineId: string): AttachmentClaim {
      // Swept on every put, so that a claim nobody comes for does not stay for good.
      sweep();
      if (file.size > MAX_SAVED_ATTACHMENT) throw new AttachmentClaimError('too-large');
      if (claims.size >= MAX_CLAIMS) throw new AttachmentClaimError('busy');
      const id = randomUUID();
      const token = randomUUID() + randomUUID();
      claims.set(id, { file, token, machineId, expiresAt: Date.now() + ttlMs });
      return { id, token, path: '/api/v1/mail/claims/' + id, filename: file.filename, mimeType: file.mimeType, size: file.size };
    },
    /** Takes the bytes once. A claim that was taken, has expired or belongs to another
     *  machine gives nothing, and is dropped either way. */
    take(id: string, token: string, machineId: string): AttachmentFile | undefined {
      const claim = claims.get(id);
      claims.delete(id);
      // The map is looked at by id and then removed whatever the answer, so that a wrong
      // token or another machine cannot try again.
      if (!claim || claim.token !== token || claim.machineId !== machineId || claim.expiresAt <= Date.now()) return undefined;
      return claim.file;
    },
    /** Whether there is nothing held, for tests and for shutdown. */
    size() { return claims.size; },
    /** Drops a claim whose save did not happen, so that its bytes are not held for the
     *  rest of the minute. */
    drop(id: string) { claims.delete(id); },
    /** Drops everything held. Called when the server stops. */
    close() {
      claims.clear();
    },
  };
}

export type AttachmentClaims = ReturnType<typeof createAttachmentClaims>;

/** Why an attachment could not be put up for its machine, with the status it is reported as. */
export class AttachmentClaimError extends Error {
  readonly status: number;
  constructor(kind: 'too-large' | 'busy') {
    super({ 'too-large': '这个附件超过 25 MB，没有保存。', busy: '同时保存的附件太多，请稍后再试。' }[kind]);
    this.name = 'AttachmentClaimError';
    this.status = kind === 'too-large' ? 413 : 429;
  }
}
