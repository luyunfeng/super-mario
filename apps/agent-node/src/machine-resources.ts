// How busy this computer is: its processors, its memory, and how both have been over the last
// minutes. It is a read of what the kernel keeps, not a probe, so it costs nothing to take.
import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem, loadavg, uptime as systemUptime } from 'node:os';
import type { Json, NodeHandler } from '../../../packages/plugin-sdk/src/index.ts';

/** One sample of how busy the computer was. */
export interface ResourceSample {
  at: string;
  /** The share of processor time that was busy, 0 to 100. */
  cpuPercent: number;
  /** The share of memory in use, 0 to 100. */
  memoryPercent: number;
  /** The load averages over 1, 5 and 15 minutes, where the computer has them. */
  load: number[];
}

/** What one read found. */
export interface ResourcesReport {
  at: string;
  os: string;
  supported: boolean;
  /** The processors, as the computer counts them. */
  cpus: number;
  memory: { totalBytes: number; freeBytes: number; usedPercent: number };
  load: number[];
  /** How long the computer has been up, in seconds. */
  uptimeSeconds: number;
  /** The last few minutes, oldest first. It is short when the agent has just started. */
  samples: ResourceSample[];
  /** How long a sample is kept, in seconds. */
  windowSeconds: number;
}

/** The first numbers of the kernel's cpu line, which count time in each state. */
function cpuTimes(text: string): { idle: number; total: number } | undefined {
  const line = text.split('\n').find(row => row.startsWith('cpu '));
  if (!line) return undefined;
  const values = line.slice(4).trim().split(/\s+/).map(Number);
  if (values.length < 4 || values.some(value => !Number.isFinite(value))) return undefined;
  // guest is already counted in user, and guest_nice in nice, so they are not added again.
  const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0);
  // user nice system idle iowait irq softirq steal: idle and iowait are processor time with
  // nothing to do; irq and softirq are work.
  const idle = values[3]! + values[4]!;
  return { idle, total };
}

/** How busy the processors were between two readings of the kernel's counters. */
export function cpuBetween(before: { idle: number; total: number }, after: { idle: number; total: number }): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  const idle = Math.max(0, after.idle - before.idle);
  return Math.min(100, Math.max(0, Math.round((1 - idle / total) * 100)));
}

export function percent(used: number, total: number): number {
  return total > 0 ? Math.round(used / total * 100) : 0;
}

/** The most that is kept of the computer's own history, and for how long. */
export const WINDOW_SECONDS = 15 * 60;
const SAMPLE_EVERY_MS = 5000;
/** The sampler stops when nothing has asked for this long: a computer nobody is looking at is
 *  not read every few seconds. */
const IDLE_AFTER_MS = 60_000;

/** Reads the computer's counters once. Tests pass their own readers. */
export async function readCounters(options: {
  cpuText?: () => Promise<string>;
  cpus?: () => { length: number };
  memory?: () => { total: number; free: number };
  load?: () => number[];
  uptime?: () => number;
  platform?: string;
} = {}) {
  const cpuText = await (options.cpuText ?? (() => readFile('/proc/stat', 'utf8')))();
  const times = cpuTimes(cpuText);
  const memory = (options.memory ?? (() => ({ total: totalmem(), free: freemem() })))();
  return {
    times,
    cpus: (options.cpus ?? ((): { length: number } => cpus()))().length,
    memory,
    load: (options.load ?? (() => loadavg()))(),
    uptime: (options.uptime ?? (() => Math.floor(systemUptime())))(),
    platform: options.platform ?? process.platform,
  };
}

/** The handler a machine offers for reading its resources. The first call starts a sampler
 *  that keeps the last fifteen minutes; it stops when nothing has asked for a while. */
export function createMachineResourcesNode(options: Parameters<typeof readCounters>[0] = {}, timers: {
  now?: () => number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval;
} = {}) {
  const now = timers.now ?? Date.now;
  const samples: { at: number; sample: ResourceSample }[] = [];
  let previous: { at: number; times: { idle: number; total: number } } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastAsked = 0;
  async function sample() {
    const read = await readCounters(options);
    const at = now();
    const cpu = previous && read.times ? cpuBetween(previous.times, read.times) : 0;
    if (read.times) previous = { at, times: read.times };
    samples.push({ at, sample: { at: new Date(at).toISOString(), cpuPercent: cpu, memoryPercent: percent(read.memory.total - read.memory.free, read.memory.total), load: read.load } });
    while (samples.length && samples[0]!.at < at - WINDOW_SECONDS * 1000) samples.shift();
    return read;
  }
  // The first reading has no earlier one to compare with, so the first sample is of memory only.
  function ensureSampling() {
    lastAsked = now();
    if (timer) return;
    // One sample at once, so that a page that asks right after it opens has more than one point.
    void sample().catch(() => {});
    timer = (timers.setInterval ?? setInterval)(() => {
      if (now() - lastAsked > IDLE_AFTER_MS) { stop(); return; }
      void sample().catch(() => {});
    }, SAMPLE_EVERY_MS);
    timer.unref?.();
  }
  const handlers: Record<string, NodeHandler> = {
    'machine.resources': async params => {
      if (Object.keys(params).length) throw new Error('读取资源不接受参数');
      const platform = options.platform ?? process.platform;
      if (platform !== 'linux') return { at: new Date(now()).toISOString(), os: platform, supported: false, cpus: 0, memory: { totalBytes: 0, freeBytes: 0, usedPercent: 0 }, load: [], uptimeSeconds: 0, samples: [], windowSeconds: WINDOW_SECONDS } as unknown as Json;
      ensureSampling();
      // The reading is of now; the samples are the sampler's, taken at their own steady pace.
      const read = await readCounters(options);
      return {
        at: new Date(now()).toISOString(), os: platform, supported: true, cpus: read.cpus,
        memory: { totalBytes: read.memory.total, freeBytes: read.memory.free, usedPercent: percent(read.memory.total - read.memory.free, read.memory.total) },
        load: read.load, uptimeSeconds: read.uptime, samples: samples.map(row => row.sample), windowSeconds: WINDOW_SECONDS,
      } as unknown as Json;
    },
  };
  function stop() { if (timer) (timers.clearInterval ?? clearInterval)(timer); timer = undefined; }
  return { handlers, stop };
}
