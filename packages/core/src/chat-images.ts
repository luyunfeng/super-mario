import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { ChatImageInput, ChatImageRef, Message } from '../../protocol/src/index.ts';

const collection = 'message.images';
export const chatImageRequestBytes = 32 * 1024 * 1024;
const maxImageBytes = 3_750_000;
const mimeTypes = new Map([['png','image/png'],['jpg','image/jpeg'],['gif','image/gif'],['webp','image/webp']]);

function fail(reason:string, status=400):never {
  throw Object.assign(new Error(reason),{status});
}

export function prepareChatImages(value:unknown):{images:ChatImageInput[]; refs:ChatImageRef[]} {
  if (value === undefined) return {images:[],refs:[]};
  if (!Array.isArray(value) || value.length > 20) fail('每条消息最多可附 20 张图片');
  const images:ChatImageInput[] = [], refs:ChatImageRef[] = [];
  let encodedBytes = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || typeof raw.mime !== 'string' || typeof raw.data !== 'string' || !raw.data)
      fail('图片须包含格式与 Base64 内容');
    encodedBytes += raw.data.length;
    if (raw.data.length > 4 * Math.ceil(maxImageBytes/3) || encodedBytes > chatImageRequestBytes)
      fail('聊天图片超过大小限制',413);
    const bytes = Buffer.from(raw.data,'base64');
    if (!bytes.length || bytes.toString('base64') !== raw.data) fail('图片内容不是有效的 Base64');
    if (bytes.length > maxImageBytes) fail('聊天图片超过大小限制',413);
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { fail('无法读取图片格式或尺寸'); }
    const mime = mimeTypes.get(dimensions.type ?? '');
    if (!dimensions.width || !dimensions.height || !mime || mime !== raw.mime)
      fail('仅支持与实际内容一致的 PNG、JPEG、GIF 或 WebP 图片');
    images.push({mime,data:raw.data});
    refs.push({mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  return {images,refs};
}

const key = (messageId:string,index:number) => JSON.stringify([messageId,index]);

/** Called in the transaction that accepts the owning message. No cross-conversation blob lookup. */
export function saveChatImages(store:Pick<Store,'put'>,message:Message,images:ChatImageInput[]) {
  images.forEach((image,i)=>store.put(collection,key(message.id,i),image));
}

export function readChatImage(store:Pick<Store,'get'>,message:Message,index:number):ChatImageInput {
  const ref = message.images?.[index];
  if (!ref) fail('当前会话中未找到该图片',404);
  const stored = store.get<ChatImageInput>(collection,key(message.id,index));
  if (!stored || typeof stored.data !== 'string' || stored.mime !== ref.mime) fail('消息图片缺失，请重新发送',409);
  const bytes = Buffer.from(stored.data,'base64');
  if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
    fail('消息图片与发送记录不匹配',409);
  return stored;
}

export function readChatImages(store:Pick<Store,'get'>,message:Message) {
  return (message.images ?? []).map((_,index)=>readChatImage(store,message,index));
}

export function removeChatImages(store:Pick<Store,'remove'>,message:Message) {
  message.images?.forEach((_,index)=>store.remove(collection,key(message.id,index)));
}
