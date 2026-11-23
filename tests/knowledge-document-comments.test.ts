import assert from 'node:assert/strict';
import test from 'node:test';
import {isKnowledgeDocumentCommentsURL,readKnowledgeDocumentComments,writeKnowledgeDocumentComment,searchKnowledgeCommentPeople} from '../plugins/knowledge-source-reader.ts';
import type {KnowledgeSourceRunCLI} from '../packages/protocol/src/index.ts';

const url='https://fixture.feishu.cn/wiki/WikiFixture';
const inspect={type:'docx',token:'DocFixture',url:'https://fixture.feishu.cn/docx/DocFixture',title:'合成文档',
  wiki_node:{node_token:'WikiFixture',obj_token:'DocFixture',obj_type:'docx'}};
const reply={user_name:'合成作者',content:{elements:[{type:'text_run',text_run:{text:'第一段'}},{type:'mention'},
  {type:'text_run',text:'请确认'}]}};
function fixture(pages:unknown[],metadata:unknown=inspect) {
  let position=0;
  const calls:string[][]=[];
  const runCLI:KnowledgeSourceRunCLI=async argv=>{
    calls.push([...argv]);
    const data=argv[1]==='+inspect'?metadata:pages[position++];
    return {exitCode:0,stdout:JSON.stringify({ok:true,identity:'user',data})};
  };
  return {runCLI,calls};
}
const cliPage=(items:unknown[],has_more=false,page_token='')=>({file_token:'DocFixture',file_type:'docx',items,has_more,page_token});
const thread=(comment_id:string,is_solved:boolean,more=false)=>({comment_id,is_solved,quote:'原文范围',reply_list:{replies:[reply],has_more:more}});

test('按明确身份读取两页评论，保留已解决状态、根回复与可见文字，回复不完整明确标识',async()=>{
  const {runCLI,calls}=fixture([cliPage([thread('one',false)],true,'next=1'),cliPage([thread('two',true,true)]),{items:Array(20).fill(reply),has_more:true}]);
  const result=await readKnowledgeDocumentComments(url+'?token=never-send',{profile:'fixture-profile',runCLI},new AbortController().signal);
  assert.deepEqual(result,{documentId:'DocFixture',truncated:true,threads:['one','two'].map((id,i)=>({id,quote:'原文范围',resolved:i===1,replies:Array(i===1?20:1).fill({author:'合成作者',text:'第一段[提及]请确认'})}))});
  assert.deepEqual(calls.map(a=>a.slice(0,2)),[['drive','+inspect'],['drive','+list-comments'],['drive','+list-comments'],['drive','file.comment.replys']]);
  assert.deepEqual(calls[2],['drive','+list-comments','--token','DocFixture','--type','docx','--solved-status','all','--page-size','25','--page-token','next=1','--as','user','--profile','fixture-profile','--format','json']);
  assert.ok(!JSON.stringify(calls).includes('never-send'));
  for (const item of [{...thread('one',false),has_more:true},{...thread('one',false),reply_list:{replies:Array(21).fill(reply)}},
    {...thread('one',false),quote:'合'.repeat(1001)}]) {
    const f=fixture([cliPage([item]),{items:Array(20).fill(reply),has_more:true}]);assert.equal((await readKnowledgeDocumentComments(url,{profile:'p',runCLI:f.runCLI},new AbortController().signal)).truncated,true);
  }
  const missing=fixture([{items:[{comment_id:'solved',is_solved:true}],has_more:false},
    {items:[reply],has_more:true,page_token:'rnext'},{items:[reply],has_more:false}]);
  const fetched=await readKnowledgeDocumentComments(url,{profile:'p',runCLI:missing.runCLI},new AbortController().signal);
  assert.equal(fetched.truncated,false);assert.equal(fetched.threads[0]?.replies.length,2);
  assert.ok(missing.calls[3]?.includes('rnext'));
  const limited=fixture(Array.from({length:4},(_,i)=>cliPage([thread('c'+i,false)],true,'more'+i)));
  assert.equal((await readKnowledgeDocumentComments(url,{profile:'p',runCLI:limited.runCLI},new AbortController().signal)).truncated,true);
  assert.equal(limited.calls.length,5);
});

