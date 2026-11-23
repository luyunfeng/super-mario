import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';

test('模型离线时只由当前启用的来源插件归组，另一来源等待期间不会阻塞队列', async t => {
  const dir = await mkdtemp(join(tmpdir(),'inbox-offline-plugins-'));
  const server = await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
  t.after(async()=>{await server.close(); await rm(dir,{recursive:true,force:true});});
  const {app} = server;
  async function ingest(source:string, name:string, earlier:number) {
    const at = new Date(Date.now()-earlier).toISOString();
    await app.inbox.ingest(source,[{
      thread:(source.startsWith('feishu:web:') ? 'web:message:' : 'feishu:message:')+JSON.stringify([name,name]),last:name,title:name,text:name,receivedAt:at,
      origin:{kind:'direct',chatId:name,connector:'飞书'},
    }]);
    const item=app.inbox.list().find(row=>row.source===source)!;
    // Make the ordinary debounce window elapse without relying on a wall-clock sleep.
    app.store.put('inbox',item.id,{...item,updatedAt:at});
    return item.id;
  }
  const web=await ingest('feishu:web:account','网页端样例',20000);
  const native=await ingest('feishu:app:owner','个人采集样例',10000);
  const matters=(id:string)=>app.inboxAssistant.list().find(g=>g.messageIds.includes(id))?.matters ?? [];
  await app.inboxAssistant.tick();
  assert.equal(matters(native).length,1);
  assert.equal(matters(native)[0]!.groupedBy,'rules');
  assert.deepEqual(matters(web),[]);
  assert.equal(app.todos().length,0);
  await app.plugins.setEnabled('feishu-web',true);
  await app.plugins.setEnabled('inbox-triage',false);
  await app.inboxAssistant.tick();
  assert.deepEqual(matters(web),[]);
  await app.plugins.setEnabled('inbox-triage',true);
  await app.inboxAssistant.tick();
  assert.equal(matters(web)[0]?.groupedBy,'rules');
  const groupId=matters(web)[0]!.id;
  await app.plugins.setEnabled('feishu-web',false);
  await app.inboxAssistant.tick();
  assert.equal(matters(web)[0]!.id,groupId);
});
