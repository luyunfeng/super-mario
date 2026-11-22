import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';
import { SaxesParser, type SaxesTagNS } from 'saxes';

const MiB = 1024 * 1024;
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const ns = 'http://schemas.openxmlformats.org/';
const strict = 'http://purl.oclc.org/ooxml/';
const mainTypes = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
} as const;
type XmlEvents = {
  open?: (tag: SaxesTagNS, parent?: SaxesTagNS) => void;
  close?: (tag: SaxesTagNS) => void;
  text?: (text: string, tag: SaxesTagNS) => void;
};
type Scan = (part: string, root: string, namespace: string, events: XmlEvents) => Promise<void>;
type Relation = { type: string; target: string; external: boolean };

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
function namespace(uri: string, kind: string) {
  return kind.startsWith('http:') ? uri === kind : uri === ns + kind + '/2006/main' || uri === strict + kind + '/main';
}
function attr(tag: SaxesTagNS, name: string, uri = '') {
  return Object.values(tag.attributes).find(a => a.local === name && a.uri === uri)?.value ?? '';
}
function rid(tag: SaxesTagNS) {
  return attr(tag, 'id', ns + 'officeDocument/2006/relationships') || attr(tag, 'id', strict + 'officeDocument/relationships');
}
function isRelation(rel: Relation, name: string) {
  return rel.type === ns + 'officeDocument/2006/relationships/' + name || rel.type === strict + 'officeDocument/relationships/' + name;
}
function target(owner: string, rel?: Relation) {
  if (!rel || rel.external || !rel.target || /[\\?#\u0000-\u001f]/.test(rel.target) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(rel.target))
    invalid('Office 文件缺少有效的包内关系');
  const part = posix.normalize(rel.target.startsWith('/') ? rel.target.slice(1) : posix.join(posix.dirname(owner), rel.target));
  if (part === '..' || part.startsWith('../') || posix.isAbsolute(part)) invalid('Office 包内关系超出目录');
  return part;
}
function display(value: string) {
  return Array.from(value.replace(/[\p{Cc}\p{Bidi_Control}\s]+/gu, ' ').trim()).slice(0, 80).join('');
}

function xmlScanner(zip: ZipFile, entries: Map<string, Entry>): Scan {
  let inspected = 0;
  return async (part, root, kind, events) => {
    const entry = entries.get(part);
    if (!entry) invalid('Office 文件缺少所需 XML 部件');
    if (entry.uncompressedSize > 12 * MiB || (inspected += entry.uncompressedSize) > 64 * MiB) invalid('Office XML 大小超过限制');
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > entry.uncompressedSize) invalid('Office XML 解压大小异常');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    if (size !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) invalid('Office XML 校验失败');
    // OOXML uses UTF-8 or UTF-16. Parse namespace-aware SAX events without a DOM or external resource resolver.
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const parser = new SaxesParser({ xmlns: true }), stack: SaxesTagNS[] = [];
    parser.on('doctype', () => invalid('Office XML 不支持 DTD'));
    parser.on('opentag', tag => {
      if (!stack.length && (tag.local !== root || !namespace(tag.uri, kind))) invalid('Office XML 根元素与声明类型不匹配');
      if (stack.length >= 128) invalid('Office XML 嵌套超过限制');
      events.open?.(tag, stack.at(-1)); stack.push(tag);
    });
    parser.on('closetag', tag => { events.close?.(tag); stack.pop(); });
    function text(value: string) { if (stack.length) events.text?.(value, stack[stack.length - 1]); }
    parser.on('text', text); parser.on('cdata', text);
    parser.write(new TextDecoder(encoding, { fatal: true }).decode(bytes)).close();
  };
}

async function relationships(scan: Scan, owner: string) {
  const result = new Map<string, Relation>();
  const path = owner ? posix.join(posix.dirname(owner), '_rels', posix.basename(owner) + '.rels') : '_rels/.rels';
  await scan(path, 'Relationships', packageRels, { open(tag, parent) {
    if (tag.local !== 'Relationship' || tag.uri !== packageRels || parent?.local !== 'Relationships') return;
    const id = attr(tag, 'Id');
    if (!id || result.has(id)) invalid('Office 文件关系标识重复或缺失');
    result.set(id, { type: attr(tag, 'Type'), target: attr(tag, 'Target'), external: attr(tag, 'TargetMode') === 'External' });
  } });
  return result;
}

async function word(scan: Scan, main: string) {
  let paragraphs = 0, tables = 0, pictures = 0, breaks = 0, headings = 0;
  const titles: string[] = [];
  let heading = false, text = '', inBody = false, hasBody = false;
  await scan(main, 'document', 'wordprocessingml', {
    open(tag, parent) {
      if (!namespace(tag.uri, 'wordprocessingml')) return;
      if (tag.local === 'body' && parent?.local === 'document') { inBody = true; hasBody = true; }
      if (!inBody) return;
      if (tag.local === 'p') { paragraphs++; heading = false; text = ''; }
      if (tag.local === 'pStyle') heading = /^(?:heading\s*[1-9]|title)$/i.test(attr(tag, 'val', tag.uri));
      if (tag.local === 'tbl') tables++;
      if (tag.local === 'drawing' || tag.local === 'pict') pictures++;
      if ((tag.local === 'pageBreakBefore' && !['0','false','off'].includes(attr(tag, 'val', tag.uri))) ||
        (tag.local === 'br' && attr(tag, 'type', tag.uri) === 'page')) breaks++;
    },
    text(value, tag) {
      if (heading && text.length < 200 && tag.local === 't' && namespace(tag.uri, 'wordprocessingml')) text += value.slice(0, 200 - text.length);
    },
    close(tag) {
      if (!namespace(tag.uri, 'wordprocessingml')) return;
      if (tag.local === 'p' && heading) { headings++; if (titles.length < 20) titles.push(display(text)); heading = false; }
      if (tag.local === 'body') inBody = false;
    },
  });
  if (!hasBody) invalid('Word 文件缺少正文');
  return `${paragraphs} 个段落，${headings} 个标题，${tables} 个表格，${pictures} 张图片，${breaks} 处显式分页` + (titles.length ? '。标题：' + titles.join('、') : '');
}

async function workbookOrDeck(scan: Scan, main: string, format: 'xlsx' | 'pptx', typeOf: (part: string) => string | undefined) {
  const deck = format === 'pptx', kind = deck ? 'presentationml' : 'spreadsheetml';
  const refs: { id: string; name: string }[] = [];
  await scan(main, deck ? 'presentation' : 'workbook', kind, { open(tag, parent) {
    if (namespace(tag.uri, kind) && tag.local === (deck ? 'sldId' : 'sheet') && parent?.local === (deck ? 'sldIdLst' : 'sheets')) {
      if (refs.length >= 1024) invalid('Office 页数超过检查上限');
      refs.push({ id: rid(tag), name: attr(tag, 'name') });
    }
  } });
  if (!deck && !refs.length) invalid('Excel 文件缺少工作表');
  const rels = refs.length ? await relationships(scan, main) : new Map<string, Relation>();
  let cells = 0, formulas = 0, tables = 0, pictures = 0;
  const seen = new Set<string>(), names: string[] = [];
  for (const ref of refs) {
    const rel = rels.get(ref.id), part = target(main, rel);
    const chartSheet = !deck && rel && isRelation(rel, 'chartsheet');
    const role = deck ? 'slide' : chartSheet ? 'chartsheet' : 'worksheet';
    if (!rel || !isRelation(rel, role) || seen.has(part) || typeOf(part) !== `application/vnd.openxmlformats-officedocument.${kind}.${role}+xml`)
      invalid('Office 页面关系或内容类型无效');
    seen.add(part);
    let inShape = false, titleShape = false, shapeText = '', firstText = '', title = '';
    await scan(part, deck ? 'sld' : role, kind, {
      open(tag) {
        if (namespace(tag.uri, kind)) {
          if (!deck && tag.local === 'c') cells++;
          if (!deck && tag.local === 'f') formulas++;
          if (deck && tag.local === 'pic') pictures++;
          if (deck && tag.local === 'sp') { inShape = true; titleShape = false; shapeText = ''; }
          if (deck && tag.local === 'ph' && ['title','ctrTitle'].includes(attr(tag, 'type'))) titleShape = true;
        }
        if (deck && tag.local === 'tbl' && namespace(tag.uri, 'drawingml')) tables++;
      },
      text(value, tag) {
        if (inShape && tag.local === 't' && namespace(tag.uri, 'drawingml') && shapeText.length < 200) shapeText += value.slice(0, 200 - shapeText.length);
      },
      close(tag) {
        if (deck && tag.local === 'sp' && namespace(tag.uri, kind)) {
          inShape = false;
          const caption = display(shapeText);
          if (!firstText) firstText = caption;
          if (titleShape && !title) title = caption;
        }
      },
    });
    if (names.length < 20) names.push(deck ? title || firstText || '（无标题）' : display(ref.name));
  }
  const summary = deck ? `${refs.length} 页幻灯片，${tables} 个表格，${pictures} 张图片` : `${refs.length} 个工作表，${cells} 个单元格，${formulas} 个公式`;
  return summary + (names.length ? (deck ? '。各页标题或首行：' : '。工作表：') + names.join('、') : '');
}

export async function inspectOffice(bytes: Buffer): Promise<{ format: string; summary: string }> {
  if (!bytes.length || bytes.length > 16 * MiB) invalid('Office 文件须为 1 字节至 16 MiB');
  let zip: ZipFile | undefined;
  try {
    zip = await fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
    if (zip.entryCount > 2048) invalid('Office 文件条目超过 2048');
    const entries = new Map<string, Entry>();
    let expanded = 0;
    for await (const entry of zip.eachEntry()) {
      if (entries.has(entry.fileName) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) invalid('Office 包含重复、加密或不支持的条目');
      if ((expanded += entry.uncompressedSize) > 64 * MiB) invalid('Office 解压总量超过 64 MiB');
      entries.set(entry.fileName, entry);
    }
    const scan = xmlScanner(zip, entries), types = new Map<string, string>(), defaults = new Map<string, string>();
    const typeOf = (part: string) => types.get(part) ?? defaults.get(posix.extname(part).slice(1).toLowerCase());
    await scan('[Content_Types].xml', 'Types', contentTypes, { open(tag, parent) {
      if (tag.uri !== contentTypes || parent?.local !== 'Types') return;
      if (tag.local === 'Default') {
        const extension = attr(tag, 'Extension').toLowerCase();
        if (!extension || defaults.has(extension)) invalid('Office 默认部件类型声明无效');
        defaults.set(extension, attr(tag, 'ContentType')); return;
      }
      if (tag.local !== 'Override') return;
      const path = attr(tag, 'PartName');
      if (!path.startsWith('/') || types.has(path.slice(1))) invalid('Office 部件类型声明无效');
      types.set(path.slice(1), attr(tag, 'ContentType'));
    } });
    const root = await relationships(scan, '');
    const mainLinks = [...root.values()].filter(rel => isRelation(rel, 'officeDocument'));
    if (mainLinks.length !== 1) invalid('Office 文件须有唯一主文档');
    const main = target('', mainLinks[0]);
    const format = (Object.keys(mainTypes) as (keyof typeof mainTypes)[]).find(format => mainTypes[format] === typeOf(main));
    if (!format) invalid('不支持该 Office 内容类型');
    const summary = format === 'docx' ? await word(scan, main) : await workbookOrDeck(scan, main, format, typeOf);
    const core = [...root.values()].find(rel => rel.type === packageRels + '/metadata/core-properties' && !rel.external);
    let title = '';
    if (core) {
      await scan(target('', core), 'coreProperties', 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties', {
        text(value, tag) {
          if (tag.local === 'title' && tag.uri === 'http://purl.org/dc/elements/1.1/' && title.length < 200) title += value.slice(0, 200 - title.length);
        },
      });
    }
    return { format, summary: display(title) ? '《' + display(title) + '》：' + summary : summary };
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error;
    return invalid('Office 文件损坏或 XML 格式无效');
  } finally { zip?.close(); }
}
