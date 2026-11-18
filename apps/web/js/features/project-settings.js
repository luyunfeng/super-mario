// 项目的“跟进”：项目信息、Agent 怎么盯这个项目、记忆整理、绑定的飞书机器人。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Field, Input, TextArea, Select, Check, Pill } from '../ui/kit.js';
import { confirmDialog, toast } from '../ui/overlay.js';

const AUTOMATION = [['inherit', '沿用全局设置'], ['conservative', '保守：审批都交给我'], ['balanced', '平衡：普通提问自动回答'], ['quiet', '少打扰：受信目录内自动处理']];

export function createProjectSettings({ api, store, router, bindFolder }) {
  let projectId = '';
  let workspace = null;
  let seq = 0;
  let painted = '';
  let dirty = false;
  const root = h('div', { class: 'stack stack--lg', id: 'panel-settings', role: 'tabpanel' });

  root.addEventListener('input', () => { dirty = true; });
  root.addEventListener('change', () => { dirty = true; });

  // 表单里有用户正在输入的内容：只有项目数据真的变了才重绘，否则保留当前输入。
  function paint(force = false) {
    const project = (store.view.snapshot?.projects ?? []).find(item => item.id === projectId);
    const signature = JSON.stringify([project, workspace?.agents, workspace?.bots, workspace?.error]);
    if (!force && (dirty || signature === painted)) return;
    painted = signature;
    if (!project) { replace(root, h('p', { class: 'muted' }, '项目不存在或已归档。')); return; }
    const followUp = project.followUp ?? { briefingTime: '09:00', overdueReminders: true, automation: 'inherit' };

    const name = Input({ value: project.name, required: true, maxLength: 120 });
    const description = TextArea({ value: project.description ?? '', rows: 2, placeholder: '一句话目标，例如：把首页改成新品牌样式' });
    const editingId = projectId;
    const info = Card({ title: '项目信息', sub: '名称和一句话目标', body: [Field({ label: '名称', control: name, required: true }), Field({ label: '一句话目标', control: description }),
      h('div', { class: 'row' }, Button({ label: '保存', kind: 'primary', onClick: async () => { await api.patch(`/projects/${encodeURIComponent(editingId)}`, { name: name.value.trim(), description: description.value.trim() }); dirty = false; store.refresh(); } }),
        Button({ label: '归档项目', kind: 'ghost', onClick: async () => {
          const ok = await confirmDialog({ title: '归档这个项目？', message: '归档后它不再出现在项目列表里；已有的待办、执行和记忆不会被删除。', confirmLabel: '归档', danger: true });
          if (!ok) return;
          await api.del(`/projects/${encodeURIComponent(editingId)}`); store.refresh(); router.go(router.href('projects'));
        } }))] });

    const time = Input({ type: 'time', value: followUp.briefingTime });
    const briefing = Check({ label: '每天发送项目简报', checked: followUp.briefingEnabled !== false });
    const reminders = Check({ label: '待办逾期时提醒我', checked: followUp.overdueReminders });
    const automation = Select({ options: AUTOMATION, value: followUp.automation });
    const expectedUpdatedAt = project.updatedAt;
    const trustedCwd = project.workspace?.cwd;
    const draft = () => ({ briefingTime: time.value || '09:00', overdueReminders: reminders.querySelector('input').checked, automation: automation.value, briefingEnabled: briefing.querySelector('input').checked });
    const follow = Card({ title: '怎么跟进', hint: 'project.followup', body: [briefing,
      h('div', { class: 'form-row' }, Field({ label: '每天几点汇报', control: time, hint: '时区继承全局简报设置。' }), Field({ label: '自动处理', control: automation, hint: '只影响这个项目的审批自动处理；“少打扰”需要绑定受信目录并确认。' })), reminders,
      h('div', null, Button({ label: '保存跟进设置', kind: 'primary', onClick: async () => {
        // Freeze the target, version and values before any asynchronous confirmation.
        const followUp = draft();
        const body = { followUp, expectedUpdatedAt };
        if (followUp.automation === 'quiet') {
          if (!trustedCwd?.trim()) throw new Error('请先为项目绑定工作区文件夹，再启用少打扰。');
          const ok = await confirmDialog({ title: '启用少打扰？', message: `受信目录：${trustedCwd}。Agent 可在此目录内自动处理审批，可能修改或删除文件。`, confirmLabel: '信任目录并启用', danger: true });
          if (!ok) return;
          body.confirmed = true;
        }
        await api.put(`/projects/${encodeURIComponent(editingId)}/follow-up`, body);
        // A late response must not clear another project's dirty state or newer edits.
        if (projectId === editingId && root.contains(time) && JSON.stringify(draft()) === JSON.stringify(followUp)) {
          dirty = false;
          toast('已保存', 'ok');
        }
        store.refresh();
      } }))] });

    const memoryAgent = workspace?.agents?.memory;
    const memory = Card({ title: '记忆整理', sub: '让 Agent 把这个项目里的资料整理成记忆', body: memoryAgent ? [
      h('div', { class: 'row row--between' }, h('span', null, memoryAgent.enabled ? '已开启' : '未开启'), Pill(memoryAgent.status === 'idle' ? '空闲' : String(memoryAgent.status), memoryAgent.enabled ? 'ok' : '')),
      h('div', null, Button({ label: memoryAgent.enabled ? '关闭整理' : '开启整理', onClick: async () => { await api.put(`/projects/${encodeURIComponent(editingId)}/memory`, { enabled: !memoryAgent.enabled }); await load(); store.refresh(); } }))]
      : h('p', { class: 'muted' }, workspace?.error ? `无法读取：${workspace.error}` : '正在读取…') });

    const bots = workspace?.bots ?? [];
    const channel = Card({ title: '飞书机器人', sub: '负责这个项目的机器人', body: bots.length
      ? bots.map(bot => h('div', { class: 'item' }, h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, bot.name), h('span', { class: 'item__meta' }, bot.connected ? '已连接' : '未连接'))))
      : [h('p', { class: 'muted' }, '还没有机器人负责这个项目。'), h('div', null, h('a', { class: 'btn btn--sm', href: router.href('channels') }, '去渠道连接'))] });
    const folder = Card({ title: '工作区文件夹', body: [h('p', { class: 'folder-path' }, project.workspace ? `${(store.view.snapshot?.machines ?? []).find(m => m.id === project.workspace.machineId)?.name ?? project.workspace.machineId} · ${project.workspace.cwd}` : '尚未绑定文件夹，原有数据保留。'), Button({ label: project.workspace ? '更换绑定文件夹' : '绑定文件夹', onClick: () => bindFolder(project) })] });
    replace(root, folder, info, follow, memory, channel);
  }

  async function load() {
    const stamp = ++seq;
    const editingId = projectId;
    try { const value = await api.get(`/projects/${encodeURIComponent(editingId)}/workspace`); if (stamp !== seq) return; workspace = value; } catch (error) { if (stamp !== seq) return; workspace = { error: error.message }; }
    paint();
  }

  return { el: root, show(id) { if (projectId !== id) { seq++; projectId = id; workspace = null; dirty = false; paint(true); } else paint(); load(); }, update: () => paint() };
}
