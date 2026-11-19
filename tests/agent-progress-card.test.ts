import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAgentProgressCard } from '../plugins/agent-progress-card.ts';
import type { AgentProgressCard, AgentProgressCardOptions } from '../plugins/agent-progress-card.ts';
import type { ExecutionProgress } from '../packages/protocol/src/execution-progress.ts';
import type { FeishuSendContext } from '../plugins/feishu.ts';

const observation: ExecutionProgress = { phase: 'starting', observedAt: '2026-11-19T16:00:00Z' };
const bodyText = (card: AgentProgressCard) => card.body.elements.map(e => e.text.content).join('\n');

test('all real phases remain in progress, including waiting without any completion evidence', () => {
  const phases = { starting: '正在启动', thinking: '正在分析', tool: '正在调用工具', responding: '正在输出', waiting: '等待后续事件' } as const;
  for (const [phase, label] of Object.entries(phases)) {
    const card = buildAgentProgressCard({ ...observation, phase: phase as ExecutionProgress['phase'] }, { title: '构建测试', status: 'pending' });
    assert.equal(card.body.elements[0].text.content, label);
    assert.notEqual(card.header.template, 'green');
    assert.doesNotMatch(bodyText(card), /执行完成|已结束|已批准/);
  }
});

test('verified success, failure, cancellation, unknown and unspecified ending stay distinct', () => {
  const cases: [AgentProgressCardOptions, string, string][] = [
    [{ title: '测试', status: 'done' }, 'green', '执行完成'],
    [{ title: '测试', status: 'failed', finished: true }, 'red', '执行失败'],
    [{ title: '测试', status: 'cancelled' }, 'orange', '执行已取消'],
    [{ title: '测试', status: 'unknown' }, 'orange', '执行结果未知'],
    [{ title: '测试', finished: true }, 'grey', '执行已结束'],
    // Conservative explicit pending takes precedence over an old finished flag.
    [{ title: '测试', finished: true, status: 'pending' }, 'blue', '正在启动'],
  ];
  for (const [options, color, label] of cases) {
    const card = buildAgentProgressCard({ ...observation, detail: '已公开结果' }, options);
    assert.equal(card.header.template, color);
    assert.equal(card.body.elements[0].text.content, label);
    assert.match(bodyText(card), /已公开结果/);
  }
  const failed = buildAgentProgressCard({ ...observation, phase: 'tool', toolName: 'read_file', detail: '文件不存在' }, { title: '测试', status: 'failed', finished: true });
  assert.match(bodyText(failed), /最后观察阶段：正在调用工具/);
  assert.match(bodyText(failed), /文件不存在/);
});

test('reply subject describes only the reply lifecycle and never declares business execution complete', () => {
  const cases: [AgentProgressCardOptions, string, string][] = [
    [{ title: '', subject: 'reply', status: 'done' }, 'green', '回复完成'],
    [{ title: '', subject: 'reply', status: 'failed', finished: true }, 'red', '回复失败'],
    [{ title: '', subject: 'reply', status: 'cancelled' }, 'orange', '回复已取消'],
    [{ title: '', subject: 'reply', status: 'unknown' }, 'orange', '回复结果未知'],
    [{ title: '', subject: 'reply', finished: true }, 'grey', '本轮回复已结束'],
    [{ title: '', subject: 'reply', finished: true, status: 'pending' }, 'blue', '正在输出'],
  ];
  for (const [options, color, label] of cases) {
    const card = buildAgentProgressCard({ ...observation, phase: 'responding' }, options);
    assert.equal(card.header.title.content, 'Agent 回复进度');
    assert.equal(card.header.template, color);
    assert.equal(card.body.elements[0].text.content, label);
    assert.doesNotMatch(bodyText(card), /执行完成|任务完成|任务已完成|执行已结束/);
  }
});

