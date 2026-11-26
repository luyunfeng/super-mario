import { isAbsolute, relative, sep } from 'node:path';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';

export type PolicyHandler = 'user' | 'main_agent' | 'supervisor' | 'rules';
export interface PolicyStage { handler: PolicyHandler; mode: 'auto' | 'suggest'; answer?: string }
export type PolicyRule = {
  id: string;
  kind: 'question' | 'permission' | 'plan' | 'review';
  handler: 'user' | 'main_agent' | 'supervisor' | 'rules';
  mode?: 'auto' | 'suggest' | 'off';
  answer?: string;
  executorId?: string;
  cwdUnder?: string;
  /** Why the owner allowed this, in their own words or a summary of it. */
  note?: string;
  grantedAt?: string;
  /** Whether an action taken under this rule can be undone. */
  reversible?: boolean;
};
export type PolicyConfig = { rules: PolicyRule[]; escalateAfterMinutes: number; ladder?: PolicyHandler[]; userDeadlineMinutes?: number; agentModes?: Partial<Record<'supervisor' | 'main_agent', 'auto' | 'suggest' | 'off'>> };
export type PolicyScope = { projectId?: string; runId?: string };
export type PolicyCard = PolicyScope & {
  kind: PolicyRule['kind']; executorId?: string; cwd?: string; createdAt?: string;
};
export type PolicyDecision = {
  layer: 'default' | 'global' | 'project' | 'run';
  ruleId: string | null;
  handler: PolicyRule['handler'];
  mode: 'auto' | 'suggest';
  answer: string | null;
  deadlineAt: string;
  userDeadlineAt: string;
  escalationMinutes: number;
  stages: PolicyStage[];
};
const collection = 'policies';
const kinds = ['question', 'permission', 'plan', 'review'];
const handlers = ['user', 'main_agent', 'supervisor', 'rules'];
const defaults: PolicyConfig = { rules: [], escalateAfterMinutes: 3, userDeadlineMinutes: 15, ladder: ['rules', 'supervisor', 'main_agent', 'user'], agentModes: { supervisor: 'suggest', main_agent: 'suggest' } };
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError('无效对象或未知字段');
  }
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('必须为非空文本');
}
function scopeKey(scope: PolicyScope): string {
  object(scope, ['projectId', 'runId']);
  for (const value of Object.values(scope)) text(value);
  return JSON.stringify([scope.projectId ?? null, scope.runId ?? null]);
}
export function validatePolicyPatch(patch: Partial<PolicyConfig>): void {
  object(patch, ['rules', 'escalateAfterMinutes', 'userDeadlineMinutes', 'ladder', 'agentModes']);
  if ('ladder' in patch && (!Array.isArray(patch.ladder) || !patch.ladder.length || patch.ladder.at(-1) !== 'user' || new Set(patch.ladder).size !== patch.ladder.length || !patch.ladder.every(stage => handlers.includes(stage)))) throw new TypeError('ladder必须是不重复的处理者列表，且user在最后');
  if ('userDeadlineMinutes' in patch && (!Number.isSafeInteger(patch.userDeadlineMinutes) || patch.userDeadlineMinutes! < 1 || patch.userDeadlineMinutes! > 43200)) throw new TypeError('userDeadlineMinutes必须为1到43200分钟');
  if ('agentModes' in patch) {
    object(patch.agentModes, ['supervisor', 'main_agent']);
    for (const mode of Object.values(patch.agentModes)) if (!['auto', 'suggest', 'off'].includes(mode)) throw new TypeError('无效Agent处理模式');
  }
  if ('escalateAfterMinutes' in patch && (!Number.isSafeInteger(patch.escalateAfterMinutes)
    || patch.escalateAfterMinutes! < 1 || patch.escalateAfterMinutes! > 43200)) {
    throw new TypeError('escalateAfterMinutes必须为1到43200之间的整数');
  }
  if ('rules' in patch) {
    if (!Array.isArray(patch.rules)) throw new TypeError('rules必须为数组');
    const ids = new Set<string>();
    for (const rule of patch.rules) {
      object(rule, ['id', 'kind', 'handler', 'mode', 'answer', 'executorId', 'cwdUnder', 'note', 'grantedAt', 'reversible']);
      text(rule.id);
      if (ids.has(rule.id)) throw new TypeError('规则id必须唯一');
      ids.add(rule.id);
      if (!kinds.includes(rule.kind) || !handlers.includes(rule.handler)
        || ('mode' in rule && !['auto', 'suggest', 'off'].includes(rule.mode!))) throw new TypeError('无效规则枚举');
      for (const key of ['answer', 'executorId', 'cwdUnder'] as const) if (key in rule) text(rule[key]);
      if (rule.cwdUnder !== undefined && !isAbsolute(rule.cwdUnder)) throw new TypeError('cwdUnder必须为绝对路径');
      for (const key of ['note', 'grantedAt'] as const) {
        if (!(key in rule)) continue;
        text(rule[key]);
        if (rule[key]!.length > (key === 'note' ? 500 : 64)) throw new TypeError(key === 'note' ? '授权说明不能超过500字' : '授权时间格式无效');
      }
      if ('reversible' in rule && typeof rule.reversible !== 'boolean') throw new TypeError('reversible必须为布尔值');
      if (rule.grantedAt !== undefined && !Number.isFinite(Date.parse(rule.grantedAt))) throw new TypeError('授权时间格式无效');
      // A rule that hands an approval to an Agent must say why the owner allowed it.
      if (rule.kind !== 'question' && rule.handler !== 'user' && rule.mode !== 'off' && !rule.note) throw new TypeError('放宽审批的规则必须填写授权说明');
      if (rule.handler === 'rules' && rule.mode === 'auto') text(rule.answer);
      if (rule.handler === 'user' && rule.mode === 'off') throw new TypeError('不能关闭最终用户处理阶段');
    }
  }
}

