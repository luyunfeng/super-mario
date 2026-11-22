import { h, replace } from '../lib/dom.js';
import { personalGroupSize } from '../lib/group-size.js';
import { Card } from '../ui/kit.js';
import { Hint } from '../ui/hint.js';

const day = 24 * 60 * 60 * 1000;
const byDate = (a, b) => (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity)
  || b.updatedAt.localeCompare(a.updatedAt);
const muted = text => h('p', { class: 'muted small' }, text);

// Inbox ranking may have been computed by an older collector. Prefer explicit
// handling and mention evidence before putting a group conversation on the home page.
function needsOwner(view, inScope) {
  const sources = new Map(view.snapshot.inbox.map(item => ['inbox:' + item.id, item]));
  const stages = new Map((view.snapshot.inboxHandling ?? []).map(({ source, stage }) =>
    [(source.kind === 'personal' ? 'inbox' : 'mailbox') + ':' + source.id, stage]));
  return view.attention.filter(item => {
    if (!inScope(item)) return false;
    if (item.type !== 'inbox') return true;
    const source = sources.get(item.id);
    if (source?.todoId || source?.archivedAt) return false;
    const origin = item.origin ?? source?.origin;
    if (origin?.kind === 'group' && origin.connector === '飞书' && origin.personalGroupObserved !== true) return false;
    if (personalGroupSize(origin) > 50) return false;
    const stage = stages.get(item.id);
    if (stage) return stage === 'human';
    if (source) return origin?.kind === 'direct' || origin?.mentionedMe === true ||
      (source.tier === 'action' && origin?.kind !== 'group' && !origin?.chatId);
    return true;
  }).sort((a, b) => Number(b.type !== 'inbox') - Number(a.type !== 'inbox') || b.createdAt.localeCompare(a.createdAt));
}

// Aggregate only chats with a known size. Legacy records without membership
// evidence stay searchable in the inbox instead of guessing from their title.
function groupDigest(inbox, inScope, now) {
  const groups = new Map();
  for (const item of inbox) {
    const origin = item.origin;
    const size = personalGroupSize(origin);
    if (!inScope(item) || !origin?.chatId || origin.personalGroupObserved !== true || size === undefined || size > 50) continue;
    const time = Date.parse(item.receivedAt);
    if (!Number.isFinite(time) || time <= now - day || time > now || item.tier === 'noise') continue;
    const key = JSON.stringify([item.source, origin.chatId, item.projectId]);
    const entry = groups.get(key) ?? { projectId: item.projectId || '', name: origin.chatName || item.title, count: 0, time: 0, latest: '' };
    entry.count++;
    if (time > entry.time) {
      entry.time = time;
      entry.latest = item.text.replace(/^\[[^\]]+\]\s*/gm, '').trim().slice(0, 140);
    }
    groups.set(key, entry);
  }
  return [...groups.values()].sort((a, b) => b.time - a.time);
}

function priorityCard(title, sub, rows, link, empty) {
  const body = h('div', null);
  let limit = 4;
  const draw = () => replace(body, rows.length ? rows.slice(0, limit).map(link) : muted(empty),
    rows.length > limit && h('button', { class: 'btn btn--sm', onclick: () => { limit += 20; draw(); } }, '查看更多'));
  draw();
  return Card({ title, sub, tools: h('span', { class: 'pill' }, String(rows.length)), body });
}