test('无评论与权限失败可区分，拒绝不可信来源、错误原件和无效分页回执',async()=>{
  const signal=new AbortController().signal, empty=fixture([cliPage([])]);
  assert.deepEqual(await readKnowledgeDocumentComments(url,{profile:'p',runCLI:empty.runCLI},signal),{documentId:'DocFixture',threads:[],truncated:false});
  assert.ok(isKnowledgeDocumentCommentsURL(url));
  for (const other of ['http://fixture.feishu.cn/wiki/a','https://bad.test/docx/a','https://fixture.feishu.cn/file/a','https://fixture.feishu.cn/wiki/../docx/a']) {
    assert.equal(isKnowledgeDocumentCommentsURL(other),false);
    await assert.rejects(readKnowledgeDocumentComments(other,{profile:'p',runCLI:empty.runCLI},signal));
  }
  assert.equal(empty.calls.length,2);
  await assert.rejects(readKnowledgeDocumentComments(url,{runCLI:empty.runCLI},signal),{code:'MISSING_PROFILE'});
  await assert.rejects(readKnowledgeDocumentComments(url,{profile:'p',runCLI:async()=>({stdout:'',stderr:JSON.stringify({error:{code:99991672}}),exitCode:1})},signal),{code:'UNAUTHORIZED'});
  const noEcho=fixture([{items:[],has_more:false}]);
  const withoutIdentity:KnowledgeSourceRunCLI=async(argv,options)=>{
    const res=await noEcho.runCLI(argv,options),envelope=JSON.parse(res.stdout);delete envelope.identity;
    return {...res,stdout:JSON.stringify(envelope)};
  };
  assert.deepEqual(await readKnowledgeDocumentComments(url,{profile:'p',runCLI:withoutIdentity},signal),{documentId:'DocFixture',threads:[],truncated:false});
  const otherIdentity:KnowledgeSourceRunCLI=async()=>({exitCode:0,stdout:JSON.stringify({ok:true,data:inspect,identity:'bot'})});
  await assert.rejects(readKnowledgeDocumentComments(url,{profile:'p',runCLI:otherIdentity},signal),{code:'INVALID_RESPONSE'});
  const wrong=fixture([],{...inspect,url:'https://other.feishu.cn/docx/DocFixture'});
  await assert.rejects(readKnowledgeDocumentComments(url,{profile:'p',runCLI:wrong.runCLI},signal),{code:'CROSS_ORIGIN'});
  assert.equal(wrong.calls.length,1);
  for(const pages of [[{...cliPage([]),file_token:'different'}],[cliPage([],true,'dup'),cliPage([],true,'dup')]]) {
    const f=fixture(pages);await assert.rejects(readKnowledgeDocumentComments(url,{profile:'p',runCLI:f.runCLI},signal),{code:'INVALID_RESPONSE'});
  }
});


test('补读回复接受 Drive 的 code/data 回执，错误码不能冒充成功',async()=>{
  const signal=new AbortController().signal;
  for (const code of [0,403]) {
    const runCLI:KnowledgeSourceRunCLI=async argv=>{
      const envelope=argv[1]==='file.comment.replys'
        ? {code,data:{items:[reply],has_more:false}}
        : {ok:true,identity:'user',data:argv[1]==='+inspect' ? inspect : {comments:[{comment_id:'first',is_solved:true}],has_more:false}};
      return {stdout:JSON.stringify(envelope),exitCode:0};
    };
    const pending=readKnowledgeDocumentComments(url,{profile:'fixture-profile',runCLI},signal);
    if (code===0) assert.equal((await pending).threads[0]?.replies[0]?.author,'合成作者');
    else await assert.rejects(pending,{code:'CLI_FAILED'});
  }
});

