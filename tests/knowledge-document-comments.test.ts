import assert from 'node:assert/strict';
import test from 'node:test';
import {isKnowledgeDocumentCommentsURL,readKnowledgeDocumentComments} from '../plugins/knowledge-source-reader.ts';
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
  assert.deepEqual(result,{truncated:true,threads:['one','two'].map((id,i)=>({id,quote:'原文范围',resolved:i===1,replies:Array(i===1?20:1).fill({author:'合成作者',text:'第一段[提及]请确认'})}))});
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
  assert.deepEqual(await readKnowledgeDocumentComments(url,{profile:'p',runCLI:empty.runCLI},signal),{threads:[],truncated:false});
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
  assert.deepEqual(await readKnowledgeDocumentComments(url,{profile:'p',runCLI:withoutIdentity},signal),{threads:[],truncated:false});
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
