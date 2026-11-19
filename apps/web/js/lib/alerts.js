// 提醒点：只表示“需要你行动”。纯函数，无副作用，导航、窄屏底栏和浏览器标题共用同一份结果。
// 返回 { chat, agent, projects, memory, channels }，每项是 null 或 { count?, dot? }。

import { personalGroupSize } from './group-size.js';

export function computeAlerts(snapshot, attention, local = {}) {
  if (!snapshot) return { chat: null, inbox: null, outbox: null, agent: null, projects: null, memory: null, channels: null };
  const problems = snapshot.problems ?? [];
  const setup = snapshot.setup ?? {};
  const seen = new Set(local.seenRunIds ?? []);
  const now = local.now ?? Date.now();

  const waiting = attention.length;
  const inboxWaiting = (snapshot.inbox ?? []).filter(item => item.tier === 'action' && !(personalGroupSize(item.origin) > 50) && !item.todoId && !item.archivedAt).length;
  const overdue = (snapshot.todos ?? []).some(todo => !todo.completedAt && todo.dueAt && new Date(todo.dueAt).getTime() < now);
  const failedRun = (snapshot.runs ?? []).some(run => (run.status === 'failed' || run.status === 'unknown') && !seen.has(run.id));

  // 没有电脑、没有连接飞书属于“还没设置”，由引导负责；这里只在“原本可用、现在坏了”时提醒。
  const agentBroken = !snapshot.agent?.available || (setup.agent === true && problems.some(item => item.area === 'agent'));
  const channelBroken = setup.channel === 'done' && problems.some(item => item.area === 'channel');

  return {
    chat: waiting ? { count: waiting } : null,
    inbox: inboxWaiting ? { count: inboxWaiting } : null,
    outbox: snapshot.background?.outboxFailed || snapshot.background?.outboxUnknown ? { dot: true } : null,
    agent: agentBroken ? { dot: true } : null,
    projects: overdue || failedRun ? { dot: true } : null,
    memory: null,
    channels: channelBroken ? { dot: true } : null,
  };
}

export function alertLabel(alert, name) {
  if (!alert) return name;
  if (alert.count) return `${name}，${alert.count} 件事等你处理`;
  return `${name}，需要查看`;
}
