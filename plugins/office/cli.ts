import { open, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { officeSourceLimit, renderOffice } from './render.ts';

async function readFileBounded(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('文件类型或大小超出限制');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('读取时文件大小已变化');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

/** Only a completed file is published. An existing destination is always preserved. */
export async function officeCli(args: string[]) {
  const [format, sourcePath, ...flags] = args;
  if (format === 'check' && sourcePath && !flags.length) {
    const { inspectOffice } = await import('./inspect.ts');
    return { file: resolve(sourcePath), ...await inspectOffice(await readFileBounded(sourcePath, 16 * 1024 * 1024)) };
  }
  if (!sourcePath || !['docx', 'pptx', 'xlsx'].includes(format)) throw new Error('用法：super-mario office <docx|pptx|xlsx> <源文件> [-o 输出文件] [--title 标题]');
  const stem = basename(sourcePath, extname(sourcePath));
  let target = join(dirname(sourcePath), stem + '.' + format), title = stem;
  for (let i = 0; i < flags.length; i += 2) {
    if (!flags[i + 1]) throw new Error('参数缺少值');
    if (flags[i] === '-o') target = flags[i + 1];
    else if (flags[i] === '--title') title = flags[i + 1];
    else throw new Error('未知参数：' + flags[i]);
  }
  if (extname(target).toLowerCase() !== '.' + format) throw new Error('输出文件扩展名与格式不符');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(await readFileBounded(sourcePath, officeSourceLimit));
  const images = format === 'xlsx' ? undefined : await (await import('./local-images.ts')).resolveLocalImages(source, sourcePath);
  const { bytes, summary } = await renderOffice(format, source, title, images);
  const temp = join(dirname(target), '.' + randomUUID() + '.tmp');
  const out = await open(temp, 'wx', 0o600);
  try {
    try { await out.writeFile(bytes); } finally { await out.close(); }
    await link(temp, target);
  } finally { await unlink(temp); }
  return { file: resolve(target), bytes: bytes.length, summary };
}
