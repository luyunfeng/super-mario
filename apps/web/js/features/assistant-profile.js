import { h, replace } from '../lib/dom.js';
import { Button, Card, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const active = view => !view.unauthorized && !!view.snapshot?.plugins?.some(
  plugin => plugin.id === 'assistant-profile' && plugin.status === 'active');

export function mainAssistantName(view) {
  return active(view) ? view.snapshot.mainAssistant?.name ?? '助手' : '主 Agent';
}

export function createAssistantProfile({ api, store }) {
  let bots, botsOwner, botsError = '';
  const body = h('div', { class: 'stack' });
  const edit = Button({ label: '修改名称', size: 'sm', onClick: open });
  const el = Card({ title: '主助手资料', id: 'assistant-profile', body, tools: edit });

  function update() {
    const view = store.view;
    if (botsOwner !== api.token() || view.unauthorized || !view.snapshot) {
      bots = undefined;
      botsError = '';
    }
    el.hidden = !active(view);
    if (el.hidden) { body.replaceChildren(); return; }
    const { mainAssistant, agent, machines, mode } = view.snapshot;
    edit.disabled = !mainAssistant;
    const online = view.connection === 'online';
    const ready = agent?.available ? '可用' : agent ? '不可用' : '状态未知';
    const model = mode === 'demo' ? '演示模式 · ' + ready : ready;
    replace(body, h('dl', { class: 'kv' },
      h('dt', null, '名称'), h('dd', null, mainAssistant?.name ?? '读取主助手名称失败'),
      h('dt', null, '模型状态'), h('dd', null, online ? model : '连接中断，状态未知'),
      h('dt', null, '在线执行机'), h('dd', null, online && machines ? machines.filter(machine => machine.online).length + ' 台' : '状态未知'),
      h('dt', null, '已连接全局机器人'), h('dd', null, !online ? '状态未知' : botsError || (bots === undefined ? '正在读取…' : bots + ' 个'))),
      !mainAssistant && Button({ label: '重新读取主助手资料', size: 'sm', onClick: () => store.refresh() }));
  }
  function setBots(rows, owner, error = '') {
    if (owner !== api.token() || store.view.unauthorized) return;
    botsOwner = owner;
    botsError = error;
    bots = rows?.filter(bot => bot.scope?.kind === 'global' && bot.enabled && bot.connected).length;
    update();
  }

  function open() {
    const initial = store.view.snapshot?.mainAssistant;
    if (!active(store.view) || !initial) return;
    const token = api.token(), route = location.hash;
    let base = initial, latest, busy = false, review = false;
    const name = Input({ value: initial.name, required: true, oninput: sync });
    const status = h('p', { role: 'status', class: 'small' });
    const comparison = h('div', { class: 'stack' });
    const submit = Button({ label: '保存', kind: 'primary', type: 'submit' });
    const form = h('form', { class: 'stack', onsubmit(event) { event.preventDefault(); if (!review) void save(base); } },
      Field({ label: '主助手名称', control: name, hint: '1 至 40 个字符，显示在主对话的助手消息上。' }), status, comparison, submit);
    const drawer = openDrawer({ title: '修改主助手名称', body: form, onClose() {
      unsubscribe();
      drawer.body.replaceChildren();
    } });
    const current = () => drawer.el.open && route === location.hash && token === api.token() && active(store.view);
    const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });

    function sync() {
      const length = [...name.value.trim()].length;
      const valid = length >= 1 && length <= 40;
      name.setAttribute('aria-invalid', String(!valid));
      name.disabled = busy;
      submit.hidden = review;
      submit.disabled = busy || !valid || review || base.name === name.value.trim();
      const keep = comparison.querySelector('[data-save-name]');
      if (keep) keep.disabled = busy || !valid;
    }
    async function compare() {
      if (!current()) return;
      latest = undefined;
      comparison.replaceChildren();
      try {
        const result = await api.post('/assistant-profile', { action: 'read' });
        if (!current()) return;
        latest = result;
        replace(comparison,
          h('p', null, '当前名称：', h('strong', null, latest.name)), h('div', { class: 'row row--wrap' },
            Button({ label: '采用当前名称', onClick() {
              if (!current() || busy) return;
              base = latest;
              name.value = base.name;
              review = false;
              comparison.replaceChildren();
              status.textContent = '已采用当前名称。';
              sync();
            } }),
            Button({ label: '保存我的名称', kind: 'primary', dataset: { saveName: 'true' }, onClick: () => save(latest) })));
      } catch (cause) {
        if (!current()) return;
        status.textContent = cause.message;
        replace(comparison, Button({ label: '重新核对名称', onClick: compare }));
      }
      if (current()) sync();
    }
    async function save(version) {
      const value = name.value.trim();
      if (busy || !current() || !version || !value || [...value].length > 40) return;
      busy = true;
      sync();
      try {
        const result = await api.post('/assistant-profile', { action: 'save', name: value, revision: version.revision });
        if (!current()) return;
        base = result;
        name.value = result.name;
        review = false;
        comparison.replaceChildren();
        status.textContent = '主助手名称已保存。';
        await store.refresh();
      } catch (cause) {
        if (!current()) return;
        if (cause.status === 409 || !cause.status || cause.status >= 500) {
          review = true;
          status.textContent = cause.status === 409 ? '名称已被修改。你的草稿已保留。' : '保存结果未确认，请核对当前名称。';
          await compare();
        } else status.textContent = cause.message;
      } finally { busy = false; if (current()) sync(); }
    }
    sync();
    name.focus();
  }
  store.subscribe?.(update);
  update();
  return { el, setBots };
}
