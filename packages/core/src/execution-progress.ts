import type { ExecutionProgress } from '../../protocol/src/index.ts';

/** Validate adapter observations without importing vendor event formats into core. */
export function executionProgress(value: unknown): ExecutionProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (!['starting', 'thinking', 'tool', 'responding', 'waiting'].includes(String(item.phase))
    || typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt))) return;
  for (const [key, max] of [['toolName', 100], ['detail', 300]] as const) {
    if (item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > max || /[\p{Cc}]/u.test(item[key]))) return;
  }
  return { phase: item.phase as ExecutionProgress['phase'], observedAt: item.observedAt,
    ...(item.toolName ? { toolName: item.toolName as string } : {}), ...(item.detail ? { detail: item.detail as string } : {}) };
}
