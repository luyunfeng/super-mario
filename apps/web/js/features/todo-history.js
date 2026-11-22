import { h, replace } from '../lib/dom.js';
import { formatDate, runStatus } from '../lib/format.js';
import { Button, Banner, Pill } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const reviewLabels = {
  accepted: '已验收', pending: '待验收', reopened: '已重开', invalidated: '验收证据已失效',
  dispatching: '正在派发返工', unknown: '派发结果未知',
};

export function openTodoHistory({ api, store, router, todo }) {
  let alive = true, sequence = 0, before;
  const list = h('div', { class: 'stack', dataset: { todoHistory: todo.id } });
  const notice = h('p', { class: 'small muted', role: 'status' });
  const error = h('div', { role: 'alert' });
  const more = Button({ label: '查看更早轮次', onClick: () => load(false) });
  more.hidden = true;
  const refresh = Button({ label: '重新读取历史', onClick: () => load(true) });
  const drawer = openDrawer({ title: '执行历史', subtitle: todo.title,
    body: [h('p', { class: 'small muted' }, '每轮对应一次实际执行。执行结束不代表待办完成；本页只读取记录。'), notice, error, list, more],
    footer: [refresh], onClose() { alive = false; sequence++; },
  });
  function runLink(label, id, projectId) {
    return h('a', { class: 'btn btn--sm', href: router.href('projects', projectId || 'all', 'runs', id),
      onclick: event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) drawer.close(); } }, label);
  }
  function row(round, projectId) {
    const run = round.run, status = runStatus[run.status] ?? { text: '未知状态', tone: '' };
    const executor = (store.view.snapshot?.executors ?? []).find(item => item.id === run.executorId)?.name ?? '历史执行者';
    return h('section', { class: 'card', dataset: { round: String(round.number) } },
      h('div', { class: 'card__body stack' },
        h('h3', null, `第 ${round.number} 轮 · `, Pill(status.text, status.tone)),
        h('p', { class: 'small muted' }, `${executor} · ${formatDate(run.createdAt, true)}`),
        h('p', null, run.prompt), run.doneWhen && h('p', { class: 'small' }, `完成标准：${run.doneWhen}`),
        run.error && Banner({ tone: 'danger', children: run.error }),
        run.output ? h('details', null, h('summary', null, '查看本轮结果'), h('pre', { class: 'output' }, run.output))
          : h('p', { class: 'small muted' }, '尚无结果记录。'),
        round.outputTruncated && h('p', { class: 'small muted' }, '摘要仅显示前 4000 字符，完整结果请打开执行记录。'),
        run.resultSource && h('p', { class: 'small muted' }, `结果来源：${run.resultSource}`),
        round.review && h('p', { class: 'small' }, '当前验收状态：' + (reviewLabels[round.review.status] ?? '未知')),
        (round.answerReceipts ?? []).map(receipt => {
          const target = receipt.target === 'executor' ? '执行会话输入' : '工作台本地处理';
          const status = { confirmed: '已确认', failed: '失败', unknown: '结果未知' };
          return h('p', { class: 'small' }, '已记录答复 · ' + receipt.title + ' · ' + target + (status[receipt.delivery] ?? '结果未知'),
            receipt.answeredAt && ' · ' + formatDate(receipt.answeredAt, true));
        }),
        round.decisions.map(decision => h('div', { class: 'row row--wrap small' },
          `历史决定：${decision.action === 'accept' ? '用户已验收' : '用户要求返工'} · ${formatDate(decision.at, true)}${decision.defects ? ' · ' + decision.defects : ''}`,
          decision.dispatchStatus === 'unknown' && h('span', null, '返工派发结果未知'),
          decision.dispatchStatus === 'dispatching' && h('span', null, '正在派发返工'),
          decision.reworkRunId && runLink('打开本次返工执行', decision.reworkRunId, projectId))),
        runLink('打开执行记录', run.id, projectId)));
  }
  async function load(reset) {
    const stamp = ++sequence, token = api.token?.();
    refresh.disabled = true; more.disabled = true; notice.textContent = '正在读取…'; replace(error);
    try {
      const result = await api.get(`/todos/${encodeURIComponent(todo.id)}/history${!reset && before ? '?before=' + encodeURIComponent(before) : ''}`);
      if (!alive || stamp !== sequence || token !== api.token?.()) return;
      if (result.todo.id !== todo.id) throw new Error('历史记录与当前待办不匹配');
      if (result.todo.projectId !== todo.projectId) { replace(list); throw new Error('待办所属项目已改变，请关闭后重新打开'); }
      if (reset) replace(list);
      for (const round of result.rounds) list.append(row(round, result.todo.projectId));
      before = result.nextBefore; more.hidden = !before;
      notice.textContent = `共 ${result.total} 轮 · ${result.todo.completedAt ? '待办已确认完成' : '待办尚未确认完成'}`;
      if (!result.total) list.append(h('p', { class: 'muted' }, '这项待办还没有关联执行记录。'));
    } catch (cause) {
      if (alive && stamp === sequence) { notice.textContent = ''; replace(error, Banner({ tone: 'danger', children: `读取失败：${cause.message}` })); }
    } finally { if (alive && stamp === sequence) { refresh.disabled = false; more.disabled = false; } }
  }
  void load(true);
  return drawer;
}
