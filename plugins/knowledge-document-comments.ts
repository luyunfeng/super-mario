import {SaxesParser} from 'saxes';

export type KnowledgeDocumentCommentAction={kind:'create';text:string;quote?:string}|{kind:'reply';threadId:string;text:string}|{kind:'resolve'|'reopen';threadId:string};
export type KnowledgeDocumentCommentReceipt={confirmed:true;threadId?:string;replyId?:string};

type Invoke=(args:string[])=>Promise<Record<string,unknown>>;
export class CommentWriteError extends Error {readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
function invalid(status:number,message:string):never {throw new CommentWriteError(status,message);}
function identifier(v:unknown):v is string {return typeof v==='string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$/.test(v);}
function obj(v:unknown):v is Record<string,unknown>{return !!v && typeof v==='object' && !Array.isArray(v);}
function text(v:unknown,limit:number) {
  if (typeof v!=='string' || !v.trim() || Array.from(v).length>limit || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\p{Cs}]/u.test(v))
    invalid(400,'评论正文或引用格式无效');
  return v;
}
function blockForQuote(xml:string,quote:string) {
  // Only the visible text of a single identified paragraph/heading can anchor a comment.
  const parser=new SaxesParser({fragment:true}),matches:string[]=[];
  let block:{id:string;parts:string[];depth:number}|undefined,depth=0;
  parser.on('doctype',()=>invalid(409,'原文结构不支持定位'));
  parser.on('opentag',tag=>{
    depth++;
    if (/^(?:p|h[1-9]|li)$/.test(tag.name) && identifier(tag.attributes.id)) {
      if (block) invalid(409,'原文段落嵌套，无法唯一定位');
      block={id:tag.attributes.id,parts:[],depth};
    }
  });
  const add=(s:string)=>{block?.parts.push(s);};
  parser.on('text',add);parser.on('cdata',add);
  parser.on('closetag',()=>{
    if (block?.depth===depth) {
      const content=block.parts.join(''),first=content.indexOf(quote);
      if (first>=0) {
        if (content.indexOf(quote,first+1)>=0 || matches.length) invalid(409,'引用在原文中出现多次，请重新选择');
        matches.push(block.id);
      }
      block=undefined;
    }
    depth--;
  });
  try {parser.write(xml).close();} catch(error) {
    if ((error as {status?:number}).status===409) throw error;
    invalid(409,'原文结构不可核实，请重新选择');
  }
  return matches[0]??invalid(409,'没有找到与引用相符的原文段落');
}
export async function performCommentWrite(id:string,action:KnowledgeDocumentCommentAction,invoke:Invoke,beforeWrite:(id:string)=>Promise<void>):Promise<KnowledgeDocumentCommentReceipt> {
  if (!obj(action) || !['create','reply','resolve','reopen'].includes(action.kind)) invalid(400,'评论操作无效');
  const allowed=action.kind==='create'?['kind','text','quote']:action.kind==='reply'?['kind','text','threadId']:['kind','threadId'];
  if (Object.keys(action).some(k=>!allowed.includes(k))) invalid(400,'评论操作参数无效');
  const kind=action.kind,thread=action.kind==='create'?undefined:action.threadId;
  if (kind!=='create' && !identifier(thread)) invalid(400,'评论线程标识无效');
  const flags=['--file-token',id,'--file-type','docx'];
  const elements:string[]=[];
  if ('text' in action) {
    // The create_v2 API limits each text element to 1000 characters.
    let current='',length=0;
    for (const char of text(action.text,4000)) {
      const escaped=char==='&'?'&amp;':char==='<'?'&lt;':char==='>'?'&gt;':char;
      const size=escaped===char?1:escaped.length;
      if (length+size>1000) {elements.push(current);current='';length=0;}
      current+=escaped;length+=size;
    }
    if (current) elements.push(current);
  }
  let args:string[];
  if (action.kind==='create') {
    let blockId:string|undefined;
    if (action.quote!==undefined) {
      const quote=text(action.quote,1000);
      const result=await invoke(['docs','+fetch','--doc',id,'--doc-format','xml','--detail','with-ids']);
      if (!obj(result.document) || result.document.document_id!==id || typeof result.document.content!=='string' ||
          result.has_more===true || result.document.has_more===true) invalid(409,'无法核实当前文档的原文段落');
      blockId=blockForQuote(result.document.content,quote);
    }
    args=['drive','file.comments','create_v2','--file-token',id,'--data',JSON.stringify({file_type:'docx',
      ...(blockId && {anchor:{block_id:blockId}}),reply_elements:elements.map(text=>({type:'text',text}))})];
  } else {
    const state=await invoke(['drive','file.comments','batch_query',...flags,'--data',JSON.stringify({comment_ids:[thread]})]);
    const item=Array.isArray(state.items) && state.items.length===1 && state.items[0];
    if (!obj(item) || item.comment_id!==thread || typeof item.is_solved!=='boolean' ||
        (state.file_token!==undefined && state.file_token!==id) || (state.file_type!==undefined && state.file_type!=='docx'))
      invalid(409,'无法核对原文档的评论线程');
    if (item.is_solved!==(kind==='reopen') || (kind==='reply' && item.is_whole!==false)) invalid(409,'评论状态已改变，或该评论不支持回复');
    args=kind==='reply'?['drive','file.comment.replys','create',...flags,'--comment-id',thread!,
      '--data',JSON.stringify({content:{elements:elements.map(text=>({type:'text_run',text_run:{text}}))}})] :
      ['drive','file.comments','patch',...flags,'--comment-id',thread!,'--data',JSON.stringify({is_solved:kind==='resolve'})];
  }
  await beforeWrite(id);
  const receipt=await invoke(args);
  if ((receipt.file_token!==undefined && receipt.file_token!==id) ||
      (receipt.comment_id!==undefined && thread!==undefined && receipt.comment_id!==thread)) invalid(502,'评论投递回执不匹配');
  if ((kind==='resolve' || kind==='reopen') && receipt.is_solved!==undefined && receipt.is_solved!==(kind==='resolve'))
    invalid(502,'评论状态回执不匹配');
  if (kind==='create' && !identifier(receipt.comment_id) || kind==='reply' && !identifier(receipt.reply_id)) invalid(502,'评论投递回执不完整');
  return {confirmed:true,...(thread || identifier(receipt.comment_id) ? {threadId:thread??String(receipt.comment_id)} : {}),
    ...(identifier(receipt.reply_id) && {replyId:receipt.reply_id})};
}
