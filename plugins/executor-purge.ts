import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject, SessionBinding } from '../packages/protocol/src/index.ts';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
function regular(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new Error('托管记录路径类型异常，未确认清理');
  return Boolean(info);
}
function readRecord(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('托管记录不是普通文件');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

// Only the project's server-side purge coordinator may attest this exact run/session mapping.
// Keep a digest so a lost response can be retried after restart without retaining the prompt or cwd.
export function purgeExecutorSession(params: JsonObject, options: {
  dataDir: string; machineId: string; bindings: Map<string, SessionBinding>;
  forget: (sessionId: string, directory: string) => void;
}) {
  const { projectId, runId, sessionId, status } = params;
  if (Object.keys(params).some(key => !['projectId', 'runId', 'sessionId', 'status'].includes(key)) ||
    typeof projectId !== 'string' || !projectId.trim() || typeof runId !== 'string' || !runId.trim() ||
    typeof sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(sessionId) ||
    !['completed', 'failed', 'cancelled'].includes(String(status))) throw new Error('需指定项目、执行和已结束的托管会话');
  const reply = { projectId, runId, sessionId, purged: true };
  const identity = createHash('sha256').update(JSON.stringify([options.machineId, projectId, runId, sessionId])).digest('hex');
  const rootFd = openSync(options.dataDir, directoryFlags);
  const root = '/proc/self/fd/' + rootFd;
  let taskFd: number | undefined;
  let receiptsFd: number | undefined;
  try {
    const binding = options.bindings.get(sessionId);
    if (binding && binding.machineId !== options.machineId) throw new Error('无法确认绑定属于这台执行机');
    const store = join(root, 'executor-sessions.json');
    if (!regular(store)) throw new Error('缺少执行机会话存储');
    const persisted = JSON.parse(readRecord(store));
    if (!Array.isArray(persisted) || JSON.stringify(persisted) !== JSON.stringify([...options.bindings.values()])) throw new Error('执行机会话存储已变化，请重新核实');

    const receipts = join(root, 'executor-purge-receipts');
    if (binding) mkdirSync(receipts, { recursive: true, mode: 0o700 });
    receiptsFd = openSync(receipts, directoryFlags);
    const receipt = join('/proc/self/fd', String(receiptsFd), sessionId);
    const accepted = regular(receipt);
    if (accepted && readRecord(receipt) !== identity) throw new Error('清理凭据与项目执行不匹配');
    if (!binding && !accepted) throw new Error('缺少执行机会话归属证据');

    try { taskFd = openSync(join(root, 'task-results'), directoryFlags); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const paths = taskFd === undefined ? [] : ['.config.json', '.json.last-message', '.json']
      .map(suffix => join('/proc/self/fd', String(taskFd), sessionId + suffix)).filter(regular);
    if (!binding) {
      if (paths.length) throw new Error('已移除绑定后出现残留文件，请核实归属');
      return reply;
    }
    if (!accepted && paths.length) {
      const resultPath = paths.find(path => path.endsWith('/' + sessionId + '.json'));
      if (!resultPath) throw new Error('尚无 runner 结束证据');
      const result = JSON.parse(readRecord(resultPath));
      // A failure event can precede process exit. Only the final close record carries exitCode.
      if (!Number.isInteger(result.exitCode) || !['completed', 'failed', 'unknown'].includes(result.state)) throw new Error('尚无 runner 结束证据');
    }
    if (!accepted) {
      const temp = receipt + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temp, identity, { flag: 'wx', mode: 0o600 });
        renameSync(temp, receipt);
      } finally { if (regular(temp)) unlinkSync(temp); }
    }
    // The receipt precedes deletion, and the binding is removed last. Retrying can finish either step.
    for (const path of paths) unlinkSync(path);
    options.forget(sessionId, root);
    return reply;
  } finally {
    if (taskFd !== undefined) closeSync(taskFd);
    if (receiptsFd !== undefined) closeSync(receiptsFd);
    closeSync(rootFd);
  }
}
