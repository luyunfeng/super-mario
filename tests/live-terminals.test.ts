import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveTerminalServices } from '../plugins/live-terminals.ts';
import type { JsonObject } from '../packages/protocol/src/index.ts';

const fake = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const dir=process.env.FAKE_LIVE_DIR,args=process.argv.slice(2);
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify(args)+'\\n');
if(args[0]==='pane'&&args[1]==='list')console.log(JSON.stringify({result:{panes:[JSON.parse(fs.readFileSync(path.join(dir,'pane'),'utf8'))]}}));
else if(args[0]==='pane'&&args[1]==='read')console.log('real fixture output\\nnext line');
else if(args.slice(0,2).join(' ')==='terminal session'){
 console.log(JSON.stringify({type:'terminal.frame',seq:5,full:process.env.FAKE_LIVE_BAD!=='1',encoding:'ansi',width:80,height:24,bytes:Buffer.from('live fixture').toString('base64')}));
 readline.createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(path.join(dir,'inputs'),line+'\\n');if(JSON.parse(line).type==='terminal.release')process.exit(0)});
 setInterval(()=>{},1000);
}else process.exit(2);
`;
async function fixture(t: test.TestContext, extra: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-live-'));
  const command = join(dir, 'fake-herdr'); await writeFile(command, fake, { mode: 0o700 });
  const pane = { pane_id: 'w1:p1', terminal_id: 'terminal-original', foreground_cwd: dir, agent: 'codex', agent_status: 'working', terminal_title_stripped: 'Working fixture' };
  const state = () => writeFile(join(dir, 'pane'), JSON.stringify(pane)); await state();
  const service = createLiveTerminalServices({ command, env: { HERDR_ENV: '1', FAKE_LIVE_DIR: dir, ...extra } });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const call = (method: string, params: JsonObject = {}) => service.handlers[`terminal.live.${method}`]!(params, () => {}) as Promise<any>;
  const target = { paneId: pane.pane_id, terminalId: pane.terminal_id, cwd: dir };
  const inputs = async () => { try { return (await readFile(join(dir, 'inputs'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { dir, pane, state, service, call, target, inputs };
}
test('真实子进程协议：项目现场列表与观察帧；未接管不能输入，关闭不发送执行命令', async t => {
  const f = await fixture(t);
  const list = await f.call('list', { cwd: f.dir }); assert.equal(list.panes.length, 1); assert.equal(list.panes[0].state, 'working');
  const lease = await f.call('open', { ...f.target, mode: 'observe' });
  const frames = await f.call('frames', { connectionId: lease.connectionId, after: -1 });
  assert.equal(frames.frames[0].full, true); assert.equal(Buffer.from(frames.frames[0].data, 'base64').toString(), 'live fixture');
  await assert.rejects(f.call('input', { connectionId: lease.connectionId, data: 'YQ==' }), /先明确接管/);
  const recent = await f.call('read', f.target); assert.match(recent.text, /real fixture output/); assert.equal(recent.completeHistory, false);
  await f.call('release', { connectionId: lease.connectionId }); assert.deepEqual(await f.inputs(), []);
  const calls = (await readFile(join(f.dir, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(args => args.join(' ') === 'terminal session observe terminal-original'));
  assert.ok(!calls.some(args => ['run', 'send-text', 'send-keys', 'close'].includes(args[1])));
});
test('显式接管只向绑定的终端流写入一次；停止接管只发送release', async t => {
  const f = await fixture(t); const lease = await f.call('open', { ...f.target, mode: 'control' });
  await assert.rejects(f.call('open', { ...f.target, mode: 'control' }), /另一个工作台窗口/);
  await f.call('input', { connectionId: lease.connectionId, data: Buffer.from('hello\r').toString('base64') });
  await f.call('release', { connectionId: lease.connectionId });
  const inputs = await f.inputs(); assert.equal(inputs.length, 2); assert.equal(Buffer.from(inputs[0].bytes, 'base64').toString(), 'hello\r'); assert.equal(inputs[1].type, 'terminal.release');
  await assert.rejects(f.call('input', { connectionId: lease.connectionId, data: 'YQ==' }), /已断开/);
});
test('pane被替换、目录变化或执行机断线后，旧控制不能向新占用者写入', async t => {
  const f = await fixture(t); const lease = await f.call('open', { ...f.target, mode: 'control' });
  f.pane.terminal_id = 'replacement'; await f.state();
  await assert.rejects(f.call('input', { connectionId: lease.connectionId, data: 'YQ==' }), /退出、替换或切换目录/);
  assert.ok(!(await f.inputs()).some(input => input.type === 'terminal.input'));
  await assert.rejects(f.call('open', { ...f.target, mode: 'observe' }), /退出、替换或切换目录/);
  f.pane.terminal_id = f.target.terminalId; await f.state();
  const next = await f.call('open', { ...f.target, mode: 'observe' }); await f.service.disconnect();
  await assert.rejects(f.call('frames', { connectionId: next.connectionId, after: -1 }), /已断开/);
});
test('Herdr环境缺失、缺少完整帧或非法输入均明确失败', async t => {
  const outside = await fixture(t, { HERDR_ENV: '0' }); await assert.rejects(outside.call('list'), /没有接入/);
  const broken = await fixture(t, { FAKE_LIVE_BAD: '1' }); await assert.rejects(broken.call('open', { ...broken.target, mode: 'observe' }), /中断/);
  const good = await fixture(t); const lease = await good.call('open', { ...good.target, mode: 'control' });
  await assert.rejects(good.call('input', { connectionId: lease.connectionId, data: 'bad base64' }), /格式无效/);
  await good.call('release', { connectionId: lease.connectionId }); assert.ok(!(await good.inputs()).some(item => item.type === 'terminal.input'));
});
