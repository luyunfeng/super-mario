import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTopicTurns, type TopicAudience } from '../apps/server/src/feishu-topic-turns.ts';
import { createStore } from '../packages/core/src/store.ts';

const a: TopicAudience = { binding: 'paired', grant: 'enrollment-one', chatId: 'chat-one', threadId: 'topic-one' };
const message = { ...a, messageId: 'message-one', root: false, command: false, words: '合成发言' };
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'topic-turns-')), path = join(dir, 'offline.db');
  const store = createStore(path);
  const host = (db: typeof store) => createTopicTurns(db, input => {
    const todo = { id: 'todo-' + db.list('todos').length, ...input };
    db.put('todos', todo.id, todo);
    return todo;
  });
  const reopened = createStore(path);
  t.after(() => { store.close(); reopened.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, turns: host(store), other: host(reopened) };
}

test('未绑定的话题仅在根消息或 /ai 建办；重复输入恢复首次文字，普通跟进沿用原任务', t => {
  const { store, turns, other } = fixture(t);
  assert.equal(turns.accept(message), undefined);
  assert.equal(turns.accept({ ...message, root: true }), undefined);
  assert.equal(turns.accept({ ...message, messageId: 'image', root: true, words: '[图片]\n[视频]' }), undefined);
  const root = { ...message, messageId: 'root', root: true, words: '  任务第一行\n任务第二行  ' };
  const turn = turns.accept(root);
  assert.deepEqual(turn, { todoId: 'todo-0', opening: true, words: '任务第一行\n任务第二行' });
  assert.deepEqual(other.accept({ ...root, words: '篡改后的重放' }), turn);
  const follow = { ...message, messageId: 'follow' };
  assert.deepEqual(other.accept(follow), { todoId: 'todo-0', opening: false, words: '合成发言' });
  assert.deepEqual(turns.accept({ ...follow, command: true, words: '另一条命令' }), other.accept(follow));
  assert.equal(turns.accept({ ...follow, threadId: 'other', root: true }), undefined);
  assert.equal(store.list('todos').length, 1);
  assert.deepEqual(store.get('todos', 'todo-0'), { id: 'todo-0', title: '任务第一行 任务第二行', notes: '任务第一行\n任务第二行' });
  assert.equal(turns.accept({ ...message, threadId: 'other', command: true, messageId: 'command' })?.opening, true);
});

test('重新登记旧话题不会继承旧待办，相同事件不在新登记下重建', t => {
  const { store, turns } = fixture(t);
  const old = turns.accept({ ...message, root: true })!;
  const again = { ...message, grant: 'enrollment-two' };
  assert.equal(turns.todoFor(again), undefined);
  assert.equal(turns.accept({ ...again, root: true }), undefined);
  assert.equal(turns.accept({ ...again, messageId: 'new-follow' }), undefined);
  const next = turns.accept({ ...again, messageId: 'new-root', command: true })!;
  assert.notEqual(next.todoId, old.todoId);
  store.put('todos', next.todoId, { id: next.todoId, completedAt: '2026-01-01T00:00:00Z' });
  assert.equal(turns.accept({ ...again, messageId: 'closed', command: true }), undefined);
  assert.equal(store.list('todos').length, 2);
});

test('主群新话题可幂等绑定已存在待办，冲突或丢失的待办不会被重新创建', t => {
  const { store, turns, other } = fixture(t);
  assert.equal(turns.bindHome({ ...a, todoId: 'missing' }), false);
  store.put('todos', 'from-group', { id: 'from-group' });
  store.put('todos', 'another', { id: 'another' });
  assert.equal(turns.bindHome({ ...a, todoId: 'from-group' }), true);
  assert.equal(other.bindHome({ ...a, todoId: 'from-group' }), true);
  assert.equal(other.bindHome({ ...a, todoId: 'another' }), false);
  assert.deepEqual(turns.accept(message), { opening: false, todoId: 'from-group', words: message.words });
  store.remove('todos', 'from-group');
  assert.equal(turns.accept({ ...message, root: true, messageId: 'deleted' }), undefined);
  assert.equal(store.list('todos').length, 1);
});