export function createHomePage({ api, router, scope, store }) {
  const body = h('div', { class: 'stack stack--lg' });
  const el = h('section', { class: 'page', id: 'home' }, h('div', { class: 'page__inner' },
    h('header', { class: 'page__head' }, h('h1', null, '首页'), Hint('nav.home')), body));
  let brief, briefError, lastRead = 0, request = 0;
  const link = (href, text) => h('a', { class: 'home-row', href }, text);
  const guideFrameWrap = h('div', { hidden: true, style: 'margin-top:12px;' });
  let guideLoaded = false;
  const guideToggle = h('button', {
    class: 'btn btn--sm', type: 'button',
    onclick: () => {
      const opening = guideFrameWrap.hidden;
      guideFrameWrap.hidden = !opening;
      guideToggle.textContent = opening ? '收起动态图解' : '展开动态图解';
      if (opening && !guideLoaded) {
        guideLoaded = true;
        guideFrameWrap.append(h('iframe', {
          src: '/guide.html?embed=1',
          title: 'Super Mario 使用教程与架构思路图',
          style: 'width:100%;height:760px;border:1px solid var(--line, #D1CFC5);border-radius:10px;background:#FAF9F5;',
        }));
      }
    },
  }, '展开动态图解');
  const guideCard = Card({
    title: '使用教程与架构思路图',
    sub: 'pi 总调度官 · 会前主动简报 · 只读调研与审批闭环',
    tools: h('div', { class: 'row' },
      guideToggle,
      h('a', { class: 'btn btn--sm btn--primary', href: '/guide.html', target: '_blank', rel: 'noopener' }, '独立页面打开 ↗')),
    body: [
      muted('点击「展开动态图解」可直接在首页交互查看 4 条核心场景的数据流动画与五步上手教程，或点击右上角在新标签全屏浏览。'),
      guideFrameWrap,
    ],
  });
  function draw() {
    const view = store.view;
    if (!view.snapshot || router.current.page !== 'home') return;
    const { todos, projects } = view.snapshot;
    const inScope = item => !scope.get() || item.projectId === scope.get();
    const attention = needsOwner(view, inScope);
    const open = todos.filter(t => !t.completedAt && inScope(t)).sort(byDate);
    const now = Date.now();
    const digest = groupDigest(view.snapshot.inbox, inScope, now);
    const cutoff = now + day;
    const urgent = t => Number.isFinite(Date.parse(t.dueAt)) && Date.parse(t.dueAt) <= cutoff;
    const todoLink = t => link(router.href('projects', t.projectId || 'all', 'todos'),
      t.title + (t.dueAt ? ' · ' + new Date(t.dueAt).toLocaleDateString() : ''));
    const briefing = (brief?.projects ?? []).filter(inScope);
    const windows = new Map(briefing.map(p => [p.projectId, p]));
    const counts = new Map();
    for (const t of open) counts.set(t.projectId || '', (counts.get(t.projectId || '') ?? 0) + 1);
    const groups = projects.filter(p => !p.archivedAt && (!scope.get() || p.id === scope.get()));
    const chatsByProject = new Map();
    for (const group of digest) {
      const chats = chatsByProject.get(group.projectId) ?? [];
      chats.push(group);
      chatsByProject.set(group.projectId, chats);
    }
    const loose = windows.get('');
    if (!scope.get() && (counts.get('') || chatsByProject.has('') || loose && [loose.completed, loose.failed, loose.ended, loose.progress, loose.decisions].some(list => list.length)))
      groups.push({ id: '', name: '未归项目' });
    const total = key => briefing.reduce((n,p) => n + p[key].length, 0);
    replace(body, h('div', { class: 'home-priorities' },
      priorityCard('需要我', '等待你回答、确认或批准', attention,
        item => link(item.route?.href ?? router.href(item.type === 'inbox' ? 'inbox' : 'chat'), item.title), '当前没有待确认事项。'),
      priorityCard('重要紧急', '已逾期或未来 24 小时到期的待办', open.filter(urgent), todoLink, '没有即将到期的待办。'),
      priorityCard('重要不急', '其余已进入待办的事项，按截止时间排列', open.filter(t => !urgent(t)), todoLink, '没有其他未完成待办。')),
    Card({ title: '简报', sub: '最近 24 小时', body: [briefError ? muted(briefError) : !brief ? muted('正在读取简报…') :
      h('p', null, '完成待办 ' + total('completed') + ' 项，执行结束 ' + total('ended') + ' 次，执行失败 ' + total('failed') + ' 次。'),
      digest.length > 0 && h('details', null, h('summary', null, '群聊动态 · ' + digest.length + ' 个群'), digest.map(g =>
        h('p', { class: 'home-row' }, h('strong', null, g.name + ' · ' + g.count + ' 条'), h('br'), '最近消息：' + g.latest)))] }),
    Card({ title: '项目总结', body: groups.length ? groups.map(p => {
      const window = windows.get(p.id);
      const chats = chatsByProject.get(p.id) ?? [];
      const updates = window ? [['执行失败', window.failed], ['完成待办', window.completed], ['执行结束', window.ended],
        ['执行进展', window.progress], ['待办更新', window.todoUpdates], ['待决定', window.decisions]] : [];
      return h('section', { class: 'home-project' },
        h('h3', null, link(router.href('projects', p.id || 'all', p.id ? 'workspace' : 'todos'), p.name)),
        muted((p.description ? p.description + ' · ' : '') + '未完成待办 ' + (counts.get(p.id) ?? 0) + ' 项'),
        updates.filter(([,items]) => items.length).map(([name, items]) => h('p', null, name + ' ' + items.length + ' 项 · ' + items.slice(0, 2).map(i => i.title).join('、'))),
        chats.length > 0 && muted('有群聊动态：' + chats.map(g => g.name).join('、')),
        window && !chats.length && !updates.some(([,items]) => items.length) && muted('最近 24 小时没有更新。'));
    }) : muted('当前范围内没有项目。') }),
    guideCard);
  }
  scope.subscribe(draw);
  async function readBrief() {
    if (router.current.page !== 'home' || !store.view.snapshot) return;
    const id = ++request;
    lastRead = Date.now();
    briefError = '';
    try {
      const result = await api.get('/brief/current');
      if (id === request) brief = result.window;
    } catch (cause) { if (id === request) briefError = '简报暂不可用：' + cause.message; }
    draw();
  }
  return { el,
    onState() {
      draw();
      if (Date.now() - lastRead > 60000) void readBrief();
    },
    onShow() { draw(); void readBrief(); },
  };
}
