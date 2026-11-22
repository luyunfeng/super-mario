import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import { createReplyTranslation } from '../plugins/reply-translation.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

test('翻译只读取指定会话的完整回复，停用或来源变化后丢弃在途结果', async t => {
  const store = createStore(':memory:');
  const host = new PluginHost({ store, dataDir: ':memory:', events: createEventBus(store), contributions: createContributions() });
  t.after(async () => { await host.close(); store.close(); });
  let entered = deferred<AbortSignal>();
  let output = deferred<string>();
  let model = 0, calls = 0;
  host.register(createReplyTranslation(async (text, target, signal) => {
    assert.equal(text, 'original');
    assert.equal(target, '日本語');
    calls++;
    entered.resolve(signal);
    return output.promise;
  }, () => String(model)));
  await host.start();
  const project = { id: 'p', name: '合成项目' };
  const source = { id: 'reply', text: 'original', role: 'assistant', conversationId: 'project:p:work' };
  store.put('projects', project.id, project);
  store.put('messages', source.id, source);
  const call = () => host.invocations.use('reply-translation.translate', { messageId: source.id, conversationId: source.conversationId, target: 'ja' });
  const first = call();
  await entered.promise;
  store.put('messages', source.id, { ...source, text: 'new' });
  output.resolve('旧译文');
  await assert.rejects(first, { status: 409 });

  store.put('messages', source.id, source);
  entered = deferred<AbortSignal>();
  output = deferred<string>();
  const archived = call();
  await entered.promise;
  store.put('projects', project.id, { ...project, archivedAt: '2026-11-20T00:00:00Z' });
  output.resolve('过期译文');
  await assert.rejects(archived, { status: 404 });

  store.put('projects', project.id, project);
  entered = deferred<AbortSignal>();
  output = deferred<string>();
  const translated = call();
  await entered.promise;
  output.resolve('合成译文');
  assert.deepEqual(await translated, { text: '合成译文' });
  assert.deepEqual(await call(), { text: '合成译文' });
  assert.equal(calls, 3);
  model++;
  entered = deferred<AbortSignal>();
  output = deferred<string>();
  const disabled = call();
  const signal = await entered.promise;
  await host.setEnabled('reply-translation', false);
  assert.ok(signal.aborted);
  output.resolve('停用前的译文');
  await assert.rejects(disabled, { name: 'AbortError' });
});
