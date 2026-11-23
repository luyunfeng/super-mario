import { h } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

export function turnQueueActive(store) {
  return !store.view.unauthorized && store.view.snapshot?.plugins?.some(p => p.id==='conversation-queue' && p.status==='active');
}

export function queueLabel(message, enabled) {
  if (!enabled || message.role!=='user' || !message.directWebInput) return '';
  if (message.queueState==='cancelled') return '已取消排队';
  if (message.status!=='pending') return '';
  if (message.queueState==='queued') return '排队中';
  if (message.queueState==='running') return '运行中';
  return '';
}

// Bind the control to the rendered input. A later turn may already be running at click time.
export function stopTurnButton(api, message, projectId, queueEnabled=false) {
  const conversationId = projectId ? `project:${projectId}:work` : 'main';
  if (message.role !== 'user' || message.status !== 'pending' || message.conversationId !== conversationId) return null;
  const queueState = queueEnabled && message.directWebInput ? message.queueState : undefined;
  if (queueState==='cancelled') return null;
  const cancel = queueState==='queued';
  const prefix = projectId ? '/projects/' + encodeURIComponent(projectId) : '';
  const notice = h('span', { role: 'status' });
  const button = Button({ label: cancel ? '取消排队' : '停止本轮', kind: 'ghost', size: 'sm', onClick: async () => {
    try {
      const path = prefix + '/messages/' + encodeURIComponent(message.id);
      const result = await api.post(path + (cancel ? '/cancel-queued' : '/stop'), {});
      if (cancel) {
        const outcomes = {cancelled:'已取消排队。',started:'这条消息已开始处理，未取消排队。',idle:'这条消息已不在队列中。'};
        notice.textContent = outcomes[result.outcome] || '取消结果未知，请核对本轮最新状态。';
      } else {
        notice.textContent = result.outcome==='requested' ? '已请求停止本轮。' : '这条输入当前没有可停止的处理。';
      }
      button.disabled = true;
    } catch (error) {
      notice.textContent = error.status && error.status < 500 ? error.message : (cancel ? '取消结果未知，请核对本轮最新状态。' : '停止结果未知，请核对本轮最新状态。');
    }
  } });
  return h('span', { class: 'row row--wrap' }, button, notice);
}
