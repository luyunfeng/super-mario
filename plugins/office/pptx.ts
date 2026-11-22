import MarkdownIt, { type Token } from 'markdown-it';
import { imageSize } from 'image-size';
import PptxModule from 'pptxgenjs';

// The package ships a Node ESM constructor and describes its CommonJS default in its types.
const PptxGenJS = PptxModule.default ?? PptxModule;

const markdown = new MarkdownIt({ html: false });
// Parse even local image references so their captions survive. Only embedded image bytes enter PowerPoint.
markdown.validateLink = () => true;
type Line = { kind: 'text' | 'heading' | 'code'; text: string; bullet?: 'dot' | number; depth?: number };
type Picture = { kind: 'picture'; data: string; alt: string; width: number; height: number };
type Table = { kind: 'table'; rows: string[][] };
type Section = { title: string; h1: boolean; body: (Line | Picture | Table)[] };
const limits = { imageBytes: 4 * 1024 * 1024, imagePixels: 32_000_000, pages: 256 };
const width = 13 + 1 / 3, height = 7.5, margin = 0.75, bottom = height - 0.48;
const ink = '23374A', accent = '176F70';

function plain(children: Token[]) {
  return children.map(token => {
    if (token.type === 'image') return token.content || '图片';
    if (token.type === 'softbreak') return ' ';
    if (token.type === 'hardbreak') return '\n';
    return token.content;
  }).join('');
}

function picture(token: Token, budget: { bytes: number; pixels: number }): Picture | undefined {
  const uri = String(token.attrGet('src') ?? '');
  const format = /^data:image\/(png|jpeg|gif);base64,/i.exec(uri)?.[1].toLowerCase();
  if (!format) return;
  const comma = uri.indexOf(',');
  const encoded = uri.slice(comma + 1);
  if (encoded.length > Math.ceil((limits.imageBytes - budget.bytes) / 3) * 4) throw new Error('PPT 内嵌图片累计超过 4 MiB');
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('PPT 内嵌图片的 Base64 无效');
  const bytes = Buffer.from(encoded, 'base64');
  budget.bytes += bytes.length;
  if (budget.bytes > limits.imageBytes) throw new Error('PPT 内嵌图片累计超过 4 MiB');
  let size;
  try { size = imageSize(bytes); } catch { throw new Error('无法读取内嵌图片尺寸'); }
  if (size.type !== (format === 'jpeg' ? 'jpg' : format)) throw new Error('PPT 内嵌图片与声明格式不符');
  if (!size.width || !size.height) throw new Error('内嵌图片尺寸无效');
  budget.pixels += size.width * size.height;
  if (budget.pixels > limits.imagePixels) throw new Error('PPT 内嵌图片累计超过 3200 万像素');
  return { kind: 'picture', data: uri, alt: token.content || '图片', width: size.width, height: size.height };
}

