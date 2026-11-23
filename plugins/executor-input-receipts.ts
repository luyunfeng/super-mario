import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../packages/protocol/src/index.ts';

type Receipt = { fingerprint: string; requested: number; thread?: string; turn?: string };
type NativeTurn = { nativeSessionId: string; turnId: string };

/** The claim commits before either PTY write. No prompt, screen content or native turn result is kept here. */
export async function submitInputOnce(dataDir: string, machineId: string, sessionId: string, clientMessageId: string, text: string,
  submit: (claimAndWrite: () => Promise<void>) => Promise<Json>, writeTextAndEnter: () => Promise<void | NativeTurn | 'not-sent'>): Promise<Json> {
  const dir = join(dataDir, 'executor-inputs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'receipts.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout = 1000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS receipts (
        machine TEXT NOT NULL, session TEXT NOT NULL, message TEXT NOT NULL, fingerprint TEXT NOT NULL,
        requested INTEGER NOT NULL, PRIMARY KEY(machine, session, message));
      CREATE TABLE IF NOT EXISTS native_turns (machine TEXT NOT NULL, session TEXT NOT NULL, message TEXT NOT NULL,
        thread TEXT NOT NULL, turn TEXT NOT NULL, PRIMARY KEY(machine, session, message), UNIQUE(machine, thread, turn));
      CREATE TABLE IF NOT EXISTS native_turn_conflicts (machine TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL,
        PRIMARY KEY(machine,thread,turn));
      CREATE VIEW IF NOT EXISTS confirmed_native_turns AS
        SELECT n.* FROM native_turns n LEFT JOIN native_turn_conflicts c USING(machine,thread,turn)
        WHERE c.machine IS NULL`);
    const ids = [machineId, sessionId, clientMessageId];
    const fingerprint = createHash('sha256').update(JSON.stringify(text)).digest('hex');
    const unknown = { state: 'unknown', clientMessageId };
    const notSent = { state: 'not-sent', requested: false, clientMessageId };
    const requested = { requested: true, clientMessageId };
    function existing() {
      const row = db.prepare(`SELECT fingerprint, requested, thread, turn FROM receipts
        LEFT JOIN confirmed_native_turns USING(machine,session,message)
        WHERE machine=? AND session=? AND message=?`).get(...ids) as Receipt | undefined;
      if (!row) return;
      if (row.fingerprint !== fingerprint) throw new Error('clientMessageId was already used with different input');
      if (row.requested === -1) return notSent;
      return row.requested === 1 ? { ...requested, ...(row.thread && row.turn && { nativeSessionId: row.thread, turnId: row.turn }) } : unknown;
    }
    // A receipt can be read after node restart without granting control of a historical pane.
    const prior = existing();
    if (prior) return prior;
    let result: Json = unknown;
    await submit(async () => {
      const inserted = db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, 0) ON CONFLICT DO NOTHING').run(...ids, fingerprint);
      if (!inserted.changes) { result = existing() ?? unknown; return; }
      try {
        const native = await writeTextAndEnter();
        if (native === 'not-sent') {
          db.prepare('UPDATE receipts SET requested=-1 WHERE machine=? AND session=? AND message=?').run(...ids);
          result = notSent;
          return;
        }
        db.exec('BEGIN IMMEDIATE');
        if (native) {
          const turn = [machineId, native.nativeSessionId, native.turnId];
          if (db.prepare('SELECT 1 FROM native_turns WHERE machine=? AND thread=? AND turn=?').get(...turn)) {
            // A repeated server turn ID cannot prove which input produced a final answer.
            db.prepare('INSERT OR IGNORE INTO native_turn_conflicts VALUES (?, ?, ?)').run(...turn);
            db.exec('COMMIT');
            result = unknown;
            return;
          }
          db.prepare('INSERT INTO native_turns VALUES (?, ?, ?, ?, ?)').run(...ids, native.nativeSessionId, native.turnId);
        }
        db.prepare('UPDATE receipts SET requested=1 WHERE machine=? AND session=? AND message=?').run(...ids);
        db.exec('COMMIT');
        result = native ? {...requested,...native} : requested;
      } catch {
        if (db.isTransaction) db.exec('ROLLBACK');
        // A disconnect may have happened after writing the text or Enter. Future requests can only read this claim.
        result = unknown;
      }
    });
    return result;
  } finally { db.close(); }
}

export function nativeInputFingerprint(dataDir: string, machineId: string, sessionId: string, clientMessageId: string, native: NativeTurn) {
  const db = new DatabaseSync(join(dataDir,'executor-inputs','receipts.sqlite'), { readOnly:true });
  try {
    const row = db.prepare(`SELECT fingerprint FROM receipts JOIN confirmed_native_turns USING(machine,session,message)
      WHERE machine=? AND session=? AND message=? AND requested=1 AND thread=? AND turn=?`)
      .get(machineId, sessionId, clientMessageId, native.nativeSessionId, native.turnId);
    return typeof row?.fingerprint === 'string' ? row.fingerprint : undefined;
  } finally { db.close(); }
}
