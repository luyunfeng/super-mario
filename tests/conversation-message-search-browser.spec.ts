import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('搜索本对话按当前项目和待办返回原话，翻页后能定位旧发言，停用时关闭搜索', {timeout:45000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-search-thread-')),token='fixture-search-originals';
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true,token});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{await browser?.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const project=server.app.projects.create({name:'合成历史项目'});
  const other=server.app.projects.create({name:'合成对照项目'});
  const task=server.app.createTodo({projectId:project.id,title:'对照交付'});
  const otherTask=server.app.createTodo({projectId:project.id,title:'另一项交付'});
  const conversationId='project:'+project.id+':work',query='查找标记';
  let serial=0;
  const put=(id:string,text:string,conversationId:string,projectId?:string,todoId?:string,replyTo?:string)=>{
    const message:Message={id,text,conversationId,role:replyTo?'assistant':'user',status:'done', ...(replyTo?{replyTo}:{directWebInput:true}),
      createdAt:new Date(Date.UTC(2026,0,1)+serial++*1000).toISOString(),projectId,todoId};
    server.app.store.put('messages',id,message);
  };
  server.app.store.transaction(()=>{
    for(let i=0;i<30;i++) {
      put('original-main-'+i,query+' 主对话-'+i+'。','main',project.id,undefined,i%2?'original-main-'+(i-1):undefined);
      put('original-task-'+i,query+' 任务-'+i+'。',conversationId,project.id,task.id,i%2?'original-task-'+(i-1):undefined);
    }
    put('main-other',query+' 其他项目主对话','main',other.id);
    put('main-all',query+' 全局主对话','main');
    put('project-other-task',query+' 同项目其他待办',conversationId,project.id,otherTask.id);
    put('project-all',query+' 项目普通发言',conversationId,project.id);
    put('routed-main',query+' 私聊原话','main',project.id);
    server.app.store.put('message.routes','routed-main',{channel:'feishu'});
    put('routed-answer',query+' 私聊回复','main',project.id,undefined,'routed-main');
    put('private',query+' 独立机器人原话','private:fixture');
    put('side',query+' 项目其他对话','project:'+project.id+':memory',project.id);
    put('foreign',query+' 其他项目工作对话','project:'+other.id+':work',other.id);
    for(let i=0;i<26;i++) put('dual-'+i,'> 类目词 引材-'+i+'。\n\n类目词 跟进-'+i+'。',conversationId,project.id,task.id);
    put('just-quote','> 类目词 仅在引用。\n\n请核对。',conversationId,project.id,task.id);
    put('just-text','> 请核对。\n\n类目词 仅在正文。',conversationId,project.id,task.id);
    put('assistant-block','> 类目词 助手列出的引文。\n\n已核对。',conversationId,project.id,task.id,'just-text');
    put('foreign-quote','> 类目词 另一待办。',conversationId,project.id,otherTask.id);
    const store=server.app.store;
    const putReply=(id:string,extra:Partial<Message>={})=>{
      put(id,'无工具名的展示正文',conversationId,project.id,task.id,'just-text');
      store.put('messages',id,{...store.get<Message>('messages',id)!,...extra});
    };
    const observedAt=new Date(Date.UTC(2026,0,1)).toISOString();
    const hidden='仅内部可见的合成标记';
    const toolCalls=[{id:'call',name:'fixture_history_lookup',args:hidden+'参数',result:hidden+'输出',startedAt:observedAt}];
    for(const [id,cid,source] of [
      ['trace-good',conversationId,'just-text'],['trace-cross','main','just-text'],['trace-other-input',conversationId,'main-other'],
    ] as const){
      putReply(id);
      store.put('agent.traces',id,{id,conversationId:cid,userMessageId:source,status:'done',toolCalls});
    }
    put('cited-turn','试验检索词命中的原话与合成输出摘录',conversationId,project.id,task.id);
    put('other-citation','外部待办合成摘录',conversationId,project.id,otherTask.id);
    const wrap=(result:object)=>JSON.stringify({content:[{type:'text',text:JSON.stringify(result)}],details:result});
    const searchResult={hits:[
      {id:'cited-turn',role:'user',createdAt:store.get<Message>('messages','cited-turn')!.createdAt,status:'done',text:'试验检索词命中的原话与合成输出摘录',projectId:project.id,todoId:task.id,
        matches:[{category:'text',text:'试验检索词命中的原话与合成输出摘录'}]},
      {id:'other-citation',role:'user',createdAt:store.get<Message>('messages','other-citation')!.createdAt,status:'done',text:'外部待办合成摘录',projectId:project.id,todoId:otherTask.id,
        matches:[{category:'text',text:'外部待办合成摘录'}]},
    ]};
    putReply('trace-public');
    store.put('agent.traces','trace-public',{id:'trace-public',conversationId,userMessageId:'just-text',status:'done',toolCalls:[
      {id:'read',name:'current_web_message_search',args:JSON.stringify({query:'试验检索词',category:'text'}),result:wrap(searchResult),isError:false},
      {id:'status',name:'conversation_status',args:'{}',result:wrap({phase:'waiting',goal:hidden,pending:{items:[{title:hidden}]}}),isError:false},
      {id:'other',name:'unrelated_tool',args:JSON.stringify({query:hidden}),result:wrap({text:hidden}),isError:false},
    ].map(call=>({...call,startedAt:observedAt,finishedAt:observedAt,tokens:25}))});
    const progress={phase:'tool' as const,toolName:'fixture_active_lookup',observedAt,detail:'合成工作轨迹',recentSteps:['不应展示的合成旧步骤']};
    putReply('progress-active',{status:'pending',progress});
    putReply('progress-done',{status:'done',progress});
    putReply('progress-foreign',{status:'pending',progress,todoId:otherTask.id,replyTo:'project-other-task'});
    for(const [id,sourceMessageId] of [['actual-run','just-text'],['misbound-run','main-other']]){
      store.put('runs',id!,{id,sourceMessageId,conversationId,projectId:project.id,todoId:task.id,status:'completed',output:hidden,
        prompt:hidden,executorId:'fixture',resultSource:'real',createdAt:observedAt,updatedAt:observedAt});
      putReply('run-result:'+id,{origin:'result',runResult:{runId:id!,status:'completed',source:'real'},text:'执行完成：合成公开回执'});
    }
    // Keep the selected answer outside the project's normal 60-message history window.
    for(let i=0;i<70;i++) put('newer-'+i,'后续记录 '+i,conversationId,project.id,task.id);
  });
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage(),headers={authorization:'Bearer '+token};
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const endpoint=server.url+'/api/v1/conversation-message-search';
  const request=(data:object)=>page.request.post(endpoint,{headers,data:{query,...data}});
  const ids=async(scope:object)=>{
    const result:string[]=[];
    let before:string|undefined;
    do {
      const response=await request({...scope,before});assert.equal(response.status(),200,await response.text());
      const payload=await response.json();
      for(const hit of payload.hits) {
        assert.ok(!result.includes(hit.id));result.push(hit.id);
        assert.ok(['assistant','user'].includes(hit.role) && hit.createdAt && hit.text.includes(query));
      }
      before=payload.nextBefore;
    } while(before);
    return result;
  };
  const mainIds=Array.from({length:30},(_,i)=>'original-main-'+(29-i));
  const taskIds=Array.from({length:30},(_,i)=>'original-task-'+(29-i));
  assert.deepEqual(await ids({conversationId:'main'}),['main-all','main-other',...mainIds]);
  assert.deepEqual(await ids({conversationId,projectId:project.id}),['project-all','project-other-task',...taskIds]);
  assert.ok((await request({conversationId,projectId:other.id})).status()>=400);
  assert.ok((await request({conversationId:'private:fixture'})).status()>=400);
  const open=page.getByRole('button',{name:'搜索本对话',exact:true}),drawer=page.getByRole('dialog',{name:'搜索本对话'});
  for(const isProject of [false,true]){
    const scope=isProject?{conversationId,projectId:project.id,todoId:task.id}:{conversationId:'main',projectId:project.id};
    const url=isProject?'#projects/'+project.id+'/workspace?todo='+task.id:'#chat?token='+token;
    await page.goto(server.url+'/'+url);
    if(!isProject) await page.locator('#message-form').getByLabel('项目范围').selectOption(project.id);
    const selected=isProject?taskIds:mainIds;
    const oldest=selected.at(-1)!;
    if(isProject) await expect(page.getByRole('log',{name:'项目对话'}).locator('[data-id="'+oldest+'"]')).toHaveCount(0);
    await open.click();
    const search=drawer.getByRole('searchbox',{name:'搜索关键词'});
    const load=page.waitForResponse(r=>r.url()===endpoint && r.request().method()==='POST');
    await search.fill(query);await search.press('Enter');
    const first=await load;assert.equal(first.status(),200,await first.text());
    assert.deepEqual(first.request().postDataJSON(),{...scope,query});
    const initial=await first.json();assert.equal(initial.hits.length,25);
    assert.deepEqual(initial.hits.map((item:Message)=>item.id),selected.slice(0,25));
    const links=drawer.getByRole('link');
    await expect(links).toHaveCount(25);
    const more=drawer.getByRole('button',{name:'加载更多'}),next=page.waitForResponse(r=>r.url()===endpoint);
    await more.click();const second=await next;
    assert.equal(second.request().postDataJSON().before,initial.nextBefore);
    assert.deepEqual((await second.json()).hits.map((item:Message)=>item.id),selected.slice(25));
    await expect(links).toHaveCount(30);await expect(more).toBeHidden();
    await links.last().click();await expect(drawer).toBeHidden();
    const log=isProject?page.getByRole('log',{name:'项目对话'}):page.locator('#messages');
    await expect(log.locator('[data-id="'+oldest+'"]')).toHaveClass(/is-search-hit/);
    if(isProject) assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('todo'),task.id);
  }
  await open.click();
  const filter=drawer.getByRole('combobox',{name:'搜索内容'});
  const keyword=drawer.getByRole('searchbox',{name:'搜索关键词'});
  await keyword.fill('类目词');await keyword.press('Enter');
  const rows=drawer.getByRole('listitem');
  await expect(rows).toHaveCount(25);
  const dual=rows.filter({hasText:'引材-25。'});
  await expect(dual).toHaveCount(1);
  await expect(dual.getByRole('link')).toHaveText(['类目词 引材-25。','类目词 跟进-25。']);
  await expect(dual.locator('mark')).toHaveText(['类目词','类目词']);
  await expect(dual).toContainText('正文');await expect(dual).toContainText('引用');
  const assistant=rows.filter({hasText:'助手列出的引文'});
  await expect(assistant).toContainText('正文');
  await expect(assistant).not.toContainText('引用');
  for(const category of ['quoted','text']){
    const initial=page.waitForResponse(r=>r.url()===endpoint && r.request().postDataJSON().category===category);
    await filter.selectOption(category);
    const first=await initial;
    const payload=await first.json();
    assert.equal(first.request().postDataJSON().before,undefined);
    const next=page.waitForResponse(r=>r.url()===endpoint && r.request().postDataJSON().before===payload.nextBefore);
    await drawer.getByRole('button',{name:'加载更多'}).click();
    const second=await next;
    assert.deepEqual(second.request().postDataJSON(),{query:'类目词',category,before:payload.nextBefore,conversationId,projectId:project.id,todoId:task.id});
    const hits=[...payload.hits,...(await second.json()).hits];
    const dualIds=Array.from({length:26},(_,i)=>'dual-'+(25-i));
    assert.deepEqual(hits.map(hit=>hit.id),category==='quoted'?['just-quote',...dualIds]:['assistant-block','just-text',...dualIds]);
    for(const hit of hits) assert.deepEqual(hit.matches.map((part:{category:string})=>part.category),[category]);
    await expect(rows).toHaveCount(hits.length);
    await expect(drawer.getByRole('link')).toHaveCount(hits.length);
    await expect(drawer.getByRole('button',{name:'加载更多'})).toBeHidden();
  }
  const currentScope={conversationId,projectId:project.id,todoId:task.id};
  const searchRun=async(query:string,category?:string)=>{
    const res=await request({...currentScope,query,category});
    assert.equal(res.status(),200,await res.text());return (await res.json()).hits;
  };
  for(const [category,query,id] of [
    ['tool_name','fixture_history_lookup','trace-good'], ['tool_name','fixture_active_lookup','progress-active'],
    ['event','合成工作轨迹','progress-active'], ['event','正在调用工具','progress-active'], ['event','执行完成','run-result:actual-run'],
  ]){
    const hits=await searchRun(query!,category);
    assert.deepEqual(hits.map((h:Message)=>h.id),[id]);
    for(const match of hits[0].matches) assert.equal(match.category,category);
    assert.ok(!JSON.stringify(hits).includes('仅内部可见的合成标记'));
  }
  assert.deepEqual(await searchRun('不应展示的合成旧步骤','event'),[]);
  for(const category of ['tool_name','event','tool_input','tool_output',undefined]) assert.deepEqual(await searchRun('仅内部可见的合成标记',category),[]);
  for(const [category,query,id] of [['tool_name','fixture_history_lookup','trace-good'],['event','合成工作轨迹','progress-active'],
    ['tool_input','试验检索词','trace-public'],['tool_output','合成输出摘录','trace-public']]){
    await filter.selectOption(category!);
    await keyword.fill(query!);await keyword.press('Enter');
    await expect(rows).toHaveCount(1);
    if(category==='tool_input' || category==='tool_output') {
      await expect(rows).toContainText('current_web_message_search');
      await expect(rows).toContainText(category==='tool_input'?'工具入参':'工具返回');
    }
    await drawer.getByRole('link',{name:new RegExp(query!)}).click();
    const located=page.getByRole('log',{name:'项目对话'}).locator('[data-id="'+id+'"]');
    await expect(located).toHaveClass(/is-search-hit/);
    if (category==='tool_name'){
      const receipt=page.waitForResponse(r=>r.url().endsWith('/conversation-tool-records') && r.request().method()==='POST');
      await located.getByRole('button',{name:'查看工具记录'}).click();
      const proof=await receipt;assert.deepEqual(await proof.json(),{names:['fixture_history_lookup']});
      await expect(located).toContainText('fixture_history_lookup');
      await expect(located).not.toContainText('仅内部可见的合成标记');
    }
    await open.click();
  }
  const statusHits=await searchRun('waiting','tool_output');
  assert.deepEqual(statusHits.map((h:Message)=>h.id),['trace-public']);
  assert.deepEqual(statusHits[0].matches,[{category:'tool_output',toolName:'conversation_status',text:'waiting'}]);
  assert.equal((await searchRun('等待决定','tool_output'))[0].matches[0].text,'等待决定 (waiting)');
  assert.deepEqual(await searchRun('外部待办合成摘录','tool_output'),[]);
  server.app.store.put('message.routes','cited-turn',{channel:'feishu'});
  assert.deepEqual(await searchRun('合成输出摘录','tool_output'),[]);
  const name='合成归档附件.txt', bytes=Buffer.from('仅存在于文件内的标记');
  const upload=await page.request.put(server.url+'/api/v1/chat-files/uploads?'+new URLSearchParams({conversationId:'main',name}),{
    headers:{...headers,'content-type':'text/plain'},data:bytes});
  assert.equal(upload.status(),201,await upload.text());
  const ticket=await upload.json();
  const sent=await page.request.post(server.url+'/api/v1/messages',{headers,data:{text:'请收下测试资料',files:[{uploadId:ticket.uploadId}]}});
  assert.equal(sent.status(),202,await sent.text());
  const withFile=await sent.json() as Message;
  server.app.store.put('messages','routed-main',{...server.app.store.get<Message>('messages','routed-main')!,files:withFile.files});
  const fileSearch=async(query:string)=>{
    const res=await request({query,conversationId:'main',category:'file'});
    assert.equal(res.status(),200,await res.text());return (await res.json()).hits;
  };
  const files=await fileSearch('归档附件');
  assert.deepEqual(files.map((hit:Message)=>hit.id),[withFile.id]);
  assert.equal(files[0].matches[0].category,'file');assert.equal(files[0].matches[0].text,name);
  assert.deepEqual(await fileSearch(bytes.toString()),[]);
  assert.ok(!JSON.stringify(files).includes(ticket.sha256));
  const filesOff=await page.request.post(server.url+'/api/v1/plugins/conversation-files',{headers,data:{enabled:false}});
  assert.equal(filesOff.status(),200);assert.deepEqual(await fileSearch('归档附件'),[]);
  const all=await request({query:'归档附件',conversationId:'main'});
  assert.equal(all.status(),200);assert.ok(!(await all.text()).includes(name));
  const off=await page.request.post(server.url+'/api/v1/plugins/conversation-search',{headers,data:{enabled:false}});
  assert.equal(off.status(),200);await expect(drawer).toBeHidden();await expect(open).toBeHidden();
  assert.equal((await request({conversationId,projectId:project.id})).status(),503);
});
