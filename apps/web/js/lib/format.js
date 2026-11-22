// 时间与状态文案。状态词全站统一：“已结束”不等于“待办完成”。
export const todoPriorityLabels = { normal: '普通优先级', high: '高优先级', low: '低优先级' };

export function timeAgo(value, now = Date.now()) {
  if (!value) return '';
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < 45) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

export function formatDate(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' });
  return withTime ? `${day} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : day;
}

export function duration(from, to = Date.now()) {
  const minutes = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 执行状态：文案与色调。tone 对应 .pill--{tone}。 */
export const runStatus = {
  queued: { text: '排队中', tone: '' },
  running: { text: '执行中', tone: 'info' },
  completed: { text: '已结束', tone: 'ok' },
  failed: { text: '失败', tone: 'danger' },
  cancelled: { text: '已取消', tone: '' },
  unknown: { text: '结果未知', tone: 'danger' },
};

export const layerNames = { personal: '个人', global: '全局', project: '项目' };

export function isRunActive(run) { return run.status === 'queued' || run.status === 'running'; }
export function isRunProblem(run) { return run.status === 'failed' || run.status === 'unknown'; }

/** 用户可见的错误文案：去掉内部名词。 */
export function friendlyError(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text || '操作未成功，请稍后重试';
}

export function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
