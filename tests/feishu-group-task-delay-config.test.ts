import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFeishuBotConfig } from '../plugins/feishu-bot-config.ts';

test('群任务预览时长兼容旧配置，保留零值并拒绝非法值', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-group-delay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bots.json');
  const store = createFeishuBotConfig(dir);
  const global = store.write(undefined, { appId: 'cli_testA', name: '合成机器人', scope: { kind: 'global' } });
  assert.equal(global.groupTaskReportDelayMinutes, 10);
  const [legacy] = JSON.parse(await readFile(path, 'utf8'));
  delete legacy.groupTaskReportDelayMinutes;
  await writeFile(path, JSON.stringify([legacy]));
  const reopened = createFeishuBotConfig(dir);
  assert.equal(reopened.list()[0].groupTaskReportDelayMinutes, 10);
  assert.equal(reopened.write(global.id, { groupTaskReportDelayMinutes: 0 }).groupTaskReportDelayMinutes, 0);
  assert.equal(reopened.write(global.id, { name: '新名称' }).groupTaskReportDelayMinutes, 0);
  assert.equal(createFeishuBotConfig(dir).read(global.id).groupTaskReportDelayMinutes, 0);
  for (const invalid of [-1, 61, 1.5, '10', null, Infinity]) {
    assert.throws(() => reopened.write(global.id, { groupTaskReportDelayMinutes: invalid as number }), /整数分钟/);
  }
  assert.equal(reopened.read(global.id).groupTaskReportDelayMinutes, 0);
  assert.equal(reopened.write(global.id, { groupTaskReportDelayMinutes: 60 }).groupTaskReportDelayMinutes, 60);
  assert.throws(() => reopened.write(global.id, { scope: { kind: 'unmarked' }, groupTaskReportDelayMinutes: 1 }), /全局机器人/);
  assert.equal(reopened.write(global.id, { scope: { kind: 'unmarked' } }).groupTaskReportDelayMinutes, undefined);
  assert.equal(reopened.write(global.id, { scope: { kind: 'global' } }).groupTaskReportDelayMinutes, 10);
});
