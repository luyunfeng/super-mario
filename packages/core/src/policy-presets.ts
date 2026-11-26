import { isAbsolute, normalize, parse } from 'node:path';
import { validatePolicyPatch, type PolicyConfig, type PolicyRule } from './policies.ts';

export type PolicyPresetId = 'conservative' | 'balanced' | 'low-interruption';
export interface PresetOptions { trustedDirectories?: string[]; confirmed?: boolean; now?: number }
export interface PolicyDiff { field: keyof PolicyConfig; before: unknown; after: unknown; description: string }
export interface PolicyPreset { id: PolicyPresetId; name: string; description: string; config: PolicyConfig; diff: PolicyDiff[]; highRisk: boolean; available: boolean; unavailableReason?: string }

/** Keep this explicit snapshot checked against createPolicies().read() in tests. */
export function conservativePolicyConfig(): PolicyConfig {
  return { rules: [], escalateAfterMinutes: 3, userDeadlineMinutes: 15,
    ladder: ['rules', 'supervisor', 'main_agent', 'user'], agentModes: { supervisor: 'suggest', main_agent: 'suggest' } };
}
export function isHighRiskPolicyRule(rule: PolicyRule): boolean {
  // Even suggestions route an approval away from the user first; make that change visible.
  return rule.kind !== 'question' && rule.handler !== 'user' && rule.mode !== 'off';
}
export function policyConfigDiff(current: PolicyConfig, next: PolicyConfig): PolicyDiff[] {
  const names: Record<keyof PolicyConfig, string> = { rules: '替换此范围的规则', escalateAfterMinutes: '每级等待分钟数', userDeadlineMinutes: '最终处理期限分钟数', ladder: '处理顺序', agentModes: 'Agent 自动处理方式' };
  return (Object.keys(names) as (keyof PolicyConfig)[]).filter(field => field === 'rules' ? !sameRules(current.rules, next.rules ?? []) : JSON.stringify(current[field]) !== JSON.stringify(next[field]))
    .map(field => ({ field, before: structuredClone(current[field]), after: structuredClone(next[field]), description: names[field] }));
}
// When a preset is applied, the server dates each grant. That date is bookkeeping: it does
// not change what a rule does. Compare rules by what they do, so a preset still counts as
// the current one after it is applied, and the date is not shown as a difference.
function sameRules(left: PolicyRule[] | undefined, right: PolicyRule[]) {
  const behaviour = (rule: PolicyRule) => { const { grantedAt: _date, ...rest } = rule; return rest; };
  const a = (left ?? []).map(behaviour), b = right.map(behaviour);
  return a.length === b.length && a.every((rule, index) => JSON.stringify(rule) === JSON.stringify(b[index]));
}
function trustedDirectories(options: PresetOptions): string[] {
  return [...new Set((options.trustedDirectories ?? []).map(directory => {
    if (typeof directory !== 'string' || !directory.trim() || !isAbsolute(directory)) throw new TypeError('受信目录必须为绝对路径');
    const path = normalize(directory);
    if (path === parse(path).root) throw new TypeError('不能信任整台电脑的根目录');
    return path;
  }))];
}
export function policyPresets(current: PolicyConfig, options: PresetOptions = {}): PolicyPreset[] {
  validatePolicyPatch(current);
  const directories = trustedDirectories(options);
  const balanced = conservativePolicyConfig();
  balanced.rules = [{ id: 'preset-question', kind: 'question', handler: 'supervisor', mode: 'auto' }];
  const quieter = structuredClone(balanced);
  // Directory containment is enforced by policies.decide(). Never infer read-only permission from text.
  // Preset rules are written by the server. They still carry the owner's reason, so a
  // later turn can say why an approval did not wait. Whether what a rule lets through can
  // be undone is the owner's call. A preset does not make it, so the field stays unsaid.
  const note = '主人选择“少打扰”预设，并指定此目录为受信目录';
  quieter.rules.push(...directories.map((cwdUnder, index): PolicyRule => ({ id: `preset-trusted-${index + 1}`, kind: 'permission', handler: 'supervisor', mode: 'auto', cwdUnder, note })));
  return [
    { id: 'conservative' as const, name: '保守', description: '审批交给你，普通提问由 Agent 提供建议。', config: conservativePolicyConfig(), highRisk: false, available: true },
    { id: 'balanced' as const, name: '平衡', description: '自动回答普通提问；审批、计划与检查仍交给你。', config: balanced, highRisk: false, available: true },
    { id: 'low-interruption' as const, name: '少打扰', description: '受信目录内的权限请求可由 Agent 自动回答，可能允许修改或删除文件；其他审批仍交给你。', config: quieter, highRisk: true, available: directories.length > 0,
      ...(!directories.length ? { unavailableReason: '请先指定受信目录。不会根据文字推断操作是否只读。' } : {}) },
  ].map(preset => ({ ...preset, diff: policyConfigDiff(current, preset.config) }));
}
/** HTTP POST adapters must call this instead of trusting a browser-supplied config. */
export function applyPolicyPreset(current: PolicyConfig, preset: string, options: PresetOptions = {}): PolicyConfig {
  const selected = policyPresets(current, options).find(item => item.id === preset);
  if (!selected) throw new TypeError('未知自动处理预设');
  if (!selected.available) throw new TypeError(selected.unavailableReason);
  if (selected.highRisk && options.confirmed !== true) throw new TypeError('放宽审批前必须明确确认');
  validatePolicyPatch(selected.config);
  // The grant is dated when the owner applies it, not when the list was computed.
  const grantedAt = new Date(options.now ?? Date.now()).toISOString();
  // Only the preset's own wording is kept. A rule that needs a note already carries one;
  // adding one to the others would make an applied preset differ from its own definition.
  return structuredClone({ ...selected.config, rules: selected.config.rules.map(rule => ({ ...rule, grantedAt })) });
}

export interface PolicyHitCard { id: string; projectId?: string; ruleId?: string; answeredAt?: string; routingHistory?: { at: string; outcome: string }[] }
/** Counts cards with real processing evidence once per rule, never estimated from configuration. */
export function policyRuleHits(cards: readonly PolicyHitCard[], options: { now?: number; projectId?: string } = {}): Record<string, number> {
  const now = options.now ?? Date.now();
  const since = now - 7 * 24 * 60 * 60 * 1000;
  const hits: Record<string, number> = Object.create(null);
  const seen = new Set<string>();
  for (const card of cards) {
    if (!card.ruleId || seen.has(card.id) || (options.projectId !== undefined && card.projectId !== options.projectId)) continue;
    const dates = [card.answeredAt, ...(card.routingHistory ?? []).filter(entry => ['answered', 'suggested'].includes(entry.outcome)).map(entry => entry.at)];
    if (!dates.some(date => { const at = Date.parse(date ?? ''); return Number.isFinite(at) && at >= since && at <= now; })) continue;
    seen.add(card.id);
    hits[card.ruleId] = (hits[card.ruleId] ?? 0) + 1;
  }
  return hits;
}