function sections(source: string, images?: ReadonlyMap<string, string>) {
  const tokens = markdown.parse(source, {});
  const explicit = tokens.some(t => t.type === 'hr' && t.level === 0);
  const out: Section[] = [];
  let section: Section = { title: '', h1: false, body: [] };
  const lists: { next: number | 'dot'; first: boolean }[] = [];
  const budget = { bytes: 0, pixels: 0 };
  let table: Table | undefined;
  function cut() {
    if (section.title || section.body.length) out.push(section);
    section = { title: '', h1: false, body: [] };
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'hr': if (token.level === 0) cut(); break;
      case 'heading_open': {
        const title = plain(tokens[++i].children ?? []);
        if (!explicit && token.level === 0 && ['h1', 'h2'].includes(token.tag)) cut();
        if (!section.title) { section.title = title; section.h1 = token.tag === 'h1'; }
        else section.body.push({ kind: 'heading', text: title });
        break;
      }
      case 'ordered_list_open':
      case 'bullet_list_open':
        lists.push({ next: token.tag === 'ol' ? Number(token.attrGet('start') ?? 1) : 'dot', first: false }); break;
      case 'ordered_list_close':
      case 'bullet_list_close': lists.pop(); break;
      case 'list_item_open': lists.at(-1)!.first = true; break;
      case 'table_open': table = { kind: 'table', rows: [] }; section.body.push(table); break;
      case 'tr_open': table!.rows.push([]); break;
      case 'table_close': table = undefined; break;
      case 'fence':
      case 'code_block': section.body.push({ kind: 'code', text: token.content.replace(/\n$/, '') }); break;
      case 'inline': {
        const children = token.children ?? [];
        if (table) { table.rows.at(-1)!.push(plain(children)); break; }
        const list = lists.at(-1);
        let bullet = list?.first ? list.next : undefined;
        if (list?.first) { list.first = false; if (typeof list.next === 'number') list.next++; }
        let segment: Token[] = [];
        function flush() {
          const text = plain(segment).trim();
          if (text) {
            section.body.push({ kind: 'text', text, bullet, depth: Math.max(0, lists.length - 1) });
            bullet = undefined;
          }
          segment = [];
        }
        for (const child of children) {
          if (images && child.type === 'image') {
            const data = images.get(String(child.attrGet('src')));
            if (data) child.attrSet('src', data);
          }
          const image = child.type === 'image' ? picture(child, budget) : undefined;
          if (image) { flush(); section.body.push(image); }
          else segment.push(child);
        }
        flush();
        break;
      }
    }
  }
  cut();
  return out;
}

// Estimate line height in inches, counting CJK characters at full width.
function lines(text: string, inches: number, points: number) {
  const capacity = inches * 72 / points * 0.92;
  return text.split('\n').reduce((sum, line) => {
    let units = 0;
    for (const char of line) units += char.codePointAt(0)! < 128 ? 0.58 : 1;
    return sum + Math.max(1, Math.ceil(units / capacity));
  }, 0);
}

