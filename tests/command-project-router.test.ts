import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCommandProjectRouter } from '../packages/core/src/agent-runtime/command-project-router.ts';

const config = { dataDir: '', host: 'localhost', port: 0, demo: false };
const projects = [{ id: 'a', name: '账务', description: '报销核算' }, { id: 'b', name: '采购' }];

test('only a single candidate ID in a complete classification is accepted', async () => {
  for (const [answer, expected] of [
    ['{"projectId":"a"}', 'a'], ['{"projectId":"outside"}', undefined], ['{"ask":true}', undefined],
    ['{"projectId":"a","ask":true}', undefined], ['{"projectId":"a","projectId":"b"}', undefined], ['a or b', undefined], ['["a"]', undefined],
  ] as const) {
    const router = createCommandProjectRouter(config, () => true, async () => answer);
    assert.equal(await router.route('核对报销', projects), expected);
  }
  const ambiguous = createCommandProjectRouter(config, () => true, async () => '{"projectId":"a"}');
  assert.equal(await ambiguous.route('整理周报', [{ id: 'a', name: '周报' }, { id: 'b', name: '周报' }]), undefined);
  const unavailable = createCommandProjectRouter(config, () => true, async () => { throw Error('provider offline'); });
  assert.equal(await unavailable.route('核对报销', projects), undefined);
});

test('demo, unavailable model and invalid candidate data ask without invoking the model', async () => {
  let calls = 0;
  const complete = async () => { calls++; return '{"projectId":"a"}'; };
  const router = createCommandProjectRouter(config, () => true, complete);
  for (const candidates of [[], [...projects, projects[0]!]]) assert.equal(await router.route('核对报销', candidates), undefined);
  assert.equal(await router.route('x'.repeat(20000), projects), undefined);
  assert.equal(await createCommandProjectRouter(config, () => false, complete).route('核对报销', projects), undefined);
  assert.equal(await createCommandProjectRouter({ ...config, demo: true }, () => true, complete).route('核对报销', projects), undefined);
  assert.equal(calls, 0);
});

test('deadline and model reload discard a late answer even if the provider ignores abort', async () => {
  for (const cancel of [false, true]) {
    let finish!: (value: string) => void;
    let requestSignal: AbortSignal | undefined;
    const router = createCommandProjectRouter(config, () => true, async (_config, _input, signal) => {
      requestSignal = signal;
      return new Promise<string>(resolve => { finish = resolve; });
    }, cancel ? 30000 : 10);
    const pending = router.route('核对报销', projects);
    if (cancel) router.cancel();
    assert.equal(await pending, undefined);
    assert.equal(requestSignal?.aborted, true);
    finish('{"projectId":"a"}');
  }
});

test('configured main API receives one isolated tool-free request and creates no session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'command-router-'));
  await mkdir(join(dir, 'pi'));
  const requests: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    // The SDK may probe model metadata with an empty GET before the completion.
    const body=Buffer.concat(chunks).toString();
    if (!body && req.method==='GET') {res.writeHead(200,{'Content-Type':'application/json'});res.end('{"data":[]}');return;}
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const data = { id: 'r', model: 'test-main', object: 'chat.completion.chunk', created: 1,
      choices: [{ index: 0, delta: { role: 'assistant', content: '{"projectId":"a"}' }, finish_reason: 'stop' }] };
    res.end('data: ' + JSON.stringify(data) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const router = createCommandProjectRouter({ ...config, dataDir: dir, model: { provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:' + address.port, model: 'test-main', apiKey: 'fixture' } }, () => true);
  const supplied = projects.map(p => ({ ...p, cwd: '/private/workspace', credentials: 'private-extra' }));
  assert.equal(await router.route('核对报销', supplied), 'a');
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.model, 'test-main');
  assert.equal(request.max_tokens ?? request.max_completion_tokens, 128);
  assert.deepEqual(request.tools ?? [], []);
  assert.equal(request.messages.length, 2);
  assert.deepEqual(JSON.parse(request.messages[1].content), { text: '核对报销', candidates: projects });
  assert.ok(!(await readdir(dir, { recursive: true })).some(path => /session|jsonl|sqlite/.test(path)));
});
