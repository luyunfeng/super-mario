import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuIntegration, preparePersonalCheckpoint } from '../plugins/feishu.ts';

const binding = {appId: 'cli_offline', openId: 'ou_me', profile: 'offline'};
const get = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const message = (chat_id: string, chat_type = 'group') => ({chat_id, chat_type, message_id: 'om_' + chat_id, sender: {id: 'ou_other', id_type: 'open_id'},
  create_time: '2026-11-16T12:00:00Z', content: 'fixture'});
const ok = (data: unknown) => ({ok: true, identity: 'user', data});
function adapter(runCLI: (args: string[]) => unknown) {
  return createFeishuIntegration({...binding, appSecret:'', personalOpenId: binding.openId, runCLI: async args => runCLI(args), onMessage: async () => {}, onInbox: async () => {}});
}

test('名单全分页后以明确的个人通知状态限定每次群搜索；折叠和未知群不进入正文、旧上下文或回复证据', async t => {
  const ids = Array.from({length: 24}, (_, n) => 'oc_' + n);
  const excluded = new Set(['oc_2','oc_3','oc_4','oc_5','oc_6','oc_7']);
  const searched = new Set<string>(), history = new Set<string>();
  const integration = adapter(args => {
    if (args.includes('+chat-list')) {
      assert.ok(args.includes('--exclude-muted'));
      const more = !get(args,'--page-token');
      return ok({chats: (more ? ids.slice(0,12) : ids.slice(12)).map(chat_id => ({chat_id})), has_more: more, page_token: more ? 'two' : ''});
    }
    if (args.includes('batch_query')) {
      const requested: string[] = JSON.parse(get(args,'--data')!).chat_ids;
      assert.ok(requested.length <= 10);
      return ok({items: requested.filter(id => id !== 'oc_4').map(chat_id => ({chat_id, is_muted: ({oc_2:true,oc_3:'false',oc_5:null} as Record<string,unknown>)[chat_id] ?? (chat_id === 'oc_5' ? undefined : false)}))
        .concat(requested.includes('oc_7') ? [{chat_id:'oc_7', is_muted:true}] : []), invalid_ids: [{id:'oc_6'}]});
    }
    if (args.includes('+messages-search')) {
      if (get(args,'--chat-type') === 'p2p') return ok({messages:[message('oc_private','p2p'),message('oc_2')],has_more:false});
      const requested = get(args,'--chat-id')!.split(',');
      assert.ok(requested.length > 0 && requested.length <= 10 && requested.every(id => !excluded.has(id)));
      requested.forEach(id => searched.add(id));
      return ok({messages:[...requested.map(id => message(id)),message('oc_2')],has_more:false});
    }
    assert.ok(args.includes('+chat-messages-list'));
    const id = get(args,'--chat-id')!;
    assert.ok(!excluded.has(id));
    history.add(id);
    return ok({messages:[message(id),message('oc_2')]});
  });
  t.after(() => integration.close());
  const allowed = ids.filter(id => !excluded.has(id));
  const batch = await integration.collectBatch(), legacy = await integration.collect();
  assert.deepEqual(searched,new Set(allowed));
  assert.deepEqual(history,new Set([...allowed,'oc_private']));
  for (const items of [legacy,batch.items]) {
    assert.equal(items.length,allowed.length + 1);
    assert.ok(items.every(item => !item.text.includes('[om_oc_2]')));
    assert.ok(items.every(item => item.origin?.personalGroupObserved === (item.origin?.kind === 'group' ? true : undefined)));
  }
  assert.deepEqual(new Set(batch.evidence?.map(item => item.chatId)),history);
});

