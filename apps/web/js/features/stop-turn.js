import { h } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

// Bind the control to the rendered input. A later turn may already be running at click time.
export function stopTurnButton(api, message, projectId) {
  const conversationId = projectId ? `project:${projectId}:work` : 'main';
  if (message.role !== 'user' || message.status !== 'pending' || message.conversationId !== conversationId) return null;
  const prefix = projectId ? '/projects/' + encodeURIComponent(projectId) : '';
  const notice = h('span', { role: 'status' });
  const button = Button({ label: '停止本轮', kind: 'ghost', size: 'sm', onClick: async () => {
    try {
      const result = await api.post(prefix + '/messages/' + encodeURIComponent(message.id) + '/stop');
      notice.textContent = result.outcome === 'requested' ? '已请求停止本轮。' : '这条输入当前没有可停止的处理。';
      button.disabled = true;
    } catch (error) {
      notice.textContent = error.status && error.status < 500 ? error.message : '停止结果未知，请核对本轮最新状态。';
    }
  } });
  return h('span', { class: 'row row--wrap' }, button, notice);
}
