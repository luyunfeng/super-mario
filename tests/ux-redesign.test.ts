import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
test('UX: setup is factual, channel skip durable, attention read-only and page modules served', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mario-ux-api-'));
  let server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
  const call=async(path:string,body?:unknown)=>{const response=await fetch(server.url+'/api/v1'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${await response.clone().text()}`);return response.json();};
  try {
    const state=await call('/state');assert.equal(state.setup.project,false);assert.equal(state.setup.memory,false);assert.equal(state.setup.channel,'todo');assert.ok(state.problems.some((p:{area:string})=>p.area==='channel'));
    await call('/setup/channel-skip',{});assert.equal((await call('/state')).setup.channel,'skipped');
    await call('/projects',{name:'验收项目',description:'保持简单'});assert.equal((await call('/state')).setup.project,true);
    const before=await call('/state');assert.deepEqual(await call('/attention'),[]);assert.deepEqual((await call('/state')).todos,before.todos);
    const presets=await call('/policies/presets');assert.equal(presets.presets.length,3);
    assert.deepEqual((await call('/policies/presets',{preset:'conservative'})).config,await call('/policies'));
    assert.ok((await call('/todos?view=sections'))['某天']);
    for(const asset of ['js/main.js','js/lib/alerts.js','js/copy/hints.js','js/pages/chat.js','js/pages/agent.js','js/pages/projects.js','js/pages/memory.js','js/pages/channels.js']){const response=await fetch(server.url+'/'+asset);assert.equal(response.status,200,asset);assert.match(response.headers.get('content-type')||'',/javascript/);}
    await server.close();server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true});assert.equal((await call('/state')).setup.channel,'skipped');
  } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});
