// 安全轻量富文本消息渲染器：纯 DOM 节点构建。
import { h } from './dom.js';

function renderInline(line) {
  const parts = [];
  const pattern = /(`[^`\n]+`|\*\*(?:[^*]|\*(?!\*))+?\*\*)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) parts.push(h('code', { class: 'md-inline-code' }, token.slice(1, -1)));
    else parts.push(h('strong', null, token.slice(2, -2)));
    last = match.index + token.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : [line];
}

function makeCodeBlock(lang, codeText) {
  const copyBtn = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm md-code__copy',
    onclick: async () => {
      try {
        await navigator.clipboard?.writeText(codeText);
        copyBtn.textContent = '已复制';
      } catch {
        copyBtn.textContent = '复制失败';
      }
      setTimeout(() => { copyBtn.textContent = '复制代码'; }, 1500);
    },
  }, '复制代码');
  return h('div', { class: 'md-code' },
    h('div', { class: 'md-code__head' }, h('span', { class: 'md-code__lang' }, lang || 'code'), copyBtn),
    h('pre', null, codeText));
}

/** 将纯文本安全渲染为紧凑纯文本或轻量富文本节点。 */
export function renderFormattedText(raw) {
  let text = String(raw ?? '');
  // Only the leading block is a referenced passage. Fenced code and the rest of
  // the message keep their usual rendering, even when they contain > lines.
  const lead = text.match(/^(?: {0,3}>[^\n]*(?:\n|$))+/);
  let quoted;
  if (lead) {
    const passage = lead[0].trimEnd().split('\n').map(line => line.replace(/^ {0,3}> ?/, '')).join('\n');
    if (passage.trim()) {
      const summary = passage.replace(/\s+/g, ' ').trim();
      quoted = h('details', { class: 'message-quote' },
        h('summary', { class: 'message-quote__preview' }, '引用 · ', summary.slice(0, 100), summary.length > 100 && '…'),
        h('p', { class: 'md-p' }, passage));
      text = text.slice(lead[0].length).trimStart();
    }
  }
  const hasMarkdown = text.includes('\n') || text.includes('`') || text.includes('**') || /^\s*(?:[-*]\s|\d+\.\s)/.test(text);
  if (!hasMarkdown) return quoted ? h('div', { class: 'md' }, quoted, text) : text;

  const blocks = quoted ? [quoted] : [];
  let paraLines = [];
  let ulItems = [];
  let olItems = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];

  function flushPara() {
    if (!paraLines.length) return;
    const children = [];
    paraLines.forEach((line, index) => {
      if (index > 0) children.push(h('br'));
      children.push(...renderInline(line));
    });
    blocks.push(h('p', { class: 'md-p' }, children));
    paraLines = [];
  }

  function flushLists() {
    if (ulItems.length) { blocks.push(h('ul', { class: 'md-list' }, ulItems)); ulItems = []; }
    if (olItems.length) { blocks.push(h('ol', { class: 'md-list md-list--num' }, olItems)); olItems = []; }
  }

  for (const line of text.split(/\r?\n/)) {
    if (inCode) {
      if (/^```\s*$/.test(line)) {
        blocks.push(makeCodeBlock(codeLang, codeLines.join('\n')));
        inCode = false;
        codeLang = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^```([^\s`]*)\s*$/);
    if (fence) {
      flushPara();
      flushLists();
      inCode = true;
      codeLang = fence[1];
      codeLines = [];
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushLists();
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (olItems.length) flushLists();
      ulItems.push(h('li', null, renderInline(ul[1])));
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (ulItems.length) flushLists();
      olItems.push(h('li', null, renderInline(ol[1])));
      continue;
    }

    flushLists();
    paraLines.push(line);
  }

  if (inCode) blocks.push(makeCodeBlock(codeLang, codeLines.join('\n')));
  flushPara();
  flushLists();

  return blocks.length ? h('div', { class: 'md' }, blocks) : text;
}
