// 以主人名义发出去的内容：飞书消息、邮件和 GitHub 评论，来自发件箱和审批记录。只读。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Pill, Select } from '../ui/kit.js';

const CONNECTORS = [['', '全部'], ['飞书', '飞书'], ['邮箱', '邮箱'], ['GitHub', 'GitHub']];
const PAGE = 10;
const when = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const firstLine = (text, most = 120) => {
  const line = String(text ?? '').split('\n').map(part => part.trim()).filter(Boolean).join(' ');
  return line.length > most ? line.slice(0, most) + '…' : line;
};

export function createSentLedgerUI({ api }) {
  let items = [];
  let next = null;
  let error = '';
  let busy = false;
  let connector = '';
  let seq = 0;
  const list = h('ol', { class: 'list', 'aria-label': '已发出的内容' });
  const status = h('p', { role: 'status', class: 'small' });
  const filter = Select({ options: CONNECTORS, value: '', 'aria-label': '按连接器筛选' });
  const more = Button({ label: '更早的', size: 'sm', onClick: () => load(true) });
  const detail = h('div', { class: 'stack', id: 'channel-sent-detail', hidden: true });
  const card = Card({ id: 'channel-sent', title: '以我的名义发出的', sub: '助手替你发出去的飞书消息、邮件和 GitHub 评论。只列确实发出去的。', body: [filter, list, h('div', { class: 'row' }, more), status, detail] });

  async function load(older = false) {
    if (busy) return;
    busy = true; more.disabled = true;
    const stamp = ++seq;
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (connector) query.set('connector', connector);
    if (older && next) { query.set('after_at', next.at); query.set('after_id', next.id); }
    try {
      const page = await api.get('/sent?' + query.toString());
      if (stamp !== seq) return;
      // A page that is not the first is added to what is shown; the first replaces it.
      items = older ? [...items, ...page.items] : page.items;
      next = page.next ?? null;
      more.hidden = !page.hasMore;
      error = '';
    } catch (cause) {
      if (stamp !== seq) return;
      error = cause.message;
    } finally { busy = false; more.disabled = false; paint(); }
  }

  function paint() {
    if (error) { replace(status, h('span', { role: 'alert' }, '无法读取已发出的内容：' + error)); return; }
    status.textContent = '';
    if (!items.length) {
      replace(list, h('li', { class: 'muted small' }, connector ? '这个连接器还没有发出去的内容。' : '还没有以你的名义发出任何内容。'));
      return;
    }
    replace(list, ...items.map(item => h('li', { class: 'item' },
      h('div', { class: 'item__main' },
        h('div', { class: 'row row--between row--wrap' },
          h('div', { class: 'row' }, Pill(item.connector), h('span', null, item.action), h('time', { class: 'small muted', dateTime: item.at }, when(item.at))),
          h('span', { class: 'small muted' }, item.through === 'approval' ? '经我批准' : '按规则发出')),
        h('p', { class: 'small muted' }, '发往 ' + (item.target || '（没有记录目标）')),
        h('p', { class: 'small' }, firstLine(item.text))),
      Button({ label: '看全文', size: 'sm', onClick: () => open(item) }))));
  }

  function open(item) {
    detail.hidden = false;
    replace(detail,
      h('p', { class: 'small muted' }, item.connector + ' · ' + item.action + ' · ' + when(item.at) + ' · 发往 ' + (item.target || '（没有记录目标）')),
      item.messageRef ? h('p', { class: 'small muted' }, '对方那边的编号 ', h('code', null, item.messageRef)) : null,
      item.approvalId ? h('p', { class: 'small muted' }, '批准记录 ', h('code', null, item.approvalId)) : null,
      h('p', { class: 'md-p' }, item.text + (item.text.length >= 4000 ? '\n…（这里只显示前 4000 字，全文在批准记录里）' : '')),
      h('div', { class: 'row' },
        Button({ label: '收起', size: 'sm', onClick: () => { detail.hidden = true; } })));
  }

  filter.addEventListener('change', () => { connector = filter.value; detail.hidden = true; load(); });
  more.hidden = true;
  return { el: card, load: () => load() };
}
