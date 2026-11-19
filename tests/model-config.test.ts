import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createModelConfig } from '../packages/core/src/model-config.ts';
import { startServer } from '../apps/server/src/index.ts';

test('model settings persist privately, preserve only matching-provider keys and reject invalid updates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-model-settings-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { host: '127.0.0.1', port: 0, dataDir: dir, demo: false };
  const settings = createModelConfig(config);
  settings.write({ mode: 'api', provider: 'openai', model: 'example-model', apiKey: 'private-test-value' });
  assert.equal(JSON.stringify(settings.public()).includes('private-test-value'), false);
  assert.equal((await stat(join(dir, 'model.json'))).mode & 0o777, 0o600);
  settings.write({ mode: 'api', provider: 'openai', model: 'other', apiKey: '' });
  assert.equal(settings.public().apiKeyConfigured, true);
  assert.throws(() => settings.write({ mode: 'api', provider: 'openai-compatible', model: 'other', baseUrl: 'file:///secret' }));
  assert.equal(settings.public().model, 'other');
  settings.write({ mode: 'api', provider: 'anthropic', model: 'other' });
  assert.equal(settings.public().apiKeyConfigured, false);
  settings.write({ mode: 'codex-cli', model: 'default' });
  const restored = createModelConfig({ ...config });
  assert.equal(restored.public().provider, 'codex-cli');
  assert.equal(restored.public().source, 'saved');
});

test('model HTTP configuration hot-applies both real pi runtimes and survives restart without leaking credentials', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-model-http-'));
  const receivedModels: string[] = [];
  let hold = false, releaseHeld = () => {}, heldArrived = () => {};
  const model = createServer(async (req,res) => {
    if (req.method === 'GET') { res.end('local model fixture'); return; }
    assert.equal(req.headers.authorization, 'Bearer fixture-api-key');
    let requestBody = ''; for await (const part of req) requestBody += part.toString();
    receivedModels.push(JSON.parse(requestBody).model);
    if (hold) { heldArrived(); await new Promise<void>(resolve => { releaseHeld = resolve; }); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta,finish] of [[{ role:'assistant', content:'模型设置已实际接通' },null],[{},'stop']]) res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',created:1,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  const address=model.address() as {port:number};
  let runtime=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:false,token:'settings-test'});
  t.after(async()=>{releaseHeld();await runtime.close();model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));await rm(dir,{recursive:true,force:true});});
  const request=async(path:string,method='GET',body?:unknown)=>{
    const response=await fetch(runtime.url+'/api/v1'+path,{method,headers:{Authorization:'Bearer settings-test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,200);return response.json();
  };
  const saved=await request('/model','PUT',{mode:'api',provider:'openai-compatible',model:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'fixture-api-key'});
  assert.equal(saved.runtime.main.available,true);assert.equal(saved.runtime.supervisor.available,true);
  assert.equal(JSON.stringify(saved).includes('fixture-api-key'),false);
  assert.equal(JSON.stringify(await request('/model')).includes('fixture-api-key'),false);
  const answer=await runtime.app.agent.ask('确认配置已生效');assert.equal(answer.text,'模型设置已实际接通');
  assert.equal(receivedModels.at(-1), 'fixture');
  hold = true;
  const arrived = new Promise<void>(resolve => { heldArrived = resolve; });
  const pending = runtime.app.agent.ask('等待当前回复完成'); await arrived;
  const conflict = await fetch(runtime.url+'/api/v1/model', { method:'PUT', headers:{Authorization:'Bearer settings-test','Content-Type':'application/json'}, body:JSON.stringify({mode:'codex-cli',model:'default'}) });
  assert.equal(conflict.status,409); assert.equal((await request('/model')).model,'fixture');
  hold = false; releaseHeld(); await pending;
  const switched = await request('/model','PUT',{mode:'api',provider:'openai-compatible',model:'fixture-v2',baseUrl:`http://127.0.0.1:${address.port}/v1`});
  assert.equal(switched.apiKeyConfigured,true);
  await runtime.app.agent.ask('切换后确认'); assert.equal(receivedModels.at(-1),'fixture-v2');
  await runtime.close();
  runtime=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:false,token:'settings-test'});
  assert.equal((await request('/model')).provider,'openai-compatible');
  const recovered=await runtime.app.agent.ask('重启后确认');assert.equal(recovered.text,'模型设置已实际接通');
  assert.ok((await readFile(join(dir,'model.json'),'utf8')).includes('fixture-api-key'));
  assert.equal(JSON.stringify(runtime.app.events.since(0)).includes('fixture-api-key'),false);
});

