import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { ChatFileRef, Message } from '../../protocol/src/index.ts';

type Scope = {conversationId:string; projectId?:string; todoId?:string};
type Ticket = Scope & {uploadId:string;ref:ChatFileRef; expires:number};
const tickets = 'message.file-uploads';
const day = 24*60*60*1000;
export const maxChatFileBytes = 200*1024*1024;
const lastSweep = new WeakMap<Store,number>();
const sha = /^[a-f0-9]{64}$/;
const folder = (dir:string) => join(dir,'chat-files');

function fail(reason:string,status:number):never { throw Object.assign(new Error(reason),{status}); }

// Content names are internal hashes. A caller needs a live ticket for this
// conversation or a previously accepted message to address the bytes.
export async function uploadChatFile(store:Store,dir:string,scope:Scope,name:string,mime:string,source:AsyncIterable<Uint8Array>,guard?:()=>void) {
  guard?.();
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name)>255 ||
      /[/\\\u0000-\u001f\u007f]/u.test(name) || name === '.' || name === '..') fail('文件名无效',400);
  const media = mime.split(';',1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(media) || media.length>127) fail('文件类型无效',400);
  const root = folder(dir);
  await mkdir(root,{recursive:true,mode:0o700});
  sweepChatFiles(store,dir);
  const uploadId = randomUUID(), temp = join(root,'upload-'+uploadId);
  const handle = await open(temp,'wx',0o600);
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of source) {
        guard?.();
        bytes += chunk.byteLength;
        if (bytes>maxChatFileBytes) fail('单个文件最多 200 MiB',413);
        await handle.writeFile(chunk);
        hash.update(chunk);
      }
    } finally { await handle.close(); }
    guard?.();
    const ref = {name,mime:media,bytes,sha256:hash.digest('hex')};
    const path = join(root,ref.sha256);
    // Publish the complete file before its ticket, without yielding between them.
    if (!existsSync(path)) renameSync(temp,path);
    store.put(tickets,uploadId,{...scope,uploadId,ref,expires:Date.now()+day} satisfies Ticket);
    return {uploadId,...ref};
  } finally { await rm(temp,{force:true}); }
}

export function prepareChatFiles(store:Store,value:unknown,scope:Scope):ChatFileRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length>20) fail('每条消息最多可附 20 个文件',400);
  return value.map(item=>{
    if (!item || typeof item.uploadId!=='string' || !/^[a-f0-9-]{36}$/.test(item.uploadId)) fail('文件上传凭据无效',400);
    const ticket = store.get<Ticket>(tickets,item.uploadId);
    if (!ticket || ticket.expires<=Date.now()) fail('文件上传已过期，请重新上传',410);
    if (ticket.conversationId!==scope.conversationId || ticket.projectId!==scope.projectId || ticket.todoId!==scope.todoId)
      fail('文件不属于当前会话',403);
    return ticket.ref;
  });
}

export function readChatFile(store:Store,dir:string,message:Message,index:number) {
  const ref = store.get<Message>('messages',message.id)?.files?.[index];
  if (!ref || !sha.test(ref.sha256)) fail('当前消息中未找到该文件',404);
  const path = join(folder(dir),ref.sha256);
  const stat = lstatSync(path,{throwIfNoEntry:false});
  if (!stat?.isFile() || stat.size!==ref.bytes) fail('消息原文件缺失或大小不符',409);
  return {path,ref};
}

// The caller authorizes the original message. Re-read its immutable references
// rather than accepting filenames, hashes or scope from a draft.
export function issueMessageFileTickets(store:Store,dir:string,message:Message) {
  return store.transaction(()=>{
    const original = store.get<Message>('messages',message.id);
    if (!original || original.conversationId!==message.conversationId ||
        original.projectId!==message.projectId || original.todoId!==message.todoId) fail('原消息范围已变化',409);
    const {conversationId,projectId,todoId} = original;
    const expires = Date.now()+day;
    return (original.files??[]).map((_,index)=>{
      const {ref} = readChatFile(store,dir,original,index);
      const uploadId = randomUUID();
      store.put(tickets,uploadId,{conversationId,projectId,todoId,uploadId,ref,expires} satisfies Ticket);
      return {uploadId,...ref};
    });
  });
}

export function removeChatFileUploads(store:Store,conversationId:string) {
  for (const value of store.list<Ticket>(tickets))
    if (value.conversationId === conversationId) store.remove(tickets,value.uploadId);
}

export function sweepChatFiles(store:Store,dir:string) {
  const now=Date.now(),root=folder(dir);
  if (now-(lastSweep.get(store)??0)<day || !existsSync(root)) return;
  const live=new Set<string>();
  store.transaction(()=>{
    for (const value of store.list<Ticket>(tickets)) {
      if (value.expires<=now) store.remove(tickets,value.uploadId);
      else live.add(value.ref.sha256);
    }
  });
  for (const m of store.list<Message>('messages')) for(const ref of m.files??[]) live.add(ref.sha256);
  for (const name of readdirSync(root)) {
    const path=join(root,name);
    if (sha.test(name) && !live.has(name)) rmSync(path,{force:true});
    if (/^upload-[a-f0-9-]{36}$/.test(name) && now-statSync(path).mtimeMs>day) rmSync(path,{force:true});
  }
  lastSweep.set(store,now);
}
