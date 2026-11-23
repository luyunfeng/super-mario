// 安全轻量富文本消息渲染器：纯 DOM 节点构建。
import { h } from './dom.js';
import { copyText } from './clipboard.js';
import { toast } from '../ui/overlay.js';

// Workbench citations use explicit routes. External references open outside the workbench.
const inlineTokens = new RegExp([
  /\[查看待决定事项\]\(#inbox\?conversation=[a-f0-9]{64}\)/.source,
  /\[查看待决定事项\]\(#chat\?(?:approval|interaction|plan|mailbox|inbox)=[A-Za-z0-9_-]{1,128}\)/.source,
  /\[核对订阅草案\]\(#memory\?subscriptionDraft=[A-Za-z0-9_-]{1,128}\)/.source,
  /\[确认来源读取\]\(#chat\?approval=[A-Za-z0-9_-]{1,128}\)/.source,
  /\[查看整理记录\]\(#memory\?curator=1&job=[A-Za-z0-9_-]{1,128}\)/.source,
  /\[查看执行\]\(#projects\/[A-Za-z0-9_-]{1,128}\/runs\/[A-Za-z0-9_-]{1,128}\)/.source,
  /\[查看待办\]\(#projects\/[A-Za-z0-9_-]{1,128}\/todos\/detail\/[A-Za-z0-9_-]{1,128}\)/.source,
  /\[查看文件\]\(#projects\/[A-Za-z0-9_-]{1,128}\/workspace\?file=(?:[A-Za-z0-9_.*+\-]|%[0-9A-Fa-f]{2})+\)/.source,
  /\[查看原文\]\(#projects\/[A-Za-z0-9_-]{1,128}\/workspace\?at=(?:[A-Za-z0-9_.*+\-]|%[0-9A-Fa-f]{2})+(?:&version=[a-f0-9]{64})?\)/.source,
  /\[查看原文\]\(#memory\?entry=[A-Za-z0-9_-]{1,128}&source=[A-Za-z0-9_-]{1,128}(?:&line=[1-9][0-9]{0,8})?\)/.source,
  /\[查看修订\]\(#memory\?entry=[A-Za-z0-9_-]{1,128}&revision=(?:[a-f0-9]{40}|[a-f0-9]{64})\)/.source,
  /(?<!!)\[[^\[\]\n]+\]\(https?:\/\/(?:[^\s()<>\\]|\([^\s()<>\\]*\))+\)/.source,
  /<https?:\/\/[^\s<>\\]+>/.source,
  /^https?:\/\/[^\s<>\\]+$/.source,
  /`[^`\n]+`|\*\*(?:[^*]|\*(?!\*))+?\*\*/.source,
].join('|'), 'g');

export function externalSourceLink(href, label) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.origin === location.origin ||
      url.username || url.password) return null;
  return h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer', title: url.href }, label);
}

function renderInline(line) {
  const parts = [];
  let last = 0;
  for (const match of line.matchAll(inlineTokens)) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const href = token.slice(split + 2, -1), label = token.slice(1, split);
      if (href.startsWith('#')) parts.push(h('a', { href }, label));
      else if (label === '核对订阅草案' || label === '确认来源读取' || /^查看(?:文件|原文|修订|待办|执行|整理记录|待决定事项)$/.test(label)) parts.push(token);
      else parts.push(externalSourceLink(href, label) ?? token);
    } else if (token.startsWith('<') || /^https?:/i.test(token)) {
      const href = token.startsWith('<') ? token.slice(1, -1) : token;
      parts.push(externalSourceLink(href, href) ?? token);
    } else if (token.startsWith('`')) parts.push(inlineCode(token.slice(1, -1)));
    else parts.push(h('strong', null, token.slice(2, -2)));
    last = match.index + token.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : [line];
}

function inlineCode(text) {
  return h('button', { type: 'button', class: 'md-inline-code', title: '复制行内代码',
    'aria-label': '复制行内代码 ' + text, onclick: async event => {
      // A drag to select part of the message must leave the clipboard alone.
      if (event.detail && window.getSelection()?.toString()) return;
      try {
        await copyText(text);
        toast('已复制代码。');
      } catch {
        toast('无法写入剪贴板，请选中代码复制。', 'danger');
      }
    } }, h('code', null, text));
}

function makeCodeBlock(lang, codeText) {
  const copyBtn = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm md-code__copy',
    onclick: async () => {
      try {
        await copyText(codeText);
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

// Consume the contiguous leading block and one blank separator. Preserve body
// indentation and any further newlines when reopening a sent message for edits.
export function splitLeadingQuote(text) {
  const lead = text.match(/^(?: {0,3}>[^\r\n]*(?:\r\n|\r|\n|$))+/);
  if (!lead) return null;
  const passage = lead[0].replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/)
    .map(line => line.replace(/^ {0,3}> ?/, '')).join('\n');
  if (!passage.trim()) return null;
  return { passage, body: text.slice(lead[0].length).replace(/^[ \t]*(?:\r\n|\r|\n)/, '') };
}

// Unescaped pipes separate cells. Outer pipes are optional.
function tableCells(line) {
  const chunks = line.trim().match(/(?:\\.|[^|\\]|\\$)+|\|/g) ?? [];
  if (!chunks.includes('|')) return null;
  if (chunks[0] === '|') chunks.shift();
  if (chunks.at(-1) === '|') chunks.pop();
  const cells = [''];
  for (const part of chunks) {
    if (part === '|') cells.push('');
    else cells[cells.length - 1] += part.replace(/\\([|\\])/g, '$1');
  }
  return cells.map(cell => cell.trim());
}

// Quote height changes with the viewport and the user's reading size.
function registerReplyQuotation() {
  if (customElements.get('sm-reply-quotation')) return;
  customElements.define('sm-reply-quotation', class extends HTMLElement {
    connectedCallback() {
      const body = this.querySelector('blockquote');
      const toggle = this.querySelector('button');
      if (!body || !toggle) return;
      const update = () => {
        const line = Number.parseFloat(getComputedStyle(body).lineHeight);
        toggle.hidden = body.scrollHeight <= line * 4 + 1;
      };
      this.observer = new ResizeObserver(update);
      this.observer.observe(body);
      update();
    }
    disconnectedCallback() { this.observer?.disconnect(); }
  });
}

function replyQuotation(lines, streaming) {
  const body = h('blockquote', { class: 'md-p' }, lines.flatMap((line, i) =>
    i ? [h('br'), ...renderInline(line)] : renderInline(line)));
  if (streaming) return h('div', { class: 'message-quote' }, body);
  const toggle = h('button', { type: 'button', hidden: true, class: 'btn btn--ghost btn--sm',
    'aria-expanded': 'false', onclick: () => {
      const open = toggle.getAttribute('aria-expanded') === 'false';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '收起引用' : '展开引用';
      body.classList.toggle('is-folded', !open);
    } }, '展开引用');
  registerReplyQuotation();
  body.classList.add('is-folded');
  return h('sm-reply-quotation', { class: 'message-quote' }, body, toggle);
}

/** 将纯文本安全渲染为紧凑纯文本或轻量富文本节点。 */
export function renderFormattedText(raw, tableAction, { reply = false, streaming = false } = {}) {
  let text = String(raw ?? '');
  let quoted;
  const reference = !reply && splitLeadingQuote(text);
  if (reference) {
    const summary = reference.passage.replace(/\s+/g, ' ').trim();
    quoted = h('details', { class: 'message-quote' },
      h('summary', { class: 'message-quote__preview' }, '引用 · ', summary.slice(0, 100), summary.length > 100 && '…'),
      h('p', { class: 'md-p' }, reference.passage));
    text = reference.body;
  }
  const hasMarkdown = text.includes('\n') || text.includes('`') || text.includes('**') || /https?:\/\//i.test(text) || /\[(?:核对订阅草案|查看(?:文件|原文|修订|待办|执行|整理记录|待决定事项))\]\(/.test(text) || /^ {0,3}(?:#{1,6}(?:\s|$)|>)/.test(text) || /^\s*(?:[-*]\s|\d+\.\s)/.test(text);
  if (!hasMarkdown) return quoted ? h('div', { class: 'md' }, quoted, text) : text;

  const blocks = quoted ? [quoted] : [];
  let paraLines = [];
  let ulItems = [];
  let olItems = [];
  let codeFence = '';
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

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (codeFence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
      if (closing && closing.startsWith(codeFence)) {
        blocks.push(makeCodeBlock(codeLang, codeLines.join('\n')));
        codeFence = '';
        codeLang = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      flushPara();
      flushLists();
      codeFence = fence[1];
      codeLang = fence[2].trim().split(/\s+/)[0];
      codeLines = [];
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushLists();
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/);
    if (heading) {
      flushPara();
      flushLists();
      const title = (heading[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      blocks.push(h('h' + heading[1].length, { class: 'md-heading' }, renderInline(title)));
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      flushPara();
      flushLists();
      const passage = [line];
      while (/^ {0,3}>/.test(lines[index + 1] ?? '')) passage.push(lines[++index]);
      blocks.push(replyQuotation(passage.map(part => part.replace(/^ {0,3}> ?/, '')), streaming));
      continue;
    }

    if (line.includes('|') && /^\s*[:|-]/.test(lines[index + 1] ?? '')) {
      const header = tableCells(line);
      const divider = tableCells(lines[index + 1]);
      if (header && divider?.length === header.length && divider.every(cell => /^:?-+:?$/.test(cell))) {
        flushPara();
        flushLists();
        const row = (cells, tag) => h('tr', null, cells.map((cell, i) => {
          const marker = divider[i];
          const align = marker.endsWith(':') ? (marker.startsWith(':') ? 'center' : 'right') : 'left';
          return h(tag, { style: { textAlign: align } }, renderInline(cell));
        }));
        const body = h('tbody');
        index++;
        while (index + 1 < lines.length) {
          const next = lines[index + 1];
          if (/^ {0,3}(?:`{3,}|~{3,})/.test(next)) break;
          const cells = tableCells(next);
          if (!cells) break;
          body.append(row(cells.slice(0, header.length), 'td'));
          index++;
        }
        const table = h('table', null, h('thead', null, row(header, 'th')), body);
        blocks.push(h('div', { class: 'md-table' }, tableAction?.(table), table));
        continue;
      }
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

  if (codeFence) blocks.push(makeCodeBlock(codeLang, codeLines.join('\n')));
  flushPara();
  flushLists();

  return blocks.length ? h('div', { class: 'md' }, blocks) : text;
}