test('未绑定和已结待办回复用法；相同消息不重复提示，普通跟进共用冷却期', t => {
  const { store, turns, other } = fixture(t);
  const notice = (id: string, command: boolean) => {
    other.accept({ ...message, messageId: id, command, words: command ? '' : '继续' });
    return turns.hint(a, id, command, command);
  };
  assert.match(notice('first', false)!, /还没有待办/);
  assert.equal(notice('second', false), undefined);
  assert.match(notice('empty', true)!, /写下/);
  assert.equal(notice('empty', true), undefined);
  const opened = turns.accept({ ...message, messageId: 'opened', root: true })!;
  store.put('todos', opened.todoId, { id: opened.todoId, completedAt: '2026-01-01T00:00:00Z' });
  assert.equal(notice('opened', false), undefined);
  assert.match(notice('finished', true)!, /已完成/);
  assert.equal(store.list('todos').length, 1);
});

test('每个待办仅有一个反向绑定，版本跨连接稳定，解绑后旧主群和旧事件都不能复活', t => {
  const {store,turns,other} = fixture(t);
  store.put('todos','from-home',{id:'from-home'});
  const home = {...a,todoId:'from-home'};
  assert.ok(turns.bindHome(home));
  const first = other.bindingFor('from-home')!;
  assert.deepEqual(first.audience,a); assert.ok(first.version);
  assert.equal(other.bindHome({...home,threadId:'competitor'}),false);
  assert.ok(other.bindHome(home)); assert.deepEqual(turns.bindingFor('from-home'),first);
  const follow = turns.accept(message)!; assert.equal(follow.todoId,'from-home');
  assert.throws(()=>other.unbind('from-home','stale'),{status:409}); assert.equal(other.todoFor(a),'from-home');
  assert.throws(()=>store.transaction(()=>{ turns.unbind('from-home',first.version); throw Error('rollback'); }));
  assert.equal(other.todoFor(a),'from-home');
  other.unbind('from-home',first.version); assert.equal(turns.bindingFor('from-home'),undefined); assert.equal(turns.todoFor(a),undefined);
  other.unbind('from-home',first.version);
  assert.equal(turns.accept({...message,root:true}),undefined); assert.equal(turns.bindHome(home),false);
  assert.equal(turns.restoreBinding('from-home',a),undefined);
  assert.equal(turns.accept({...message,messageId:'later-follow'}),undefined);
  const fresh = turns.accept({...message,messageId:'new-command',command:true})!;
  assert.notEqual(fresh.todoId,'from-home'); assert.notEqual(turns.bindingFor(fresh.todoId)?.version,first.version);
  assert.throws(()=>other.unbind(fresh.todoId,first.version),{status:409});
  assert.equal(turns.todoFor(a),fresh.todoId);
});

test('迁移只接受既有唯一 forward 的原始 audience，不能选择旧库中冲突的多个关联', t => {
  const {store,turns,other} = fixture(t);
  const hash = (audience: TopicAudience) => createHash('sha256')
    .update(JSON.stringify([audience.binding,audience.grant,audience.chatId,audience.threadId])).digest('hex');
  const second = {...a,threadId:'second'};
  store.put('todos','legacy',{id:'legacy'}); store.put('feishu.topic-todos',hash(a),'legacy');
  assert.equal(turns.bindingFor('legacy'),undefined);
  assert.equal(turns.restoreBinding('legacy',second),undefined);
  assert.equal(turns.bindHome({...second,todoId:'legacy'}),false);
  store.put('feishu.topic-todos',hash(second),'legacy');
  assert.equal(turns.restoreBinding('legacy',a),undefined); assert.equal(turns.todoFor(second),undefined);
  assert.equal(turns.accept({...message,root:true}),undefined);
  assert.throws(()=>turns.unbind('legacy','missing'),{status:409});
  store.remove('feishu.topic-todos',hash(second));
  const restored = other.restoreBinding('legacy',a);
  assert.ok(restored); assert.deepEqual(restored.audience,a); assert.deepEqual(turns.bindingFor('legacy'),restored);
  assert.deepEqual(turns.restoreBinding('legacy',a),restored);
  other.unbind('legacy',restored.version);
  assert.equal(turns.bindHome({...a,todoId:'legacy'}),false);
});

