import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { todoLineage } from '../packages/core/src/todo-lineage.ts';

test('完整历程包含祖先与真实旁支，每代可查看同一历程，按实际时间与 ID 排序', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const owner={runId:'run',machineId:'machine',sessionId:'session'};
  const add=(id:string,createdAt:string,extra:object={})=>store.put('todos',id,{id,title:id,projectId:'project',createdAt,...extra});
  const first='2026-01-01T00:00:00Z', later='2026-01-01T08:01:00+08:00', last='2026-01-01T00:02:00Z';
  add('root',first,{responsibleSession:{...owner,privateNote:'其他执行机数据'},completedAt:later,notes:'私有备注'});
  add('right',later,{continuesTodoId:'root',continuationRootId:'root',continuationReason:'另一条路径'});
  add('left',later,{continuesTodoId:'root',continuationRootId:'root',continuationReason:'接手根待办'});
  add('tip',last,{continuesTodoId:'left',continuationRootId:'root'});
  add('child',last,{parentTodoId:'root',afterTodoIds:['left']});
  for (const id of ['root','left','right','tip']) {
    const steps=todoLineage(store,id);
    assert.deepEqual(steps.map(step=>step.id),['root','left','right','tip']);
    assert.deepEqual(steps.filter(step=>step.current).map(step=>step.id),[id]);
    assert.deepEqual(steps[0],{id:'root',title:'root',createdAt:first,completedAt:later,responsibleSession:owner,current:id==='root'});
    assert.equal(steps[1]?.continuationReason,'接手根待办');
    assert.equal(steps[2]?.continuesTodoId,'root');
    assert.equal(steps[3]?.completedAt,undefined);
  }
  assert.deepEqual(todoLineage(store,'child'),[]);
  assert.deepEqual(todoLineage(store,'absent'),[]);
});

test('根标识不能代替真实前序关系，拒绝错键、断链、环与跨项目数据，包括仅支持 list 的存储', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  function put(key:string,id:string,extra:object={}) {
    store.put('todos',key,{id,title:key,createdAt:'2026-01-01',projectId:'p',continuationRootId:'root',...extra});
  }
  put('root','root');put('ok','ok',{continuesTodoId:'root'});
  put('impostor','ok',{continuesTodoId:'root',title:'伪造正文'});
  put('broken','broken',{continuesTodoId:'missing'});
  put('cycle1','cycle1',{continuesTodoId:'cycle2'});put('cycle2','cycle2',{continuesTodoId:'cycle1'});
  put('foreign','foreign',{continuesTodoId:'root',projectId:'another'});
  put('via-foreign','via-foreign',{continuesTodoId:'foreign'});
  put('alias','forged-parent',{continuesTodoId:'root'});
  put('via-alias','via-alias',{continuesTodoId:'forged-parent'});
  put('wrong-root','wrong-root',{continuationRootId:'other',continuesTodoId:'root'});
  const fallback={get:store.get,list:store.list};
  for (const reader of [store,fallback]) {
    assert.deepEqual(todoLineage(reader,'root').map(step=>step.title),['ok','root']);
    for (const key of ['impostor','broken','cycle1','cycle2','foreign','via-foreign','alias','via-alias','wrong-root'])
      assert.deepEqual(todoLineage(reader,key),[]);
  }
  put('root','root',{continuesTodoId:'ok'});
  assert.deepEqual(todoLineage(store,'ok'),[]);
  put('root','spoof');
  assert.deepEqual(todoLineage(store,'ok'),[]);
});
