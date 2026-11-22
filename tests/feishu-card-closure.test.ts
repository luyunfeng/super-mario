import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuMessageCard, extractExternalLinks } from '../apps/server/src/feishu-cards.ts';

test('extractExternalLinks extracts unique public http/https URLs and skips localhost', () => {
  const text = [
    '入会 https://meet.example.com/j/10001',
    '迁移方案 https://docs.example.com/docx/SampleDoc1。',
    '本地 http://127.0.0.1:48080/test',
    '重复 https://meet.example.com/j/10001',
  ].join('\n');
  const links = extractExternalLinks(text, 2);
  assert.equal(links.length, 2);
  assert.equal(links[0]!.url, 'https://meet.example.com/j/10001');
  assert.equal(links[1]!.url, 'https://docs.example.com/docx/SampleDoc1');
});

test('result card uses green header, reply-to-continue hint and external link buttons', () => {
  const card = buildFeishuMessageCard('完成了\n文档 https://example.com/docs/1', {
    title: 'dev-host-01 · demo-project',
    kind: 'result',
    webBase: 'http://127.0.0.1:48080/',
  }) as { header: { template: string }; elements: Array<{ tag: string; elements?: Array<{ content: string }>; actions?: Array<{ url?: string; text?: { content: string } }> }> };

  assert.equal(card.header.template, 'green');
  const note = card.elements.find(e => e.tag === 'note');
  assert.ok(note && note.elements?.some(el => el.content.includes('直接回复这张卡，就能继续给这个 Agent 派活')));
  const actionUrls = card.elements
    .filter(e => e.tag === 'action')
    .flatMap(e => (e.actions ?? []).map(a => a.url).filter(Boolean));
  assert.ok(actionUrls.includes('https://example.com/docs/1'));
});
