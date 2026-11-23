import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../packages/protocol/src/index.ts';

type Receipt = { fingerprint: string; requested: number };

/** The claim commits before either PTY write. No prompt, screen content or native turn result is kept here. */
export async function submitInputOnce(dataDir: string, machineId: string, sessionId: string, clientMessageId: string, text: string,
  submit: (claimAndWrite: () => Promise<void>) => Promise<Json>, writeTextAndEnter: () => Promise<void>): Promise<Json> {
  const dir = join(dataDir, 'executor-inputs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'receipts.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout = 1000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS receipts (
        machine TEXT NOT NULL, session TEXT NOT NULL, message TEXT NOT NULL, fingerprint TEXT NOT NULL,
        requested INTEGER NOT NULL, PRIMARY KEY(machine, session, message))`);
    const ids = [machineId, sessionId, clientMessageId];
    const fingerprint = createHash('sha256').update(JSON.stringify(text)).digest('hex');
    const unknown = { state: 'unknown', clientMessageId };
    const requested = { requested: true, clientMessageId };
    function existing() {
      const row = db.prepare('SELECT fingerprint, requested FROM receipts WHERE machine=? AND session=? AND message=?').get(...ids) as Receipt | undefined;
      if (!row) return;
      if (row.fingerprint !== fingerprint) throw new Error('clientMessageId was already used with different input');
      return row.requested === 1 ? requested : unknown;
    }
    // A receipt can be read after node restart without granting control of a historical pane.
    const prior = existing();
    if (prior) return prior;
    let result: Json = unknown;
    await submit(async () => {
      const inserted = db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, 0) ON CONFLICT DO NOTHING').run(...ids, fingerprint);
      if (!inserted.changes) { result = existing() ?? unknown; return; }
      try {
        await writeTextAndEnter();
        db.prepare('UPDATE receipts SET requested=1 WHERE machine=? AND session=? AND message=?').run(...ids);
        result = requested;
      } catch {
        // A disconnect may have happened after writing the text or Enter. Future requests can only read this claim.
        result = unknown;
      }
    });
    return result;
  } finally { db.close(); }
}
