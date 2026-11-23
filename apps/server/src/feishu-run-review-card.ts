import {actionTodoLink,ownerReviewLink} from '../../../packages/core/src/todo-link.ts';
import {cardPlain,cardWebBase} from './feishu-cards.ts';
import type {PendingOwnerReview} from '../../../packages/core/src/run-review.ts';

export function reviewLocation(run:{todoId?:string;projectId?:string},webBase?:string,review?:PendingOwnerReview){
  const base=cardWebBase(webBase);
  if(!base || !run.todoId)return;
  return base+(review ? ownerReviewLink(review).href : actionTodoLink({id:run.todoId,projectId:run.projectId}).webPath);
}

// Use plain text for original evidence, criteria and defects. Action authority lives in
// the server receipt linking this exact platform card, private input and evidence version.
export function runReviewCard(review:PendingOwnerReview,original:string,grant:string,webBase?:string){
  if(Buffer.byteLength(original)>16000)return;
  const block=(s:string)=>({tag:'div',text:cardPlain(s)});
  const callback=(action:string)=>[{type:'callback',value:{kind:'workbench.runReview',runId:review.runId,grant,action}}];
  const url=reviewLocation(review,webBase,review);
  const elements=[
    ...Array.from(original.matchAll(/[\s\S]{1,1000}/gu),m=>block(m[0])),
    block('待办：'+review.title),block('本轮验收标准：'+review.doneWhen),
    {tag:'button',type:'primary',text:cardPlain('验收通过并完成待办'),behaviors:callback('accept'),
      confirm:{title:cardPlain('确认验收通过？'),text:cardPlain('将按本轮证据完成关联待办。')}},
    {tag:'form',name:'review_rework',elements:[
      {tag:'input',name:'defects',input_type:'multiline_text',required:true,max_length:1000,placeholder:cardPlain('说明未达到哪条标准及具体差异')},
      {tag:'button',name:'rework',form_action_type:'submit',text:cardPlain('按缺陷返工'),behaviors:callback('rework'),
        confirm:{title:cardPlain('确认提交返工？'),text:cardPlain('工作台将按填写的缺陷另行派发返工。')}},
    ]},
    ...(url?[{tag:'button',text:cardPlain('在工作台核对'),behaviors:[{type:'open_url',default_url:url}]}]:[]),
  ];
  const card={schema:'2.0',header:{title:cardPlain('执行结果 · 等待主人验收'),template:'orange'},body:{elements}};
  return Buffer.byteLength(JSON.stringify(card))<=24000?card:undefined;
}
