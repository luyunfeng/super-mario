import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { readArchiveText } from './chat-file-text.ts';
import { extractKnowledgeAttachment } from './knowledge-attachment-parser.ts';
import { runPersonalCLI, type PersonalCLI } from './feishu-personal.ts';

const MiB = 1024 * 1024;
type Input = {
  profile: string; rows: { id: string; text: string }[]; task: string; check(): Promise<void>; signal: AbortSignal;
  choose(list: string): Promise<string>;
};
type Image = { type: 'image'; data: string; mimeType: string };
type Candidate = { messageId: string; key: string; name: string; context: string };

function candidates(rows: Input['rows'], notes: string[]) {
  const items: Candidate[] = [];
  const seen = new Set<string>();
  let missing = 0, missingFiles = 0, omitted = 0, clipped = 0;
  for (const { id, text: body } of rows) {
    const text = body.slice(0, 16000);
    if (text.length < body.length) clipped++;
    if (!/^om_[a-zA-Z0-9_-]+$/.test(id)) continue;
    const add = (key: string, label = '') => {
      if (!/^(?:img|file)_[a-zA-Z0-9_-]{1,240}$/.test(key) || seen.has(id + ':' + key)) return;
      if (items.length === 100) {
        const first = items.shift()!;
        seen.delete(first.messageId + ':' + first.key);
        omitted++;
      }
      seen.add(id + ':' + key);
      const name = (label.split(/[\\/]/).pop() ?? '').replace(/[\p{Cc}\p{Bidi_Control}]/gu, '').slice(0, 140) || (key.startsWith('img_') ? '图片' : '附件');
      items.push({ messageId: id, key, name, context: text.slice(0, 180) });
    };
    for (const m of text.matchAll(/\[Image:\s*(img_[\w-]+)\]|!\[[^\]\n]*\]\((img_[\w-]+)\)|\[([^\]\n]+)\]\((file_[\w-]+)\)/gi))
      add(m[1] ?? m[2] ?? m[4], m[3]);
    for (const m of text.matchAll(/<(?:file|image|img|audio|video)\b[^>]{0,2000}>/gi)) {
      const key = /\b(?:key|file_key|image_key)="([^"]+)"/i.exec(m[0])?.[1];
      if (key) add(key, /\bname="([^"]*)"/i.exec(m[0])?.[1]);
      else missingFiles++;
    }
    for (const m of text.matchAll(/"(?:file_key|image_key)"\s*:\s*"((?:file|img)_[\w-]+)"/g))
      add(m[1], /"file_name"\s*:\s*"([^"]+)"/.exec(text)?.[1]);
    if (/\[Image\]|\[图片\]/i.test(text)) missing++;
    if (/\[(?:File|Audio|Video|附件|文件|音频|视频)\]/i.test(text)) missingFiles++;
  }
  if (omitted) notes.push('资源选择清单保留最近 100 项，其余 ' + omitted + ' 项未参与选择。');
  if (clipped) notes.push(clipped + ' 条较长消息仅扫描了前 16000 个字符中的资源标识。');
  if (missingFiles) notes.push(missingFiles + ' 处附件占位符缺少资源标识，未能读取。');
  if (missing) notes.push(missing + ' 条消息只显示图片占位符，未取得图片资源标识。');
  return items;
}

