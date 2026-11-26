// 消息：主人与每个已配对机器人的独立对话，按最近活动排在一起。从这里打开、检索、归档。
import { h, replace } from '../lib/dom.js';
import { Button, Input, Pill, Segmented } from '../ui/kit.js';
import { timeAgo } from '../lib/format.js';
import { openPrivateThreads } from '../features/feishu-private-threads.js';
import { systemText } from '../copy/terms.js';

const FILTERS = [['active', '进行中'], ['archived', '已归档']];
const PAGE_SIZE = 50;

export function createMessagesPage({ api, store, router }) {
  const list = h('ol', { class: 'list', 'aria-label': '独立对话' });
  const status = h('p', { class: 'muted small', role: 'status' });
  const search = Input({ type: 'search', 'aria-label': '检索独立对话', placeholder: '按标题或内容检索' });
  let filter = 'active', query = '', sequence = 0, page, bots = [];
  // What is on screen: every page read so far, keyed by conversation, so that a later page never repeats one.
  let shown = [], total = 0, loading = false;
  const filterBar = Segmented({ label: '范围', options: FILTERS, value: 'active', onChange: value => { filter = value; load(); } });
  const body = h('div', { class: 'stack stack--lg' }, search, status, list);
  const head = h('header', { class: 'page__head' },
    h('div', { class: 'page__title' }, h('h1', null, '消息'), h('p', { class: 'page__sub' }, '你与机器人的所有独立对话，最近的在最上面。')),
    filterBar.el);
  // page__inner is the padding every workbench page sits in. Without it the title tucks under the top bar.
  const el = h('section', { class: 'page', id: 'page-messages', 'aria-label': '消息' },
    h('div', { class: 'page__inner' }, head, body));
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim(); load(); }, 250); });
  function active() { return router.current.page === 'messages'; }
  const params = () => new URLSearchParams({ archived: filter === 'archived' ? '1' : '0', limit: String(PAGE_SIZE), ...(query ? { query } : {}) });
  async function load(more = false) {
    const stamp = ++sequence, offset = more ? shown.length : 0;
    if (!more) shown = [];
    loading = true;
    status.textContent = '正在读取…';
    try {
      const [pageValue, botList] = await Promise.all([
        api.get('/feishu/messages?' + params() + (offset ? '&offset=' + offset : '')), api.get('/feishu/bots')]);
      if (stamp !== sequence || !active()) return;
      bots = botList;
      // A conversation that moved while pages were being read is already on screen: keep the first copy.
      const fresh = pageValue.items.filter(item => !shown.some(row => row.threadId === item.threadId));
      total = pageValue.total;
      shown = more ? [...shown, ...fresh] : fresh;
      render();
    } catch (error) {
      if (stamp === sequence && active()) {
        status.textContent = '读取失败：' + systemText(error.message);
        if (!more) { shown = []; replace(list); }
      }
    } finally {
      if (stamp === sequence) loading = false;
    }
  }
  function render() {
    if (!shown.length) {
      replace(list);
      status.textContent = query ? '没有匹配的对话。' : filter === 'archived' ? '没有已归档的对话。' : '还没有和机器人的独立对话。在飞书里私聊一个已配对的机器人，或从渠道页打开。';
      return;
    }
    status.textContent = '共 ' + total + ' 个对话' + (shown.length < total ? '，已显示 ' + shown.length + ' 个' : '') + '。';
    const more = shown.length < total ? Button({ label: '加载更多', onClick: () => { if (!loading) load(true); } }) : null;
    replace(list, shown.map(row), more);
  }
  function row(item) {
    const tags = item.tags?.length ? ' · ' + item.tags.map(tag => '#' + tag).join(' ') : '';
    return h('li', { class: 'item', dataset: { thread: item.threadId, bot: item.botId } },
      h('div', { class: 'item__main' },
        h('div', { class: 'row row--between row--wrap' },
          h('button', { class: 'item__title item__button', type: 'button', onClick: () => open(item) }, item.title || '独立对话'),
          h('span', { class: 'row' }, Pill(item.botName), item.archived ? Pill('已归档') : null, h('span', { class: 'muted small' }, timeAgo(item.latestAt)))),
        h('span', { class: 'item__meta' }, item.count + ' 条消息', tags)));
  }
  function open(item) {
    const bot = bots.find(row => row.id === item.botId);
    if (!bot) { status.textContent = '这个机器人已经不在了，对话记录还在飞书里。'; return; }
    openPrivateThreads({ api, bot, store, target: { threadId: item.threadId }, backLabel: '返回消息', onClose: () => { if (active()) load(); } });
  }
  page = { el, onShow() { if (active()) load(); } };
  return page;
}

