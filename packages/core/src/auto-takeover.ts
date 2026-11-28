import { isAbsolute, relative, resolve } from 'node:path';
import type { EventBus, MachineClient, Store } from '../../plugin-sdk/src/index.ts';
import type { Project } from '../../protocol/src/index.ts';
import type { Card } from './interactions.ts';

const recordsCollection = 'takeover.records';
const settingsCollection = 'takeover.settings';

export interface TakeoverSettings {
  enabled: boolean;
  autoTrustBoundProjects: boolean;
  scanIntervalSec: number;
}

export interface TakeoverPrompt {
  key: string;
  machineId: string;
  machineName: string;
  paneId: string;
  terminalId: string;
  cwd: string;
  paneTitle: string;
  agent: string;
  projectId?: string;
  kind: 'trust_dir' | 'permission' | 'choice';
  rev: string;
  title: string;
  excerpt: string;
  options: Array<{ label: string; keys: string }>;
  status: 'open' | 'auto_answered' | 'user_answered' | 'withdrawn' | 'failed';
  cardId?: string;
  actionNote?: string;
  observedAt: string;
  updatedAt: string;
}

const defaults: TakeoverSettings = {
  enabled: true,
  autoTrustBoundProjects: true,
  scanIntervalSec: 15,
};

function within(root: string, path: string): boolean {
  const rest = relative(resolve(root), resolve(path));
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../'));
}

/**
 * Automated terminal prompt takeover coordinator:
 * 1. Scans online Herdr machines for blocked terminal dialogs (trust_dir / permission / choice).
 * 2. Auto-answers safe trust_dir dialogs inside bound project directories (with rev check).
 * 3. Opens interactive cards for permissions/choices so Web & Feishu can answer remotely.
 * 4. Automatically withdraws open cards if the user already answered locally on their computer.
 */