/** Configuration only: deciding never approves a card or performs external actions. */
export function createPolicies({ store, events }: { store: Store; events: EventBus }) {
  function resolved(scope: PolicyScope = {}, conversationQuestion = false) {
    scopeKey(scope);
    let config = structuredClone(defaults);
    // A conversation question must outlive the default one-hour Feishu reminder.
    if (conversationQuestion) config.userDeadlineMinutes = 120;
    let layer: PolicyDecision['layer'] = 'default';
    const layers: [PolicyDecision['layer'], PolicyScope][] = [['global', {}]];
    if (scope.projectId !== undefined) layers.push(['project', { projectId: scope.projectId }]);
    if (scope.runId !== undefined) {
      layers.push(['run', { runId: scope.runId }]);
      if (scope.projectId !== undefined) layers.push(['run', scope]);
    }
    for (const [name, target] of layers) {
      const patch = store.get<Partial<PolicyConfig>>(collection, scopeKey(target));
      if (patch === undefined) continue;
      validatePolicyPatch(patch);
      // A narrower rule table replaces the broader table, including an empty table.
      if (patch.rules !== undefined) layer = name;
      config = { ...config, ...patch, agentModes: { ...config.agentModes, ...patch.agentModes } };
    }
    return { config, layer };
  }
  return {
    read(scope: PolicyScope = {}): PolicyConfig { return resolved(scope).config; },
    reset(scope: PolicyScope, options: { notify?: boolean } = {}): PolicyConfig {
      store.remove(collection, scopeKey(scope));
      if (options.notify !== false) events.publish('policies.changed', {});
      return resolved(scope).config;
    },
    write(scope: PolicyScope, patch: Partial<PolicyConfig>, options: { notify?: boolean } = {}): PolicyConfig {
      const key = scopeKey(scope);
      validatePolicyPatch(patch);
      store.transaction(() => {
        const previous = store.get<Partial<PolicyConfig>>(collection, key) ?? {};
        validatePolicyPatch(previous);
        store.put(collection, key, { ...previous, ...patch, ...(patch.agentModes ? {agentModes:{...previous.agentModes,...patch.agentModes}} : {}) });
      });
      // Neither answers nor caller-controlled identifiers enter the event log.
      if (options.notify !== false) events.publish('policies.changed', {});
      return resolved(scope).config;
    },
    decide(card: PolicyCard, conversationQuestion = false): PolicyDecision {
      // Cards may contain additional business fields; only policy inputs are consumed.
      if (!card || typeof card !== 'object' || Array.isArray(card) || !kinds.includes(card.kind)) throw new TypeError('无效卡片kind');
      const scope: PolicyScope = {};
      if (card.projectId !== undefined) scope.projectId = card.projectId;
      if (card.runId !== undefined) scope.runId = card.runId;
      for (const value of [card.executorId, card.cwd]) if (value !== undefined) text(value);
      if (card.cwd !== undefined && !isAbsolute(card.cwd)) throw new TypeError('cwd必须为绝对路径');
      if (card.createdAt !== undefined) text(card.createdAt);
      const created = card.createdAt === undefined ? Date.now() : Date.parse(card.createdAt);
      if (!Number.isFinite(created)) throw new TypeError('createdAt必须为有效日期');
      const { config, layer } = resolved(scope, conversationQuestion && card.kind === 'question' && !card.runId);
      const rule = config.rules.find(rule => {
        if (rule.kind !== card.kind || (rule.executorId !== undefined && rule.executorId !== card.executorId)) return false;
        if (rule.cwdUnder === undefined) return true;
        if (card.cwd === undefined) return false;
        const path = relative(rule.cwdUnder, card.cwd);
        return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
      });
      const ladder = config.ladder ?? defaults.ladder!;
      const stages: PolicyStage[] = [];
      const explicit = rule?.handler;
      // Permissions/plans/reviews default directly to the user. A general Agent mode never relaxes this.
      const start = explicit ? ladder.indexOf(explicit) : card.kind === 'question' ? 0 : ladder.length - 1;
      const route = card.kind !== 'question'
        ? explicit && explicit !== 'user' && rule?.mode !== 'off' && ladder.includes(explicit) ? [explicit, 'user' as const] : ['user' as const]
        : start < 0 ? ['user' as const] : ladder.slice(start);
      for (const handler of route) {
        if (handler === 'user') { stages.push({ handler, mode: 'suggest' }); break; }
        const mode = handler === explicit ? rule?.mode ?? 'suggest' : handler === 'rules' ? 'off' : config.agentModes?.[handler] ?? 'suggest';
        if (mode === 'off') continue;
        if (handler === 'rules') {
          if (rule?.answer) stages.push({ handler, mode, answer: rule.answer });
        } else stages.push({ handler, mode });
      }
      if (!stages.length || stages.at(-1)!.handler !== 'user') stages.push({ handler: 'user', mode: 'suggest' });
      const first = stages[0]!;
      const userDeadlineAt = new Date(created + (config.userDeadlineMinutes ?? 15) * 60000).toISOString();
      return {
        layer: rule ? layer : 'default', ruleId: rule?.id ?? null,
        handler: first.handler, mode: first.mode, answer: first.answer ?? null,
        deadlineAt: first.handler === 'user' ? userDeadlineAt : new Date(created + config.escalateAfterMinutes * 60000).toISOString(),
        userDeadlineAt, escalationMinutes: config.escalateAfterMinutes, stages,
      };
    },
  };
}