export async function renderPptx(source: string, title: string, images?: ReadonlyMap<string, string>): Promise<{ bytes: Buffer; summary: string }> {
  if (/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(source + title))
    throw new Error('PPT 来源或标题含有无法写入文档的字符');
  const content = sections(source, images);
  if (!content.length) throw new Error('PPT 来源没有可生成的内容');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.title = title || content[0].title;
  deck.author = 'Super Mario';
  deck.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos' };
  let pages = 0, tables = 0;
  function page() {
    if (++pages > limits.pages) throw new Error('PPT 超过 256 页，请拆分源文稿');
    return deck.addSlide();
  }
  for (const [index, section] of content.entries()) {
    let slide = page();
    const bodyWidth = width - 2 * margin;
    const cover = index === 0 && section.h1 && section.body.length <= 2 &&
      section.body.every(block => block.kind === 'text' && block.bullet === undefined && lines(block.text, bodyWidth, 22) <= 3);
    if (cover && lines(section.title, bodyWidth, 42) <= 3) {
      slide.background = { color: '103B45' };
      slide.addText(section.title, { x: margin, y: 1, w: bodyWidth, h: 2.35, valign: 'bottom', margin: 0, fontSize: 42, bold: true, color: 'FFFFFF', objectName: '封面标题' });
      slide.addText((section.body as Line[]).map(block => block.text).join('\n'), { x: margin, y: 3.63, w: bodyWidth, h: 3.1, margin: 0, valign: 'top', color: 'CDE2DF', fontSize: 22, objectName: '封面副标题' });
      continue;
    }

    let y = margin;
    function heading() {
      y = margin;
      if (!section.title) return;
      const titleLines = lines(section.title, bodyWidth, 30);
      if (titleLines > 4) throw new Error('幻灯片标题过长，请缩短标题');
      const h = titleLines * 0.5 + 0.08;
      slide.addText(section.title, { x: margin, y, w: bodyWidth, h, margin: 0, fontSize: 30, bold: true, color: ink, objectName: '页标题' });
      y += h + 0.25;
    }
    heading();
    const top = y;
    function reserve(h: number) {
      if (h > bottom - top + 0.001) throw new Error('单个段落或表格行超出幻灯片，请拆分该内容');
      if (y + h > bottom + 0.001) { slide = page(); heading(); }
    }

    const firstPicture = section.body.find((block): block is Picture => block.kind === 'picture');
    const sidebar = firstPicture && section.body.some(block => block.kind !== 'picture');
    const contentWidth = sidebar ? bodyWidth * 0.60 : bodyWidth;
    function drawPicture(image: Picture, x: number, topY: number, w: number, h: number) {
      const scale = Math.min(w / image.width, h / image.height);
      const imageW = image.width * scale, imageH = image.height * scale;
      slide.addImage({ data: image.data, altText: image.alt, x: x + (w - imageW) / 2, y: topY + (h - imageH) / 2, w: imageW, h: imageH });
    }
    if (sidebar && firstPicture) {
      drawPicture(firstPicture, margin + contentWidth + 0.35, top, bodyWidth - contentWidth - 0.35, bottom - top);
    }
    for (const block of section.body) {
      if (block.kind === 'picture') {
        if (sidebar && block === firstPicture) continue;
        const h = Math.min(bottom - top, contentWidth * block.height / block.width);
        reserve(h);
        drawPicture(block, margin, y, contentWidth, h);
        y += h + 0.18;
      } else if (block.kind === 'table') {
        const [header, ...data] = block.rows;
        tables++;
        const column = contentWidth / header.length;
        const fontSize = column < 1.2 ? 12 : 16;
        if (column < 0.55) throw new Error('PPT 表格列数过多，请拆分表格');
        const rowHeight = (row: string[]) => Math.max(...row.map(cell => lines(cell, column - 0.16, fontSize))) * fontSize / 72 * 1.35 + 0.14;
        const headerH = rowHeight(header);
        for (let row = 0; row < data.length || row === 0;) {
          reserve(headerH + (data[row] ? rowHeight(data[row]) : 0));
          const chunk = [header], heights = [headerH];
          let h = headerH;
          while (row < data.length) {
            const next = rowHeight(data[row]);
            if (y + h + next > bottom + 0.001) break;
            chunk.push(data[row++]); heights.push(next); h += next;
          }
          slide.addTable(chunk.map((cells, r) => cells.map(text => ({ text, options: { bold: r === 0, color: r === 0 ? 'FFFFFF' : ink,
            fill: { color: r === 0 ? accent : r % 2 ? 'F1F7F6' : 'FFFFFF' } } }))), {
            x: margin, y, w: contentWidth, rowH: heights, colW: header.map(() => column), margin: 0.07,
            fontSize, border: { type: 'solid', pt: 0.5, color: 'CCDAD9' }, autoPage: false,
          });
          y += h + 0.18;
          if (!data.length) break;
        }
      } else {
        const indent = Math.min(block.depth ?? 0, 5) * 0.32;
        const available = contentWidth - indent - (block.bullet === undefined ? 0 : 0.35);
        const numbered = typeof block.bullet === 'number' && block.bullet >= 1 && block.bullet <= 32767;
        const text = typeof block.bullet === 'number' && !numbered ? block.bullet + '. ' + block.text : block.text;
        let size = block.kind === 'heading' ? 23 : block.kind === 'code' ? 16 : 21;
        const textHeight = () => lines(text, available, size) * size / 72 * 1.35 + 0.08;
        while (size > 14 && textHeight() > bottom - top) size--;
        const h = textHeight();
        reserve(h);
        const bullet = numbered ? { type: 'number' as const, numberStartAt: Number(block.bullet), indent: 24 }
          : block.bullet === 'dot' ? { indent: 24 } : undefined;
        slide.addText(text, { x: margin + indent, y, w: contentWidth - indent, h, margin: 0, fontSize: size, color: ink,
          bold: block.kind === 'heading', fontFace: block.kind === 'code' ? 'Consolas' : 'Aptos', bullet, valign: 'top' });
        y += h + 0.12;
      }
    }
  }
  const bytes = await deck.write({ outputType: 'nodebuffer', compression: true });
  if (!Buffer.isBuffer(bytes)) throw new Error('PPT 没有生成二进制内容');
  return { bytes, summary: `共 ${pages} 页，${tables} 个表格` };
}
