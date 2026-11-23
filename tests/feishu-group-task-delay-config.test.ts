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

test('调整提醒保留原卡版本，变更身份失效原卡，并支持旧配置和关闭提醒', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-nudge-setting-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const store = createFeishuBotConfig(dir);
  const bot = store.write(undefined, { appId:'cli_example', name:'合成机器人', scope:{ kind:'global' } });
  const path = join(dir,'bots.json');
  const [legacy] = JSON.parse(await readFile(path,'utf8'));
  delete legacy.decisionNudgeMinutes;
  await writeFile(path, JSON.stringify([legacy]));
  const reopened = createFeishuBotConfig(dir);
  assert.equal(reopened.read(bot.id).decisionNudgeMinutes, 60);
  for (const invalid of [-1, 8641, 0.5, '60', null])
    assert.throws(() => reopened.write(bot.id,{ decisionNudgeMinutes: invalid as number }), /整数分钟/);
  const disabled = reopened.write(bot.id,{ decisionNudgeMinutes:0, groupChats:[], collaboration:{peerBotIds:[]} });
  assert.equal(disabled.revision, bot.revision);
  assert.equal(createFeishuBotConfig(dir).read(bot.id).decisionNudgeMinutes, 0);
  const moved = reopened.write(bot.id,{ decisionNudgeMinutes:8640, scope:{kind:'unmarked'} });
  assert.equal(moved.revision, bot.revision+1);
});