test('写评论在核实 Wiki 原件和唯一原文段落后过守卫，只发一次且核验返回标识',async()=>{
  const calls:string[][]=[],signal=new AbortController().signal;
  let xml='<doc><p id="blkFixture">原文<strong>段落</strong></p></doc>',result:Record<string,unknown>={comment_id:'thread',reply_id:'reply'};
  const runCLI:KnowledgeSourceRunCLI=async argv=>{
    calls.push([...argv]);const data=argv[1]==='+inspect'?inspect:argv[1]==='+fetch'?{document:{document_id:'DocFixture',content:xml}}:result;
    return {exitCode:0,stdout:JSON.stringify(argv[1]==='file.comments'?{code:0,data}:{ok:true,identity:'user',data})};
  };
  const write=(quote?:string)=>writeKnowledgeDocumentComment(url,{profile:'p',runCLI},signal,{kind:'create',text:'请比较 <A> & B',...(quote && {quote})},async id=>{calls.push(['guard',id]);});
  assert.deepEqual(await write('文段落'),{confirmed:true,threadId:'thread',replyId:'reply'});
  assert.deepEqual(calls.map(a=>a.slice(0,2)),[['drive','+inspect'],['docs','+fetch'],['guard','DocFixture'],['drive','file.comments']]);
  const last=calls.at(-1)!;
  assert.deepEqual(last.slice(0,5),['drive','file.comments','create_v2','--file-token','DocFixture']);
  assert.deepEqual(JSON.parse(last[last.indexOf('--data')+1]!),{file_type:'docx',anchor:{block_id:'blkFixture'},reply_elements:[{type:'text',text:'请比较 &lt;A&gt; &amp; B'}]});
  calls.length=0;
  const long='😀'+'&'.repeat(999)+'<>尾';
  await writeKnowledgeDocumentComment(url,{profile:'p',runCLI},signal,{kind:'create',text:long},async()=>{});
  const argv=calls.at(-1)!,parts=JSON.parse(argv[argv.indexOf('--data')+1]!).reply_elements as {text:string}[];
  assert.ok(parts.every(part=>Array.from(part.text).length<=1000 && !/&(?:a|am|amp|l|lt|g|gt)?$/.test(part.text)));
  assert.equal(parts.map(part=>part.text).join(''),'😀'+'&amp;'.repeat(999)+'&lt;&gt;尾');
  calls.length=0;xml='<p id="one">重复</p><p id="two">重复</p>';
  await assert.rejects(write('重复'),{status:409});assert.deepEqual(calls.map(a=>a[1]),['+inspect','+fetch']);
  calls.length=0;
  await assert.rejects(writeKnowledgeDocumentComment(url,{profile:'p',runCLI},signal,{kind:'create',text:'正文'},async()=>{throw Object.assign(Error('审批失效'),{status:409});}),{status:409});
  assert.deepEqual(calls.map(a=>a[1]),['+inspect']);
  calls.length=0;result={};
  await assert.rejects(write(),{status:502});assert.deepEqual(calls.map(a=>a[0]),['drive','guard','drive']);
});

test('逐项核对评论同文档归属、是否允许回复及解决状态，并拒绝不确定回执',async()=>{
  const signal=new AbortController().signal,calls:string[][]=[];let solved=false,whole=false,threadId='T1',replyId='R1';
  const runCLI:KnowledgeSourceRunCLI=async argv=>{
    calls.push([...argv]);const data=argv[1]==='+inspect'?inspect:argv[2]==='batch_query'?{items:[{comment_id:threadId,is_solved:solved,is_whole:whole}]}:
      argv[2]==='create'?{reply_id:replyId}:{};
    return {exitCode:0,stdout:JSON.stringify(argv[1]==='+inspect'?{ok:true,data}:{code:0,data})};
  };
  const apply=(kind:'reply'|'resolve'|'reopen')=>writeKnowledgeDocumentComment(url,{profile:'p',runCLI},signal,
    kind==='reply'?{kind,threadId:'T1',text:'补充'}:{kind,threadId:'T1'},async id=>{calls.push(['guard',id]);});
  assert.deepEqual(await apply('reply'),{confirmed:true,threadId:'T1',replyId:'R1'});
  assert.ok(calls[3]?.includes('--comment-id'));assert.ok(calls[3]?.includes('T1'));
  assert.deepEqual(await apply('resolve'),{confirmed:true,threadId:'T1'});
  assert.ok(calls.at(-1)?.includes('{"is_solved":true}'));
  solved=true;assert.deepEqual(await apply('reopen'),{confirmed:true,threadId:'T1'});assert.ok(calls.at(-1)?.includes('{"is_solved":false}'));
  for(const props of [{kind:'resolve',solved:true,whole:false,id:'T1'},{kind:'reply',solved:false,whole:true,id:'T1'},
    {kind:'reply',solved:false,whole:false,id:'another'}] as const){
    calls.length=0;solved=props.solved;whole=props.whole;threadId=props.id;
    await assert.rejects(apply(props.kind),{status:409});assert.deepEqual(calls.map(a=>a[2]),['--url','batch_query']);
  }
  threadId='T1';replyId='';calls.length=0;await assert.rejects(apply('reply'),{status:502});
  assert.equal(calls.filter(a=>a[2]==='create').length,1);
});