test('主人初绑/换绑维持双向唯一，失效版本不覆盖，事务回滚还原原绑定', t => {
  const {store,turns,other} = fixture(t);
  store.put('todos','manual',{id:'manual'}); store.put('todos','neighbor',{id:'neighbor'});
  const b = {...a,threadId:'target-b'}, c = {...a,threadId:'target-c'};
  const first = turns.bindOwner('manual',a,null);
  assert.equal(first.ownerManaged,true);
  assert.deepEqual(other.bindOwner('manual',a,null),first);
  assert.deepEqual(other.bindOwner('manual',a,first.version),first);
  other.bindOwner('neighbor',b,null);
  assert.throws(()=>turns.bindOwner('manual',b,first.version),{status:409});
  assert.throws(()=>turns.bindOwner('manual',c,null),{status:409});
  assert.throws(()=>store.transaction(()=>{ turns.bindOwner('manual',c,first.version); throw Error('rollback'); }));
  assert.deepEqual(other.bindingFor('manual'),first); assert.equal(other.todoFor(c),undefined);
  const next = other.bindOwner('manual',c,first.version);
  assert.notEqual(next.version,first.version); assert.deepEqual(next.audience,c);
  assert.equal(turns.todoFor(a),undefined); assert.equal(turns.todoFor(c),'manual');
  assert.throws(()=>turns.bindOwner('manual',c,first.version),{status:409});
  assert.equal(turns.todoFor(b),'neighbor');
});

test('手工绑定首条真实决定成为锚点；同一待办与话题重新绑定后旧回执不能跨代', t => {
  const {store,turns,other} = fixture(t);
  const opened = turns.accept({...message,root:true})!;
  const original = turns.bindingFor(opened.todoId)!;
  assert.deepEqual(turns.bindOwner(opened.todoId,a,null),original);
  const legacyEvent = createHash('sha256').update(JSON.stringify([a.binding,a.chatId,message.messageId])).digest('hex');
  const old = store.get<{bindingVersion?:string}>('feishu.topic-turns',legacyEvent)!;
  delete old.bindingVersion; store.put('feishu.topic-turns',legacyEvent,old);
  assert.deepEqual(turns.accept({...message,root:true}),opened);
  turns.unbind(opened.todoId,original.version);
  const manual = turns.bindOwner(opened.todoId,a,null);
  assert.equal(other.accept({...message,root:true}),undefined);
  assert.equal(other.accept({...message,messageId:'empty',words:' [图片] '}),undefined);
  assert.equal(other.bindHome({...a,todoId:opened.todoId}),false);
  const input = {...message,messageId:'first-manual'};
  const first = other.accept(input)!;
  assert.deepEqual(first,{todoId:opened.todoId,opening:false,words:input.words,authorityVersion:manual.version,sourceOpening:true});
  assert.deepEqual(turns.accept({...input,words:'尝试修改'}),first);
  assert.deepEqual(turns.accept({...message,messageId:'second-manual'}),{todoId:opened.todoId,opening:false,words:message.words,authorityVersion:manual.version});
  other.unbind(opened.todoId,manual.version); const rebound = turns.bindOwner(opened.todoId,a,null);
  assert.notEqual(manual.version,rebound.version); assert.equal(turns.accept(input),undefined);
  const fresh = other.accept({...message,messageId:'fresh'}); assert.equal(fresh?.sourceOpening,true); assert.equal(fresh?.authorityVersion,rebound.version);
  assert.deepEqual(other.restoreBinding(opened.todoId,a),rebound);
});

test('绑定标题按 Unicode 码点裁剪，改名和清空不轮换授权，换绑不继承旧标题', t => {
  const {store,turns,other} = fixture(t);
  store.put('todos','title-task',{id:'title-task'});
  const first = turns.bindOwner('title-task',a,null, '  项目群  ');
  assert.equal(first.title,'项目群');
  assert.deepEqual(other.bindOwner('title-task',a,first.version),first);
  const label = '甲'.repeat(199) + '🙂';
  const renamed = other.bindOwner('title-task',a,first.version,'  ' + label + '不保留  ');
  assert.equal(renamed.title,label); assert.equal(renamed.version,first.version);
  assert.equal(turns.accept(message)?.authorityVersion,first.version);
  assert.throws(()=>turns.bindOwner('title-task',a,'old','误改'),{status:409});
  assert.equal(turns.bindingFor('title-task')?.title,label);
  const cleared = turns.bindOwner('title-task',a,first.version,'   ');
  assert.equal(cleared.title,undefined); assert.equal(cleared.version,first.version);
  turns.bindOwner('title-task',a,first.version,'旧标题');
  const next = other.bindOwner('title-task',{...a,threadId:'new'},first.version);
  assert.equal(next.title,undefined); assert.notEqual(next.version,first.version);
});
