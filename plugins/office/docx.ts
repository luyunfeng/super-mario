import MarkdownIt from 'markdown-it';
import { imageSize } from 'image-size';
import {
  AlignmentType, Bookmark, Document, ExternalHyperlink, HeadingLevel, ImageRun, InternalHyperlink, LevelFormat,
  Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
  type IParagraphOptions, type NumberingDefinition, type ParagraphChild,
} from 'docx';

const markdown = new MarkdownIt();
// Parse local image references as image tokens so their captions survive. Writers below allow only supported targets.
markdown.validateLink = () => true;
type Token = ReturnType<typeof markdown.parse>[number];
const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function picture(token: Token): ImageRun | TextRun {
  const label = token.content.trim() || '图片';
  const src = String(token.attrGet('src') ?? '');
  const match = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(src);
  if (match) {
    const data = Buffer.from(match[2], 'base64');
    // Inspect only caller-provided bytes. No path resolution or remote fetching.
    try {
      const { type, width, height } = imageSize(data);
      const expected = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
      if (type === expected && (type === 'png' || type === 'jpg' || type === 'gif') && width > 0 && height > 0
        && data.toString('base64') === match[2]) {
        const scale = Math.min(1, 601 / width, 880 / height);
        return new ImageRun({ type, data, transformation: { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) },
          altText: { title: label, name: label, description: label } });
      }
    } catch { /* Keep the caption if the embedded bytes are not a supported raster image. */ }
  }
  return new TextRun({ text: '［图片：' + label + '］', italics: true });
}

function inline(tokens: Token[], anchors: Map<string, string>, header = false, task = false): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  let bold = 0, italic = 0, strike = 0;
  let link: { target: string; children: ParagraphChild[] } | undefined;
  for (const token of tokens) {
    const target = link?.children ?? children;
    if (token.type === 'link_open') {
      link = { target: String(token.attrGet('href') ?? ''), children: [] };
    } else if (token.type === 'link_close' && link) {
      let anchor: string | undefined;
      if (link.target.startsWith('#')) {
        try { anchor = anchors.get(decodeURIComponent(link.target.slice(1))); } catch { /* Leave a malformed anchor as text. */ }
      }
      if (anchor) children.push(new InternalHyperlink({ anchor, children: link.children }));
      else if (/^(?:https?:\/\/|mailto:)/i.test(link.target)) children.push(new ExternalHyperlink({ link: link.target, children: link.children }));
      else children.push(...link.children);
      link = undefined;
    } else if (token.tag === 'strong') bold += token.nesting;
    else if (token.tag === 'em') italic += token.nesting;
    else if (token.tag === 's') strike += token.nesting;
    else if (token.type === 'image') target.push(picture(token));
    else if (token.type === 'hardbreak') target.push(new TextRun({ break: 1 }));
    else if (token.type === 'text' || token.type === 'softbreak' || token.type === 'code_inline') {
      let text = token.type === 'softbreak' ? ' ' : token.content;
      if (task) { text = text.replace(/^\[([ xX])\](?=\s)/, (_, check) => check === ' ' ? '☐' : '☑'); task = false; }
      target.push(new TextRun({ text, ...(header || bold ? { bold: true } : {}), ...(italic ? { italics: true } : {}),
        ...(strike ? { strike: true } : {}), ...(link ? { style: 'Hyperlink' } : {}),
        ...(token.type === 'code_inline' ? { font: 'Consolas', shading: { fill: 'F1F3F5' } } : {}) }));
    }
  }
  return children;
}

