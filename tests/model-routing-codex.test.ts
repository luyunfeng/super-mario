import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { modelCompletion } from '../packages/core/src/agent-runtime/model-completion.ts';
import { createStore } from '../packages/core/src/store.ts';

/** The stand-in for the codex command, copied to where the test can run it. It runs no model:
 *  this is the CLI contract, and not a real Codex. */
async function fakeCodex(dir: string) {
  const command = join(dir, 'stand-in-codex.mjs');
  // The file is run directly, so it starts with the interpreter's own path.
  await writeFile(command, '#!' + process.execPath + '\n' + await readFile(new URL('./fixtures/stand-in-codex.mjs', import.meta.url), 'utf8'), { mode: 0o700 });
  return { command, record: join(dir, 'calls.jsonl') };
}

test('in Codex CLI mode a purpose with a model of its own is passed that model, and the spare is registered', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-routing-codex-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const codex = await fakeCodex(dir);
  const store = createStore(join(dir, 'store.sqlite'));
  t.after(() => store.close());
  store.put('settings', 'model-routing', { translation: { model: 'purpose-model', fallback: 'spare-model' } });
  // The stand-in writes its record where this points, as it is given the test's environment.
  process.env.STAND_IN_RECORD = codex.record;
  t.after(() => { delete process.env.STAND_IN_RECORD; });
  const config = { dataDir: join(dir, 'data'), model: { provider: 'codex-cli' as const, model: 'main-model', cliCommand: codex.command } };
  const complete = await modelCompletion(config, new AbortController().signal, 'translate', 2000, false, 'translation', store);
  const answer = await complete(JSON.stringify({ texts: ['需要翻译的回复'] }), new AbortController().signal);
  // The model the purpose was given is the one the command was asked for, and not the main model.
  assert.deepEqual(JSON.parse(answer), { texts: ['translated by purpose-model'] });
  const calls = (await readFile(codex.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { model: string });
  assert.deepEqual(calls.map(call => call.model), ['purpose-model']);
});
