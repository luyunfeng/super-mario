import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { imageSize } from 'image-size';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt();
markdown.validateLink = () => true;
const byteLimit = 4 * 1024 * 1024;
const pixelLimit = 32_000_000;
const supported = new Map([['.png', 'png'], ['.jpg', 'jpg'], ['.jpeg', 'jpg'], ['.gif', 'gif']]);

function within(root: string, file: string) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function localPath(src: string) {
  let path: string;
  try { path = decodeURIComponent(src); } catch { return; }
  if (!path || isAbsolute(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || /[\\?#\p{Cc}]/u.test(path)) return;
  if (supported.has(extname(path).toLowerCase())) return path;
}

async function readImage(root: string, path: string, remaining: number) {
  const candidate = resolve(root, path);
  if (!within(root, candidate)) return;
  const resolved = await realpath(candidate);
  if (!within(root, resolved) || !(await stat(resolved)).isFile()) return;
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) return;
    // Verify the open object before reading, including after a parent-directory symlink swap.
    const actual = await realpath(process.platform === 'linux' ? '/proc/self/fd/' + file.fd : candidate);
    if (!within(root, actual)) return;
    const current = await stat(actual);
    if (current.dev !== info.dev || current.ino !== info.ino) return;
    if (info.size > remaining) throw new Error('文档图片累计超过 4 MiB');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) return;
      offset += result.bytesRead;
    }
    if ((await file.stat()).size !== info.size) return;
    return bytes;
  } finally { await file.close(); }
}

/** Resolve CLI Markdown destinations only. Renderers receive bytes encoded as data URIs. */
export async function resolveLocalImages(source: string, sourcePath: string) {
  const root = await realpath(dirname(resolve(sourcePath)));
  const images = new Map<string, string>();
  const seen = new Map<string, { bytes: number; pixels: number }>();
  let count = 0, totalBytes = 0, totalPixels = 0;
  for (const block of markdown.parse(source, {})) {
    for (const token of block.children ?? []) {
      if (token.type !== 'image') continue;
      const src = String(token.attrGet('src') ?? '');
      const path = localPath(src);
      const embedded = /^data:image\/(png|jpeg|gif);base64,/i.exec(src);
      if (!path && !embedded) continue;
      if (++count > 64) throw new Error('文档图片最多 64 张');
      let cost = seen.get(src);
      if (!cost) {
        let bytes: Buffer | undefined;
        if (path) {
          try { bytes = await readImage(root, path, byteLimit - totalBytes); }
          catch (error) {
            if (!(error instanceof Error && 'code' in error)) throw error;
            // Missing, inaccessible or changed sources keep their Markdown captions.
          }
        } else if (embedded) {
          const encoded = src.slice(embedded[0].length);
          if (encoded.length > Math.ceil((byteLimit - totalBytes) / 3) * 4) throw new Error('文档图片累计超过 4 MiB');
          bytes = Buffer.from(encoded, 'base64');
        }
        let pixels = 0;
        if (bytes) {
          const expected = path ? supported.get(extname(path).toLowerCase()) : embedded![1].toLowerCase().replace('jpeg', 'jpg');
          try {
            const { type, width, height } = imageSize(bytes);
            if (type === expected && width > 0 && height > 0) {
              pixels = width * height;
              if (path && pixels <= pixelLimit - totalPixels)
                images.set(src, 'data:image/' + (type === 'jpg' ? 'jpeg' : type) + ';base64,' + bytes.toString('base64'));
            }
          } catch { /* Invalid image bytes retain the caption. */ }
        }
        cost = { bytes: bytes?.length ?? 0, pixels };
        seen.set(src, cost);
      }
      totalBytes += cost.bytes;
      totalPixels += cost.pixels;
      if (totalBytes > byteLimit) throw new Error('文档图片累计超过 4 MiB');
      if (totalPixels > pixelLimit) throw new Error('文档图片累计超过 3200 万像素');
    }
  }
  return images;
}
