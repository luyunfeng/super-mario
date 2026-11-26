import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { PURPOSES, countUse, readFallbacks, readRouting, recordFallback, resolvePurpose, validateRule, type Routing } from '../packages/core/src/model-routing.ts';

const ZONE = 'Asia/Shanghai';
const MONDAY = new Date('2026-11-23T10:00:00Z');
// Monday 18:00 in Shanghai; Monday 16:30 UTC is Tuesday 00:30 there, and so is another day.
const LATE = new Date('2026-11-23T16:30:00Z');

test('a purpose without a model of its own follows the main model; one with it uses its own', () => {
  const store = createStore(':memory:');
  const routing: Routing = { supervisor: { model: 'cheap-model' }, lessons: { fallback: 'spare-model' } };
  assert.deepEqual(resolvePurpose(store, routing, 'main', 'main-model', MONDAY, ZONE), {
    model: 'main-model', own: false, fallback: undefined, blocked: undefined, usage: { used: 0, limit: undefined } });
  assert.equal(resolvePurpose(store, routing, 'supervisor', 'main-model', MONDAY, ZONE).model, 'cheap-model');
  assert.equal(resolvePurpose(store, routing, 'supervisor', 'main-model', MONDAY, ZONE).own, true);
  // Lessons follow the main model, and have a fallback that is not the model it follows.
  assert.deepEqual(resolvePurpose(store, routing, 'lessons', 'main-model', MONDAY, ZONE), {
    model: 'main-model', own: false, fallback: 'spare-model', blocked: undefined, usage: { used: 0, limit: undefined } });
  // A fallback that is the model already in use is no fallback.
  const same: Routing = { lessons: { model: 'main-model', fallback: 'main-model' } };
  assert.equal(resolvePurpose(store, same, 'lessons', 'main-model', MONDAY, ZONE).fallback, undefined);
  assert.equal(resolvePurpose(store, {}, 'translation', undefined, MONDAY, ZONE).model, '');
  store.close();
});

test('a day limit is counted per purpose and per day, in the owner\'s time zone', () => {
  const store = createStore(':memory:');
  const routing: Routing = { translation: { dailyLimit: 2 }, lessons: { dailyLimit: 2 } };
  countUse(store, 'translation', MONDAY, ZONE);
  assert.equal(resolvePurpose(store, routing, 'translation', 'm', MONDAY, ZONE).usage.used, 1);
  // Another purpose is not counted against it.
  assert.equal(resolvePurpose(store, routing, 'lessons', 'm', MONDAY, ZONE).usage.used, 0);
  countUse(store, 'translation', MONDAY, ZONE);
  const full = resolvePurpose(store, routing, 'translation', 'm', MONDAY, ZONE);
  assert.match(full.blocked!, /今日 回复翻译已用 2 次，达到上限 2/);
  assert.equal(full.usage.limit, 2);
  // The next day in the owner's zone starts at zero, although it is the same Monday in UTC.
  const nextDay = resolvePurpose(store, routing, 'translation', 'm', LATE, ZONE);
  assert.equal(nextDay.blocked, undefined);
  assert.equal(nextDay.usage.used, 0);
  // The main model has no enforced limit: with nothing left to fall back to, the day would stop.
  const main: Routing = { main: { dailyLimit: 1 } };
  countUse(store, 'main', MONDAY, ZONE);
  assert.equal(resolvePurpose(store, main, 'main', 'm', MONDAY, ZONE).blocked, undefined);
  store.close();
});

test('a day\'s count replaces the day before\'s, and a clock set back does not reset it', () => {
  const store = createStore(':memory:');
  countUse(store, 'lessons', MONDAY, ZONE);
  const before = new Date('2026-11-22T10:00:00Z');
  countUse(store, 'lessons', before, ZONE);
  // Monday's count is still there; only Sunday's was written, and nothing else was touched.
  assert.equal(store.list('settings').filter(row => typeof row === 'object' && row && 'purpose' in row).length, 2);
  store.close();
});

test('a rule is checked before it is saved, and what is saved is read back', () => {
  assert.deepEqual(validateRule('supervisor', {}), {});
  assert.deepEqual(validateRule('supervisor', { model: ' cheap-model ', dailyLimit: '30' }), { model: 'cheap-model', dailyLimit: 30 });
  assert.deepEqual(validateRule('lessons', { dailyLimit: 0 }), {});
  assert.throws(() => validateRule('supervisor', { model: 'has space' }), /型号格式无效/);
  assert.throws(() => validateRule('supervisor', { model: 'a', fallback: 'a' }), /备用型号不能和首选型号相同/);
  assert.throws(() => validateRule('supervisor', { dailyLimit: 1.5 }), /每日上限/);
  assert.throws(() => validateRule('supervisor', { dailyLimit: -1 }), /每日上限/);
  assert.throws(() => validateRule('supervisor', { colour: 'red' }), /只接受/);
  assert.throws(() => validateRule('supervisor', 'a string'), /必须为对象/);
  // What is saved with a field that is not well-formed is read without it.
  const store = createStore(':memory:');
  store.put('settings', 'model-routing', { supervisor: { model: 'cheap-model', dailyLimit: 5 }, lessons: { model: 'bad model' }, unknown: { model: 'x' } });
  assert.deepEqual(readRouting(store), { supervisor: { model: 'cheap-model', dailyLimit: 5 } });
  store.close();
});

test('fallbacks are kept, the most recent twenty, and read newest first', () => {
  const store = createStore(':memory:');
  for (let i = 0; i < 25; i++) recordFallback(store, { purpose: PURPOSES[i % PURPOSES.length]!, from: 'first', to: 'second', at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), reason: 'unavailable' });
  const read = readFallbacks(store);
  assert.equal(read.length, 20);
  assert.equal(read[0]!.at, new Date(Date.UTC(2026, 10, 1, 0, 24)).toISOString());
  assert.equal(read.at(-1)!.at, new Date(Date.UTC(2026, 10, 1, 0, 5)).toISOString());
  store.close();
});
