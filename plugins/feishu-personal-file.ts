import {mkdir,mkdtemp,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readChatFileText} from './chat-file-text.ts';
import {personalProblem,runPersonalCLI,type PersonalAccount,type PersonalCLI} from './feishu-personal.ts';
import {createPersonalMessageAccess,fail,personalMessageData,row} from './feishu-personal-message-access.ts';

export function createPersonalFileReader(cli:PersonalCLI=runPersonalCLI) {
  const {locateRaw}=createPersonalMessageAccess(cli);
  return async (account:PersonalAccount,chatId:string,messageId:string,signal:AbortSignal,check:()=>void)=>{
    async function source() {
      check();
      const message=await locateRaw(account,chatId,messageId,signal);
      check();
      if(message.deleted===true) fail('原消息已撤回',410);
      if(message.msg_type!=='file') fail('原消息不是可读取的文件附件',422);
      let body:unknown;
      try {body=JSON.parse(message.body?.content);} catch {fail('无法核实原消息附件');}
      if(!row(body) || typeof body.file_key!=='string' || !/^file_[\w-]{1,240}$/.test(body.file_key) ||
        typeof body.file_name!=='string') fail('无法核实原消息附件');
      const name=body.file_name.split(/[\\/]/).pop()?.replace(/[\p{Cc}\p{Bidi_Control}]/gu,'').trim();
      if(!name || name.length>512) fail('附件名称无效');
      return {key:body.file_key,name};
    }
    const attachment=await source();
    const dir=await mkdtemp(join(tmpdir(),'mario-inbox-file-')).catch(()=>fail('无法准备临时附件目录'));
    const filename='lark-im-resources/attachment.bin',path=join(dir,filename),limit=8*1024*1024;
    try {
      await mkdir(join(dir,'lark-im-resources'),{mode:0o700}).catch(()=>fail('无法准备临时附件目录'));
      check();
      const receipt=personalMessageData(await cli(['--profile',account.profile,'--as','user','im','+messages-resources-download',
        '--message-id',messageId,'--file-key',attachment.key,'--type','file','--output',filename],
        {cwd:dir,maxFileBytes:limit,signal,timeout:60000}).catch(error=>{
          signal.throwIfAborted();
          const problem=personalProblem(error);
          if(problem && ['permissions','denied','expired'].includes(problem.kind)) fail(problem.message,403);
          fail('附件下载失败或超过 8 MiB 上限');
        }));
      check();
      const stat=await lstat(path).catch(()=>fail('下载未生成可读取的附件'));
      if(!stat.isFile() || stat.nlink!==1 || stat.size>limit || (receipt.size_bytes!==undefined && receipt.size_bytes!==stat.size))
        fail('附件大小或下载回执无法核实');
      let result;
      try { result=await readChatFileText(path,{name:attachment.name,mime:'application/octet-stream',bytes:stat.size},signal); }
      catch(error) {
        signal.throwIfAborted();
        const code=(error as {code?:string}).code;
        fail(code==='UNSUPPORTED'?'不支持读取此文件格式':code==='LIMIT_EXCEEDED'?'附件超过解析上限':'附件无法解析为可读正文',422);
      }
      if(!result.text.trim()) fail('附件没有可读取的正文',422);
      const latest=await source();
      if(latest.key!==attachment.key || latest.name!==attachment.name) fail('原消息附件已变化，请重新打开',409);
      const chars=Array.from(result.text);
      return {name:attachment.name,text:chars.slice(0,16000).join(''),truncated:!!result.truncated || chars.length>16000};
    } finally {await rm(dir,{recursive:true,force:true}).catch(()=>fail('临时附件清理失败'));}
  };
}
