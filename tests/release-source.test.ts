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
      {id:27, tag_name:'v3/test', published_at:'2026-01-01T08:00:00Z', name:'测试版', prerelease:true, draft:false, body:'说明一\n说明二',html_url:'https://invalid.example/'},
      {id:26, tag_name:'v2', name:null, body:null, draft:false},
      {id:28, draft:true, tag_name:'草稿', body:'此项不应出现'},
    ]);
  });
  assert.deepEqual(contributions.list('connectors'),[{id:'releases',value:{kind:'subscription-source',name:'GitHub 版本发布',
    resourceLabel:'仓库（owner/repo）',service:'release-source.releases'}},
    {id:'repository',value:{kind:'subscription-source',mode:'snapshot',name:'GitHub 仓库状态',resourceLabel:'仓库（owner/repo）',service:'release-source.repository'}}]);
  assert.deepEqual(await read(),{checkpoint:'27',items:[
    {id:'27',title:'测试版',occurredAt:'2026-01-01T08:00:00Z',text:'说明一\n说明二',url:'https://github.com/sample/.github/releases/tag/v3%2Ftest'},
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

test('限流优先使用 Retry-After，其次使用尚未到期的 GitHub 重置时刻', async t => {
  const now=Date.parse('2026-11-23T10:20:30.250Z');
  t.mock.timers.enable({apis:['Date'],now});
  let headers=new Headers();
  const {read}=await fixture(t,async()=>new Response(null,{status:403,headers}));
  const reset=String(Math.floor(now/1000)+75);
  const futureDate=new Date(now+42000).toUTCString();
  const cases: [Record<string,string>,number|undefined][]=[
    [{'retry-after':'18','x-ratelimit-reset':reset},18],
    [{'retry-after':futureDate,'x-ratelimit-reset':reset},42],
    [{'x-ratelimit-reset':reset},75],
    [{'retry-after':'0','x-ratelimit-reset':reset},75],
    [{'retry-after':'invalid','x-ratelimit-reset':reset},75],
    [{'retry-after':new Date(now-60000).toUTCString(),'x-ratelimit-reset':reset},75],
    [{'retry-after':'1.5','x-ratelimit-reset':'12e3'},undefined],
    [{'retry-after':'-1','x-ratelimit-reset':String(Math.floor(now/1000))},undefined],
    [{'retry-after':'9007199254740993','x-ratelimit-reset':'9007199254740993'},undefined],
    [{},undefined],
  ];
  for (const [values,seconds] of cases) {
    headers=new Headers({'x-ratelimit-remaining':'0',...values});
    await assert.rejects(read(),err=>{
      assert.ok(err instanceof Error && 'sourceReadCode' in err && err.sourceReadCode==='rate_limited');
      if (seconds===undefined) assert.ok(!Object.hasOwn(err,'retryAfterSeconds'));
      else assert.ok('retryAfterSeconds' in err && err.retryAfterSeconds===seconds);
      return true;
    });
  }
  headers=new Headers({'x-ratelimit-remaining':'42','x-ratelimit-reset':reset});
  await assert.rejects(read(),{status:403,sourceReadCode:'forbidden'});
});

test('分页只信任 next 关系，游标逐页递增并始终请求同一仓库官方 URL',async t=>{
  const requested:string[]=[];
  const base='https://api.github.com/repos/sample/project/releases?per_page=30';
  const {host}=await fixture(t,async url=>{
    requested.push(String(url));
    const page=requested.length;
    const link=page===1 ? '<https://example.invalid/path?page=99>; rel="next", <https://example.invalid/>; rel="last"'
      : page===2 ? '<https://example.invalid/prev>; rel="prev", <https://example.invalid/a,b>; title="page, later"; rel="next"' :
        '<https://example.invalid/next>; rel="prev"; title="next"';
    return Response.json([{id:page,tag_name:'v'+page}],{headers:{link}});
  });
  const read=(cursor?:string)=>host.invocations.use('release-source.releases',{resource:'sample/project',...(cursor!==undefined && {cursor})}) as Promise<{items:{id:string}[];nextCursor?:string}>;
  const first=await read(), second=await read(first.nextCursor), third=await read(second.nextCursor);
  assert.deepEqual([first.nextCursor,second.nextCursor,third.nextCursor],['2','3',undefined]);
  assert.deepEqual([first,second,third].map(result=>result.items[0].id),['1','2','3']);
  for (const cursor of ['', '0','1','02','2&other=x','https://example.invalid/?page=3','1.5','9007199254740993'])
    await assert.rejects(read(cursor),{status:400,sourceReadCode:'invalid_resource'});
  assert.deepEqual(requested,[base,base+'&page=2',base+'&page=3']);
});


test('首页只给候选水位，超过一页的新发布继续查找旧水位，水位消失时读至末页',async t=>{
  const {host}=await fixture(t,async url=>{
    const page=Number(new URL(String(url)).searchParams.get('page') ?? '1');
    const ids=Array.from({length:page===3 ? 10 : 30},(_,i)=>70-30*(page-1)-i);
    return Response.json(ids.map(id=>({id,tag_name:'v'+id})),{headers:page<3 ? {link:'<https://example.invalid/ignored>; rel="next"'} : {}});
  });
  const read=(checkpoint:string,cursor?:string)=>host.invocations.use('release-source.releases',{resource:'sample/project',checkpoint,...(cursor && {cursor})}) as Promise<{items:{id:string}[];nextCursor?:string;checkpoint?:string}>;
  const head=await read('35');
  assert.deepEqual([head.checkpoint,head.items.length,head.nextCursor],['70',30,'2']);
  const tail=await read('35',head.nextCursor);
  assert.deepEqual(tail.items.map(item=>item.id),['40','39','38','37','36']);
  assert.equal(tail.nextCursor,undefined);
  assert.equal(tail.checkpoint,undefined);
  assert.deepEqual(await read('70'),{items:[],checkpoint:'70'});
  const first=await read('80'), second=await read('80',first.nextCursor),last=await read('80',second.nextCursor);
  assert.equal(first.items.length+second.items.length+last.items.length,70);
  assert.equal(last.nextCursor,undefined);
  for (const invalid of ['0','07','bad','999999999999999999999']) await assert.rejects(read(invalid),{status:400});
});

test('仓库快照只反映五项仓库设置，忽略分页链接和活动计数',async t=>{
  const base={full_name:'Sample/Project',description:'仓库说明',default_branch:'main',archived:false,disabled:false};
  let response:unknown={...base,stargazers_count:100,html_url:'https://example.invalid/'};
  const {host}=await fixture(t,async(url,init)=>{
    assert.equal(String(url),'https://api.github.com/repos/sample/project');
    assert.equal(init?.redirect,'error');
    assert.equal(init?.credentials,'omit');
    return Response.json(response,{headers:{link:'<https://example.invalid/>; rel="next"'}});
  });
  const read=()=>host.invocations.use('release-source.repository',{resource:'sample/project'});
  const expected={snapshot:{title:'Sample/Project 仓库状态',url:'https://github.com/Sample/Project',
    text:'仓库：Sample/Project\n描述："仓库说明"\n默认分支：main\n已归档：否\n已禁用：否'}};
  assert.deepEqual(await read(),expected);
  response={updated_at:'2026-08-10',stargazers_count:101,...base};
  assert.deepEqual(await read(),expected);
  response={...base,description:null,default_branch:'next',archived:true,disabled:true};
  assert.deepEqual(await read(),{snapshot:{...expected.snapshot,text:'仓库：Sample/Project\n描述：未填写\n默认分支：next\n已归档：是\n已禁用：是'}});
  for (const invalid of [{...base,private:true},{...base,full_name:'sample/other'},{...base,disabled:null},{}]) {
    response=invalid;
    await assert.rejects(read(),{status:502,sourceReadCode:'unavailable'});
  }
});

test('仓库快照复用读取限流提示，拒绝分页或外部 URL',async t=>{
  let calls=0;
  const {host}=await fixture(t,async()=>{
    calls++;
    return new Response(null,{status:429,headers:{'retry-after':'18'}});
  });
  const use=(input:Record<string,string>)=>host.invocations.use('release-source.repository',input);
  const invalid:Record<string,string>[]=[{resource:'https://example.invalid'},{resource:'sample/project',cursor:'2'},{resource:'sample/project',checkpoint:'10'}];
  for (const args of invalid)
    await assert.rejects(use(args),{status:400,sourceReadCode:'invalid_resource'});
  assert.equal(calls,0);
  await assert.rejects(use({resource:'sample/project'}),{status:429,sourceReadCode:'rate_limited',retryAfterSeconds:18});
  assert.equal(calls,1);
});
