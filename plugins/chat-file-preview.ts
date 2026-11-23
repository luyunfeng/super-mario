import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ChatFilePreview, ChatFileRef } from '../packages/protocol/src/index.ts';
import { readChatFileText } from './chat-file-text.ts';

const MiB = 1024*1024;
async function boundedBytes(path:string,ref:ChatFileRef,limit:number,signal:AbortSignal) {
  if(ref.bytes<1 || ref.bytes>limit) throw Error();
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if (!stat.isFile() || stat.size!==ref.bytes) throw Error();
    const bytes=Buffer.alloc(ref.bytes);
    for(let offset=0;offset<bytes.length;){
      signal.throwIfAborted();
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      if (!bytesRead) throw Error();
      offset+=bytesRead;
    }
    return bytes;
  } finally {await handle.close();}
}

function render(bytes:Buffer,kind:string,signal:AbortSignal):Promise<ChatFilePreview> {
  signal.throwIfAborted();
  const ext=import.meta.url.endsWith('.ts')?'ts':'js';
  const worker=new Worker(new URL('./chat-file-preview-worker.'+ext,import.meta.url),{
    workerData:{bytes:new Uint8Array(bytes),kind},execArgv:[],stdout:true,stderr:true,
    resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:16,stackSizeMb:4},
  });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(value?:ChatFilePreview)=>{
      if(settled) return; settled=true;
      clearTimeout(timer);signal.removeEventListener('abort',abort);
      void worker.terminate().catch(()=>{}).then(()=>{
        if(signal.aborted) reject(signal.reason);
        else resolve(value??{});
      });
    };
    const abort=()=>finish();
    const timer=setTimeout(abort,10000);
    worker.once('message',finish);
    worker.once('error',abort);
    worker.once('exit',abort);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted) abort();
  });
}

// A deliberately small RTF subset. Groups with binary data, fields, hidden text,
// foreign code pages or unrecognised control words go to an explicit unavailable state.
function simpleRtf(bytes:Buffer):ChatFilePreview|undefined {
  const raw=bytes.toString('latin1');
  if (!/^\{\\rtf1\b/.test(raw) || /[^\x09\x0a\x0d\x20-\x7e]/.test(raw)) return;
  let text='',depth=0,fallback=0;
  const tokens=/\\([a-z]+)(-?\d+)? ?|\\([\\{}])|([{}])|([\s\S])/gy;
  for(let match; (match=tokens.exec(raw));) {
    const [,word,param,literal,brace,char]=match;
    if (word) {
      if (word==='u' && param!==undefined) {const n=Number(param);if(n< -32768 || n>65535)return;text+=String.fromCharCode(n&65535);fallback=1;}
      else if(word==='par'||word==='line') text+='\n';
      else if(word==='tab') text+='\t';
      else if(!['rtf','ansi','b','i','ul','ulnone','plain','pard','fs','f','deff'].includes(word) && !(word==='uc'&&param==='1'))return;
    } else if(brace){
      depth+=brace==='{'?1:-1;
      if(depth<0||depth>64)return;
    } else {
      const value=literal??char;
      if((char==='\\') || (!depth && value.trim()))return;
      if(value==='\n'||value==='\r')continue;
      if(fallback) fallback--; else text+=value;
    }
  }
  if(depth || !text.trim())return;
  return {text:text.trim().slice(0,6000),truncated:text.trim().length>6000,note:'RTF 正文摘录'};
}

export async function readChatFilePreview(path:string,ref:ChatFileRef,signal:AbortSignal):Promise<ChatFilePreview> {
  signal.throwIfAborted();
  const ext=extname(ref.name).toLowerCase();
  const kind=ext==='.pdf'?'pdf': ['.docx','.xlsx','.pptx'].includes(ext)?'office':['.pages','.numbers','.key'].includes(ext)?'iwork':undefined;
  if(ext==='.rtf'){
    const unavailable={note:'此 RTF 暂无可核验的纯文字预览，可下载原文件。'};
    try {const bytes=await boundedBytes(path,ref,256*1024,signal);signal.throwIfAborted();return simpleRtf(bytes)??unavailable;}
    catch {signal.throwIfAborted();return unavailable;}
  }
  if(kind){
    try {
      const bytes=await boundedBytes(path,ref,kind==='pdf'?4*MiB:12*MiB,signal);
      const preview=await render(bytes,kind==='office' ? ext : kind,signal);
      signal.throwIfAborted();
      if(preview.thumbnail || preview.text) return preview;
    } catch {signal.throwIfAborted();}
    if(kind==='iwork') return {note:'包内没有可读取的预览图或文档段落，可下载原文件。'};
  }
  try {
    const result=await readChatFileText(path,ref,signal);
    signal.throwIfAborted();
    if(result.text.trim()) return {text:result.text.slice(0,6000),truncated:!!result.truncated||result.text.length>6000,
      ...(kind && {note:kind==='pdf'?'未取得 PDF 首页图，以下为真实文字摘录。':'包内未取得预览图，以下为真实文字摘录。'})};
  } catch {signal.throwIfAborted();}
  return {note:'当前没有可读取的预览，可下载原文件。'};
}
