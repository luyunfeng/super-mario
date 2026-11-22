// 预览、复制和下载共享同一次导出结果。每次切换选项时立即丢弃旧结果。
import { h, replace } from '../lib/dom.js';
import { Button, Banner } from '../ui/kit.js';
import { openDrawer, toast } from '../ui/overlay.js';

export function conversationExportActive(store) {
  return !store.view.unauthorized && store.view.snapshot?.plugins?.some(
    plugin => plugin.id === 'conversation-export' && plugin.status === 'active',
  );
}

export function createConversationExport({ api, store, getProjectId = () => undefined }) {
  let drawer;
  const button = Button({ label: '导出对话', size: 'sm', onClick: () => {
    if (drawer?.el.open) return;
    const projectId = getProjectId();
    drawer = openConversationExport({ api, store, source: projectId ? { projectId } : {},
      subtitle: projectId ? '当前项目的工作对话' : '主对话', isCurrent: () => projectId === getProjectId() });
  } });
  const update = () => { button.hidden = !conversationExportActive(store); };
  store.subscribe(update);
  update();
  function copyMessage(message, getText) {
    const projectId = getProjectId(), owner = api.draftOwner();
    const conversation = projectId ? `project:${projectId}:work` : 'main';
    if (!conversationExportActive(store) || message.conversationId !== conversation ||
        (projectId && message.projectId && message.projectId !== projectId) || message.origin === 'notification' ||
        !['user', 'assistant'].includes(message.role) || !message.text?.trim()) return null;
    return Button({ label: '复制正文', kind: 'ghost', size: 'sm', onClick: async (_, control) => {
      const current = () => control.isConnected && owner === api.draftOwner() && owner === store.view.snapshotOwner &&
        projectId === getProjectId() && conversationExportActive(store);
      if (!current()) return;
      try {
        await navigator.clipboard.writeText(getText(message));
        if (current()) toast('已复制正文。');
      } catch {
        if (current()) toast('无法写入剪贴板，请选中消息正文复制。', 'danger');
      }
    } });
  }
  return { button, copyMessage, get active() { return conversationExportActive(store); }, close: () => drawer?.close() };
}

export function openConversationExport({ api, store, source, subtitle, isCurrent }) {
  if (!conversationExportActive(store) || !isCurrent()) return;
  const token = api.token();
  const route = location.hash;
  let request = 0;
  const includeWork = h('input', { type: 'checkbox', onchange: load });
  const status = h('div', { class: 'muted small', role: 'status' });
  const preview = h('pre', { class: 'mailbox-content', 'aria-label': 'Markdown 预览', hidden: true });
  const drawer = openDrawer({
    title: '导出对话', subtitle, wide: true,
    body: [h('label', { class: 'row' }, includeWork, '包含公开工作步骤'), status, preview], footer: [],
    onClose: () => { unsubscribe(); preview.textContent = ''; drawer.foot.replaceChildren(); },
  });
  const current = () => drawer.el.open && token === api.token() && route === location.hash && conversationExportActive(store) && isCurrent();
  const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });

  async function load() {
    if (!current()) return;
    const order = ++request;
    const valid = () => current() && order === request;
    preview.hidden = true;
    preview.textContent = '';
    drawer.foot.replaceChildren();
    status.textContent = '正在导出对话…';
    try {
      const { markdown, filename, count } = await api.post('/conversation-export', { ...source, includeWork: includeWork.checked });
      if (!valid()) return;
      if (!count) { status.textContent = '暂无可导出的消息'; return; }
      status.textContent = `共 ${count} 条消息`;
      preview.textContent = markdown;
      preview.hidden = false;
      replace(drawer.foot,
        Button({ label: '复制 Markdown', onClick: async () => {
          if (!valid()) return;
          try {
            await navigator.clipboard.writeText(markdown);
            if (valid()) status.textContent = `已复制 ${count} 条消息`;
          } catch {
            if (valid()) status.textContent = '无法写入剪贴板，请选中预览文本复制或下载文件。';
          }
        } }),
        Button({ label: '下载 .md', kind: 'primary', onClick: () => {
          if (!valid()) return;
          const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
          h('a', { href: url, download: filename }).click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } }));
    } catch (error) {
      if (!valid()) return;
      replace(status, Banner({ tone: 'danger', children: `导出失败：${error.message}`, action: Button({ label: '重试', size: 'sm', onClick: load }) }));
    }
  }
  void load();
  return drawer;
}
