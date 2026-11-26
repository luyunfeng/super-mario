import assert from 'node:assert/strict';
import test from 'node:test';
import { cpuBetween, createMachineResourcesNode, readCounters } from '../apps/agent-node/src/machine-resources.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';

/** A cpu line with the given counters, as /proc/stat writes it: user nice system idle iowait irq softirq steal. */
const cpuLine = (values: number[]) => 'cpu  ' + values.join(' ') + '\ncpu0 1 0 0 1 0 0 0 0\n';

test('how busy the processors were is read from two readings of the counters', () => {
  const before = { idle: 100, total: 200 };
  assert.equal(cpuBetween(before, { idle: 150, total: 300 }), 50);
  assert.equal(cpuBetween(before, { idle: 100, total: 300 }), 100);
  assert.equal(cpuBetween(before, { idle: 200, total: 300 }), 0);
  // Counters that went backwards, as after a restart, say nothing rather than a negative number.
  assert.equal(cpuBetween(before, { idle: 10, total: 20 }), 0);
  assert.equal(cpuBetween(before, before), 0);
});

test('the counters are read once, with memory as a share and the load as the computer gives it', async () => {
  const read = await readCounters({
    cpuText: async () => cpuLine([10, 0, 5, 80, 2, 1, 1, 1]),
    cpus: () => ({ length: 8 }),
    memory: () => ({ total: 1000, free: 250 }),
    load: () => [1.5, 2.25, 3],
    uptime: () => 86400,
  });
  // user 10, nice 0, system 5, idle 80, iowait 2, irq 1, softirq 1, steal 1: idle and iowait are
  // idle, the rest is work, and guest is not added again.
  assert.deepEqual(read.times, { idle: 80 + 2, total: 100 });
  assert.equal(read.cpus, 8);
  assert.deepEqual(read.memory, { total: 1000, free: 250 });
  assert.deepEqual(read.load, [1.5, 2.25, 3]);
  assert.equal(read.uptime, 86400);
  // A cpu line that is not there says nothing, and does not fail the reading.
  assert.equal((await readCounters({ cpuText: async () => '', memory: () => ({ total: 1, free: 1 }) })).times, undefined);
  assert.equal((await readCounters({ cpuText: async () => 'cpu  1 2', memory: () => ({ total: 1, free: 1 }) })).times, undefined);
});

test('the first reading has one sample, the sampler adds to it, and old samples drop off', async () => {
  let clock = Date.parse('2026-11-27T00:00:00Z');
  const intervals: (() => void)[] = [];
  const cleared: unknown[] = [];
  let counters = [10, 0, 5, 80, 2, 1, 1, 1];
  const node = createMachineResourcesNode({
    cpuText: async () => cpuLine(counters),
    cpus: () => ({ length: 4 }),
    memory: () => ({ total: 1000, free: 1000 - (clock % 60000) / 60 }),
    load: () => [0, 0, 0],
  }, { now: () => clock, setInterval: ((callback: () => void) => { intervals.push(callback); return { unref() {} }; }) as unknown as typeof setInterval,
    clearInterval: timer => { cleared.push(timer); } });
  const handler = node.handlers['machine.resources']!;
  const first = await handler({}, () => {}) as Json as { samples: { at: string; cpuPercent: number; memoryPercent: number }[]; memory: { usedPercent: number }; cpus: number };
  // The first sample has no earlier counters to compare with, so its cpu is 0 and not made up.
  assert.equal(first.samples.length, 1);
  assert.equal(first.samples[0]!.cpuPercent, 0);
  assert.equal(first.memory.usedPercent, 0);
  assert.equal(first.cpus, 4);
  // Five seconds pass and half the processor time was busy: the sampler's next point says so.
  clock += 5000;
  counters = [10 + 50, 0, 5, 80 + 50, 2, 1, 1, 1];
  for (const tick of [...intervals]) tick();
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await handler({}, () => {}) as Json as { samples: { at: string; cpuPercent: number }[] };
  assert.equal(second.samples.length, 2);
  assert.equal(second.samples[1]!.cpuPercent, 50);
  assert.equal(second.samples[1]!.at, '2026-11-27T00:00:05.000Z');
  // Fifteen minutes on, the first point is past the window and is dropped.
  clock += 15 * 60 * 1000;
  // The page is still open: it asks again, which keeps the sampler going.
  await handler({}, () => {});
  for (const tick of [...intervals]) tick();
  await new Promise(resolve => setTimeout(resolve, 10));
  const later = await handler({}, () => {}) as Json as { samples: { at: string }[] };
  assert.equal(later.samples.some(row => row.at === '2026-11-27T00:00:00.000Z'), false);
  assert.equal(cleared.length, 0, 'a page that is still asking keeps the sampler on');
  // When nothing has asked for a minute the sampler stops, and its timer is cleared.
  clock += 61_000;
  for (const tick of [...intervals]) tick();
  assert.equal(cleared.length, 1);
  node.stop();
});

test('the reading takes no arguments, and on a system without the files it says so', async () => {
  const node = createMachineResourcesNode({ platform: 'darwin' });
  await assert.rejects(node.handlers['machine.resources']!({ extra: 1 }, () => {}), /不接受参数/);
  const report = await node.handlers['machine.resources']({}, () => {}) as Json as { supported: boolean; samples: unknown[] };
  assert.equal(report.supported, false);
  assert.deepEqual(report.samples, []);
});