export async function readGroupResources(input: Input, cli: PersonalCLI = runPersonalCLI) {
  const notes: string[] = [], texts: string[] = [], images: Image[] = [];
  const output = { notes, texts, images };
  const all = candidates(input.rows, notes);
  if (!all.length) return output;
  if (input.task.length > 4000) notes.push('资源选择使用了任务开头的 4000 个字符。');
  const check = async () => { input.signal.throwIfAborted(); await input.check(); input.signal.throwIfAborted(); };
  await check();
  let selected: number[];
  try {
    const raw = await input.choose(JSON.stringify({ task: input.task.slice(0, 4000), instruction: '按相关性返回所需资源的整数编号 JSON 数组；没有需要的资源时返回 []。', resources: all.map((x, i) => ({ id: i + 1, name: x.name, context: x.context })) }));
    if (raw.length > 2000) throw Error();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(n => Number.isInteger(n) && n >= 1 && n <= all.length)) throw Error();
    selected = [...new Set<number>(parsed)];
  } catch {
    await check();
    notes.push('资源选择未完成，图片和附件均未读取。');
    return output;
  }
  await check();
  if (selected.length < all.length) notes.push('本轮未选取 ' + (all.length - selected.length) + ' 个附件或图片。');
  if (!selected.length) return output;
  const dir = await mkdtemp(join(tmpdir(), 'mario-feishu-read-'));
  let total = 0, remainingText = 32000;
  try {
    await mkdir(join(dir, 'lark-im-resources'), { mode: 0o700 });
    for (const n of selected) {
      const item = all[n - 1], image = item.key.startsWith('img_');
      const label = '资源 ' + n + '「' + item.name + '」';
      if (image && images.length >= 20) { notes.push(label + ' 未读取，已达到 20 张图片上限。'); continue; }
      const limit = Math.min(50 * MiB, 200 * MiB - total);
      if (!limit) { notes.push('已达到 200 MiB 下载上限，其余资源未读取。'); break; }
      const relative = 'lark-im-resources/' + n + '.bin';
      await check();
      let reportedSize: unknown;
      try {
        const downloaded = await cli(['--profile', input.profile, '--as', 'user', 'im', '+messages-resources-download',
          '--message-id', item.messageId, '--file-key', item.key, '--type', image ? 'image' : 'file', '--output', relative],
        { cwd: dir, maxFileBytes: limit, signal: input.signal, timeout: 60000 });
        reportedSize = downloaded.data?.size_bytes;
      } catch {
        await check();
        // A failed command may have already downloaded part of a file.
        total += limit;
        notes.push(label + ' 下载失败或超过大小限制，未读取。');
        continue;
      }
      await check();
      const handle = await open(join(dir, relative), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
      if (!handle) { notes.push(label + ' 未生成可读取的本地文件，其余资源未下载。'); break; }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) { notes.push(label + ' 文件无效或超过下载上限，其余资源未下载。'); break; }
        total += stat.size;
        if (!stat.size || (reportedSize !== undefined && reportedSize !== stat.size)) throw Error();
        const bytes = await handle.readFile();
        if (bytes.length !== stat.size) throw Error();
        if (image) {
          const { type, width, height } = imageSize(bytes);
          if (!type || !['png', 'jpg', 'gif', 'webp'].includes(type) || !width || !height) throw Error();
          images.push({ type: 'image', data: bytes.toString('base64'), mimeType: type === 'jpg' ? 'image/jpeg' : 'image/' + type });
          texts.push('图片 ' + images.length + ' 对应' + label + '，来源消息 ' + item.messageId + '。');
        } else {
          let text: string;
          if (/\.(pdf|docx)$/i.test(item.name)) text = await extractKnowledgeAttachment({ bytes, name: item.name, signal: input.signal });
          else if (/\.(zip|xlsx)$/i.test(item.name)) text = (await readArchiveText(bytes, /\.xlsx$/i.test(item.name) ? 'xlsx' : 'zip', input.signal)).text;
          else {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw Error();
          }
          if (!text.trim()) throw Error();
          const excerpt = text.slice(0, Math.min(16000, remainingText));
          if (excerpt) texts.push(label + '\n' + excerpt);
          remainingText -= excerpt.length;
          if (text.length > excerpt.length) notes.push(label + ' 正文受到长度限制，部分内容未送入模型。');
        }
      } catch {
        input.signal.throwIfAborted();
        notes.push(label + ' 格式无法解析、正文为空或超过解析限制，未读入内容。');
      } finally { await handle.close(); await rm(join(dir, relative), { force: true }); }
    }
    await check();
    return output;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
