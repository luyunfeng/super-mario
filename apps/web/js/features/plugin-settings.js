import { h, replace, keyedList, readLocal, writeLocal } from '../lib/dom.js';
import { PAGES } from '../lib/router.js';
import { Button, Pill } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { systemText } from '../copy/terms.js';

const key = 'sm.pluginSidebar.v1';
const status = { active: ['已启用', 'ok'], waiting: ['等待配置', 'warn'], disabled: ['已停用', ''], failed: ['不可用', 'danger'] };

function features(plugin) {
  if (!Array.isArray(plugin.navigation)) return [];
  return plugin.navigation.filter(item => item && typeof item.id === 'string' && item.id && typeof item.label === 'string' && item.label &&
    typeof item.route === 'string' && /^#[a-z]+(?:\/[\w-]+)*(?:\?[\w=&-]+)?$/.test(item.route) &&
    !new URLSearchParams(item.route.split('?')[1]).has('token') && PAGES.includes(item.route.slice(1).split(/[/?]/)[0]))
    .map(item => ({ ...item, key: JSON.stringify([plugin.id, item.id]) }));
}

export function createPluginSettings({ api, store, router }) {
  const saved = readLocal(key, []);
  const pins = new Set(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []);
  const nav = h('nav', { class: 'plugin-links', 'aria-label': '已固定的插件功能' });
  const list = h('div', { class: 'stack' });
  const shortcuts = h('div', { class: 'row plugin-mobile-pins' });
  let drawer;
  function openFeature(item) {
    drawer?.close();
    router.go(item.route);
  }
  function paint() {
    const { snapshot, unauthorized, loadError } = store.view;
    const plugins = unauthorized ? [] : snapshot?.plugins ?? [];
    const available = new Map();
    for (const plugin of plugins.filter(plugin => plugin.status === 'active')) {
      for (const item of features(plugin)) available.set(item.key, item);
    }
    const visible = [...pins].map(id => available.get(id)).filter(Boolean);
    keyedList(nav, visible, item => item.key, item => h('a', {
      class: 'nav__item', href: item.route, onclick: e => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); openFeature(item);
      },
    }, item.label));
    nav.hidden = visible.length === 0;
    if (!drawer) return;
    keyedList(shortcuts, visible, item => item.key, item => Button({ label: item.label, size: 'sm', onClick: () => openFeature(item) }));
    shortcuts.hidden = !visible.length;
    if (!plugins.length) {
      replace(list, h('p', { role: 'status' }, loadError || (snapshot ? '暂无已安装插件' : '正在读取插件…')));
      list._keyed = undefined;
      return;
    }
    keyedList(list, plugins, p => p.id, plugin => {
      const entries = features(plugin);
      return h('section', { class: 'plugin-section', 'aria-label': systemText(plugin.name) },
        h('div', { class: 'row' }, h('strong', null, systemText(plugin.name)), Pill(...(status[plugin.status] ?? ['未知', ''])),
          Button({ size: 'sm', label: plugin.enabled ? '停用' : '启用', onClick: async () => {
            await api.post('/plugins/' + encodeURIComponent(plugin.id), { enabled: !plugin.enabled });
            await store.refresh();
            if (store.view.loadError) throw new Error(store.view.loadError);
          } })),
        plugin.capabilities?.length > 0 && h('details', null, h('summary', { class: 'small' }, '查看插件声明的能力'), h('ul', null, plugin.capabilities.map(name => h('li', null, name)))),
        plugin.error && h('p', { class: 'small' }, plugin.error),
        entries.map(item => h('div', { class: 'row' },
          Button({ label: item.label, size: 'sm', disabled: !available.has(item.key), onClick: () => openFeature(item) }),
          h('label', null, h('input', { type: 'checkbox', checked: pins.has(item.key), onchange: e => {
            if (e.target.checked) pins.add(item.key); else pins.delete(item.key);
            writeLocal(key, [...pins]); paint();
          } }), ' 固定到侧边栏'))));
    }, plugin => JSON.stringify([plugin, features(plugin).map(item => pins.has(item.key))]));
  }
  function open() {
    if (drawer?.el.open) return;
    drawer = openDrawer({ title: '插件配置', subtitle: '启停影响整个工作台。侧边栏布局仅保存在此浏览器。', body: [shortcuts, list], onClose: () => { drawer = undefined; } });
    paint();
  }
  const footer = h('footer', { class: 'plugin-footer' }, Button({ label: '插件配置', size: 'sm', onClick: open }));
  store.subscribe(paint);
  paint();
  return { nav, footer, open };
}
