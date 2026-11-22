// Counts for one task invocation. Input includes cache reads and writes.
export type ExecutionUsage = { input: number; output: number };

export function executionUsage(input: unknown, output: unknown): ExecutionUsage | undefined {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0
    || typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) return undefined;
  return { input, output };
}
