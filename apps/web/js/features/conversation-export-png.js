// Lay out into lines before allocating pixels. Only one bounded page and one
// decoded attachment are live at a time, including when a single reply spans pages.
import { renderFormattedText } from '../lib/markdown.js';

const WIDTH = 390, PAGE_HEIGHT = 2400, PAD = 16, SCALE = 2;
const normal = { size: 14, color: '#233330' };
const meta = { size: 11, color: '#526d65' };
const code = { size: 13, mono: true, color: '#31434b' };
const font = s => (s.bold ? '600 ' : '') + s.size + 'px ' + (s.mono ? 'monospace' : 'system-ui, sans-serif');
const tooLarge = () => new Error('所选内容超过图片导出的容量，请减少消息后再试。');

function inline(node, style, out) {
  if (node.nodeType === Node.TEXT_NODE) { out.push([node.textContent, style]); return; }
  if (node.tagName === 'BR') { out.push(['\n', style]); return; }
  if (node.tagName === 'STRONG') style = { ...style, bold: true };
  if (node.tagName === 'CODE') style = code;
  if (node.tagName === 'A') style = { ...style, color: '#126c61' };
  for (const child of node.childNodes) inline(child, style, out);
}

function paragraphs(text, user) {
  if (!text) return [];
  const doc = user ? text : renderFormattedText(text, undefined, { reply: true, streaming: true });
  if (typeof doc === 'string') return [{ spans: [[doc, normal]] }];
  const result = [];
  function add(node, style, prefix = '', background) {
    const spans = prefix ? [[prefix, style]] : [];
    inline(node, style, spans);
    result.push({ spans, background });
  }
  for (const node of doc.children) {
    if (node.matches('.md-code')) add(node.querySelector('pre'), code, '', '#eef1f3');
    else if (node.matches('ol,ul')) Array.from(node.children).forEach((li, index) =>
      add(li, normal, node.tagName === 'OL' ? (index + 1) + '. ' : '• '));
    else if (node.matches('.md-table')) {
      for (const row of node.querySelectorAll('tr')) {
        const spans = [];
        Array.from(row.children).forEach((cell, i) => {
          if (i) spans.push(['  │  ', meta]);
          inline(cell, { ...normal, bold: cell.tagName === 'TH' }, spans);
        });
        result.push({ spans, background: row.querySelector('th') ? '#e3eeea' : '#f2f6f4' });
      }
    } else if (node.querySelector('blockquote')) add(node.querySelector('blockquote'), normal, '▏', '#edf3ef');
    else if (node.matches('.md-heading')) add(node, { ...normal, size: 17, bold: true });
    else add(node, normal);
  }
  return result;
}

function wrap(ctx, spans, width, background) {
  const lines = [];
  let runs = [], x = 0, height = 20;
  function finish() {
    if (lines.length >= 4000) throw tooLarge();
    lines.push({ runs, height, background }); runs = []; x = 0; height = 20;
  }
  for (const [text, style] of spans) {
    ctx.font = font(style);
    for (const token of text.matchAll(/\n|[^\S\n]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
      if (token[0] === '\n') { finish(); continue; }
      const append = (part, advance) => {
        if (x && x + advance > width) finish();
        const previous = runs.at(-1);
        if (previous && previous.style === style) previous.text += part;
        else runs.push({ x, text: part, style });
        height = Math.max(height, style.size + 8);
        x += advance;
      };
      const advance = ctx.measureText(token[0]).width;
      if (advance <= width) append(token[0], advance);
      else for (const ch of token[0]) append(ch, ctx.measureText(ch).width);
    }
  }
  if (runs.length || !lines.length) finish();
  return lines;
}

async function paintImage(ctx, { api, conversationId, signal }, row, x, y, w) {
  signal?.throwIfAborted();
  const url = '/messages/' + encodeURIComponent(row.id) + '/images/' + row.index +
    '?conversationId=' + encodeURIComponent(conversationId);
  const blob = await api.blob(url, signal);
  signal?.throwIfAborted();
  if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(blob.type) || blob.size > 3750000)
    throw new Error('原图格式或大小不适合导出。');
  const img = new Image(), objectURL = URL.createObjectURL(blob);
  try {
    // Let the browser read dimensions first. Request a full decode only after
    // the pixel budget is known, even for a very small compressed attachment.
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('无法读取原图。'));
      img.src = objectURL;
    });
    signal?.throwIfAborted();
    const { naturalWidth: width, naturalHeight: height } = img;
    if (!width || !height || width * height > 32_000_000) throw new Error('原图分辨率过高，请减少附件。');
    await img.decode();
    signal?.throwIfAborted();
    const ratio = Math.min(w / width, (row.height - 4) / height, 1);
    ctx.drawImage(img, x, y, width * ratio, height * ratio);
  } finally { img.removeAttribute('src'); URL.revokeObjectURL(objectURL); }
}

