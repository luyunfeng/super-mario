import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../../plugin-sdk/src/index.ts';

export function createStore(dbPath: string): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Tolerate short-lived readers, but still surface a persistent commit lock.
  db.exec('PRAGMA busy_timeout = 1000');
  db.exec(`CREATE TABLE IF NOT EXISTS documents (
    collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS documents_numeric_cursor ON documents(collection, CAST(id AS INTEGER))");
  db.exec("CREATE INDEX IF NOT EXISTS documents_message_conversation ON documents(json_extract(value, '$.conversationId')) WHERE collection = 'messages'");
  // Public live excerpts start at a durable boundary. SQLite may renumber implicit
  // rowids during VACUUM or reuse them after deletes, so keep explicit message positions.
  const hasPositions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_positions'");
  if (!hasPositions.get()) {
    try {
      db.exec('BEGIN IMMEDIATE');
      if (!hasPositions.get()) db.exec(`
        CREATE TABLE message_positions (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE);
        INSERT INTO message_positions(id) SELECT id FROM documents WHERE collection='messages' ORDER BY rowid;
        CREATE TRIGGER record_message_position AFTER INSERT ON documents WHEN NEW.collection='messages'
        BEGIN INSERT INTO message_positions(id) VALUES (NEW.id); END;
        CREATE TRIGGER forget_message_position AFTER DELETE ON documents WHEN OLD.collection='messages'
        BEGIN DELETE FROM message_positions WHERE id=OLD.id; END;
      `);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  const lastMessage = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='message_positions'");
  // Read the bounded position range first, even before SQLite has table statistics.
  const messagePage = db.prepare(`SELECT p.position,p.id,d.value FROM message_positions p
    CROSS JOIN documents d ON d.collection='messages' AND d.id=p.id
    WHERE p.position>? ORDER BY p.position LIMIT ?`);
  const after = db.prepare('SELECT value FROM documents WHERE collection = ? AND CAST(id AS INTEGER) > ? ORDER BY CAST(id AS INTEGER) LIMIT ?');
  const get = db.prepare('SELECT value FROM documents WHERE collection = ? AND id = ?');
  // Stable insertion order keeps conversations chronological; editing a row does not move it.
  const list = db.prepare('SELECT value FROM documents WHERE collection = ? ORDER BY rowid');
  const byConversation = db.prepare("SELECT value FROM documents WHERE collection = 'messages' AND json_extract(value, '$.conversationId') = ? ORDER BY rowid");
  const entries = db.prepare('SELECT id, value FROM documents WHERE collection = ? ORDER BY rowid');
  const put = db.prepare('INSERT INTO documents VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET value = excluded.value');
  const remove = db.prepare('DELETE FROM documents WHERE collection = ? AND id = ?');
  let sequence = 0;
  let transactionDepth = 0;
  let writeFailure: Error | undefined;
  let closed = false;
  function assertWritable() {
    if (writeFailure) throw writeFailure;
    if (transactionDepth > 0 && !db.isTransaction) {
      // SQLite can roll back a transaction itself (e.g. on SQLITE_FULL). Never
      // let the remaining callback silently switch to standalone commits.
      writeFailure = new Error('Store transaction ended unexpectedly; close and reopen the store before writing');
      throw writeFailure;
    }
  }
  return {
    lastMessagePosition() { return Number(lastMessage.get()?.seq ?? 0); },
    messagesAfterPosition<T>(after: number, limit: number) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1)
        throw new RangeError('Invalid message cursor or page size');
      return messagePage.all(after, limit).map(row => ({position:Number(row.position), id:String(row.id), value:JSON.parse(String(row.value)) as T}));
    },
    messagesByConversation<T>(conversationId: string): T[] {
      return byConversation.all(conversationId).map(row => JSON.parse(String(row.value)) as T);
    },
    listAfter<T>(collection: string, id: number, limit = 1000): T[] { return after.all(collection, id, limit).map(row => JSON.parse(row.value as string) as T); },
    get<T>(collection: string, id: string): T | undefined {
      const row = get.get(collection, id);
      return row ? JSON.parse(row.value as string) as T : undefined;
    },
    list<T>(collection: string): T[] {
      return list.all(collection).map(row => JSON.parse(row.value as string) as T);
    },
    entries<T>(collection: string) {
      return entries.all(collection).map(row => ({ id: String(row.id), value: JSON.parse(row.value as string) as T }));
    },
    put(collection, id, value) {
      assertWritable();
      const json = JSON.stringify(value);
      if (json === undefined) throw new TypeError('Store values must be JSON documents');
      put.run(collection, id, json);
    },
    remove(collection, id) { assertWritable(); return remove.run(collection, id).changes > 0; },
    transaction<T>(fn: () => T): T {
      assertWritable();
      // Reject native async functions before they can write after an await.
      if (fn.constructor.name === 'AsyncFunction') throw new TypeError('Transactions require a synchronous callback');
      const name = `transaction_${++sequence}`;
      const root = transactionDepth === 0;
      db.exec(root ? 'BEGIN' : `SAVEPOINT ${name}`);
      transactionDepth++;
      try {
        const result = fn();
        if (result != null && typeof (result as { then?: unknown }).then === 'function') {
          // Observe a rejected Promise without allowing it to commit the transaction.
          void Promise.resolve(result).catch(() => {});
          throw new TypeError('Transactions must not return a Promise');
        }
        // Also reject a cleanup failure caught by the caller inside fn().
        assertWritable();
        db.exec(root ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        try {
          if (db.isTransaction) {
            if (root) {
              // A busy COMMIT leaves the root transaction open. RELEASE of a
              // root savepoint would attempt that same blocked commit again.
              db.exec('ROLLBACK');
            } else {
              db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
              db.exec(`RELEASE SAVEPOINT ${name}`);
            }
          }
          if (root && db.isTransaction) throw new Error('Root transaction remained open after rollback');
        } catch (cleanupError) {
          writeFailure = new AggregateError([error, cleanupError], 'Store transaction cleanup failed; close and reopen the store before writing');
          throw writeFailure;
        }
        throw error;
      } finally {
        transactionDepth--;
      }
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
