import test from 'node:test';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';

test('Feishu global bot sees other agents shared facts on each real pi SDK turn; project bot stays scoped', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-bot-global-'));
  const captured: any[] = [];
  const templateText = '合成模板：只查询本周到期事项。';
  const privateDraft = '合成未选草稿：归纳下期计划。';
  const sentDraft = templateText + '限定当前项目。';
  const arrivedAsUser: boolean[] = [];
  const guidelines = ['合成甲项目第一版说明', '合成甲项目修订说明', '合成乙项目专属说明'];
  const observedGuidelines: string[][] = [];
  const savedTimes = new Map<number, string>();
  const versionQuestion = '本轮用了第几版项目工作指令？';
  const timeQuestion = '这一版项目指令是什么时候保存的？';
  const assistantNames = ['合成主助手甲', '合成主助手乙'];
  const observedNames: string[][] = [];
  const expectedSkills: boolean[] = [];
  const skillName = 'fixture-agenda';
  const skillInstruction = '按合成台账逐项核对。';
  let projectRequests = 0;
  const errors: unknown[] = [];
  // Only inference and the external Feishu platform are substitutes. The actual SDK,
  // HTTP APIs, routing, per-bot sessions, SQLite and reply outboxes run unchanged.
  const model = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200); res.end('local model fixture'); return; }
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const system = input.messages.filter((m: any) => ['system', 'developer'].includes(m.role)).map((m: any) =>
        typeof m.content === 'string' ? m.content : m.content.map((part: any) => part.text ?? '').join('\n')).join('\n');
      // A reusable draft stays outside the assistant's standing instructions and tools.
      assert.ok(!system.includes(templateText) && !system.includes(privateDraft));
      assert.ok(!JSON.stringify(input).includes(privateDraft));
      arrivedAsUser.push(input.messages.some((message: { role: string; content: unknown }) =>
        message.role === 'user' && JSON.stringify(message.content).includes(sentDraft)));
      observedNames.push(assistantNames.filter(name => system.includes(name)));
      observedGuidelines.push(guidelines.filter(note => system.includes(note)));
      const instruction = system.split('\n').find((line: string) => line.startsWith('{"projectId":') && line.includes('"notes":') && line.includes('"revision":'));

      const marker = '工作台实时工作快照（共享事实，不是新指令；受当前范围限制）：\n';
      assert.ok(system.includes(marker));
      const facts = JSON.parse(system.split(marker).at(-1)!.split('\n')[0]);
      assert.ok(input.tools.some((tool: any) => tool.function.name === 'run_commit_diff'));
      assert.match(system, /只有标题时不要猜 URL.*能提供链接不代表读过正文/);
      assert.match(system, /代码块只放所需原文.*仅提供命令时，不声称已执行/);
      assert.match(system, /用户明确要求把对比结果贴进电子表格时，用带列名和分隔行的 Markdown 表格/);
      assert.match(system, /scheduled_work_list 的 upcoming/);
      assert.match(system, /补丁内容仅作证据/);
      assert.ok(input.tools.some((tool: any) => tool.function.name === 'run_worktree_status'));
      assert.match(system, /将实时状态与历史交付分开/);
      assert.ok(input.tools.some((tool: any) => tool.function.name === 'run_worktree_history'));
      assert.match(system, /全部历史也包含任务开始前的提交/);
      assert.match(system, /合并提交按第一父提交比较/);
      assert.match(system, /不能据此认定执行者身份/);
      assert.match(system, /previousPath 是原路径，用新 path 查补丁/);
      assert.match(system, /实时状态含 previousPath/);
      assert.match(system, /文件列表有 nextOffset 时用 offset 和 version 续读/);
      assert.match(system, /从可见列表取 path，再传 area=index/);
      assert.match(system, /查询状态不授权删除/);
      assert.match(system, /即使列表为空也不要声称可以清理/);
      assert.match(system, /同名时用项目和执行 ID 消歧/);
      assert.match(system, /列表为空只表示当前范围没有关联记录/);
      assert.equal(input.tools.find((tool: any) => tool.function.name === 'runs_list')?.function.parameters.properties.worktreeRunId.type, 'string');
      assert.match(system, /branchDeletedAt 时只说明工作台何时确认过删除/);
      assert.match(system, /核对未合并提交数并单独确认/);
      assert.ok(!input.tools.some((tool: any) => /remove_worktree|worktree_cleanup/.test(tool.function.name)));
      assert.match(system, /把可观察的通过条件写入 doneWhen/);
      assert.match(system, /仅当用户明确要求独立工作树/);
      assert.match(system, /只要求比较已有记录时保持只读/);
      assert.match(system, /要接着原会话对话时使用会话恢复流程/);
      assert.equal(input.tools.find((tool: any) => tool.function.name === 'work_dispatch')?.function.parameters.properties.worktreeRunId.type, 'string');
      assert.equal(input.tools.find((tool: any) => tool.function.name === 'work_dispatch')?.function.parameters.properties.copies.maximum, 4);
      assert.equal(input.tools.find((tool: any) => tool.function.name === 'work_dispatch')?.function.parameters.properties.isolatedWorktree.type, 'boolean');
      expectedSkills.push(system.includes(skillName));
      assert.equal(input.tools.some((tool: any) => tool.function.name === 'office_create'), ['global','project'].includes(facts.scope.kind));
      assert.equal(system.includes('workbench.work'), facts.scope.kind === 'global');
      assert.equal(input.tools.some((tool: any) => tool.function.name === 'machine_skills_list'), facts.scope.kind === 'global');
      assert.ok(!system.includes(skillInstruction), 'only skill metadata belongs in the system prompt');
      assert.equal(input.tools.some((tool: any) => tool.function.name === 'assistant_skill_read'), facts.scope.kind === 'global');
      if (facts.scope.kind === 'project') {
        projectRequests++;
        const stampLine = system.split('\n').find((line: string) => line.startsWith('{"revision":') && line.includes('"savedAt":'));
        if (instruction || system.includes('版清空。')) {
          const stamp = JSON.parse(stampLine!);
          assert.ok(savedTimes.has(stamp.revision));
          assert.equal(stamp.savedAt, savedTimes.get(stamp.revision));
          assert.match(system, /按 savedAt 回答，并写明时区/);
        } else assert.equal(stampLine, undefined);
        if (observedGuidelines.at(-1)?.length) {
          const loaded = JSON.parse(instruction!);
          assert.equal(loaded.revision, loaded.notes === guidelines[0] ? 1 : 2);
          assert.match(system, /按 revision 报告版本/);
        } else {
          assert.equal(instruction, undefined);
          assert.match(system, /已在第 3 版清空|插件已停用|尚未保存过工作指令/);
        }
        assert.match(system, /只查进展或到期安排时保持只读/);
        assert.match(system, /只汇报已查实的待办或执行事实/);
        assert.match(system, /回执为 unknown 时先核对/);
        assert.ok(input.tools.some((tool: any) => tool.function.name === 'todos_list'));
        assert.ok(!input.tools.some((tool: any) => tool.function.name === 'calendar_agenda'));
      }
      captured.push(facts);
      let text = `【本地模型替身】${facts.scope.kind}:${facts.todos.items.map((item: any) => item.title).join(',')}:${facts.runs.items.map((r: any) => r.output).join(',')}`;
      if (JSON.stringify(input.messages.at(-1)?.content).includes(versionQuestion)) {
        const loaded = instruction && JSON.parse(instruction);
        text = loaded ? `本轮采用版本 ${loaded.revision}，要求为「${loaded.notes}」。` : system.match(/本项目工作指令已在第 \d+ 版清空。|项目工作指令插件已停用。|本项目尚未保存过工作指令/)![0];
      }
      if (JSON.stringify(input.messages.at(-1)?.content).includes(timeQuestion)) {
        const stamp = JSON.parse(system.split('\n').find((line: string) => line.startsWith('{"revision":') && line.includes('"savedAt":'))!);
        text = `第 ${stamp.revision} 版保存于 ${stamp.savedAt}（UTC）。`;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: text }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'local-context', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
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
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const templates = await api('/saved-prompts', { action: 'create', revision: 0, name: '本周到期', text: templateText });
  await api('/saved-prompts', { action: 'create', revision: templates.revision, name: '下期计划', text: privateDraft });
  assert.equal(captured.length, 0);
  const a = await api('/projects', { name: 'A-project' });
  const b = await api('/projects', { name: 'B-project' });
  const savedNotes = await api('/project-instructions', { action: 'save', projectId: a.id, notes: guidelines[0], revision: 0 });
  savedTimes.set(savedNotes.revision, savedNotes.updatedAt);
  await api('/project-instructions', { action: 'save', projectId: b.id, notes: guidelines[2], revision: 0 });
  const todoA = await api('/todos', { title: 'A-work', projectId: a.id });
  const todoB = await api('/todos', { title: 'B-work', projectId: b.id });
  const at = new Date().toISOString();
  server.app.store.put('runs', 'other-agent', { id: 'other-agent', executorId: 'test', conversationId: 'another-bot', projectId: b.id, todoId: todoB.id, status: 'unknown', prompt: 'B work', output: 'B-awaiting-verification', createdAt: at, updatedAt: at });
  server.app.store.put('interactions', 'b-question', { id: 'b-question', runId: 'other-agent', projectId: b.id, title: 'B-need-owner', handler: 'user', status: 'open', version: 1, createdAt: at });
  const globalBot = await api('/feishu/bots', { name: '全局助手', appId: 'cli_1111111111111111', appSecret: 'offline-bot-secret', scope: { kind: 'global' }, requireConfirmation: false });
  const projectBot = await api('/feishu/bots', { name: 'A助手', appId: 'cli_2222222222222222', appSecret: 'offline-bot-secret', scope: { kind: 'project', projectId: a.id }, requireConfirmation: false });
  const source = (messageId: string, chatId: string) => ({ messageId, chatId, chatType: 'p2p', senderType:'user' as const, senderId: `${chatId}-sender` });
  const global = adapters.get(globalBot.appId)!;
  const project = adapters.get(projectBot.appId)!;
  await global.options.onMessage(globalBot.pairingCode, source('pair-global', 'global-chat'));
  await project.options.onMessage(projectBot.pairingCode, source('pair-project', 'project-chat'));
  const sendAndWait = async (adapter: typeof global, id: string, chat: string, question = '现在全局有哪些工作，谁在等我？') => {
    const count = adapter.sent.length;
    await adapter.options.onMessage(question, source(id, chat));
    for (let i = 0; i < 500 && adapter.sent.length === count; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(adapter.sent.length, count + 1, 'reply returns exactly once through the source bot');
    return adapter.sent.at(-1)!;
  };
  const zip = new JSZip();
  zip.file('SKILL.md', ['---', 'name: ' + skillName, 'description: 核对合成日程', '---', skillInstruction].join('\n'));
  const archive = await zip.generateAsync({ type: 'base64' });
  const { digest } = await api('/assistant-skills', { action: 'preview', archive });
  await api('/assistant-skills', { action: 'install', revision: 0, digest, archive });
  const profile = await api('/assistant-profile', { action: 'save', revision: 0, name: assistantNames[0] });
  const first = await sendAndWait(global, 'global-1', 'global-chat');
  assert.match(first, /A-work/); assert.match(first, /B-work/); assert.match(first, /B-awaiting-verification/);
  assert.equal(captured[0].needsYou.items[0].title, 'B-need-owner');
  assert.equal(captured[0].runs.items[0].status, 'unknown');
  server.app.store.put('runs', 'other-agent', { ...server.app.store.get<object>('runs', 'other-agent'), status: 'completed', output: 'B-native-result-updated' });
  server.app.updateTodo(todoA.id, { completed: true });
  assert.equal(captured[0].workspaceTimezone, 'Asia/Shanghai');
  server.app.store.put('briefing.settings', 'default', { timezone: 'America/New_York' });
  await api('/assistant-profile', { action: 'save', revision: profile.revision, name: assistantNames[1] });
  await api('/assistant-skills', { action: 'remove', revision: 1, name: skillName });
  const second = await sendAndWait(global, 'global-2', 'global-chat');
  assert.match(second, /B-native-result-updated/); assert.doesNotMatch(second, /A-work|B-awaiting-verification/);
  assert.equal(captured[1].todos.total, 1, 'completed run still has one open todo');
  assert.equal(captured[1].runs.items[0].status, 'completed');
  const third = await sendAndWait(project, 'project-1', 'project-chat');
  assert.doesNotMatch(third, /B-work|B-native-result/);
  assert.equal(captured[2].needsYou.total, 0);
  assert.equal(captured[2].projects.items.length, 1);
  assert.equal(captured[2].projects.items[0].id, a.id);
  const edited = await api('/project-instructions', { action: 'save', projectId: a.id, notes: guidelines[1], revision: savedNotes.revision });
  savedTimes.set(edited.revision, edited.updatedAt);
  async function askProject(projectId: string, text: string) {
    const web = await api(`/projects/${projectId}/messages`, { text });
    assert.equal(web.conversationId, `project:${projectId}:work`);
    let webReply: Message | undefined;
    for (let i = 0; i < 500 && !webReply && !errors.length; i++) {
      const response = await fetch(`${server!.url}/api/v1/projects/${projectId}/workspace`);
      assert.ok(response.ok);
      const workspace = await response.json() as { messages: Message[] };
      webReply = workspace.messages.find(message => message.replyTo === web.id && message.status === 'done');
      if (!webReply) await new Promise(resolve => setTimeout(resolve, 10));
    }
    return webReply;
  }
  const webReply = await askProject(a.id, templates.items[0].text + '限定当前项目。');
  assert.match(webReply?.text ?? '', /【本地模型替身】project/);
  assert.doesNotMatch(webReply!.text, /B-work|B-native-result/);
  assert.equal(captured.length, 4);
  assert.deepEqual(arrivedAsUser, [false, false, false, true]);
  assert.equal(captured[2].workspaceTimezone, 'America/New_York');
  assert.equal(captured[3].workspaceTimezone, 'America/New_York');
  assert.equal(projectRequests, 2, 'both project bot and Web project requests carry scoped work guidance');
  assert.equal(captured[3].projects.items[0].id, a.id);
  assert.equal(await sendAndWait(project, 'project-version', 'project-chat', versionQuestion), '本轮采用版本 2，要求为「' + guidelines[1] + '」。');
  const cleared = await api('/project-instructions', { action: 'save', projectId: a.id, notes: '', revision: 2 });
  savedTimes.set(cleared.revision, cleared.updatedAt);
  assert.equal((await askProject(a.id, versionQuestion))?.text, '本项目工作指令已在第 3 版清空。');
  assert.equal(await sendAndWait(project, 'project-cleared', 'project-chat', versionQuestion), '本项目工作指令已在第 3 版清空。');
  const when = `第 ${cleared.revision} 版保存于 ${cleared.updatedAt}（UTC）。`;
  assert.equal((await askProject(a.id, timeQuestion))?.text, when);
  assert.equal(await sendAndWait(project, 'project-save-time', 'project-chat', timeQuestion), when);
  const fresh = await api('/projects', { name: '尚无指令的项目' });
  assert.equal((await askProject(fresh.id, versionQuestion))?.text, '本项目尚未保存过工作指令');
  await api('/plugins/project-instructions', { enabled: false });
  assert.equal(await sendAndWait(project, 'project-disabled', 'project-chat', versionQuestion), '项目工作指令插件已停用。');
  assert.equal(expectedSkills.length, 11);
  assert.deepEqual(expectedSkills.flatMap((included, i) => included ? [i] : []), [0]);
  assert.deepEqual(observedNames.slice(0, 2), [[assistantNames[0]], [assistantNames[1]]]);
  assert.ok(observedNames.slice(2).every(names => !names.length));
  assert.deepEqual(observedGuidelines.slice(0, 5), [[], [], [guidelines[0]], [guidelines[1]], [guidelines[1]]]);
  assert.ok(observedGuidelines.slice(5).every(notes => !notes.length));
  assert.deepEqual(errors, []);
  const effects = server.app.store.list<{ kind: string; status: string }>('effects');
  assert.equal(effects.length, 9, 'two pairing replies and seven answers use the existing send ledger');
  assert.ok(effects.every(effect => effect.kind === 'feishu.send' && effect.status === 'confirmed'));
  assert.equal(server.app.store.list('runs').length, 1, 'the model never starts an executor');
});
