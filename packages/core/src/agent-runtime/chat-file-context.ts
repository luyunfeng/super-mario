import { readChatFile } from '../chat-files.ts';
import type { ChatFileRef, Message } from '../../../protocol/src/index.ts';
import type { Store } from '../../../plugin-sdk/src/index.ts';

export type ChatFileReader = (path:string, ref:ChatFileRef, signal:AbortSignal, forwarded?:boolean) => Promise<{text:string;truncated?:boolean}>;

/** One-turn excerpts. Only include scoped files, in message order, within a single input budget. */
export async function chatFileContext(store: Store, dataDir:string, message:Message, reader:ChatFileReader|undefined, check:()=>void, signal:AbortSignal, forwarded=false) {
  const materials: {name:string;status:string;text?:string}[] = [];
  const timeout = AbortSignal.timeout(30000);
  const parseSignal = AbortSignal.any([signal,timeout]);
  // The trusted Feishu route contains a single, server-formatted transcript bounded in code points.
  let remaining = forwarded ? 60000 : 24000;
  for (const [index,ref] of (message.files ?? []).entries()) {
    check(); signal.throwIfAborted();
    const name = ref.name;
    if (!reader) { materials.push({name,status:'文件解析器不可用，未读取'}); continue; }
    if (timeout.aborted) { materials.push({name,status:'本轮解析已超时，未读取'}); continue; }
    if (!remaining) { materials.push({name,status:'本轮摘录已达上限，未读取'}); continue; }
    try {
      const file = await readChatFile(store,dataDir,message,index);
      check(); signal.throwIfAborted();
      const result = await reader(file.path,file.ref,parseSignal,forwarded);
      const text = forwarded ? Array.from(result.text).slice(0,30000).join('') : result.text.slice(0,Math.min(8000,remaining)).replace(/[\uD800-\uDBFF]$/u,'');
      if (text.trim()) remaining -= text.length;
      const status = !text.trim() ? '没有可读取的正文' : result.truncated || text.length < result.text.length ? '已读取摘录，正文已截断' : '已读取';
      materials.push({name,status,...(text.trim() && {text})});
    } catch (error) {
      check(); signal.throwIfAborted();
      const code = timeout.aborted ? 'TIMEOUT' : (error as {code?:unknown})?.code;
      materials.push({name,status:code === 'UNSUPPORTED' ? '不支持此格式，未读取' : code === 'LIMIT_EXCEEDED' ? '超过解析上限，未读取' : code === 'EMPTY_SOURCE' ? '没有可提取的正文' : code === 'TIMEOUT' ? '解析超时，未读取' : '文件缺失、损坏或无法解析，未取得正文'});
    }
  }
  check(); signal.throwIfAborted();
  return JSON.stringify(materials);
}