test('CLI launcher settings persist, restart and isolate API credentials without executing commands', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fresh = () => ({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const settings = createModelConfig(fresh());
  settings.write({ mode: 'codex-cli', model: 'default' });
  assert.equal(createModelConfig(fresh()).public().cliCommand, undefined);
  assert.equal(createModelConfig(fresh()).public().cliConfigDir, undefined);
  const cliCommand = join(dir, 'not installed', 'codex;$(echo marker)');
  const cliConfigDir = join(dir, 'not created', 'configuration');
  settings.write({ mode: 'api', provider: 'openai', model: 'fixture', apiKey: 'fixture-secret' });
  settings.write({ mode: 'codex-cli', cliCommand, cliConfigDir, apiKey: 'must-not-persist' });
  const restored = createModelConfig(fresh());
  assert.equal(restored.public().cliCommand, cliCommand);
  assert.equal(restored.public().cliConfigDir, cliConfigDir);
  assert.equal(restored.public().apiKeyConfigured, false);
  const saved = await readFile(join(dir, 'model.json'), 'utf8');
  assert.equal(saved.includes('secret'), false);
  assert.equal(saved.includes('must-not-persist'), false);
  assert.equal(JSON.parse(saved).cliCommand, cliCommand);
  restored.write({ mode: 'api', provider: 'openai', model: 'fixture', cliCommand, cliConfigDir });
  assert.equal(restored.public().apiKeyConfigured, false);
  assert.equal('cliCommand' in restored.public(), false);
  assert.equal('cliConfigDir' in restored.public(), false);
  assert.equal('cliCommand' in JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')), false);
  restored.write({ mode: 'codex-cli', cliCommand: 'codex-custom', cliConfigDir: '' });
  assert.equal(restored.public().cliCommand, 'codex-custom');
  restored.write({ mode: 'codex-cli', cliCommand: '', cliConfigDir: '' });
  assert.equal(restored.public().cliCommand, undefined);
});

test('CLI launcher validation rejects relative paths, arguments, controls and oversized settings atomically', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-launcher-validation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = createModelConfig({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  settings.write({ mode: 'codex-cli', cliCommand: 'codex' });
  const saved = await readFile(join(dir, 'model.json'), 'utf8');
  for (const cliCommand of ['./codex', '../codex', 'bin/codex', 'bin\\codex', 'codex --version', 'codex\n', '/tmp/co\u0000dex', 'x'.repeat(4097), 42]) {
    assert.throws(() => settings.write({ mode: 'codex-cli', cliCommand }));
    assert.equal(settings.public().cliCommand, 'codex');
  }
  for (const cliConfigDir of ['relative', './config', '~/config', '/tmp/config\n', '/tmp/\u007f', '/'.repeat(4097), 42]) {
    assert.throws(() => settings.write({ mode: 'codex-cli', cliConfigDir }));
  }
  assert.equal(await readFile(join(dir, 'model.json'), 'utf8'), saved);
});

test('CLI settings HTTP save/read/restart uses isolated demo without launching a model', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-launcher-http-'));
  const options = { host: '127.0.0.1', port: 0, dataDir: dir, demo: true };
  let runtime = await startServer(options);
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const body = { mode: 'codex-cli', model: 'default', cliCommand: join(dir, 'missing launcher', 'codex'), cliConfigDir: join(dir, 'missing configuration') };
  const response = await fetch(runtime.url + '/api/v1/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cliCommand, body.cliCommand);
  await runtime.close();
  runtime = await startServer(options);
  const restored = await (await fetch(runtime.url + '/api/v1/model')).json();
  assert.equal(restored.cliCommand, body.cliCommand);
  assert.equal(restored.cliConfigDir, body.cliConfigDir);
  assert.equal(restored.source, 'saved');
});

test('custom Anthropic gateway accepts a full messages URL and a model outside the catalog', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-anthropic-gateway-'));
  const requests: unknown[] = [];
  const gateway = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push([new URL(req.url!, 'http://localhost').pathname, req.headers['x-api-key'], JSON.parse(body).model]);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'fixture', role: 'assistant', type: 'message', content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'gateway OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(r => gateway.listen(0, '127.0.0.1', r));

  const base = 'http://127.0.0.1:' + (gateway.address() as { port: number }).port;
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: false });
  t.after(async () => { await server.close(); gateway.closeAllConnections(); await new Promise<void>(r => gateway.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const model = 'namespace/offline-model';
  for (const suffix of ['/v1/messages', '/v1', '']) {
    const response = await fetch(server.url + '/api/v1/model', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'api', provider: 'anthropic', model, apiKey: 'fixture-key', baseUrl: base + suffix }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).runtime.main.available, true);
    assert.equal((await server.app.agent.ask('test gateway')).text, 'gateway OK');
    assert.deepEqual(requests.at(-1), ['/v1/messages', 'fixture-key', model]);
  }
});
