// GitHub 渠道：用某台电脑上的 gh 登录读取未读通知，进入收件箱。令牌留在那台电脑上。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Check, Field, Select, TextArea } from '../ui/kit.js';

const READY = '执行机已提供 GitHub 读取';
const CI_MODES = [['mine', '默认分支，以及我自己的合并请求'], ['default-branch', '只有默认分支'], ['all', '所有分支'], ['off', '不收 CI 失败']];
const lines = value => value.split('\n').map(item => item.trim()).filter(Boolean);

export function createGithubChannel({ api, store }) {
  let view = null;
  let error = '';
  let busy = false;
  let seq = 0;
  const status = h('p', { role: 'status', class: 'small' });
  const body = h('div', { class: 'stack' });
  const card = Card({ id: 'channel-github', title: 'GitHub', sub: '未读通知进入收件箱。令牌留在所选电脑上，不传到工作台。',
    tools: h('a', { class: 'btn btn--sm', href: '#inbox' }, '打开收件箱'), body: [body, status] });

  async function load() {
    const stamp = ++seq;
    try {
      const value = await api.get('/github/connector');
      if (stamp !== seq) return;
      view = value; error = '';
    } catch (cause) {
      if (stamp !== seq) return;
      error = cause.message;
    }
    paint();
  }

  function paint() {
    if (error) { replace(body, h('p', { class: 'small', role: 'alert' }, '无法读取 GitHub 连接：' + error)); return; }
    if (!view) { replace(body, h('p', { class: 'muted small' }, '正在读取…')); return; }
    const machines = view.machines ?? [];
    const usable = machines.filter(machine => machine.ready);
    const select = Select({ options: usable.map(machine => [machine.id, machine.name + (machine.online ? '' : '（离线）')]), value: view.machineId ?? '', 'aria-label': '读取 GitHub 的电脑' });
    if (!usable.length) select.append(new Option('没有可用的电脑', ''));
    const enabled = Check({ label: '读取 GitHub 未读通知', checked: view.enabled });
    const ciMode = Select({ options: CI_MODES, value: view.ciMode ?? 'mine', 'aria-label': 'CI 失败收哪些' });
    const muted = TextArea({ rows: 2, value: (view.mutedRepositories ?? []).join('\n'), 'aria-label': '静音的仓库', placeholder: '一行一个，owner/repo' });
    const ignored = TextArea({ rows: 2, value: (view.ignoredBranches ?? []).join('\n'), 'aria-label': '忽略的分支', placeholder: '一行一个，可用 * 和 ?' });
    const save = Button({ label: '保存', kind: 'primary', size: 'sm', onClick: async () => {
      if (busy) return;
      busy = true; save.disabled = true;
      try {
        view = await api.put('/github/connector', { enabled: enabled.querySelector('input').checked, machineId: select.value || undefined,
          ciMode: ciMode.value, mutedRepositories: lines(muted.value), ignoredBranches: lines(ignored.value) });
        error = '';
        store.refresh();
      } catch (cause) { error = cause.message; }
      finally { busy = false; paint(); }
    } });
    const check = Button({ label: '立即检查', size: 'sm', onClick: async () => {
      if (busy || !view?.enabled) return;
      busy = true; check.disabled = true; status.textContent = '正在读取…';
      try { view = await api.post('/github/connector/poll'); error = ''; store.refresh(); }
      catch (cause) { error = cause.message; }
      finally { busy = false; paint(); }
    } });
    check.disabled = !view.enabled || busy;
    const account = view.accountKnown
      ? h('p', { class: 'small' }, '当前账号 ', h('strong', null, view.login), view.epoch ? `，这是第 ${view.epoch + 1} 个账号` : '')
      : h('p', { class: 'small muted' }, view.enabled ? '还没有读到账号。' : '尚未启用。');
    const last = [view.lastRunAt && '最近检查 ' + new Date(view.lastRunAt).toLocaleString(),
      view.lastError && h('span', { role: 'alert' }, view.lastError)].filter(Boolean);
    replace(body,
      view.machineId && !view.ready && view.enabled ? h('p', { class: 'small', role: 'alert' },
        view.machine?.online ? '这台电脑的执行机版本不支持 GitHub 连接，请升级执行机。' : '所选电脑已离线，恢复后继续读取。') : null,
      h('div', { class: 'form-row' }, h('label', { class: 'field' }, h('span', { class: 'field__label' }, '读取 GitHub 的电脑'), select),
        h('div', { class: 'stack' }, enabled, h('div', { class: 'row row--wrap' }, save, check))),
      account,
      h('details', null, h('summary', null, '哪些通知进收件箱'),
        h('div', { class: 'stack' },
          Field({ label: 'CI 失败', control: ciMode, hint: 'GitHub 只通知发起运行的人，之后的失败由工作台定期核对。' }),
          Field({ label: '静音的仓库', control: muted, hint: '这些仓库的通知不进收件箱。' }),
          Field({ label: '忽略的分支', control: ignored, hint: '这些分支的 CI 失败不进收件箱。* 不跨 /，? 匹配一个字符。' }))),
      last.length ? h('p', { class: 'small muted' }, ...last.flatMap((item, index) => index ? [' · ', item] : [item])) : null,
      !usable.length ? h('p', { class: 'small muted' }, '需要一台安装了 gh 并已登录 GitHub 的电脑，且 ${READY}。') : null);
    status.textContent = '';
  }

  return { el: card, load, update: () => paint() };
}