test('名单半途失败仅收私聊，保留群回扫起点，名单恢复后补原时间范围', async t => {
  let failing = true;
  const searches: string[][] = [];
  const integration = adapter(args => {
    if (args.includes('+chat-list')) {
      if (get(args,'--page-token') && failing) throw new Error('offline directory error');
      return ok({chats:[{chat_id:'oc_a'}],has_more:!get(args,'--page-token'),page_token:'next'});
    }
    if (args.includes('batch_query')) return ok({items:[{chat_id:'oc_a',is_muted:false}]});
    if (args.includes('+chat-messages-list')) return ok({messages:[]});
    searches.push(args);
    return ok({messages: [get(args,'--chat-id') ? message('oc_a') : message('oc_dm','p2p')], has_more:false});
  });
  t.after(() => integration.close());
  const initial = preparePersonalCheckpoint(binding);
  initial.window!.start = '2026-11-15T12:00:00Z';
  const privateOnly = await integration.collectBatch(initial);
  assert.equal(privateOnly.checkpoint.lastCompletedThrough,undefined);
  assert.equal(privateOnly.checkpoint.groupRetryFrom,initial.window!.start);
  assert.deepEqual(privateOnly.evidence?.map(item => item.chatId),['oc_dm']);
  assert.equal((await integration.collect()).length,1);
  assert.ok(searches.every(args => get(args,'--chat-type') === 'p2p'));
  failing = false;
  const recovered = await integration.collectBatch(privateOnly.checkpoint);
  assert.ok(recovered.checkpoint.lastCompletedThrough);
  assert.equal(recovered.checkpoint.groupRetryFrom,undefined);
  assert.ok(searches.filter(args => get(args,'--chat-id')).every(args => get(args,'--start') === initial.window!.start));
});

test('旧群游标作废；名单换序续用相同范围游标，群变免打扰后重扫变化的批次', async t => {
  let ids = ['oc_a','oc_b'];
  let page = 0;
  const integration = adapter(args => {
    if (args.includes('+chat-list')) return ok({chats:ids.map(chat_id => ({chat_id})),has_more:false});
    if (args.includes('batch_query')) return ok({items:ids.map(chat_id => ({chat_id,is_muted:false}))});
    if (args.includes('p2p')) return ok({messages:[],has_more:false});
    const scope = get(args,'--chat-id');
    const prefix = args.includes('--is-at-me') ? 'mention' : 'general';
    assert.equal(scope,page === 2 ? 'oc_a' : 'oc_a,oc_b');
    assert.equal(get(args,'--page-token'), page === 1 ? prefix + '-0' : undefined);
    return ok({messages:[],has_more:page < 2,page_token:prefix+'-'+page});
  });
  t.after(() => integration.close());
  const old = preparePersonalCheckpoint(binding);
  old.window!.lanes.push({done:false,seen:[],token:'old-global-mention'},{done:false,seen:[],token:'old-global-search'});
  const first = await integration.collectBatch(old);
  page++; ids.reverse();
  const second = await integration.collectBatch(structuredClone(first.checkpoint));
  page++; ids = ['oc_a'];
  const end = await integration.collectBatch(second.checkpoint);
  assert.equal(end.hasMore,false);
  assert.equal(end.checkpoint.lastCompletedThrough,old.window!.end);
});

test('同轮名单确认后发生免打扰，后续群搜索、游标重试和旧版上下文都重新核验', async t => {
  for (const phase of ['before-search','before-replay','before-context'] as const) {
    let checks = 0, groupReads = 0;
    const integration = adapter(args => {
      if (args.includes('+chat-list')) return ok({chats:[{chat_id:'oc_changed'}],has_more:false});
      if (args.includes('batch_query')) {
        checks++;
        const muted = checks >= ({'before-search':2,'before-replay':3,'before-context':4})[phase];
        return ok({items:[{chat_id:'oc_changed',is_muted:muted}]});
      }
      if (args.includes('+messages-search')) {
        if (args.includes('p2p')) return ok({messages:[message('oc_dm','p2p')],has_more:false});
        groupReads++;
        if (phase === 'before-replay') throw Object.assign(new Error('expired'),{kind:'cursor'});
        return ok({messages:[message('oc_changed')],has_more:false});
      }
      assert.ok(args.includes('+chat-messages-list'));
      assert.equal(get(args,'--chat-id'),'oc_dm');
      return ok({messages:[]});
    });
    t.after(() => integration.close());
    if (phase === 'before-context') {
      assert.deepEqual((await integration.collect()).map(item => item.origin?.chatId),['oc_dm']);
      assert.equal(groupReads,2);
    } else {
      const checkpoint = preparePersonalCheckpoint(binding);
      checkpoint.window!.lanes.push({chatIds:['oc_changed'],mentions:true,done:false,seen:[],token:'old-cursor'});
      const batch = await integration.collectBatch(checkpoint);
      assert.equal(groupReads,phase === 'before-search' ? 0 : 1);
      assert.deepEqual(batch.items.map(item => item.origin?.chatId),['oc_dm']);
      assert.deepEqual(batch.evidence?.map(item => item.chatId),['oc_dm']);
      assert.equal(batch.checkpoint.lastCompletedThrough,undefined);
    }
  }
});
