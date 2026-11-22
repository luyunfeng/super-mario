import type { Json, NativeExportSource } from '../packages/protocol/src/index.ts';

export function nativeSource(value: Json | undefined): NativeExportSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['machineId', 'executorId', 'nativeSessionId', 'cwd'].includes(key)))
    throw Object.assign(new Error('原生会话来源无效'), { status: 400 });
  const { machineId, executorId, nativeSessionId, cwd } = value;
  if (typeof machineId !== 'string' || !machineId.trim() || typeof nativeSessionId !== 'string' || !nativeSessionId.trim()
    || typeof cwd !== 'string' || !cwd.trim() || (executorId !== 'codex' && executorId !== 'claude-code')
    || [machineId, nativeSessionId, cwd].some(field => /[\p{Cc}\p{Cs}]/u.test(field)))
    throw Object.assign(new Error('原生会话来源无效'), { status: 400 });
  return { machineId, executorId, nativeSessionId, cwd };
}
