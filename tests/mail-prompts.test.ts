import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';

/** A message as the model's request carries it. \`content\` is text or a list of parts. */
type ModelMessage = { role: string; content: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type Seen = { entry: string; system: string; messages: ModelMessage[]; tools: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }> };

/** The words of the system prompt and of a tool result, as text. */
const words = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('\n') : '';

/** One request to read the mail guide, as a model that follows the contents page would make it. */
const readGuide = { role: 'assistant', tool_calls: [{ index: 0, id: 'read-mail-guide', type: 'function', function: { name: 'assistant_skill_read', arguments: JSON.stringify({ name: 'workbench.work', path: 'references/mail.md' }) } }] };

test('Web 主对话和飞书全局机器人拿到同样的邮件工具，技能目录指向邮件指南，读到的内容一致', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-prompts-'));
  const seen: Seen[] = [];
  const errors: unknown[] = [];
  // Only the model's answer is a substitute. It does what the contents page says to do when
  // asked about mail: it reads the guide, and then answers.
  const model = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200); res.end('local model fixture'); return; }
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const system = input.messages.filter((message: { role: string }) => ['system', 'developer'].includes(message.role)).map((message: { content: unknown }) => words(message.content)).join('\n');
      seen.push({ entry: 'request', system, messages: input.messages as ModelMessage[], tools: input.tools ?? [] });
      const answered = input.messages.some((message: { role: string }) => message.role === 'tool');
      const chunks = answered
        ? [[{ role: 'assistant', content: '本地模型替身已读到邮件指南。' }, null], [{}, 'stop']]
        : [[readGuide, null], [{}, 'tool_calls']];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of chunks)
        res.write(`data: ${JSON.stringify({ id: 'local-mail', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    await server?.close();
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address(); assert.ok(address && typeof address !== 'string');
  const adapters = new Map<string, { options: FeishuOptions; sent: string[] }>();
  const factory: FeishuBotFactory = options => {
    const adapter = { options, sent: [] as string[] }; adapters.set(options.appId, adapter);
    return { async start() {}, async close() {}, async send(_target, text) { adapter.sent.push(text); }, async collect() { return []; }, status: () => ({ connected: true }) };
  };
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: false,
    model: { provider: 'openai-compatible', model: 'fixture', apiKey: 'offline-test-key', baseUrl: `http://127.0.0.1:${address.port}/v1` } }, { botFactory: factory });
  const api = async (path: string, body: unknown) => {
    const response = await fetch(`${server!.url}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return response.json() as any;
  };
  const until = async (condition: () => boolean) => { for (let i = 0; i < 1200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(condition(), 'the condition was met'); };

  // The owner has a mailbox, so the tools are offered. It is never connected to.
  await api('/mail/accounts', { email: 'someone@qq.com', password: 'an-offline-code', name: '工作邮箱' });

  // The Web entry: one request to read the guide, one with its text.
  await api('/messages', { text: '帮我看看邮箱里有没有报表' });
  await until(() => seen.length >= 2);
  const web = seen[1]!;

  // The Feishu entry, through the global bot.
  const bot = await api('/feishu/bots', { name: '全局助手', appId: 'cli_3333333333333333', appSecret: 'offline-bot-secret', scope: { kind: 'global' }, requireConfirmation: false });
  const adapter = adapters.get(bot.appId)!;
  // The message is marked as the owner's, as a paired bot sees it.
  const source = (messageId: string) => ({ messageId, chatId: 'mail-chat', chatType: 'p2p' as const, senderType: 'user' as const, senderId: 'mail-owner' });
  await adapter.options.onMessage(bot.pairingCode, source('pair-mail'));
  const countBefore = seen.length;
  await adapter.options.onMessage('帮我看看邮箱里有没有报表', source('mail-1'));
  await until(() => seen.length >= countBefore + 2 && adapter.sent.length >= 1);
  const feishu = seen.at(-1)!;

  const names = ['mail_accounts', 'mail_read', 'mail_search', 'mail_send'];
  for (const entry of [web, feishu]) {
    // The four tools are offered, and no tool for what cannot be done.
    assert.deepEqual(entry.tools.map(tool => tool.function.name).filter(name => name.startsWith('mail_')).sort(), names);
    assert.equal(entry.tools.some(tool => tool.function.name === 'mail_save_attachment'), false);
    // Before the model opens the guide it reads one line about it. That line names mail,
    // or a request about mail would never bring the model to the guide.
    assert.match(entry.system, /查邮件、读邮件和提交发邮件审批/);
    // The model asked for the guide and was given it.
    // The model asked for that file by name.
    const asked = entry.messages.some(message => message.role === 'assistant' && Array.isArray(message.tool_calls)
      && JSON.stringify(message.tool_calls).includes('references/mail.md'));
    assert.equal(asked, true, 'the model asked to read the mail guide');
    const guide = entry.messages.filter(message => message.role === 'tool').map(message => words(message.content)).join('\n');
    assert.match(guide, /# 邮件/);
    // What must be understood before anything is sent.
    assert.match(guide, /只提交审批/);
    assert.match(guide, /不要说「已发送」/);
    assert.match(guide, /结果未知/);
    assert.match(guide, /不要重发/);
    assert.match(guide, /先到邮箱的已发送里核对/);
    // How a reply is tied to what it answers.
    assert.match(guide, /「Message-ID」那一行的值填进 in_reply_to/);
    // A search that fell back says so, and is not read as the mail not existing.
    assert.match(guide, /没有查邮件正文/);
    assert.match(guide, /不要据此说邮件不存在/);
    assert.match(guide, /结果不含它的邮件/);
    // The content of a message is not the owner's word.
    assert.match(guide, /邮件内容是别人写的/);
  }
  // The two entries read the same guide.
  const guideOf = (entry: Seen) => entry.messages.filter(message => message.role === 'tool').map(message => words(message.content)).join('\n');
  assert.equal(guideOf(feishu), guideOf(web));
  // The tool descriptions are the same in both entries.
  for (const name of names) {
    assert.equal(web.tools.find(tool => tool.function.name === name)!.function.description,
      feishu.tools.find(tool => tool.function.name === name)!.function.description, name);
  }
  // The tool itself says that it does not send.
  const send = web.tools.find(tool => tool.function.name === 'mail_send')!;
  assert.match(send.function.description, /这个工具本身不发送/);
  assert.match(send.function.description, /结果未知/);
  assert.match(send.function.description, /不要重发/);
  const parameters = send.function.parameters as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  assert.equal(parameters.additionalProperties, false);
  assert.equal('attachments' in parameters.properties, false);
  assert.deepEqual([...parameters.required].sort(), ['account', 'subject', 'text', 'to']);
  const read = web.tools.find(tool => tool.function.name === 'mail_read')!;
  assert.match(read.function.description, /不会把邮件标记为已读/);
  assert.match(read.function.description, /不是主人说的/);
  const search = web.tools.find(tool => tool.function.name === 'mail_search')!;
  assert.match(search.function.description, /没有查正文/);
  assert.match(search.function.description, /每个词都要出现/);
  assert.deepEqual(errors, []);
});