test('card is an interactive payload compatible with the existing adapter and local Card 2.0 reference', () => {
  const card = buildAgentProgressCard({ ...observation, phase: 'tool', toolName: 'read_file', detail: '正在读取 README' }, { title: '项目检查', text: '已找到操作说明。' });
  const context: FeishuSendContext = { card, replyTo: 'fake-message' };
  assert.equal(context.card, card);
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.tag, 'plain_text');
  assert.equal(card.header.text_tag_list[0].tag, 'text_tag');
  assert.ok(card.body.elements.every(e => e.tag === 'div' && e.text.tag === 'plain_text'));
  assert.match(bodyText(card), /工具：read_file\n公开摘要：正在读取 README\n已找到操作说明/);
  assert.match(bodyText(card), /2026-11-19T16:00:00Z/);
  const ids = card.body.elements.map(e => e.element_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(id)));
  assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
  assert.equal('msg_type' in card, false);
});

test('snapshots do not mutate inputs, accumulate previous text, infer unseen reasoning or render mentions', () => {
  const progress = Object.freeze({ ...observation, phase: 'thinking' as const,
    systemPrompt: 'PRIVATE_SYSTEM_SENTINEL', reasoning: 'PRIVATE_REASONING_SENTINEL',
    toolArguments: { secret: 'PRIVATE_ARGS_SENTINEL' } });
  const options = Object.freeze({ title: '检查', text: '<at id=all></at> **原样正文**' });
  const first = buildAgentProgressCard(progress, options);
  const second = buildAgentProgressCard(progress, { title: '检查', text: '新的可见回复' });
  assert.match(bodyText(first), /<at id=all><\/at> \*\*原样正文\*\*/);
  assert.ok(first.body.elements.every(e => e.text.tag === 'plain_text'));
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_.*_SENTINEL/);
  assert.doesNotMatch(bodyText(second), /原样正文/);
  assert.equal(first.body.elements.some(e => e.element_id === 'progress_detail'), false);
  assert.deepEqual(buildAgentProgressCard(progress, options), first);
});

test('common credentials and terminal control codes are removed from all display fields', () => {
  const secretText = 'token=FAKE_QUERY_TOKEN api_key="FAKE_API_KEY" appSecret:FAKE_APP_SECRET password=FAKE_PASSWORD Authorization: Bearer FAKE_BEARER\n-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_KEY\n-----END PRIVATE KEY-----\n\x1b[31m公开结果\x1b[0m\x00';
  const card = buildAgentProgressCard({ ...observation, toolName: secretText, detail: secretText, observedAt: secretText }, { title: secretText, text: secretText });
  const json = JSON.stringify(card);
  assert.doesNotMatch(json, /FAKE_|\\u001b|\\u0000/);
  assert.match(json, /凭证已隐藏/);
  assert.match(bodyText(card), /公开结果/);
});

test('large unicode and escaping-heavy snapshots are bounded without breaking surrogate pairs', () => {
  for (const char of ['🛠', '中', '"', '\\', '\t']) {
    const large = char.repeat(60_000);
    const card = buildAgentProgressCard({ ...observation, phase: 'tool', toolName: large, detail: large, observedAt: large }, { title: large, text: large, status: 'failed' });
    // Existing send() JSON-encodes the card into content, then encodes the envelope.
    const envelope = JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) });
    assert.ok(Buffer.byteLength(envelope, 'utf8') < 30_000, `wire budget exceeded for ${JSON.stringify(char)}`);
    assert.ok(Array.from(bodyText(card)).every(char => {
      const point = char.codePointAt(0)!;
      return point < 0xd800 || point > 0xdfff;
    }));
    const response = card.body.elements.find(e => e.element_id === 'progress_text');
    if (char !== '\t') assert.ok(response?.text.content.endsWith('…'));
  }
});

test('empty optional data produces a useful minimal card with no invented result', () => {
  const card = buildAgentProgressCard({ ...observation, detail: ' ', toolName: '', observedAt: '' }, { title: '  ', text: '' });
  assert.equal(card.header.title.content, 'Agent 执行进度');
  assert.equal(card.body.elements.length, 2);
  assert.equal(card.body.elements[1].text.content, '观察时间：未知');
});
