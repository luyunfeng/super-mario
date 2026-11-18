// 自动处理：哪些事不用问你。预设（保守 / 平衡 / 少打扰）+ 一句话规则。
// 默认保守：审批都交给你。放宽审批的规则标为高风险，保存前必须确认，并显示命中次数。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Pill, Select, Input, Field, Banner } from '../ui/kit.js';
import { confirmDialog, openDrawer } from '../ui/overlay.js';
import { uuid as makeId } from '../lib/format.js';

const LABELS = {
  question: 'Agent 提问', permission: '权限审批', plan: '计划审批', review: '结果检查',
  user: '你', supervisor: '自动跟进 Agent', main_agent: '主 Agent', rules: '固定回答',
  auto: '直接处理', suggest: '只给建议', off: '不处理',
};
const isRisky = rule => rule.kind !== 'question' && rule.handler !== 'user' && rule.mode !== 'off';
const query = (projectId, extra = []) => {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  for (const [key, value] of extra) params.append(key, value);
  return params.size ? `?${params}` : '';
};

function describe(value) {
  if (Array.isArray(value)) {
    return value.length
      ? value.map(item => typeof item === 'string' ? LABELS[item] ?? item
        : `${LABELS[item.kind]} → ${LABELS[item.handler]}（${LABELS[item.mode ?? 'suggest']}）${item.cwdUnder ? `，仅在 ${item.cwdUnder} 内` : ''}`).join('；')
      : '无规则';
  }
  if (value && typeof value === 'object') return Object.entries(value).map(([key, mode]) => `${LABELS[key] ?? key}：${LABELS[mode] ?? mode}`).join('；');
  return String(value ?? '未设置');
}

export function ruleSentence(rule) {
  const where = rule.cwdUnder ? `，且在 ${rule.cwdUnder} 内` : '';
  const answer = rule.handler === 'rules' && rule.answer ? `：“${rule.answer}”` : '';
  return `当${LABELS[rule.kind]}${where}时，由${LABELS[rule.handler]}${LABELS[rule.mode ?? 'suggest']}${answer}`;
}

