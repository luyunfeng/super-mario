import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveTerminalServices } from '../plugins/live-terminals.ts';
import type { JsonObject } from '../packages/protocol/src/index.ts';

const fake = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const dir=process.env.FAKE_LIVE_DIR,args=process.argv.slice(2);
const route=path.basename(process.env.HERDR_SOCKET_PATH || 'default.sock','.sock');
const paneFile=path.join(dir,fs.existsSync(path.join(dir,'pane-'+route))?'pane-'+route:'pane');
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify(args)+'\\n');
if(args[0]==='pane'&&args[1]==='list')console.log(JSON.stringify({result:{panes:[JSON.parse(fs.readFileSync(paneFile,'utf8'))]}}));
else if(args.join(' ')==='api snapshot' && fs.existsSync(path.join(dir,'snapshot-'+route)))console.log(fs.readFileSync(path.join(dir,'snapshot-'+route),'utf8'));
else if(args.join(' ')==='session list --json' && fs.existsSync(path.join(dir,'sessions')))console.log(fs.readFileSync(path.join(dir,'sessions'),'utf8'));
else if(args.join(' ')==='session list --json')console.log(JSON.stringify({sessions:[
 {name:'default',running:true,default:true,socket_path:'/fixture/default.sock'},
 {name:'project',running:true,default:false,socket_path:'/fixture/project.sock'},
 {name:'stopped',running:false,default:false,socket_path:'/fixture/stopped.sock'}]}));