export function createAutoTakeover(options: {
  store: Store;
  events: EventBus;
  machines: () => MachineClient | undefined;
  openCard: (input: { kind: 'question' | 'permission'; title: string; body: string; projectId?: string; executorId?: string; cwd?: string }) => Card;
  withdrawCard?: (id: string) => void;
  verifyAutomaticKeys?: (machineId:string,paneId:string)=>Promise<()=>boolean>;
}) {
  const { store, events } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let scanning = false;
  let closed = false;

  const settings = (): TakeoverSettings => ({
    ...defaults,
    ...store.get<Partial<TakeoverSettings>>(settingsCollection, 'default'),
  });

  function configure(patch: Partial<TakeoverSettings>): TakeoverSettings {
    const next: TakeoverSettings = {
      ...settings(),
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(typeof patch.autoTrustBoundProjects === 'boolean' ? { autoTrustBoundProjects: patch.autoTrustBoundProjects } : {}),
      ...(typeof patch.scanIntervalSec === 'number' && Number.isInteger(patch.scanIntervalSec) && patch.scanIntervalSec >= 5 && patch.scanIntervalSec <= 300
        ? { scanIntervalSec: patch.scanIntervalSec } : {}),
    };
    store.put(settingsCollection, 'default', next);
    events.publish('takeover.changed', { enabled: next.enabled, autoTrustBoundProjects: next.autoTrustBoundProjects, scanIntervalSec: next.scanIntervalSec });
    reschedule();
    return next;
  }

  function matchProject(machineId: string, cwd: string): Project | undefined {
    return store.list<Project>('projects').find(
      p => !p.archivedAt && p.workspace?.machineId === machineId && within(p.workspace.cwd, cwd),
    );
  }

  async function answerPrompt(key: string, keys: string, by: 'auto' | 'user' = 'user'): Promise<TakeoverPrompt> {
    const rec = store.get<TakeoverPrompt>(recordsCollection, key);
    if (!rec) throw Object.assign(new Error('未找到对应的终端卡点记录'), { status: 404 });
    if (rec.status !== 'open') throw Object.assign(new Error('该终端卡点已处理，无需重复操作'), { status: 409 });
    if (!rec.options.some(opt => opt.keys === keys)) throw Object.assign(new Error('不支持的终端按键选项'), { status: 400 });
    const hub = options.machines();
    if (!hub) throw Object.assign(new Error('执行机网关未就绪'), { status: 503 });
    if (by==='auto' && options.verifyAutomaticKeys) {
      const current=await options.verifyAutomaticKeys(rec.machineId,rec.paneId);
      if (!current()) throw Object.assign(new Error('原执行的自动按键已暂停，请主人核对'),{status:409});
    }
    const res = await hub.call(rec.machineId, 'terminal.live.answer_prompt', {
      paneId: rec.paneId,
      terminalId: rec.terminalId,
      cwd: rec.cwd,
      rev: rec.rev,
      keys,
    }) as { applied?: boolean; reason?: string };
    const now = new Date().toISOString();
    const updated: TakeoverPrompt = res.applied
      ? { ...rec, status: by === 'auto' ? 'auto_answered' : 'user_answered', actionNote: by === 'auto' ? '命中已绑定项目目录信任规则，已自动放行' : '已由用户通过工作台远程按键确认', updatedAt: now }
      : { ...rec, status: 'withdrawn', actionNote: '终端画面已变化（可能已在本地处理），未重复按键', updatedAt: now };
    store.put(recordsCollection, key, updated);
    if (rec.cardId) {
      try { options.withdrawCard?.(rec.cardId); } catch {}
    }
    events.publish('takeover.changed', { key, status: updated.status });
    return updated;
  }

  function pruneClosedRecords() {
    const closedRecords = store.list<TakeoverPrompt>(recordsCollection)
      .filter(rec => rec.status !== 'open')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const stale of closedRecords.slice(60)) {
      store.remove(recordsCollection, stale.key);
    }
  }

  async function scanOnce(): Promise<TakeoverPrompt[]> {
    const cfg = settings();
    if (closed || !cfg.enabled || scanning) return list();
    const hub = options.machines();
    if (!hub) return list();
    scanning = true;
    try {
      const online = hub.list().filter(m => m.online && m.capabilities.includes('terminal.live.scan_prompts'));
      const succeededMachines = new Set<string>();
      const seenKeys = new Set<string>();
      const now = new Date().toISOString();

      type ScannedResult = { prompts?: Array<{ paneId: string; terminalId: string; cwd: string; title: string; agent: string; prompt: { kind: 'trust_dir' | 'permission' | 'choice'; rev: string; title: string; excerpt: string; options: Array<{ label: string; keys: string }> } }> };
      const settled = await Promise.allSettled(online.map(async m => ({
        machine: m,
        scanned: await hub.call(m.id, 'terminal.live.scan_prompts', {}, { timeoutMs: 12000 }) as ScannedResult,
      })));

      for (const outcome of settled) {
        if (outcome.status !== 'fulfilled') continue;
        const { machine: m, scanned } = outcome.value;
        succeededMachines.add(m.id);
        for (const item of scanned.prompts ?? []) {
          const key = `${m.id}:${item.terminalId}:${item.prompt.rev}`;
          seenKeys.add(key);
          const existing = store.get<TakeoverPrompt>(recordsCollection, key);
          if (existing) continue;

          const project = matchProject(m.id, item.cwd);
          const record: TakeoverPrompt = {
            key,
            machineId: m.id,
            machineName: m.name,
            paneId: item.paneId,
            terminalId: item.terminalId,
            cwd: item.cwd,
            paneTitle: item.title,
            agent: item.agent,
            ...(project ? { projectId: project.id } : {}),
            kind: item.prompt.kind,
            rev: item.prompt.rev,
            title: item.prompt.title,
            excerpt: item.prompt.excerpt,
            options: item.prompt.options,
            status: 'open',
            observedAt: now,
            updatedAt: now,
          };
          store.put(recordsCollection, key, record);

          // Auto-approve trust_dir inside explicitly bound project workspaces.
          if (cfg.autoTrustBoundProjects && record.kind === 'trust_dir' && project && record.options[0]) {
            try {
              await answerPrompt(key, record.options[0].keys, 'auto');
              continue;
            } catch { /* fall through to user card */ }
          }

          // Otherwise open an interaction card so Web & Feishu notify the user.
          try {
            const optText = record.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
            const card = options.openCard({
              kind: record.kind === 'permission' ? 'permission' : 'question',
              title: `${record.title} · ${record.paneTitle}`,
              body: `机器：${record.machineName} · 目录：${record.cwd}\n\n${record.excerpt}\n\n可选操作：\n${optText}`,
              ...(project ? { projectId: project.id } : {}),
              executorId: `${m.id}/${record.agent}`,
              cwd: record.cwd,
            });
            store.put(recordsCollection, key, { ...record, cardId: card.id });
          } catch { /* keep record open in takeover list */ }
          events.publish('takeover.changed', { key, status: 'open' });
        }
      }

      // Withdraw stale open prompts only for machines whose scan actually succeeded.
      for (const rec of store.list<TakeoverPrompt>(recordsCollection)) {
        if (rec.status !== 'open') continue;
        if (!succeededMachines.has(rec.machineId)) continue;
        if (!seenKeys.has(rec.key)) {
          store.put(recordsCollection, rec.key, { ...rec, status: 'withdrawn', actionNote: '终端对话框已消失（可能已在本地电脑处理）', updatedAt: now });
          if (rec.cardId) { try { options.withdrawCard?.(rec.cardId); } catch {} }
          events.publish('takeover.changed', { key: rec.key, status: 'withdrawn' });
        }
      }
      pruneClosedRecords();
    } finally {
      scanning = false;
    }
    return list();
  }

  function list(): TakeoverPrompt[] {
    const all = store.list<TakeoverPrompt>(recordsCollection)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const open = all.filter(rec => rec.status === 'open');
    const recentClosed = all.filter(rec => rec.status !== 'open').slice(0, 20);
    return [...open, ...recentClosed];
  }

  function reschedule() {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (closed || !settings().enabled) return;
    timer = setInterval(() => { void scanOnce().catch(() => {}); }, settings().scanIntervalSec * 1000);
    timer.unref();
  }

  return {
    settings,
    configure,
    list,
    scanOnce,
    answerPrompt,
    start() { if (!closed) reschedule(); },
    close() { closed = true; if (timer) clearInterval(timer); timer = undefined; },
  };
}
