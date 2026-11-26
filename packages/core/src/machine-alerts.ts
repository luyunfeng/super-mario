// What is worth telling the owner about a computer before it stops working: a disk nearly full,
// the processors busy for minutes on end, memory nearly used up. Each computer is read every
// few minutes; a condition is told once, and again only after it went away and came back.
import type { MachineClient } from '../../plugin-sdk/src/index.ts';
import type { Json, MachineInfo } from '../../protocol/src/index.ts';

/** What one computer is told of, and what it was last told. */
interface MachineAlertState {
  /** The conditions this computer was last told of, by name. */
  told: string[];
  updatedAt: string;
}

/** The thresholds, as whole percents. They are the only tuning here, and are not a setting:
 *  a disk that is 90% full is worth a look on any computer. */
export const THRESHOLDS = { disk: 90, memory: 90, cpu: 90 } as const;
/** How long the processors must stay busy before it is worth a message. */
export const CPU_BUSY_FOR_MS = 5 * 60 * 1000;
/** How often each online computer is read. */
export const CHECK_EVERY_MS = 5 * 60 * 1000;

const COLLECTION = 'machine-alerts';

/** One condition worth telling of. */
export interface Alert { name: string; text: string }

/** A whole percent from what a computer said, or undefined when it did not say one. */
function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : undefined;
}

/** What the readings of one computer say is worth telling of. Pure: it reads nothing and tells
 *  no one. What the computer said is read as data and not trusted to be well-formed. */
export function findAlerts(storage: unknown, resources: unknown, now = Date.now()): Alert[] {
  const alerts: Alert[] = [];
  const mounts = (storage as { mounts?: unknown } | null | undefined)?.mounts;
  for (const mount of Array.isArray(mounts) ? mounts : []) {
    const path = (mount as { mount?: unknown } | null)?.mount;
    const used = percent((mount as { usedPercent?: unknown } | null)?.usedPercent);
    if (typeof path === 'string' && path && used !== undefined && used >= THRESHOLDS.disk) alerts.push({ name: 'disk:' + path, text: path + ' 已用 ' + used + '%，快满了。' });
  }
  const resource = resources as { samples?: unknown; memory?: { usedPercent?: unknown } } | null | undefined;
  const samples = (Array.isArray(resource?.samples) ? resource.samples : []) as { at?: unknown; cpuPercent?: unknown; memoryPercent?: unknown }[];
  const memory = percent(samples.at(-1)?.memoryPercent) ?? percent(resource?.memory?.usedPercent);
  if (memory !== undefined && memory >= THRESHOLDS.memory) alerts.push({ name: 'memory', text: '内存已用 ' + memory + '%。' });
  // The processors are worth a message only when they have been busy for minutes: a build or a
  // test run is busy for a moment and is not a problem.
  const since = now - CPU_BUSY_FOR_MS;
  const recent = samples.filter(sample => typeof sample.at === 'string' && Date.parse(sample.at) >= since);
  const busy = recent.map(sample => percent(sample.cpuPercent));
  if (recent.length >= 3 && busy.every(value => value !== undefined && value >= THRESHOLDS.cpu)) alerts.push({ name: 'cpu', text: '处理器已连续 ' + Math.round(CPU_BUSY_FOR_MS / 60000) + ' 分钟在 ' + THRESHOLDS.cpu + '% 以上。' });
  return alerts;
}

/** Which alerts are new, given what this computer was already told of. */
export function newAlerts(alerts: Alert[], told: string[]): Alert[] {
  return alerts.filter(alert => !told.includes(alert.name));
}

export function createMachineAlerts({ store, machines, notify, enabled = () => true, now = () => new Date() }: {
  store: { get<T>(collection: string, id: string): T | undefined; put(collection: string, id: string, value: unknown): void; remove(collection: string, id: string): boolean };
  machines: Pick<MachineClient, 'list' | 'call'>;
  notify: (input: Record<string, unknown>) => Json;
  /** Whether the owner wants to be told of computers at all. */
  enabled?: () => boolean;
  now?: () => Date;
}) {
  /** Reads each online computer once and tells the owner of what is new. */
  async function check(): Promise<{ checked: number; told: number }> {
    let checked = 0, told = 0;
    // Turned off: nothing is read, and what each computer was told of is kept for when it is on again.
    if (!enabled()) return { checked, told };
    for (const machine of machines.list().filter(row => row.online)) {
      const storage = machine.capabilities.includes('machine.storage') ? await read(machines, machine, 'machine.storage') : undefined;
      const resources = machine.capabilities.includes('machine.resources') ? await read(machines, machine, 'machine.resources') : undefined;
      if (!storage && !resources) continue;
      checked++;
      const found = findAlerts(storage, resources, now().getTime());
      const previous = store.get<MachineAlertState>(COLLECTION, machine.id);
      const fresh = newAlerts(found, previous?.told ?? []);
      for (const alert of fresh) {
        // The key names this telling, and not the condition: a condition that comes back is told
        // of again, and a message that is retried on its way is still delivered once.
        notify({ title: machine.name + '：' + alert.text, text: '这台电脑需要你看一下。' + alert.text, urgency: 'now', dedupKey: 'machine-alert:' + machine.id + ':' + alert.name + ':' + now().toISOString() });
        told++;
      }
      // What this computer is now told of: the conditions it has, kept across checks, and the
      // ones that went away dropped, so that they can be told of again if they come back.
      store.put(COLLECTION, machine.id, { told: found.map(alert => alert.name), updatedAt: now().toISOString() } satisfies MachineAlertState);
    }
    return { checked, told };
  }
  return { check };
}

/** One reading of a computer, or undefined when it cannot be had. A computer that is going
 *  offline, or an agent too old for the reading, is left out and not treated as a failure. */
async function read(machines: Pick<MachineClient, 'list' | 'call'>, machine: MachineInfo, method: string): Promise<Json | undefined> {
  try { return await machines.call(machine.id, method, {}, { timeoutMs: 15_000 }); }
  catch { return undefined; }
}
