import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createReleaseSourceExtension } from '../plugins/release-source.ts';

async function fixture(t: TestContext, fetcher: typeof fetch, timeoutMs = 5000) {
  const store = createStore(':memory:');
  const contributions = createContributions();
  const host = new PluginHost({store, contributions, events:createEventBus(store), dataDir:':memory:'});
  t.after(async () => { await host.close(); store.close(); });
  host.register(createReleaseSourceExtension({fetch:fetcher, timeoutMs}));
  await host.start();
  const read = (resource = 'sample/.github') => host.invocations.use('release-source.releases',{resource});
  return {host, contributions, read};
}

test('版本来源通过插件服务匿名读取官方仓库，将已发布版本映射成稳定条目', async t => {
  let requests = 0;
  const {read,host,contributions} = await fixture(t, async (url,init) => {
    requests++;
    assert.equal(String(url),'https://api.github.com/repos/sample/.github/releases?per_page=30');
    assert.equal(init?.method,'GET');
    assert.equal(init?.redirect,'error');
    assert.equal(init?.credentials,'omit');
    assert.equal(new Headers(init?.headers).has('authorization'),false);
    return Response.json([
      {id:27, tag_name:'v3/test', name:'测试版', prerelease:true, draft:false, body:'说明一\n说明二',html_url:'https://invalid.example/'},
      {id:26, tag_name:'v2', name:null, body:null, draft:false},
      {id:28, draft:true, tag_name:'草稿', body:'此项不应出现'},
    ]);
  });
  assert.deepEqual(contributions.list('connectors'),[{id:'releases',value:{kind:'subscription-source',name:'GitHub 版本发布',
    resourceLabel:'仓库（owner/repo）',service:'release-source.releases'}}]);
  assert.deepEqual(await read(),{items:[
    {id:'27',title:'测试版',text:'说明一\n说明二',url:'https://github.com/sample/.github/releases/tag/v3%2Ftest'},
    {id:'26',title:'v2',text:'v2',url:'https://github.com/sample/.github/releases/tag/v2'},
  ]});
  for (const bad of ['https://example.invalid/repo','sample/..','sample/%2e%2e','sample/repo?find=x','sample/repo/private','/root','sample/rr#name'])
    await assert.rejects(read(bad),{status:400,sourceReadCode:'invalid_resource'});
  assert.equal(requests,1);
  await host.setEnabled('release-source',false);
  assert.deepEqual(contributions.list('connectors'),[]);
  await assert.rejects(read(),/unavailable/);
});

test('来源区分不存在、限流、错误响应以及实际响应体过大', async t => {
  let result = new Response(null,{status:404});
  const {read}=await fixture(t,async()=>result);
  await assert.rejects(read(),{status:404,sourceReadCode:'not_found'});
  for (const status of [403,429]) {
    result=new Response('不回显上游正文',{status,headers:{'x-ratelimit-remaining':'0'}});
    await assert.rejects(read(),{status:429,sourceReadCode:'rate_limited',message:/限流/});
  }
  for (const invalid of [new Response('malformed'),Response.json({}),Response.json([{tag_name:'v1'}]),
    new Response('x',{headers:{'content-length':String(2**21+1)}})]) {
    result=invalid;
    await assert.rejects(read(),{status:502});
  }
  let cancelled=false;
  result=new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128*1024)); },
    cancel() { cancelled=true; },
  }));
  await assert.rejects(read(),{status:502,message:/2 MiB/});
  assert.ok(cancelled);
});

test('读取中超时或停用插件均取消响应流', async t => {
  for (const disable of [false,true]) {
    let received!:()=>void, cancelled=false;
    const started=new Promise<void>(resolve=>{received=resolve;});
    const {read,host}=await fixture(t,async()=>new Response(new ReadableStream({
      start(controller) {controller.enqueue(new TextEncoder().encode('['));received();},
      cancel() {cancelled=true;},
    })),disable?5000:30);
    const failure=assert.rejects(read(),disable ? /abort/i : {status:504});
    await started;
    if (disable) await host.setEnabled('release-source',false);
    await failure;
    assert.ok(cancelled);
  }
});


test('长发布说明按 Unicode 码点生成可投递的摘录', async t => {
  const chars='🚀'.repeat(16001);
  const {read}=await fixture(t,async()=>Response.json([{id:3,name:chars,tag_name:'v3',body:chars}]));
  const result=await read() as {items:{title:string;text:string}[]};
  assert.equal(result.items[0].title,'🚀'.repeat(511)+'…');
  assert.equal(result.items[0].text,'🚀'.repeat(15999)+'…');
});
