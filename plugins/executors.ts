import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { codexTurnEndpoint, startCodexTopicTurn, codexTopicAnswer, type CodexTurnEndpoint } from './codex-topic-turns.ts';
import { nativeInputFingerprint, submitInputOnce } from './executor-input-receipts.ts';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeResumeCommand, validateNativeSessionId } from './session-resume.ts';
import { codexWorkerToolArgs, validateTaskLauncher, validateWorkerToolUrl } from './task-runner.ts';
import type { AgentDiagnosticsOptions } from './agent-diagnostics.ts';
import type { TerminalHostInstance } from '../packages/protocol/src/index.ts';
import { readTaskResult } from './task-results.ts';
import { createKnowledgeWorker } from './knowledge-worker.ts';
import type { ExecutorInfo, Json, JsonObject, NativeResumeSpec, SessionBinding } from '../packages/protocol/src/index.ts';
import type { Dispose, NodeHandler, TerminalHost } from '../packages/plugin-sdk/src/index.ts';

const commands = { codex: 'codex', 'claude-code': 'claude', pi: 'pi' } as const;
function onPath(name: string): boolean {
  return (isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir || '.', name))).some(file => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
  });
}
function string(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`Invalid ${key}`);
  return value;
}
function inputText(params: JsonObject): string {
  const text = params.text;
  if (typeof text !== 'string' || !text.length || text.includes('\0')) throw new Error('Invalid text');
  return text;
}
function argv(value: Json | undefined): string[] {
  if (!Array.isArray(value) || !value.length || !value.every(v => typeof v === 'string' && !v.includes('\0')) || !value[0]) throw new Error('Invalid argv/keys');
  return value as string[];
}
function directory(value: string): string {
  const cwd = resolve(value);
  if (!statSync(cwd).isDirectory()) throw new Error('cwd must be an existing directory');
  return cwd;
}

