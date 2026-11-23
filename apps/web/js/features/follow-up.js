// 自动跟进：提醒与简报。展示当前节奏，细项在抽屉里调整。
import { h, replace } from '../lib/dom.js';
import { formatDate } from '../lib/format.js';
import { Button, Card, Field, Input, Check, Banner } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function createFollowUpCard({ api, store }) {
  let automation = null;
  let supervisor = null;
  let briefing = null;
  let presence = null;
  let error = '';
  let seq = 0;
  const summary = h('p', { id: 'follow-summary' }, '正在读取…');
  const state = h('div', { role: 'status' });
  const body = [state, summary, h('div', { class: 'row row--wrap' },
    Button({ label: '调整节奏', size: 'sm', onClick: () => openSettings() }),
    Button({ label: '简报与离场通知设置', size: 'sm', onClick: () => openBriefingSettings() }),
    Button({ label: '今日简报', size: 'sm', onClick: openToday }),
    Button({ label: '查看简报', size: 'sm', onClick: () => openBrief() }))];
  const el = Card({ title: '自动跟进', hint: 'agent.followup', body, id: 'agent-follow-up' });

  function paint() {
    if (!automation || !supervisor) { summary.textContent = error || '正在读取…'; return; }
    summary.textContent = `每 ${automation.tickSeconds} 秒检查一次；超过 ${automation.needsYouMinutes} 分钟没人处理就提醒你；到期提醒${automation.remindersEnabled ? '已开启' : '已关闭'}。`;
    replace(state,
      !supervisor.available && Banner({ tone: 'warn', children: `自动跟进 Agent 暂不可用：${supervisor.reason ?? ''}` }),
      supervisor.canResume && Banner({
        tone: 'warn', children: '自动跟进上一次没有正常完成，已暂停。请先核对状态，再决定是否恢复。',
        action: Button({ label: '恢复自动跟进', size: 'sm', onClick: async () => { await api.post('/supervisor/resume', {}); await load(); store.refresh(); } }),
      }));
  }

  async function load() {
    const stamp = ++seq;
    try {
      const [auto, sup, brief, web] = await Promise.all([api.get('/automation'), api.get('/supervisor/settings'), api.get('/briefing/settings'), api.get('/presence')]);
      if (stamp !== seq) return;
      automation = auto; supervisor = sup; briefing = brief; presence = web; error = '';
    } catch (cause) { if (stamp !== seq) return; error = `读取跟进设置失败：${cause.message}`; }
    paint();
  }

  function openBriefingSettings() {
    if (!briefing) return;
    const zone = Input({ value: briefing.timezone });
    const morning = Input({ type:'time',value:briefing.morning });
    const evening = Input({ type:'time',value:briefing.evening });
    const start = Input({ type:'time',value:briefing.activeStart });
    const end = Input({ type:'time',value:briefing.activeEnd });
    const hours = Input({ type:'number',min:1,max:168,value:briefing.intervalHours });
    const interval = Check({label:'启用间隔简报',checked:briefing.intervalEnabled});
    const away = Check({label:'离开页面后通知结果和待决定',checked:briefing.awayNotifications});
    const grading = Check({label:'低干扰：保留执行结果和项目对话通知',checked:briefing.lowDistraction === true});
    const held = (presence?.notifications ?? []).filter(n => n.status === 'held')
      .sort((a,b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    const heldSearch = Input({type:'search','aria-label':'搜索保留通知',placeholder:'搜索通知正文'});
    const heldList = h('div',{class:'stack'});
    function showHeld() {
      const query = heldSearch.value.trim().toLowerCase();
      const matches = held.filter(n=>n.text.toLowerCase().includes(query));
      replace(heldList,matches.length ? matches.map(n=>h('article',{},
        n.createdAt && h('time',{class:'small muted',dateTime:n.createdAt},formatDate(n.createdAt,true)),h('p',{},n.text)))
        : h('p',{role:'status'},query ? '没有匹配的保留通知。' : '暂无保留通知。'));
    }
    heldSearch.addEventListener('input',showHeld);
    showHeld();
    const quiet = briefing.decisionQuietHours ?? { enabled:false, start:'22:00', end:'08:00' };
    const quietToggle = Check({label:'飞书待决定提醒免打扰',checked:quiet.enabled});
    const quietCheck = quietToggle.querySelector('input');
    const quietStart = Input({type:'time',value:quiet.start,required:true});
    const quietEnd = Input({type:'time',value:quiet.end,required:true});
    const quietTimes = h('div',{class:'form-row'},
      Field({label:'免打扰开始',control:quietStart}), Field({label:'免打扰结束',control:quietEnd}));
    quietTimes.hidden = !quietCheck.checked;
    quietCheck.addEventListener('change',()=>{quietTimes.hidden=!quietCheck.checked;});
    const message = h('div',{role:'alert'});
    const backlog = (presence?.notifications ?? []).filter(n => n.status === 'pending');
    const drawer = openDrawer({title:'简报与离场通知',body:[
      h('p',{class:'muted'},'摘要按项目汇总。间隔简报仅在指定时段产生；投递沿用当前发送授权。'),
      Field({label:'时区',control:zone}),
      h('div',{class:'form-row'},Field({label:'早间时间',control:morning}),Field({label:'晚间时间',control:evening})), interval,
      Field({label:'间隔（小时）',control:hours}),
      h('div',{class:'form-row'},Field({label:'时段开始',control:start}),Field({label:'时段结束',control:end})),away,
      grading, h('details',{},h('summary',{},'已保留的通知（'+held.length+'）'),
        held.length > 0 && heldSearch,heldList), quietToggle,quietTimes,
      h('p',{class:'small muted'},'免打扰按简报时区生效。时段结束后，仍待回答的飞书提问卡才会提醒。'),
      h('p',null,`待路由通知 ${backlog.length} 条`),backlog.map(n => h('p',{class:'small'},n.reason)),message],
      footer:Button({label:'保存简报设置',kind:'primary',onClick:async()=>{
        if(quietCheck.checked && (!quietStart.reportValidity() || !quietEnd.reportValidity())) return;
        try { briefing = await api.put('/briefing/settings',{timezone:zone.value,morning:morning.value,evening:evening.value,activeStart:start.value,activeEnd:end.value,intervalHours:Number(hours.value),intervalEnabled:interval.querySelector('input').checked,awayNotifications:away.querySelector('input').checked,lowDistraction:grading.querySelector('input').checked,decisionQuietHours:{enabled:quietCheck.checked,start:quietStart.value || quiet.start,end:quietEnd.value || quiet.end}});drawer.close();await load(); }
        catch(error){replace(message,Banner({tone:'danger',children:`保存失败：${error.message}`}));}
      }})});
  }

  function openSettings() {
    if (!automation || !supervisor) return;
    const num = (value, min, max, step = 1) => Input({ type: 'number', min, max, step, value, required: true });
    const tick = num(automation.tickSeconds, 1, 3600);
    const stalled = num(automation.stalledMinutes, 1, 43200);
    const factor = num(automation.stalledFactorOfEstimate, 1, 10, 'any');
    const needs = num(automation.needsYouMinutes, 1, 43200);
    const batch = num(supervisor.batchSeconds, 1, 3600);
    const gap = num(supervisor.minGapMinutes, 1, 43200);
    const reminders = Check({ label: '到期前提醒我', checked: automation.remindersEnabled });
    const message = h('div', { role: 'alert' });
    const drawer = openDrawer({
      title: '调整跟进节奏', subtitle: '通常不需要改，默认值适合大多数人。',
      body: [reminders,
        h('div', { class: 'form-row' }, Field({ label: '检查间隔（秒）', control: tick }), Field({ label: '多久没人处理就提醒你（分钟）', control: needs })),
        h('div', { class: 'form-row' }, Field({ label: '判定停滞的时长（分钟）', control: stalled }), Field({ label: '或预计用时的倍数', control: factor })),
        h('div', { class: 'form-row' }, Field({ label: '合并消息的间隔（秒）', control: batch }), Field({ label: '两次跟进之间最短间隔（分钟）', control: gap })),
        message],
      footer: [Button({ label: '取消', onClick: () => drawer.close() }), Button({
        label: '保存', kind: 'primary',
        onClick: async () => {
          try {
            await api.put('/automation', { tickSeconds: Number(tick.value), stalledMinutes: Number(stalled.value), stalledFactorOfEstimate: Number(factor.value), needsYouMinutes: Number(needs.value), remindersEnabled: reminders.querySelector('input').checked });
            await api.put('/supervisor/settings', { batchSeconds: Number(batch.value), minGapMinutes: Number(gap.value) });
          } catch (cause) { replace(message, Banner({ tone: 'danger', children: `保存没有成功：${cause.message}。请核对后重试。` })); return; }
          drawer.close(); await load();
        },
      })],
    });
  }

  function openToday() {
    const content = h('div', { class: 'stack' });
    const owner = api.draftOwner();
    const controller = new AbortController();
    const drawer = openDrawer({ title: '今日简报', body: content, onClose() { controller.abort(); unsubscribe(); } });
    const current = () => drawer.el.open && owner === api.draftOwner() && !store.view.unauthorized;
    const enabled = () => store.view.snapshot?.plugins?.some(p => p.id === 'daily-brief' && p.status === 'active');
    const unsubscribe = store.subscribe(() => { if (!current() || !enabled()) drawer.close(); });
    async function read() {
      replace(content, h('p', { role: 'status' }, '正在读取今日简报…'));
      try {
        const brief = await api('/briefing/today', { method: 'POST', body: {}, signal: controller.signal });
        if (!current() || !enabled()) return;
        const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: brief.timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        function itemLabel(item) {
          if (item.endAt) return /^\d{4}-\d{2}-\d{2}$/.test(item.at) ? '全天' : clock.format(Date.parse(item.at)) + '–' + clock.format(Date.parse(item.endAt));
          return { todo: '待办已完成', completed: '执行已结束', queued: '排队中', running: '执行中' }[item.kind];
        }
        const groups = [['待你决定', brief.decisions], ['待处理收件', brief.inbox], ['今日提及', brief.mentions], ['今日完成', brief.completed],
          ['今日更新的失败执行', brief.failed], ['当前执行', brief.running], ['今日日程', brief.calendar]];
        replace(content, h('p', { class: 'small muted' }, brief.date + ' · ' + brief.timezone + ' · 生成于 ' + clock.format(Date.parse(brief.generatedAt))),
          Button({ label: '刷新今日简报', onClick: read }), groups.map(([title, group]) =>
          h('section', { class: 'stack' }, h('h3', null, title),
            group.available === false ? h('p', null, group.reason || '来源不可用') : [
              h('p', { class: 'small muted' }, (group.totalIsLowerBound ? '至少 ' : '') + group.total + ' 项' + (group.truncated ? ' · 当前仅显示部分记录' : '')),
              group.items.map(item => h('p', null, [itemLabel(item), item.title, item.reason].filter(Boolean).join(' · '))),
            ])));
      } catch (error) {
        if (current()) replace(content, h('p', { role: 'alert' }, error.message), Button({ label: '重新读取今日简报', onClick: read }));
      }
    }
    void read();
  }

  async function openBrief() {
    const content = h('div', { class: 'stack' }, h('p', { class: 'muted' }, '正在读取…'));
    openDrawer({ title: '简报与提醒', body: content });
    try {
      const brief = await api.get('/brief');
      if (!brief) { replace(content, h('p', { class: 'muted' }, '暂时没有简报，请确认简报插件已启用。')); return; }
      const groups = brief.sections || { 逾期: brief.todos?.overdue || [], 等待中: brief.todos?.waiting || [], 待处理: brief.todos?.upcoming || [], 已完成: brief.todos?.completed || [] };
      const blocks = Object.entries(groups).filter(([, items]) => items.length)
        .map(([name, items]) => h('div', { class: 'stack' }, h('h3', null, name), items.map(item => h('p', null, item.title))));
      if (brief.window) {
        const timeZone = brief.timezone || 'UTC';
        const format = new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium', timeStyle: 'short' });
        blocks.unshift(h('div', { class: 'stack' },
          h('p', { class: 'small muted' }, `统计时段（${timeZone}） ${format.format(new Date(brief.window.from))} → ${format.format(new Date(brief.window.to))}`),
          brief.window.basis && h('p', { class: 'small muted' }, brief.window.basis),
          brief.window.projects.map(p => {
            const sections = [['进展', [...p.progress, ...p.todoUpdates]], ['待办完成', p.completed],
              ['执行结束，待验收', p.ended], ['失败', p.failed], ['待决定', p.decisions]];
            for (const [label, items] of [['低干扰保留通知', p.heldNotifications], ['可稍后回答', p.deferredQuestions], ['执行结果未知', p.unknown], ['执行已取消', p.cancelled], ['等待执行', p.queued]]) {
              if (items?.length) sections.push([label, items]);
            }
            return h('section', { class: 'stack' }, h('h3', null, p.name), sections.map(([label, items]) =>
              h('div', null, h('strong', null, `${label} ${items.length}`), items.map(item => {
                  const href = label === '可稍后回答' ? '#projects/all/todos/detail/' + encodeURIComponent(item.id) : item.href;
                  return h('p', null, href?.startsWith('#') ? h('a', { href }, item.title) : item.title);
                }))));
          })));
      }
      for (const signal of brief.signals || []) blocks.push(h('p', null, signal.text));
      replace(content, blocks.length ? blocks : h('p', { class: 'muted' }, '当前没有需要跟进的内容。'));
    } catch (cause) { replace(content, h('p', { class: 'text-danger' }, `简报暂时不可读：${cause.message}`)); }
  }

  return { el, load };
}
