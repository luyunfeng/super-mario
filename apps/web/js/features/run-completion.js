import { h } from '../lib/dom.js';

export function completionTimingView(timing) {
  if (!timing) return null;
  const { reportedAt, actualMinutes, initialEstimateMinutes, deltaMinutes, source, receiptId } = timing;
  const difference = deltaMinutes === 0 ? '与首派预计一致'
    : '比首派预计' + (deltaMinutes < 0 ? '少用 ' : '多用 ') + Math.abs(deltaMinutes) + ' 分钟';
  return h('section', {class:'stack', 'aria-label':'计划执行完成回执'},
    h('h4', null, '计划执行完成回执'),
    h('div', null, '首次收到完成结果 · ', h('time', {dateTime:reportedAt}, new Date(reportedAt).toLocaleString('zh-CN'))),
    h('div', null, '实际用时 ' + actualMinutes + ' 分钟，首派预计 ' + initialEstimateMinutes + ' 分钟，' + difference),
    h('div', {class:'small muted'}, '回执来源 · ' + source + ' · ' + receiptId));
}