test('联系人按显式用户 profile 查询，只返回点名所需的字段，公开标识不会与同名候选混淆',async()=>{
  const signal=new AbortController().signal;
  const result=await searchKnowledgeCommentPeople('fixture',' 同名 ',signal,async argv=>{
    assert.deepEqual(argv,['contact','+search-user','--query','同名','--page-size','20','--as','user','--profile','fixture','--format','json']);
    return {ok:true,identity:'user',data:{users:['ou_fixture1','ou_fixture2','ou_fixture1'].map(open_id=>({open_id,localized_name:'同名',department:open_id==='ou_fixture1'?'示例研发部':'',email:'仅测试内部字段'})),has_more:true}};
  });
  assert.deepEqual(result,{people:[{openId:'ou_fixture1',name:'同名',department:'示例研发部'},{openId:'ou_fixture2',name:'同名'}],truncated:true});
  await assert.rejects(searchKnowledgeCommentPeople('fixture','',signal,async()=>assert.fail('空搜索不应出站')),{status:400});
  await assert.rejects(searchKnowledgeCommentPeople('fixture','甲',signal,async()=>({ok:true,identity:'bot',data:{users:[]}})),{status:502});
});

test('评论点名按 UTF-16 位置组成平台元素，允许同人多次，拒绝错位、重叠与伪造类型',async()=>{
  const signal=new AbortController().signal,text='😀<& @甲 / @乙 @甲',profile='p';
  const m1={openId:'ou_fixture1',name:'甲',start:text.indexOf('@甲')},m2={openId:'ou_fixture2',name:'乙',start:text.indexOf('@乙')},
    again={...m1,start:text.lastIndexOf('@甲')};
  const calls:string[][]=[];
  const runCLI:KnowledgeSourceRunCLI=async argv=>{
    calls.push([...argv]);
    if (argv[1]==='+inspect') return {exitCode:0,stdout:JSON.stringify({ok:true,data:inspect})};
    const data=argv[2]==='batch_query'?{items:[{comment_id:'c1',is_whole:false,is_solved:false}]}:{reply_id:'r1',comment_id:'c1'};
    return {exitCode:0,stdout:JSON.stringify({code:0,data})};
  };
  for(const kind of ['create','reply'] as const){
    const mentions=[again,m2,m1],action=kind==='create'?{kind,text,mentions}:{kind,threadId:'c1',text,mentions};
    await writeKnowledgeDocumentComment(url,{profile,runCLI},signal,action,async()=>{});
    const argv=calls.at(-1)!,payload=JSON.parse(argv[argv.indexOf('--data')+1]!);
    const expected=['😀&lt;&amp; ',m1,' / ',m2,' ',again];
    assert.deepEqual(kind==='create'?payload.reply_elements:payload.content.elements,expected.map(e=>typeof e==='string'?
      kind==='create'?{type:'text',text:e}:{type:'text_run',text_run:{text:e}}:kind==='create'?{type:'mention_user',mention_user:e.openId}:{type:'person',person:{user_id:e.openId}}));
  }
  for(const mentions of [[{...m1,start:m1.start-1}],[{...m1,name:'别名'}],[m1,m1],[{...m1,type:'link'}],Array(21).fill(m1)]) {
    await assert.rejects(writeKnowledgeDocumentComment(url,{profile,runCLI},signal,{kind:'create',text,mentions},async()=>assert.fail('无效点名不能进入投递')),{status:400});
  }
  const f=fixture([cliPage([{...thread('c1',false),reply_list:{replies:[{content:{elements:[
    {type:'person',person:{name:'合成乙',user_id:'ou_first'}},{type:'mention',mention_user:{open_id:'ou_fixture'}},{type:'mention'}]}}]}}])]);
  const got=await readKnowledgeDocumentComments(url,{profile,runCLI:f.runCLI},signal);
  assert.equal(got.threads[0]?.replies[0]?.text,'@合成乙@ou_fixture[提及]');
});