else if(args[0]==='session'&&args[1]==='attach'){
 fs.closeSync(fs.openSync('/dev/tty','r'));
 fs.writeFileSync(path.join(dir,'attached'),JSON.stringify({pid:process.pid,session:args[2],pane:process.env.HERDR_PANE_ID,tmux:process.env.TMUX,term:process.env.TERM}));
 process.stdin.setRawMode(true);
 process.stdin.on('data',chunk=>process.stdout.write('typed='+chunk.toString('hex')));
 process.stdout.on('resize',()=>process.stdout.write('size='+process.stdout.columns+'x'+process.stdout.rows));
 process.stdout.write('initial='+process.stdout.columns+'x'+process.stdout.rows);
 if(process.env.FAKE_FULL_LARGE==='1')process.stdout.write('X'.repeat(4*1024*1024)+'END');
 process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});
}else if(args[0]==='pane'&&args[1]==='read')console.log(route+' real fixture output\\nnext line');
else if(args.slice(0,2).join(' ')==='terminal session'){
 console.log(JSON.stringify({type:'terminal.frame',seq:5,full:process.env.FAKE_LIVE_BAD!=='1',encoding:'ansi',width:80,height:24,bytes:(process.env.FAKE_LIVE_OVERSIZED==='1'?Buffer.alloc(800000):Buffer.from('live fixture')).toString('base64')}));
 if(process.env.FAKE_LIVE_LARGE==='1')for(let seq=6;seq<=8;seq++)console.log(JSON.stringify({type:'terminal.frame',seq,full:false,encoding:'ansi',width:80,height:24,bytes:Buffer.alloc(450000,65).toString('base64')}));
 readline.createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(path.join(dir,'input-'+route),line+'\\n');fs.appendFileSync(path.join(dir,'inputs'),line+'\\n');if(JSON.parse(line).type==='terminal.release')process.exit(0)});
 setInterval(()=>{},1000);
}else process.exit(2);
`;
async function fixture(t: test.TestContext, extra: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-live-'));
  const command = join(dir, 'fake-herdr'); await writeFile(command, fake, { mode: 0o700 });
  const pane = { pane_id: 'w1:p1', terminal_id: 'terminal-original', foreground_cwd: dir, agent: 'codex', agent_status: 'working', terminal_title_stripped: 'Working fixture' };
  const state = () => writeFile(join(dir, 'pane'), JSON.stringify(pane)); await state();
  const service = createLiveTerminalServices({ command, env: { HERDR_ENV: '1', HERDR_SESSION: 'default', HERDR_SOCKET_PATH: join(dir, 'default.sock'), FAKE_LIVE_DIR: dir, ...extra } });
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
  const callsBeforeIdle = await readFile(join(f.dir, 'calls'), 'utf8');
  assert.deepEqual((await f.call('frames', { connectionId: lease.connectionId, after: frames.frames[0].seq })).frames, []);
  assert.equal(await readFile(join(f.dir, 'calls'), 'utf8'), callsBeforeIdle);
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

test('大帧积压按RPC上限分批读取，保持序号且不丢数据', async t => {
  const f = await fixture(t, { FAKE_LIVE_LARGE: '1' });
  const lease = await f.call('open', { ...f.target, mode: 'observe' });
  let after = -1; const seqs: number[] = [];
  for (let i = 0; i < 10 && after < 8; i++) {
    const value = await f.call('frames', { connectionId: lease.connectionId, after });
    assert.ok(Buffer.byteLength(JSON.stringify({ type: 'result', id: 'fixture', result: value })) < 1024 * 1024);
    for (const frame of value.frames) { seqs.push(frame.seq); after = frame.seq; }
  }
  assert.deepEqual(seqs, [5, 6, 7, 8]);
});
test('观察期间终端身份或目录变化，旧帧不再交付', async t => {
  const f = await fixture(t);
  const lease = await f.call('open', { ...f.target, mode: 'observe' });
  f.pane.foreground_cwd = tmpdir(); await f.state();
  await assert.rejects(f.call('frames', { connectionId: lease.connectionId, after: -1 }), /退出、替换或切换目录/);
  await assert.rejects(f.call('frames', { connectionId: lease.connectionId, after: -1 }), /已断开/);
});

test('单帧超过RPC预算时关闭观察，不交付超限响应', async t => {
  const f = await fixture(t, { FAKE_LIVE_OVERSIZED: '1' });
  await assert.rejects(f.call('open', { ...f.target, mode: 'observe' }), /中断/);
  assert.deepEqual(await f.inputs(), []);
});

test('项目现场列表包含子文件夹中启动的终端，但排除项目外同级目录', async t => {
  const f = await fixture(t);
  const subDir = join(f.dir, 'sub-a');
  await mkdir(subDir, { recursive: true });
  f.pane.foreground_cwd = subDir;
  await f.state();
  const listed = await f.call('list', { cwd: f.dir });
  assert.equal(listed.panes.length, 1);
  assert.equal(listed.panes[0].cwd, subDir);
  const sibling = await mkdtemp(join(tmpdir(), 'mario-live-sibling-'));
  t.after(() => rm(sibling, { recursive: true, force: true }));
  f.pane.foreground_cwd = sibling;
  await f.state();
  const outside = await f.call('list', { cwd: f.dir });
  assert.equal(outside.panes.length, 0);
});

test('完整客户端按执行机 socket 选会话，终端尺寸、UTF-8 输入和释放均走真实 PTY', async t => {
  const f = await fixture(t, { HERDR_SOCKET_PATH: '/fixture/project.sock', HERDR_PANE_ID: 'fixture-pane', TMUX: 'fixture-tmux' });
  const { sessions } = await f.call('sessions');
  assert.deepEqual(sessions.map((s: any) => [s.name, s.running, s.current]), [
    ['default', true, false], ['project', true, true], ['stopped', false, false],
  ]);
  for (const session of ['missing', 'stopped', '../default']) await assert.rejects(f.call('full.open', { session }), /会话未运行/);
  const { connectionId, session } = await f.call('full.open', { cols: 90, rows: 25 });
  assert.equal(session, 'project');
  const attached = JSON.parse(await readFile(join(f.dir, 'attached'), 'utf8'));
  assert.deepEqual(attached, { pid: attached.pid, session: 'project', term: 'xterm-256color' });
  const initial = await f.call('frames', { connectionId, after: -1 });
  assert.equal(Buffer.from(initial.frames[0].data, 'base64').toString(), 'initial=90x25');
  await f.call('resize', { connectionId, cols: 100, rows: 30 });
  const input = Buffer.from('中文');
  await f.call('input', { connectionId, data: input.toString('base64') });
  let output = '', after = initial.frames[0].seq;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(output.includes('size=100x30') && output.includes('typed='+input.toString('hex')))) {
    const result = await f.call('frames', { connectionId, after });
    for (const frame of result.frames) {
      output += Buffer.from(frame.data, 'base64').toString();
      after = frame.seq;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(output.includes('size=100x30') && output.includes('typed='+input.toString('hex')));
  await f.call('release', { connectionId });
  assert.throws(() => process.kill(attached.pid, 0), { code: 'ESRCH' });
  const other = await f.call('full.open', { session: 'default' });
  assert.equal(other.session, 'default');
  await f.service.disconnect();
  await assert.rejects(f.call('input', { connectionId: other.connectionId, data: 'YQ==' }), /断开/);
});

test('完整客户端输出超过缓存时等待消费，分批传递全部 PTY 字节', async t => {
  const f = await fixture(t, { FAKE_FULL_LARGE: '1', HERDR_SOCKET_PATH: '/fixture/project.sock' });
  const { connectionId } = await f.call('full.open');
  await new Promise(resolve => setTimeout(resolve, 250));
  let after = -1, output = '';
  const deadline = Date.now() + 7000;
  while (!output.endsWith('END') && Date.now() < deadline) {
    const { frames } = await f.call('frames', { connectionId, after });
    for (const frame of frames) {
      assert.equal(frame.seq, ++after);
      output += Buffer.from(frame.data, 'base64').toString();
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(output === 'initial=120x36' + 'X'.repeat(4*1024*1024) + 'END');
});

test('不同会话可以独立接管同名终端，租约只检查和写入原会话', async t => {
  const f = await fixture(t);
  const sessions = ['default', 'project'].map(name => ({ name, running: true, default: name === 'default', socket_path: join(f.dir, name+'.sock') }));
  await writeFile(join(f.dir, 'sessions'), JSON.stringify({ sessions }));
  const projectPane = { ...f.pane, terminal_title_stripped: 'project title' };
  await writeFile(join(f.dir, 'pane-project'), JSON.stringify(projectPane));
  const panes = await f.call('list', { session: 'project' });
  assert.equal(panes.panes[0].title, 'project title');
  assert.match((await f.call('read', { ...f.target, session: 'project' })).text, /^project real/);
  const a = await f.call('open', { ...f.target, mode: 'control' });
  await assert.rejects(f.call('open', { ...f.target, mode: 'control', session: 'default' }), /另一个工作台窗口/);
  const b = await f.call('open', { ...f.target, mode: 'control', session: 'project' });
  f.pane.terminal_id = 'replaced';
  await f.state();
  await assert.rejects(f.call('input', { connectionId: a.connectionId, data: 'Yg==' }), /替换/);
  await f.call('input', { connectionId: b.connectionId, data: 'YQ==' });
  await f.call('release', { connectionId: b.connectionId });
  const projectInputs = (await readFile(join(f.dir,'input-project'),'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(projectInputs.map(i => i.type), ['terminal.input','terminal.release']);
  assert.equal(projectInputs[0].bytes, 'YQ==');
});

test('列表使用会话快照焦点；聚焦请求只发给绑定的 socket', async t => {
  const f = await fixture(t);
  const socketPath = join(f.dir, 'project.sock');
  const requests: string[] = [];
  const server = createServer(socket => {
    socket.once('data', bytes => {
      const req = JSON.parse(bytes.toString());
      requests.push(req.params.pane_id);
      assert.equal(req.method,'pane.focus');
      socket.end(JSON.stringify({ id: req.id, result: {} })+'\n');
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath,resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await writeFile(join(f.dir, 'sessions'), JSON.stringify({ sessions: [{name:'project',running:true,socket_path:socketPath}] }));
  await writeFile(join(f.dir,'snapshot-project'), JSON.stringify({result:{snapshot:{panes:[f.pane,{...f.pane,pane_id:'w1:p2',focused:true}],focused_pane_id:f.pane.pane_id}}}));
  const { panes } = await f.call('list', {session:'project'});
  assert.deepEqual(panes.map((p: any) => [p.paneId, !!p.focused]), [[f.target.paneId,true],['w1:p2',false]]);
  await assert.rejects(f.call('focus', {...f.target, terminalId:'replaced',session:'project'}), /替换/);
  const result = await f.call('focus', {...f.target,session:'project'});
  assert.equal(result.focused,true);
  assert.deepEqual(requests,[f.target.paneId]);
});
