import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { fromBufferPromise, type Entry } from 'yauzl';
import { SaxesParser } from 'saxes';
import { extractKnowledgeAttachment } from './knowledge-attachment-parser.ts';
import type { ChatFileRef } from '../packages/protocol/src/index.ts';

const MiB = 1024 * 1024;
// Read only selected Office XML or a ZIP directory. Never unpack members to the filesystem.
export async function readArchiveText(bytes: Buffer, kind: 'xlsx'|'pptx'|'zip', signal: AbortSignal) {
  const zip = await fromBufferPromise(bytes, { lazyEntries: true });
  try {
    if (zip.entryCount > 4096) throw Error();
    const entries: Entry[] = [];
    for await (const entry of zip.eachEntry()) entries.push(entry);
    if (kind === 'zip') return {text:'压缩包目录（前 120 项，未解压正文）\n' + entries.slice(0, 120).map(e => e.fileName.slice(0, 200)).join('\n'),truncated:entries.length > 120};
    const strings: string[] = [], lines: string[] = [];
    let expanded = 0, chars = 0, truncated = false;
    const slides = kind === 'pptx';
    const sheets = slides
      ? entries.filter(e => /^ppt\/slides\/slide[0-9]+\.xml$/.test(e.fileName)).sort((a,b) => a.fileName.localeCompare(b.fileName,'en',{numeric:true}))
      : entries.filter(e => /^xl\/worksheets\/[^/]+\.xml$/.test(e.fileName));
    if (!sheets.length) throw Error();
    for (const entry of [...entries.filter(e => !slides && e.fileName === 'xl/sharedStrings.xml'), ...sheets]) {
      signal.throwIfAborted();
      if ((expanded += entry.uncompressedSize) > 12 * MiB) throw Error();
      const stream = await zip.openReadStreamPromise(entry);
      const parser = new SaxesParser({ xmlns: true });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const shared = entry.fileName === 'xl/sharedStrings.xml';
      let cell = '', type = '', value = '', capture = false, inCell = false;
      parser.on('doctype', () => { throw Error(); });
      parser.on('opentag', tag => {
        if (slides ? tag.local === 'p' : (tag.local === 'si' || tag.local === 'c')) {
          inCell = true; value = ''; cell = tag.attributes.r?.value ?? ''; type = tag.attributes.t?.value ?? '';
        }
        capture = inCell && (tag.local === 't' || tag.local === 'v');
      });
      parser.on('text', text => {
        if (!capture) return;
        if (value.length + text.length > 4000) truncated = true;
        value += text.slice(0, 4000 - value.length);
      });
      parser.on('closetag', tag => {
        capture = false;
        if (shared && tag.local === 'si') { strings.push(value); inCell = false; }
        if (!shared && tag.local === (slides ? 'p' : 'c')) {
          inCell = false;
          const actual = type === 's' ? strings[Number(value)] ?? '' : value;
          if (actual && chars < 18000) { lines.push(cell + ' ' + actual); chars += actual.length + cell.length + 1; }
        }
      });
      if (!shared) lines.push(entry.fileName);
      let count = 0;
      try {
        for await (const chunk of stream) {
          signal.throwIfAborted();
          if ((count += chunk.length) > entry.uncompressedSize) throw Error();
          parser.write(decoder.decode(chunk, { stream: true }));
        }
        parser.write(decoder.decode()).close();
      } finally { stream.destroy(); }
      if (chars >= 18000) { truncated = true; break; }
    }
    if (!chars) return {text:'',truncated};
    if (truncated) lines.push(slides ? '幻灯片内容已截断。' : '表格内容已截断。');
    return {text:lines.join('\n'),truncated};
  } finally { zip.close(); }
}

const textExtensions = new Set('txt md markdown csv tsv json jsonl jsonc ndjson yaml yml xml html htm css scss less svg ini conf cfg toml log diff patch js cjs mjs jsx ts tsx vue svelte py rb go rs c h cpp cc hpp cs java kt kts swift php sh bash zsh fish ps1 sql r lua dart scala properties env dockerfile makefile'.split(' '));

/** Use only a host-resolved content path. Parser errors are rendered as controlled statuses by the caller. */
export async function readChatFileText<T extends Pick<ChatFileRef,'name'|'mime'|'bytes'>>(path:string, ref:T, signal:AbortSignal, forwarded=false):Promise<{text:string;truncated?:boolean}> {
  signal.throwIfAborted();
  const ext = extname(ref.name).slice(1).toLowerCase();
  const document = ext === 'pdf' || ext === 'docx';
  const archive = ext === 'xlsx' || ext === 'pptx';
  if (!document && !archive && !textExtensions.has(ext) && !textExtensions.has(ref.name.toLowerCase()) && !ref.mime.startsWith('text/'))
    throw Object.assign(new Error('不支持读取此格式'), {code:'UNSUPPORTED'});
  const limit = document ? MiB : archive ? 8 * MiB : forwarded ? 120000 : 64 * 1024;
  if ((document || archive) && ref.bytes > limit) throw Object.assign(new Error('文件超过解析上限'),{code:'LIMIT_EXCEEDED'});
  const handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== ref.bytes) throw Error('文件内容与登记不符');
    const length = Math.min(limit,stat.size), bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes,offset,length-offset,offset);
      if (!read.bytesRead) throw Error('读取文件不完整');
      offset += read.bytesRead;
    }
    if (document) return {text:await extractKnowledgeAttachment({name:ref.name,bytes,signal})};
    if (archive) return readArchiveText(bytes,ext,signal);
    const truncated = length < stat.size;
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:truncated});
    if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw Error('文件不是 UTF-8 文本');
    return {text,truncated};
  } finally { await handle.close(); }
}