/** The host owns PTYs. Disconnecting RPC observers must never terminate their processes. */
export function createExecutionServices(options: { host: TerminalHost; dataDir: string; workerToolUrl?: string; machineId?: string; agentInstanceId?: string; launchers?: AgentDiagnosticsOptions['launchers']; hasCommand?: (name: string) => boolean; validateResume?: (input: NativeResumeSpec & { cwd: string }) => Promise<unknown> }): {
  describe(machineId: string): Promise<ExecutorInfo[]>;
  handlers: Record<string, NodeHandler>;
  disconnect(): Promise<void>;
  close(): Promise<void>;
} {
  const { host } = options;
  const workerToolUrl = options.workerToolUrl === undefined ? undefined : validateWorkerToolUrl(options.workerToolUrl);
  const machineId = options.machineId ?? 'unknown';
  const agentInstanceId = options.agentInstanceId;
  const scope = { machineId, ...(agentInstanceId ? { agentInstanceId } : {}) };
  const launchers: NonNullable<AgentDiagnosticsOptions['launchers']> = {};
  for (const [id, spec] of Object.entries(options.launchers ?? {})) {
    if (id !== 'codex' && id !== 'claude-code' && id !== 'pi') throw new Error('Invalid launcher executor');
    launchers[id] = validateTaskLauncher(spec);
  }
  async function describeHost(): Promise<TerminalHostInstance> {
    const unknown: TerminalHostInstance = {
      ...scope, hostKind: 'terminal-cli',
      identity: { state: 'unknown', reason: 'Terminal host instance identity unavailable' },
      atomicControl: { state: 'unsupported', reason: 'Atomic recovery control is not implemented' },
    };
    try { return host.describeInstance ? await host.describeInstance(scope) : unknown; }
    catch { return unknown; }
  }
  const knowledgeWorker = createKnowledgeWorker({ dataDir: options.dataDir, launchers });
  const hasCommand = options.hasCommand ?? onPath;
  const file = join(options.dataDir, 'executor-sessions.json');
  const bindings = new Map<string, SessionBinding>();
  const owned = new Set<string>();
  // Only launch in this services lifetime grants current-agent authority.
  // Neither a persisted agent ID nor a matching pane/cwd can restore it.
  const currentSessions = new Set<string>();
  const codexSocket = process.env.SUPER_MARIO_CODEX_SOCKET;
  const codexEndpoints = new Map<string, CodexTurnEndpoint>();
  const recoveryReason = 'Historical session ownership is unknown after agent restart; observation and control are disabled';
  function assertCurrentPane(paneId: string) {
    if ([...bindings.values()].some(b => b.paneId === paneId && !currentSessions.has(b.sessionId))) throw new Error(recoveryReason);
  }
  const writing = new Set<string>();
  const watches = new Map<string, { active: boolean; ready: Promise<Dispose>; cleanup?: Promise<void> }>();
  if (existsSync(file)) {
    const rows: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('Invalid executor session store');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !['sessionId', 'paneId', 'executorId', 'cwd', 'createdAt'].every(k => typeof row[k] === 'string' && row[k].length) || !Object.hasOwn(commands, row.executorId) || bindings.has(row.sessionId) || [...bindings.values()].some(b => b.paneId === row.paneId)) throw new Error('Invalid executor session binding');
      try {
        if (Object.hasOwn(row, 'nativeSessionId')) validateNativeSessionId(row.nativeSessionId);
        if (Object.hasOwn(row, 'nativeResume')) {
          const spec = row.nativeResume;
          if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
              Object.keys(spec).some(key => !['executorId', 'nativeSessionId'].includes(key)) || spec.executorId !== row.executorId) throw new Error('Invalid nativeResume');
          validateNativeSessionId(spec.nativeSessionId);
          if (row.nativeSessionId !== undefined && row.nativeSessionId !== spec.nativeSessionId) throw new Error('Native session ID mismatch');
        }
      } catch (error) { throw new Error('Invalid executor session binding native resume fields', { cause: error }); }
      bindings.set(row.sessionId, row as SessionBinding);
    }
  }
  function save() {
    mkdirSync(options.dataDir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify([...bindings.values()], null, 2), { mode: 0o600 });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
  }
  function binding(params: JsonObject): SessionBinding {
    const result = bindings.get(string(params, 'sessionId'));
    if (!result) throw new Error('Session is not bound');
    return result;
  }
  function isTaskSession(b: SessionBinding): boolean {
    // Persisted config is authoritative across reconnects, even after the runner exits.
    return existsSync(join(resolve(options.dataDir), 'task-results', `${b.sessionId}.config.json`));
  }
  function isTaskPane(paneId: string): boolean {
    return [...bindings.values()].some(b => b.paneId === paneId && isTaskSession(b));
  }
  async function writable(paneId: string) {
    assertCurrentPane(paneId);
    const bound = [...bindings.values()].find(b => b.paneId === paneId);
    if (!owned.has(paneId) && !bound) throw new Error('Pane is not bound or owned');
    const pane = (await host.list()).find(p => p.id === paneId);
    if (!pane || (bound && resolve(pane.cwd) !== bound.cwd)) throw new Error('Bound pane is missing or cwd changed');
  }
  async function write(paneId: string, action: () => Promise<void>): Promise<Json> {
    if (writing.has(paneId)) throw new Error('Pane already has a writer');
    writing.add(paneId);
    try {
      await writable(paneId);
      // A transport failure may follow a successful write: never automatically resend.
      try { await action(); } catch (error) {
        throw new Error(`Terminal write failed for pane ${paneId}; outcome unknown, do not automatically resend`, { cause: error });
      }
      return { requested: true };
    } finally { writing.delete(paneId); }
  }
  async function submitText(paneId: string, text: string) {
    await host.input(paneId, text);
    await host.keys(paneId, ['Enter']);
  }
  const pendingInput = new Map<string, { text: string; job: Promise<Json> }>();
  async function unwatch(watchId: string) {
    const watch = watches.get(watchId);
    if (!watch) return;
    watch.active = false;
    // Keep failed disposers reachable so shutdown can retry their cleanup.
    if (!watch.cleanup) watch.cleanup = watch.ready.then(dispose => dispose()).then(() => { watches.delete(watchId); }).catch(error => { watch.cleanup = undefined; throw error; });
    await watch.cleanup;
  }
  function copyBinding(value: SessionBinding) {
    const { nativeResume, ...fields } = value;
    return { ...fields, ...(nativeResume ? { nativeResume: { ...nativeResume } } : {}) };
  }
  async function launch(params: JsonObject, resume = false) {
    if (['command', 'argv', 'env', 'profile', 'launcher', 'launchers', 'workerToolUrl', 'workerToolKey', 'workerToolKeyHash'].some(key => Object.hasOwn(params, key))) throw new Error('Launcher configuration is local only');
    if (!resume && ['resume', 'nativeResume', 'nativeSessionId'].some(key => Object.hasOwn(params, key))) throw new Error('Use executor.resume for native resume');
    if (resume && Object.keys(params).some(key => !['executorId', 'nativeSessionId', 'prompt', 'cwd', 'mode'].includes(key))) throw new Error('Invalid resume parameter');
    const executorId = string(params, 'executorId');
    if (executorId !== 'codex' && executorId !== 'claude-code' && executorId !== 'pi') throw new Error('Unsupported executor');
    if (executorId === 'pi' && (resume || params.mode !== 'task')) throw new Error('Pi supports new tasks only');
    const model = params.model;
    if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))) throw new Error('Invalid model identifier');
    const launcher = launchers[executorId];
    const command = launcher?.command ?? commands[executorId];
    const profileEnv = launcher?.profile ? { [executorId === 'pi' ? 'PI_CODING_AGENT_DIR' : executorId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: launcher.profile.configDir } : undefined;
    const prompt = string(params, 'prompt');
    const cwd = directory(string(params, 'cwd'));
    const checkAvailable = async () => {
      const status = await host.status();
      if (!status.available) throw new Error(status.reason ?? 'Terminal host unavailable');
      if (!hasCommand(command)) throw new Error(`${command} is not on PATH`);
      directory(cwd);
    };
    await checkAvailable();
    const sessionId = randomUUID();
    if (params.mode !== undefined && params.mode !== 'interactive' && params.mode !== 'task') throw new Error('Invalid mode');
    let nativeResume: NativeResumeSpec | undefined;
    let resumeCommand: ReturnType<typeof buildNativeResumeCommand> | undefined;
    if (resume) {
      // Build before validation or filesystem writes; no fallback to a new CLI session.
      resumeCommand = buildNativeResumeCommand({ executorId, nativeSessionId: string(params, 'nativeSessionId'), prompt, cwd: string(params, 'cwd'), mode: params.mode === 'task' ? 'task' : 'interactive', ...(params.mode === 'task' ? { resultsPath: join(resolve(options.dataDir), 'task-results', `${sessionId}.json`) } : {}) });
      nativeResume = { executorId, nativeSessionId: string(params, 'nativeSessionId') };
      await options.validateResume!({ executorId, nativeSessionId: nativeResume.nativeSessionId, cwd });
      await checkAvailable();
    }
    // -- ends option parsing, including prompts starting with '-' or containing shell syntax.
    let args = executorId === 'codex' ? [command, '--', prompt] : [command, '--session-id', sessionId, '--', prompt];
    const endpoint = nativeResume?.executorId === 'codex' && params.mode !== 'task' && codexSocket !== undefined
      ? codexTurnEndpoint(codexSocket, cwd, nativeResume.nativeSessionId) : undefined;
    if (resumeCommand) args = [command, ...(endpoint ? ['--remote', 'unix://' + endpoint.path] : []), ...resumeCommand.args];
    // A shared app-server owns its own MCP configuration. Local CLI overrides cannot grant it this credential.
    const workerKey = executorId === 'codex' && workerToolUrl && !endpoint ? randomBytes(32).toString('base64url') : undefined;
    const env = workerKey && workerToolUrl ? { ...profileEnv, SUPER_MARIO_WORKER_KEY: workerKey,
      SUPER_MARIO_WORKER_URL: workerToolUrl, SUPER_MARIO_WORKER_SESSION: sessionId } : profileEnv;
    if (model && params.mode !== 'task') args.splice(1, 0, '--model', model);
    if (workerKey && params.mode !== 'task') args.splice(1, 0, ...codexWorkerToolArgs());
    if (params.mode === 'task') {
      const tasksDir = join(resolve(options.dataDir), 'task-results');
      mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
      const configPath = join(tasksDir, `${sessionId}.config.json`);
      writeFileSync(configPath, JSON.stringify({ prompt, cwd, executorId, ...(model && { model }), ...(launcher ? { launcher } : {}), ...(nativeResume ? { nativeSessionId: nativeResume.nativeSessionId } : {}), resultsPath: join(tasksDir, `${sessionId}.json`) }), { mode: 0o600 });
      // The compiled plugin resolves its sibling .js; Node 24 can run source .ts directly.
      const runner = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './task-runner.ts' : './task-runner.js', import.meta.url));
      args = [process.execPath, runner, configPath];
    }
    if (resume) await checkAvailable();
    const hostInstance = await describeHost();
    const pane = await host.create({ cwd, argv: args, ...(env ? { env } : {}), name: `${executorId}-${sessionId}`, ...(params.mode === 'task' ? { keepOpen: true } : {}) });
    const result: SessionBinding = {
      sessionId, paneId: pane.id, executorId, cwd, createdAt: new Date().toISOString(),
      ...(options.machineId ? { machineId } : {}), ...(agentInstanceId ? { agentInstanceId } : {}),
      hostKind: hostInstance.hostKind,
      ...(hostInstance.identity.state === 'known' ? { hostInstanceId: hostInstance.identity.id } : {}),
      ...(nativeResume ? { nativeResume, nativeSessionId: nativeResume.nativeSessionId } : {}),
    };
    bindings.set(sessionId, result);
    try { save(); } catch (error) {
      bindings.delete(sessionId);
      throw new Error(`CLI may be running in pane ${pane.id}, but binding persistence failed; outcome unknown`, { cause: error });
    }
    currentSessions.add(sessionId);
    if (endpoint) codexEndpoints.set(sessionId, endpoint);
    return { ...copyBinding(result), ...(workerKey ? { workerToolKeyHash: createHash('sha256').update(workerKey).digest('hex') } : {}) };
  }
  const handlers: Record<string, NodeHandler> = {
    ...knowledgeWorker.handlers,
    'executor.start': params => launch(params),
    ...(options.validateResume ? { 'executor.resume': (params: JsonObject) => launch(params, true) } : {}),
    'executor.recovery': async params => {
      if (Object.keys(params).some(key => key !== 'sessionId')) throw new Error('Invalid recovery parameters');
      const selected = params.sessionId === undefined ? [...bindings.values()] : [binding(params)];
      return { ...scope, host: { ...await describeHost() }, sessions: selected.map(b => {
        const current = currentSessions.has(b.sessionId);
        return { sessionId: b.sessionId, paneId: b.paneId, origin: current ? 'current-agent' : 'restored',
          canObserve: current, canControl: current, ...(current ? {} : { reason: recoveryReason }) };
      }) };
    },
    'executor.sessions': async () => [...bindings.values()].map(copyBinding),
    'executor.result': async params => {
      const b = binding(params);
      const path = join(resolve(options.dataDir), 'task-results', `${b.sessionId}.json`);
      if (existsSync(path)) return { ...readTaskResult(path) };
      if (!currentSessions.has(b.sessionId)) return { state: 'unknown', source: 'runner', text: recoveryReason + '; no native task result is available' };
      if (isTaskSession(b)) return { ...readTaskResult(path) };
      return { state: 'unknown', text: (await host.read(b.paneId)).text, source: 'screen' };
    },
    'executor.read': async params => {
      const b = binding(params);
      assertCurrentPane(b.paneId);
      const result = await host.read(b.paneId);
      return { ...result, state: 'unknown', source: 'screen' };
    },
    'executor.input': async params => {
      const b = binding(params);
      assertCurrentPane(b.paneId);
      if (isTaskSession(b)) throw new Error('Task sessions do not accept interactive input');
      const text = inputText(params);
      return write(b.paneId, () => submitText(b.paneId, text));
    },
    'executor.input.once': async params => {
      if (Object.keys(params).some(key => !['sessionId', 'clientMessageId', 'text'].includes(key))) throw new Error('Invalid input parameters');
      const b = binding(params), text = inputText(params), id = string(params, 'clientMessageId');
      if (Array.from(id).length > 200 || /[\s\p{Cc}]/u.test(id)) throw new Error('Invalid clientMessageId');
      const key = JSON.stringify([b.sessionId, id]);
      const pending = pendingInput.get(key);
      if (pending) {
        if (pending.text !== text) throw new Error('clientMessageId was already used with different input');
        return pending.job;
      }
      const endpoint = codexEndpoints.get(b.sessionId);
      const job = submitInputOnce(options.dataDir, machineId, b.sessionId, id, text, action => {
        assertCurrentPane(b.paneId);
        if (isTaskSession(b)) throw new Error('Task sessions do not accept interactive input');
        return write(b.paneId, action);
      }, () => endpoint ? startCodexTopicTurn(endpoint, text) : submitText(b.paneId, text)).finally(() => pendingInput.delete(key));
      pendingInput.set(key, { text, job });
      return job;
    },
    'executor.turnResult': async params => {
      if (Object.keys(params).some(key => !['sessionId','clientMessageId','nativeSessionId','turnId'].includes(key))) throw new Error('Invalid turn result parameters');
      const b = binding(params), endpoint = codexEndpoints.get(b.sessionId);
      const ids = {sessionId:b.sessionId,clientMessageId:string(params,'clientMessageId'),nativeSessionId:string(params,'nativeSessionId'),turnId:string(params,'turnId')};
      const unknown = {state:'unknown',...ids};
      if (!endpoint || endpoint.nativeSessionId !== ids.nativeSessionId) return unknown;
      try {
        const hash = nativeInputFingerprint(options.dataDir, machineId, b.sessionId, ids.clientMessageId, ids);
        if (!hash) return unknown;
        const result = await codexTopicAnswer(endpoint, ids.turnId, hash);
        if (result.state === 'completed' && nativeInputFingerprint(options.dataDir, machineId, b.sessionId, ids.clientMessageId, ids) !== hash) return unknown;
        return { ...ids, source:'codex-app-server', ...result } as Json;
      } catch { return unknown; }
    },
    'executor.interrupt': async params => { const b = binding(params); return write(b.paneId, () => host.keys(b.paneId, ['C-c'])); },
    'terminal.list': async () => (await host.list()).map(p => ({ ...p })),
    'terminal.create': async params => {
      const pane = await host.create({ cwd: directory(string(params, 'cwd')), argv: argv(params.argv), name: string(params, 'name') });
      owned.add(pane.id);
      return { ...pane };
    },
    'terminal.read': async params => { const id = string(params, 'paneId'); assertCurrentPane(id); return { ...await host.read(id) }; },
    'terminal.input': async params => { const id = string(params, 'paneId'); assertCurrentPane(id); if (isTaskPane(id)) throw new Error('Task sessions do not accept interactive input'); const text = inputText(params); return write(id, () => host.input(id, text)); },
    'terminal.keys': async params => { const id = string(params, 'paneId'); assertCurrentPane(id); const keys = argv(params.keys); if (isTaskPane(id) && (keys.length !== 1 || keys[0] !== 'C-c')) throw new Error('Task sessions only accept C-c interrupt'); return write(id, () => host.keys(id, keys)); },
    'terminal.close': async params => { const id = string(params, 'paneId'); return write(id, async () => { await host.close(id); owned.delete(id); }); },
    'terminal.watch': async (params, emit) => {
      const paneId = string(params, 'paneId');
      assertCurrentPane(paneId);
      const watchId = randomUUID();
      const watch = { active: true, ready: Promise.resolve<Dispose>(() => {}) };
      watches.set(watchId, watch);
      watch.ready = Promise.resolve().then(() => host.watch(paneId,
        frame => { if (watch.active) emit('terminal.frame', { watchId, paneId, ...frame }); },
        error => { if (watch.active) emit('terminal.error', { watchId, paneId, error: error.message }); }));
      try { await watch.ready; } catch (error) { watch.active = false; watches.delete(watchId); throw error; }
      return { watchId };
    },
    'terminal.unwatch': async params => { await unwatch(string(params, 'watchId')); return { requested: true }; },
  };
  if (!codexSocket) delete handlers['executor.turnResult'];
  return {
    handlers,
    async describe(machineId) {
      const status = await host.status();
      return Object.entries(commands).map(([id, command]) => {
        const configuredCommand = launchers[id as keyof typeof commands]?.command ?? command;
        const present = hasCommand(configuredCommand);
        return { id, name: id === 'pi' ? 'Pi' : id === 'codex' ? 'Codex' : 'Claude Code', kind: 'cli', machineId, defaultCwd: process.cwd(), available: status.available && present, mode: 'real',
          supportsModel: true,
          ...(id === 'pi' ? { taskOnly: true, nativeResultSources: ['pi-json'] } : options.validateResume ? { nativeResultSources: [id === 'codex' ? 'codex-json' : 'claude-stream-json'] } : {}),
          description: id === 'pi' ? 'pi CLI 单次任务，使用 JSONL 事件采集结果。可用性仅检查终端和命令。' : '交互式 PTY；可用性仅检查终端和 PATH，不证明已认证。屏幕状态为 unknown；未接入原生 hook 或审批。',
          ...(!status.available ? { reason: status.reason ?? 'Terminal host unavailable' } : !present ? { reason: `${command} is not on PATH` } : {}) };
      });
    },
    close: () => knowledgeWorker.close(),
    async disconnect() {
      const results = await Promise.allSettled([...watches.keys()].map(unwatch));
      const failed = results.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