export function createPolicyCard({ api, store }) {
  let projectId = '';
  let trusted = '';
  let config = null;
  let presets = [];
  let hits = null;
  let error = '';
  let seq = 0;

  const scopeSelect = Select({ options: [['', '全部项目']], 'aria-label': '作用范围' });
  const trustSelect = Select({ options: [['', '请选择明确的工作目录']], 'aria-label': '少打扰预设的受信目录' });
  const summary = h('p', { id: 'policy-summary' });
  const presetBox = h('div', { class: 'presets', role: 'radiogroup', 'aria-label': '自动处理预设' });
  const trustField = Field({ label: '“少打扰”只在这个目录内生效', control: trustSelect, hint: '只会自动处理这个目录内的操作，目录外仍交给你。' });
  const rulesBox = h('div', { class: 'list' });
  const errorBox = h('div', { role: 'alert' });
  const body = [
    h('div', { class: 'row row--between row--wrap' }, h('span', { class: 'muted small' }, '作用范围'), h('div', { style: { minWidth: '200px' } }, scopeSelect)),
    summary, presetBox, trustField, errorBox,
    h('div', { class: 'row row--between' }, h('h3', null, '自定义规则'), Button({ label: '编辑规则', size: 'sm', onClick: () => openEditor() })),
    rulesBox,
  ];
  const card = Card({ title: '自动处理', hint: 'agent.rules', body, id: 'agent-rules' });

  scopeSelect.addEventListener('change', () => { projectId = scopeSelect.value; trusted = ''; load(); });
  trustSelect.addEventListener('change', () => { trusted = trustSelect.value; load(); });

  function directories() {
    const snapshot = store.view.snapshot;
    return [...new Set((snapshot?.executors ?? []).map(item => item.defaultCwd).filter(Boolean))];
  }

  function paint() {
    replace(errorBox, error && Banner({ tone: 'danger', children: error }));
    if (!config) { summary.textContent = '正在读取…'; return; }
    const current = presets.find(item => !item.diff?.length && item.available);
    summary.textContent = `当前：${current ? current.name : '自定义'} · ${config.rules.length} 条规则。没有匹配规则的审批都交给你。`;
    replace(presetBox, presets.map(preset => {
      const selected = !preset.diff?.length && preset.available;
      return h('button', {
        class: `preset ${selected ? 'is-selected' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(selected),
        dataset: { preset: preset.id },
        onclick: () => applyPreset(preset),
      }, h('span', { class: 'preset__name' }, preset.name, preset.highRisk && Pill('放宽审批', 'danger')),
        h('span', { class: 'preset__desc' }, preset.description));
    }));
    const needTrust = presets.some(item => item.highRisk);
    trustField.hidden = !needTrust;
    const dirs = directories();
    const options = [['', '请选择明确的工作目录'], ...dirs.map(dir => [dir, dir])];
    if (trusted && !dirs.includes(trusted)) options.push([trusted, trusted]);
    replace(trustSelect, options.map(([value, text]) => h('option', { value }, text)));
    trustSelect.value = trusted;
    if (!config.rules.length) { replace(rulesBox, h('p', { class: 'muted small' }, '没有自定义规则。')); return; }
    replace(rulesBox, config.rules.map(rule => h('div', { class: 'item' },
      h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, ruleSentence(rule)),
        h('span', { class: 'item__meta' }, hits === null ? '过去 7 天：暂无统计' : `过去 7 天处理了 ${hits[rule.id] ?? 0} 次`)),
      isRisky(rule) && Pill('高风险', 'danger'))));
  }

  async function load() {
    const stamp = ++seq;
    try {
      const [value, presetData] = await Promise.all([
        api.get(`/policies${query(projectId)}`),
        api.get(`/policies/presets${query(projectId, trusted ? [['trustedDirectory', trusted]] : [])}`),
      ]);
      if (stamp !== seq) return;
      config = value; presets = presetData.presets; hits = presetData.hits ?? null; error = '';
    } catch (cause) { if (stamp !== seq) return; error = `读取自动处理失败：${cause.message}`; }
    paint();
  }

  async function applyPreset(preset) {
    if (!preset.available && preset.highRisk && !trusted) { error = '请先选择“少打扰”生效的工作目录。'; paint(); trustSelect.focus(); return; }
    if (!preset.diff?.length) return;
    const ok = await confirmDialog({
      title: `改为“${preset.name}”？`,
      message: h('div', { class: 'stack' }, h('p', null, preset.description),
        preset.diff.map(diff => h('p', { class: 'small' }, `${diff.description}：${describe(diff.before)} → ${describe(diff.after)}`)),
        preset.highRisk && h('p', { class: 'text-danger small' }, '高风险：受信目录内的权限请求会交给 Agent 自动回答，可能允许修改或删除文件。')),
      confirmLabel: `改为${preset.name}`, danger: preset.highRisk,
    });
    if (!ok) return;
    try {
      await api.post('/policies/presets', { preset: preset.id, ...(projectId ? { projectId } : {}), ...(trusted ? { trustedDirectories: [trusted] } : {}), confirmed: preset.highRisk });
      error = '';
    } catch (cause) { error = cause.status && cause.status < 500 ? `没有应用成功：${cause.message}` : '应用结果未知，请先核对当前规则，不会自动重试。'; }
    await load();
  }

  function openEditor() {
    if (!config) return;
    const draft = structuredClone(config);
    const rows = h('div', { class: 'stack' });
    const minutes = Input({ type: 'number', min: 1, max: 43200, value: draft.escalateAfterMinutes });
    const deadline = Input({ type: 'number', min: 1, max: 43200, value: draft.userDeadlineMinutes ?? 15 });
    const executors = store.view.snapshot?.executors ?? [];
    const message = h('div', { role: 'alert' });
    const drawerRef = {};

    function row(rule) {
      const kind = Select({ options: ['question', 'permission', 'plan', 'review'].map(key => [key, LABELS[key]]), value: rule.kind, 'aria-label': '遇到' });
      const handler = Select({ options: ['user', 'supervisor', 'main_agent', 'rules'].map(key => [key, LABELS[key]]), value: rule.handler, 'aria-label': '由谁处理' });
      const mode = Select({ options: ['suggest', 'auto', 'off'].map(key => [key, LABELS[key]]), value: rule.mode ?? 'suggest', 'aria-label': '处理方式' });
      const executor = Select({ options: [['', '任何执行者'], ...executors.map(item => [item.id, item.name])], value: rule.executorId ?? '', 'aria-label': '来自执行者' });
      const cwd = Input({ value: rule.cwdUnder ?? '', placeholder: '工作目录前缀，可留空', 'aria-label': '工作目录' });
      const answer = Input({ value: rule.answer ?? '', placeholder: '固定回答的内容', 'aria-label': '固定回答' });
      const risk = h('p', { class: 'text-danger small' }, '高风险：这条规则会把审批交给 Agent，直接处理可能允许修改或删除文件。');
      const node = h('fieldset', { class: 'rule' },
        h('div', { class: 'form-row' }, Field({ label: '遇到', control: kind }), Field({ label: '由谁处理', control: handler }), Field({ label: '方式', control: mode })),
        h('div', { class: 'form-row' }, Field({ label: '来自', control: executor }), Field({ label: '目录范围', control: cwd })),
        Field({ label: '固定回答', control: answer }), risk,
        Button({ label: '删除这条规则', kind: 'ghost', size: 'sm', onClick: () => { node.remove(); } }));
      node.read = () => ({ id: rule.id, kind: kind.value, handler: handler.value, mode: mode.value,
        ...(executor.value ? { executorId: executor.value } : {}), ...(cwd.value.trim() ? { cwdUnder: cwd.value.trim() } : {}),
        ...(answer.value.trim() ? { answer: answer.value.trim() } : {}) });
      const sync = () => { const value = node.read(); answer.closest('.field').hidden = handler.value !== 'rules'; risk.hidden = !isRisky(value); node.classList.toggle('is-risk', isRisky(value)); };
      node.addEventListener('change', sync); sync();
      return node;
    }
    draft.rules.forEach(rule => rows.append(row(rule)));
    const save = Button({
      label: '保存规则', kind: 'primary',
      onClick: async () => {
        const next = { ...draft, rules: [...rows.children].map(node => node.read()), escalateAfterMinutes: Number(minutes.value), userDeadlineMinutes: Number(deadline.value) };
        if (next.rules.some(isRisky)) {
          const ok = await confirmDialog({ title: '保存高风险规则？', message: '标红的规则会把审批交给 Agent 自动处理，可能允许外部操作或修改文件。', confirmLabel: '确认保存', danger: true });
          if (!ok) return;
        }
        try { await api.put(`/policies${query(projectId)}`, next); }
        catch (cause) { replace(message, Banner({ tone: 'danger', children: cause.status && cause.status < 500 ? `保存失败：${cause.message}` : '保存结果未知，请先核对当前规则，不会自动重试。' })); return; }
        drawerRef.close(); await load();
      },
    });
    Object.assign(drawerRef, openDrawer({
      title: '编辑自动处理规则', subtitle: projectId ? '只对所选项目生效' : '对全部项目生效', wide: true,
      body: [h('div', { class: 'form-row' }, Field({ label: '每一级等待多久未处理就上交（分钟）', control: minutes }), Field({ label: '最终交给你处理的期限（分钟）', control: deadline })),
        rows, Button({ label: '添加规则', icon: 'plus', onClick: () => rows.append(row({ id: `custom-${makeId()}`, kind: 'question', handler: 'user', mode: 'suggest' })) }), message],
      footer: [Button({ label: '取消', onClick: () => drawerRef.close() }), save],
    }));
  }

  return {
    el: card,
    load,
    setProjects(projects) {
      const items = projects.filter(item => !item.archivedAt);
      const signature = JSON.stringify(items.map(item => [item.id, item.name]));
      if (scopeSelect.dataset.sig === signature) return;
      scopeSelect.dataset.sig = signature;
      replace(scopeSelect, h('option', { value: '' }, '全部项目'), items.map(item => h('option', { value: item.id }, item.name)));
      scopeSelect.value = items.some(item => item.id === projectId) ? projectId : '';
    },
  };
}
