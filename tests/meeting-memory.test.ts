import assert from 'node:assert/strict';
import test from 'node:test';
import type { InboxItem } from '../packages/protocol/src/index.ts';
import { enqueueMeetingMemory, meetingMemorySources } from '../packages/core/src/meeting-memory.ts';

function message(id: string, content: string): InboxItem {
  const source = 'feishu:cli_fixture:ou_owner';
  return { id, source, version: 1, last: id, thread: `feishu:message:${JSON.stringify(['oc_fixture', id])}`,
    origin: { kind: 'direct', chatId: 'oc_fixture', connector: '飞书', meetingMinutes: true },
    title: '测试纪要通知', sender: '测试应用', text: `[${id}] 测试应用: ${content}`, tier: 'fyi', reason: '', updatedAt: '2030-01-01' };
}
function collect(items: InboxItem[]) {
  const jobs: {input: Record<string,unknown>; key: string; id: string}[] = [];
  enqueueMeetingMemory(items, (input, origin) => jobs.push({input, key: origin.sourceKey, id: origin.sourceMessageId}));
  return jobs;
}

test('按文档投放规范链接，去除跟踪参数，跨消息重放使用同一键', () => {
  const first = message('om_a', '[周会](https://team.feishu.cn/docx/Example1?from=chat)。https://team.feishu.cn/wiki/Example2/');
  const repeat = message('om_b', 'https://team.feishu.cn/docx/Example1#part');
  const jobs = collect([first,repeat]);
  assert.deepEqual(jobs.map(job => job.input.url), ['https://team.feishu.cn/docx/Example1','https://team.feishu.cn/wiki/Example2']);
  assert.equal(jobs[0]?.input.title, '周会');
  assert.ok(jobs.every(job => job.input.layer === 'personal' && job.input.text === undefined && job.id === first.id));
  assert.equal(collect([repeat])[0]?.key, jobs[0]?.key);
  assert.notEqual(collect([{...repeat, source:'feishu:cli_fixture:ou_second'}])[0]?.key, jobs[0]?.key);
});

test('保存无文档会议正文，非受信链接仅作为消息文字保存', () => {
  const inline = message('om_c', '本次评审决定保留原接口。');
  const unsupported = message('om_d', '行动项：测试小组明天复核。文档通知 https://redirect.invalid/?url=https://team.feishu.cn/docx/Fake');
  const [a,b] = collect([inline,unsupported]);
  assert.equal(a!.input.text, '本次评审决定保留原接口。');
  assert.equal(b!.input.url, undefined);
  assert.match(String(b!.input.title), /链接未读取/);
  assert.equal(collect([message('om_e','')]).length, 0);
});

test('跨来源、聚合会话和未核实群不触发会议资料投放', () => {
  const row = message('om_f','一条材料');
  assert.deepEqual(collect([
    {...row, source: 'feishu:web:fixture'}, {...row, thread: 'feishu:oc_fixture:main'},
    {...row, origin:{...row.origin!, meetingMinutes: undefined}},
    {...row, origin:{...row.origin!, kind:'group', personalGroupObserved: true}},
  ]), []);
});

test('自定义受信域按精确域名匹配，审批复核与首次入队生成相同来源', () => {
  const item = message('om_custom', 'https://tenant.example/docx/Canonical https://bad.tenant.example/wiki/Rejected');
  const sources = meetingMemorySources(item, ['tenant.example']);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.input.url, 'https://tenant.example/docx/Canonical');
  enqueueMeetingMemory([item], (input, provenance) => assert.deepEqual({ input, provenance }, sources[0]), ['tenant.example']);
});

test('欢迎语、操作提示和只有链接的通知不生成知识', () => {
  const rows = [
    '欢迎使用智能纪要助手！我可以为你总结会议内容。',
    '如何使用：点击查看会议纪要、会议决定或待办事项。',
    '会议已结束。纪要已生成，请打开飞书查看。',
    '会议摘要：[查看详情](https://example.invalid/minutes/XYZ)',
    '文档生成成功 https://redirect.invalid/?url=https://team.feishu.cn/docx/Fake',
    '会议纪要：暂无正文。',
  ].map((text,i) => message('notice' + i, text));
  assert.deepEqual(collect(rows), []);
  const note = message('om_actions', '## 下一步\n- 测试组周五前提交验证结果。');
  assert.equal(collect([note])[0]?.input.text, '## 下一步\n- 测试组周五前提交验证结果。');
});