function table(tokens: Token[], anchors: Map<string, string>): Table {
  const rows: TableRow[] = [];
  let cells: TableCell[] = [], header = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'tr_open') cells = [];
    else if (token.type === 'th_open' || token.type === 'td_open') {
      header = token.type === 'th_open';
      const style = token.attrGet('style');
      const alignment = style === 'text-align:right' ? AlignmentType.RIGHT : style === 'text-align:center' ? AlignmentType.CENTER : AlignmentType.LEFT;
      cells.push(new TableCell({ ...(header ? { shading: { fill: 'E8EEF4' } } : {}),
        children: [new Paragraph({ alignment, children: inline(tokens[i + 1]?.children ?? [], anchors, header) })] }));
    } else if (token.type === 'tr_close') rows.push(new TableRow({ children: cells, tableHeader: header }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

export async function renderDocx(source: string, title: string, images?: ReadonlyMap<string, string>): Promise<{ bytes: Buffer; summary: string }> {
  if (!source.trim()) throw new Error('Word 文档内容不能为空');
  // XML 1.0 cannot carry these characters. Reject them before serializing the package.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\p{Cs}]/u.test(source + title)) throw new Error('Word 文档含无效字符');
  const tokens = markdown.parse(source, {});
  // Repeated Markdown references can expand a small source into many copies of the same long image or URL.
  let expandedBytes = 0;
  let elements = tokens.length;
  for (const token of tokens) {
    if (token.type === 'code_block' || token.type === 'fence') elements += token.content.split('\n').length;
    for (const child of token.children ?? []) {
      elements++;
      if (images && child.type === 'image') {
        const data = images.get(String(child.attrGet('src')));
        if (data) child.attrSet('src', data);
      }
      const destination = child.type === 'image' ? child.attrGet('src') : child.type === 'link_open' ? child.attrGet('href') : null;
      if (typeof destination === 'string') expandedBytes += Buffer.byteLength(destination);
      if (expandedBytes > 6 * 1024 * 1024) throw new Error('Word 图片和链接引用展开后过大，请拆分文档');
    }
    if (elements > 50_000) throw new Error('Word 文档元素过多，请拆分文档');
  }
  const anchors = new Map<string, string>(), nextSuffix = new Map<string, number>(), bookmarks = new Map<number, string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const name = (tokens[i + 1]?.children ?? []).map(t => t.content).join('').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/gu, '-');
    let slug = name, suffix = nextSuffix.get(name) ?? 0;
    while (anchors.has(slug)) slug = name + '-' + ++suffix;
    nextSuffix.set(name, suffix);
    const id = 'heading_' + (bookmarks.size + 1);
    bookmarks.set(i, id); anchors.set(slug, id);
  }
  const body: (Paragraph | Table)[] = [], numbering: NumberingDefinition[] = [];
  const lists: { reference: string; level: number; first: boolean }[] = [];
  let quotes = 0, nextPage = false, tables = 0;
  function paragraph(options: IParagraphOptions) {
    const list = lists.at(-1);
    body.push(new Paragraph({
      ...(nextPage ? { pageBreakBefore: true } : {}), ...(quotes ? { style: 'WorkQuote' } : {}),
      ...(list?.first ? { numbering: { reference: list.reference, level: list.level } }
        : list ? { indent: { left: (list.level + 1) * 720 } } : {}), ...options,
    }));
    if (list) list.first = false;
    nextPage = false;
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'heading_open':
      case 'paragraph_open': {
        const index = i, children = inline(tokens[++i]?.children ?? [], anchors, false, lists.at(-1)?.first);
        const bookmark = bookmarks.get(index);
        paragraph(bookmark ? { heading: headings[Number(token.tag.slice(1)) - 1], children: [new Bookmark({ id: bookmark, children })] } : { children });
        break;
      }
      case 'blockquote_open': quotes++; break;
      case 'blockquote_close': quotes--; break;
      case 'hr': nextPage = true; break;
      case 'fence':
      case 'code_block':
        for (const line of token.content.replace(/\n$/, '').split('\n')) paragraph({ style: 'WorkCode', children: [new TextRun(line)] });
        break;
      case 'ordered_list_open':
      case 'bullet_list_open': {
        const level = Math.min(lists.length, 8), reference = 'list-' + numbering.length;
        const ordered = token.type === 'ordered_list_open';
        numbering.push({ reference, levels: [{ level, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? '%' + (level + 1) + '.' : '•', start: Number(token.attrGet('start') ?? 1),
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }] });
        lists.push({ reference, level, first: false });
        break;
      }
      case 'bullet_list_close':
      case 'ordered_list_close': lists.pop(); break;
      case 'list_item_open': lists[lists.length - 1].first = true; break;
      case 'table_open': {
        const start = i;
        while (i < tokens.length && tokens[i].type !== 'table_close') i++;
        if (nextPage) paragraph({});
        body.push(table(tokens.slice(start, i), anchors)); tables++;
        break;
      }
    }
  }
  if (!body.length) throw new Error('Markdown 中没有可生成文档的正文');
  const document = new Document({ title, creator: 'super-mario', numbering: { config: numbering },
    styles: { default: { document: { run: { size: 22 }, paragraph: { spacing: { after: 120 } } } },
      paragraphStyles: [
        { id: 'WorkQuote', name: '引用', basedOn: 'Normal', paragraph: { indent: { left: 480 } }, run: { color: '506272', italics: true } },
        { id: 'WorkCode', name: '代码', basedOn: 'Normal', paragraph: { spacing: { after: 0 }, shading: { fill: 'F1F3F5' } }, run: { font: 'Consolas', size: 20 } },
      ] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { left: 1440, right: 1440, top: 1440, bottom: 1440 } } }, children: body }],
  });
  return { bytes: await Packer.toBuffer(document), summary: `${body.length - tables} 个段落，${bookmarks.size} 个标题，${tables} 个表格` };
}