export async function renderConversationPNGs({ api, conversationId, title, messages, heading = true, dates = true, signal }) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('请选择要导出的消息。');
  if (messages.length > 200 || messages.reduce((n, m) => n + (m.text?.length || 0), 0) > 512 * 1024) throw tooLarge();
  const ruler = document.createElement('canvas').getContext('2d');
  const pages = [];
  let parts = [], height = PAD;
  function finishPage() {
    if (!parts.length) return;
    pages.push({ parts, height: height + PAD });
    if (pages.length > 32) throw tooLarge();
    parts = []; height = PAD;
  }
  function add(rows, user, header = false) {
    const x = user ? 76 : PAD, w = WIDTH - PAD - x;
    const total = rows.reduce((n, r) => n + r.height, 0) + 16;
    if (height > PAD && total <= PAGE_HEIGHT - 2 * PAD && height + total > PAGE_HEIGHT - PAD) finishPage();
    let chunk = [];
    function commit() {
      if (!chunk.length) return;
      const h = chunk.reduce((n, r) => n + r.height, 16);
      parts.push({ rows: chunk, x, w, y: height, h, user, header });
      height += h + 8;
      chunk = [];
    }
    let bottom = height + 16;
    for (const row of rows) {
      if (bottom + row.height > PAGE_HEIGHT - PAD) { commit(); finishPage(); bottom = height + 16; }
      chunk.push(row); bottom += row.height;
    }
    commit();
  }
  if (heading && title) add(wrap(ruler, [[title, { ...normal, size: 19, bold: true }]], WIDTH - 2 * PAD - 16), false, true);
  for (const message of messages) {
    signal?.throwIfAborted();
    const user = message.role === 'user', width = WIDTH - PAD - (user ? 76 : PAD) - 16;
    const at = new Date(message.createdAt);
    const date = dates && Number.isFinite(+at) ? '  ' + at.toLocaleString() : '';
    const rows = wrap(ruler, [[(user ? '你' : '助理') + date, meta]], width);
    for (const p of paragraphs(message.text, user)) rows.push(...wrap(ruler, p.spans, width, p.background));
    for (const image of message.images || []) {
      if (!Number.isSafeInteger(image.index) || image.index < 0) throw new Error('无效的原图索引。');
      rows.push({ id: message.id, index: image.index, height: 156 });
    }
    for (const file of message.files || []) {
      const size = file.bytes < 1024 ? file.bytes + ' B' : Math.ceil(file.bytes / 1024) + ' KB';
      rows.push(...wrap(ruler, [['附件 · ' + file.name + ' · ' + size, meta]], width));
    }
    if (rows.length === 1 && !message.text) rows.push(...wrap(ruler, [['此消息没有可导出的正文或附件', meta]], width));
    add(rows, user);
  }
  finishPage();
  const blobs = [];
  let bytes = 0;
  for (const page of pages) {
    signal?.throwIfAborted();
    const canvas = document.createElement('canvas');
    try {
      canvas.width = WIDTH * SCALE; canvas.height = page.height * SCALE;
      const ctx = canvas.getContext('2d');
      ctx.scale(SCALE, SCALE); ctx.textBaseline = 'top';
      ctx.fillStyle = '#f6f8f6'; ctx.fillRect(0, 0, WIDTH, page.height);
      for (const part of page.parts) {
        if (!part.header) {
          ctx.fillStyle = part.user ? '#dcefe5' : '#ffffff';
          ctx.beginPath(); ctx.roundRect(part.x, part.y, part.w, part.h, 10); ctx.fill();
        }
        let y = part.y + 8;
        const x = part.x + 8, width = part.w - 16;
        for (const row of part.rows) {
          if (row.runs) {
            if (row.background) { ctx.fillStyle = row.background; ctx.fillRect(x - 2, y, width + 4, row.height); }
            for (const run of row.runs) {
              ctx.font = font(run.style); ctx.fillStyle = run.style.color;
              ctx.fillText(run.text, x + run.x, y + 2);
            }
          } else await paintImage(ctx, { api, conversationId, signal }, row, x, y, width);
          y += row.height;
        }
      }
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      signal?.throwIfAborted();
      if (!blob) throw new Error('浏览器未能生成 PNG。');
      bytes += blob.size;
      if (bytes > 64 * 1024 * 1024) throw tooLarge();
      blobs.push(blob);
    } finally { canvas.width = canvas.height = 1; }
  }
  return blobs;
}
