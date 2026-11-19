// 渠道：在飞书里找 Agent。机器人是三步向导：扫码创建 → 在飞书里配对 → 选择负责的项目。
// 个人消息采集需要单独授权，默认关闭，只读。手动接入、信箱和事件收进“高级”。
import { h, replace } from '../lib/dom.js';
import { Button, Banner, Card, Check, Dot, Empty, Field, Fold, Input, Pill, Select } from '../ui/kit.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { createPersonalMessagesUI } from '../features/personal-messages.js';
import { createBotMailboxesUI } from '../legacy/bot-mailboxes.js';
import { systemText } from '../copy/terms.js';

const JOB_LABELS = { queued: '准备中', waiting_for_scan: '等待扫码', creating_app: '创建中', configuring: '配置中', publishing: '发布中', verifying: '核验中', completed: '机器人已创建', needs_configuration: '需要完成配置', failed: '创建失败', unknown: '结果未知', cancelled: '已取消', expired: '二维码已过期' };
const JOB_DONE = new Set(['completed', 'needs_configuration', 'failed', 'unknown', 'cancelled', 'canceled', 'expired']);
const GLOBAL = '__global';

export function createChannelsPage({ api, store, router }) {
  let bots = [];
  const mainSetup = () => router.current.parts[0] === 'main-bot';
  let job = null;
  let selected = '';
  let registrations = [];
  let restoreScope = false;
  let creating = false;
  let nameDraft;
  let error = '';
  let seq = 0;
  let timer;
  let projectSig = '';

  const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
  const projects = () => (store.view.snapshot?.projects ?? []).filter(item => !item.archivedAt);
  const scopeText = (scope) => scope?.kind === 'project' ? `项目：${projects().find(item => item.id === scope.projectId)?.name ?? '项目已不可用'}`
    : scope?.kind === 'global' ? '全局' : '还没有选择负责的项目';

  // —— 机器人向导 ——
  const wizard = h('div', { class: 'stack stack--lg' });
  const botCard = Card({ title: '飞书机器人', hint: 'channel.bot', id: 'channel-bot', body: wizard });

  function step(number, title, done, content) {
    return h('li', { class: `wstep ${done ? 'is-done' : ''}`, dataset: { step: number, done: String(done) } },
      h('span', { class: 'wstep__mark', 'aria-hidden': 'true' }, done ? '✓' : String(number)),
      h('div', { class: 'wstep__main' }, h('strong', null, title), content));
  }

  function renderJob(record = job) {
    if (!record) return null;
    const qr = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(record.qrDataUrl || '') && h('img', { class: 'qr', src: record.qrDataUrl, alt: '使用飞书扫描，创建机器人', width: 240, height: 240 });
    const steps = (record.missingSteps || []).map((item) => {
      const text = typeof item === 'string' ? item : item.message || item.title || item.description || '请核查飞书配置';
      let link;
      try { const url = new URL(item.url); if (url.protocol === 'https:' && ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)) link = h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, '前往飞书配置'); } catch { /* 没有链接。 */ }
      return h('p', { class: 'small' }, systemText(text), ' ', link);
    });
    return h('div', { class: 'stack', dataset: { job: record.status } },
      h('div', { class: 'row' }, Pill(JOB_LABELS[record.status] ?? '等待处理', record.status === 'failed' || record.status === 'unknown' ? 'danger' : record.status === 'completed' ? 'ok' : 'info'),
        record.progress && h('span', { class: 'muted small' }, systemText(record.progress))),
      record.id && ['failed', 'unknown', 'expired', 'needs_configuration'].includes(record.status) &&
        h('div', { class: 'small muted' }, '日志 ID：', h('code', null, record.id),
          record.diagnostic && h('span', null, ' · ', record.diagnostic.step,
            record.diagnostic.httpStatus && ' · HTTP ' + record.diagnostic.httpStatus,
            record.diagnostic.platformCode !== undefined && ' · 飞书业务码 ' + record.diagnostic.platformCode,
            record.diagnostic.reason && ' · ' + record.diagnostic.reason,
            record.diagnostic.redirectHost && ' · 跳转主机 ' + record.diagnostic.redirectHost,
            record.diagnostic.platformLogId && ' · 飞书日志 ID：' + record.diagnostic.platformLogId)),
      qr, record.status === 'unknown' && Banner({ tone: 'danger', children: '结果未知。请先到飞书后台核对，系统不会自动重复创建。' }),
      record.expiresAt && h('p', { class: 'muted small' }, `二维码有效期至 ${new Date(record.expiresAt).toLocaleString('zh-CN')}`), steps,
      !JOB_DONE.has(record.status) && Button({ label: '取消本次创建', size: 'sm', onClick: async () => { job = await api.post(`/feishu/registrations/${encodeURIComponent(record.id)}/cancel`, {}); paint(); } }));
  }

  function renderCreate() {
    const projectSetup = router.current.parts[0] === 'project-bot';
    const project = projectSetup && projects().find(item => item.id === router.current.parts[1]);
    const label = mainSetup() ? '主 Agent' : project ? project.name : '工作助手';
    const suggested = ('Super Mario · ' + label).slice(0, 80).replace(/[\uD800-\uDBFF]$/, '');
    const name = Input({ value: nameDraft ?? suggested, maxLength: 80, required: true, 'aria-label': '机器人名称' });
    name.addEventListener('input', () => { nameDraft = name.value; });
    const scope = mainSetup() ? { kind: 'global' } : project ? { kind: 'project', projectId: project.id } : { kind: 'unmarked' };
    const active = job && (!JOB_DONE.has(job.status) || job.status === 'unknown');
    return h('div', { class: 'stack' },
      projectSetup && h('p', { class: 'small' }, project ? '负责项目：' + project.name : '项目不可用，请返回项目页重新选择。'),
      mainSetup() && h('p', { class: 'small' }, '为主 Agent 创建全局飞书机器人，可跟进所有项目。'),
      !bots.length && !active && h('ol', { class: 'howto small' },
        h('li', null, '扫码创建机器人（用飞书扫一扫）'), h('li', null, '在飞书里私聊它，回复配对码'), h('li', null, mainSetup() ? '确认全局机器人已连接' : '选择它负责的项目')),
      !active && h('form', { class: 'row', onsubmit: async (event) => {
        event.preventDefault();
        if (!name.value.trim() || (projectSetup && !project)) return;
        event.currentTarget.querySelector('button').disabled = true;
        try { job = await api.post('/feishu/registrations', { name: name.value.trim(), scope, requireConfirmation: true }); creating = false; error = ''; }
        catch (cause) { error = cause.status && cause.status < 500 ? `没有开始创建：${systemText(cause.message)}` : '创建结果未知，请先到飞书后台核对，系统不会自动重试。'; if (!cause.status || cause.status >= 500) job = { id: '', status: 'unknown' }; }
        paint(); schedule();
      } }, h('div', { class: 'grow' }, name), h('button', { class: 'btn btn--primary', type: 'submit', disabled: projectSetup && !project }, '生成二维码')),
      renderJob());
  }

  function renderBot(bot) {
    const bind = Select({ options: [[GLOBAL, '全局（所有项目）'], ...projects().map(item => [item.id, item.name])], value: bot.scope?.kind === 'project' ? bot.scope.projectId : bot.scope?.kind === 'global' ? GLOBAL : projects()[0]?.id ?? GLOBAL, 'aria-label': '负责的项目', disabled: !bot.paired });
    const paired = Boolean(bot.paired);
    const bound = bot.scope?.kind === 'project' || bot.scope?.kind === 'global';
    return h('ol', { class: 'wsteps' },
      step(1, '扫码创建机器人', true, [h('p', { class: 'muted small' }, `「${bot.name}」${bot.connected ? '已连接' : '未连接'}${bot.reason ? `：${systemText(bot.reason)}` : ''}`),
      !bot.enabled && renderJob(registrations.findLast(item => item.botId === bot.id && ['needs_configuration', 'unknown'].includes(item.status)) ?? null)]),
      step(2, '在飞书里完成配对', paired, paired ? h('p', { class: 'muted small' }, '已配对，由服务端确认。')
        : !bot.enabled ? h('div', { class: 'stack' },
          h('p', { class: 'small' }, '工作台连接已停用。确认飞书版本已发布后，可启用现有机器人。'),
          Button({ label: '已发布，启用连接', size: 'sm', onClick: async () => {
            try { await api.patch(`/feishu/bots/${encodeURIComponent(bot.id)}`, { enabled: true }); await load(); schedule(); }
            catch (cause) { error = systemText(cause.message); paint(); }
          } }))
        : !bot.connected ? h('p', { class: 'small' }, bot.reason || '等待飞书长连接建立。')
        : h('p', { class: 'small' }, bot.pairingCode ? `请在飞书里私聊「${bot.name}」，发送配对码：` : (bot.reason || '等待配对信息。'), bot.pairingCode && h('code', { class: 'pairing' }, bot.pairingCode))),
      step(3, '选择它负责的项目', bound, h('div', { class: 'row row--wrap' }, h('div', { style: { minWidth: '200px' } }, bind),
        Button({ label: '绑定', size: 'sm', disabled: !paired, onClick: async () => {
          await api.patch(`/feishu/bots/${encodeURIComponent(bot.id)}`, { scope: bind.value === GLOBAL ? { kind: 'global' } : { kind: 'project', projectId: bind.value } });
          await load(); store.refresh();
        } }), h('span', { class: 'muted small' }, scopeText(bot.scope)))));
  }

  function paint() {
    const current = bots.find(bot => bot.id === selected) ?? (creating ? null : bots[0]);
    selected = current?.id ?? '';
    const showCreate = creating || !bots.length || (job && !job.botId);
    replace(wizard,
      error && Banner({ tone: 'danger', children: error }),
      bots.length > 0 && h('div', { class: 'list' }, bots.map(bot => h('div', { class: `item item--click ${bot.id === selected ? 'is-selected' : ''}`, tabindex: 0, role: 'button', dataset: { bot: bot.id },
        onclick: () => { if (job && JOB_DONE.has(job.status)) job = null; selected = bot.id; creating = false; paint(); }, onkeydown: (event) => { if (event.key === 'Enter') event.currentTarget.click(); } },
      Dot(bot.connected ? 'ok' : 'warn'), h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, bot.name), h('span', { class: 'item__meta' }, `${scopeText(bot.scope)} · ${bot.paired ? '已配对' : '未配对'}`)),
      !bot.enabled && Pill('已停用')))),
      current && !showCreate && renderBot(current),
      showCreate ? renderCreate() : Button({ label: '添加另一个机器人', icon: 'plus', size: 'sm', onClick: () => { creating = true; nameDraft = undefined; job = null; paint(); } }),
      !bots.length && !showCreate && Empty({ title: '还没有机器人' }));
  }

  // 个人账号授权和采集独立于机器人连接，不要求用户理解 CLI 配置。
  const personal = createPersonalMessagesUI({ api, store, router, onConnectApplication() {
    creating = true; paint(); botCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    botCard.querySelector('input')?.focus();
  } });
  const collectCard = personal.el;

  // —— 高级 ——
  const advancedHost = h('div', { class: 'legacy' });
  let mailboxes;
  const advanced = Fold({ title: '高级：手动接入、信箱与事件', body: advancedHost, onOpen: () => {
    mailboxes = createBotMailboxesUI({ api, element: advancedHost, showRegistration: false, getState: () => store.view.snapshot, onChanged: async () => { await load(); store.refresh(); } });
    mailboxes.open();
  } });

  const problemBox = h('div', { id: 'channel-problems' });
  const el = h('section', { class: 'page', id: 'channels' },
    h('div', { class: 'page__inner' },
      h('header', { class: 'page__head' },
        h('div', { class: 'page__title' }, h('h1', null, '渠道'), h('p', { class: 'page__sub' }, hintCopy('nav.channels').tag)),
        h('div', { class: 'page__actions' }, Hint('nav.channels'))),
      problemBox, h('div', { class: 'stack stack--lg' }, botCard, collectCard, advanced)));

  async function load() {
    const stamp = ++seq;
    const results = await Promise.allSettled([api.get('/feishu/bots'), personal.refresh(), api.get('/feishu/registrations')]);
    if (stamp !== seq) return;
    if (results[0].status === 'fulfilled') bots = results[0].value;
    if (results[2].status === 'fulfilled') {
      const jobs = results[2].value;
      registrations = jobs;
      job = job?.id ? jobs.find(item => item.id === job.id) ?? job : jobs.find(item => !JOB_DONE.has(item.status) || (item.status === 'unknown' && !item.botId)) ?? null;
    }
    if (restoreScope && results[0].status === 'fulfilled') {
      restoreScope = false;
      const match = bots.find(bot => mainSetup() ? bot.scope?.kind === 'global'
        : bot.scope?.kind === 'project' && bot.scope.projectId === router.current.parts[1]);
      if (match) { selected = match.id; creating = false; }
    }
    if (job?.botId && bots.some(bot => bot.id === job.botId) && JOB_DONE.has(job.status)) {
      selected = job.botId; creating = false; job = null;
    }
    error = results.some(item => item.status === 'rejected') ? '部分渠道信息读取失败，请检查连接和访问权限。' : '';
    paint();
  }

  function schedule() {
    clearTimeout(timer);
    const waiting = (job && !JOB_DONE.has(job.status)) || bots.some(bot => bot.enabled && !bot.paired);
    if (!waiting || router.current.page !== 'channels') return;
    timer = setTimeout(async () => {
      const id = job?.id;
      if (id && !JOB_DONE.has(job.status)) {
        try {
          const next = await api.get('/feishu/registrations/' + encodeURIComponent(id));
          if (router.current.page !== 'channels' || job?.id !== id) return;
          job = next; error = ''; paint();
          if (JOB_DONE.has(job.status)) await load();
        } catch { error = '读取扫码进度失败，正在重新连接。'; paint(); }
      } else await load();
      schedule();
    }, job?.status === 'queued' ? 350 : 1500);
  }

  return {
    el,
    onShow(route) {
      nameDraft = undefined;
      restoreScope = ['main-bot', 'project-bot'].includes(route.parts[0]);
      if (['main-bot', 'project-bot'].includes(route.parts[0])) { selected = ''; creating = true; }
      else if (route.parts[0] === 'bot') { selected = route.parts[1] || ''; creating = false; }
      else creating = false;
      load().then(schedule); if (route.parts[0] === 'advanced') advanced.open = true; },
    onState({ snapshot }) {
      const problems = (snapshot.problems ?? []).filter(item => item.area === 'channel');
      const configured = snapshot.setup?.channel === 'done';
      replace(problemBox, configured && problems.map(item => Banner({ tone: 'danger', children: `${item.message}。${item.fix}` })));
      // 向导里可能有正在输入的内容：只有项目列表变了才重绘。
      const signature = JSON.stringify(projects().map(item => [item.id, item.name]));
      if (signature !== projectSig) { projectSig = signature; if (router.current.page === 'channels') paint(); }
      mailboxes?.update(snapshot);
    },
  };
}
