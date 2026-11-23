import { createHash, timingSafeEqual } from 'node:crypto';
import { InputError } from '../../../packages/core/src/workbench.ts';
import type { EffectRecord } from '../../../packages/core/src/effects.ts';
import { responsibleSessionTodos } from '../../../packages/core/src/responsible-session.ts';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { MachineInfo, Run } from '../../../packages/protocol/src/index.ts';

/** A session ID identifies a pane on one machine. Only its attested launch key identifies the caller. */
export function currentWorkerTodo(store: Pick<Store, 'get' | 'list'>, machines: MachineInfo[], sessionId: string, key: string) {
  const hash = createHash('sha256').update(key).digest();
  const grants = [];
  for (const run of store.list<Run>('runs')) {
    if (run.sessionId !== sessionId || run.status !== 'running' || !run.machineId || run.executorId !== run.machineId + '/codex') continue;
    const effect = store.get<EffectRecord>('effects', 'run:' + run.id + ':start');
    const result = effect?.result;
    if (effect?.status === 'confirmed' && effect.kind === (run.nativeResume ? 'executor.resume' : 'executor.start') &&
      effect.target === run.machineId && result && typeof result === 'object' && !Array.isArray(result) &&
      result.pending === true && result.sessionId === run.sessionId && typeof result.agentInstanceId === 'string' &&
      machines.some(m => m.online && m.id === run.machineId && m.agentInstanceId === result.agentInstanceId) &&
      typeof result.workerToolKeyHash === 'string' && /^[a-f0-9]{64}$/.test(result.workerToolKeyHash) &&
      timingSafeEqual(hash, Buffer.from(result.workerToolKeyHash,'hex'))) grants.push({run, prompt:effect.summary});
  }
  const grant = grants.length === 1 && grants[0];
  if (!grant) throw new InputError('执行会话凭证无效', 401);
  const todo = responsibleSessionTodos(store)(grant.run);
  if (!todo) throw new InputError('当前会话没有负责的未完成待办', 403);
  return {todo, prompt:grant.prompt, executorId:grant.run.executorId};
}
