import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Native browser module with no TypeScript declaration.
import { modelChangedAt, provenance, replyModel, tokenText, usageText } from '../apps/web/js/features/reply-provenance.js';

test('a reply says which model gave it, and the place where the model changed is marked', () => {
  assert.equal(replyModel({ model: { provider: 'openai', model: 'gpt-x' } }), 'openai / gpt-x');
  assert.equal(replyModel({ model: { provider: 'openai-compatible', model: 'local-model' } }), 'openai-compatible / local-model');
  // A provider with the model\'s own name says it once; a reply without a model says nothing.
  assert.equal(replyModel({ model: { provider: 'm', model: 'm' } }), 'm');
  assert.equal(replyModel({}), '');
  assert.equal(replyModel({ model: { provider: 'p', model: '' } }), '');
  const first = { model: { provider: 'openai', model: 'gpt-x' } };
  const same = { model: { provider: 'openai', model: 'gpt-x' } };
  const other = { model: { provider: 'anthropic', model: 'claude-y' } };
  // The first reply is where the model is first named; one that keeps it is not a change.
  assert.equal(modelChangedAt(first, undefined), true);
  assert.equal(modelChangedAt(same, first), false);
  assert.equal(modelChangedAt(other, same), true);
  // A reply that does not say which model gave it is never a change, whatever came before.
  assert.equal(modelChangedAt({}, first), false);
  assert.equal(modelChangedAt(same, {}), true, 'after a reply that does not say, the model is named again');
  assert.deepEqual(provenance(other, same), { changed: true, model: '切换到 anthropic / claude-y', usage: '' });
  assert.deepEqual(provenance(same, first), { changed: false, model: 'openai / gpt-x', usage: '' });
  assert.deepEqual(provenance(first, undefined), { changed: true, model: 'openai / gpt-x', usage: '' });
});

test('what an exchange used is said in tokens, with the cache only when something was read from it', () => {
  assert.equal(tokenText(0), '0');
  assert.equal(tokenText(1234), '1,234');
  assert.equal(tokenText(12345), '12k');
  assert.equal(tokenText(999999), '1000k');
  assert.equal(tokenText(-1), '');
  assert.equal(tokenText(1.5), '');
  assert.equal(usageText({}), '');
  assert.equal(usageText({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }), '');
  assert.equal(usageText({ usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 200, totalTokens: 1700 } }), '输入 1,200 · 输出 300');
  assert.equal(usageText({ usage: { input: 9000, output: 400, cacheRead: 8000, cacheWrite: 0, totalTokens: 17400 } }), '输入 9,000 · 输出 400 · 缓存读取 8,000');
  assert.equal(usageText({ usage: { input: -1, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 399 } }), '输入  · 输出 400');
});
