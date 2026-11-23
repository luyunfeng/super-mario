import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { decisionQuietNow } from '../packages/core/src/decision-quiet-hours.ts';

test('飞书免打扰支持当地时区、跨午夜、同日窗口及边界', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const at = (utc:string) => decisionQuietNow(store,new Date('2026-01-02T'+utc+':00Z'));
  assert.equal(at('16:00'),false);
  function set(start:string,end:string) {
    store.put('briefing.settings','default',{timezone:'Asia/Shanghai',decisionQuietHours:{enabled:true,start,end}});
  }
  set('22:00','08:00');
  assert.equal(at('13:59'),false);
  assert.equal(at('14:00'),true);
  assert.equal(at('23:59'),true);
  assert.equal(at('00:00'),false);
  set('13:00','14:00');
  assert.equal(at('05:00'),true);
  assert.equal(at('06:00'),false);
  set('08:00','08:00');
  assert.equal(at('00:00'),false);
});
