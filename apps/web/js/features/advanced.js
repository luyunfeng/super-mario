// 高级：插件、插件文件、后台事件、界面、诊断。通常不用动，默认全部折叠。
import { h, replace } from '../lib/dom.js';
import { Button, Fold, Pill, Check } from '../ui/kit.js';
import { hintsEnabled, setHintsEnabled } from '../ui/hint.js';
import { createAgentArtifactsUI } from '../legacy/agent-artifacts.js';
import { createBackgroundPage } from '../legacy/background-page.js';
import { systemText } from '../copy/terms.js';

const PLUGIN_STATUS = { active: ['已启用', 'ok'], disabled: ['已停用', ''], waiting: ['等待配置', 'warn'], failed: ['不可用', 'danger'] };
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };

export function createAdvanced({ api, store, router }) {
  const pluginList = h('div', { class: 'list' });
  const plugins = Fold({ title: '插件', body: pluginList });

  const artifactsHost = h('div', { class: 'legacy' });
  let artifacts;
  const files = Fold({ title: '插件文件', body: artifactsHost, onOpen: () => { artifacts = createAgentArtifactsUI({ api, element: artifactsHost, onChanged: () => store.refresh() }); artifacts.open(); } });

  const backgroundHost = h('div', { class: 'legacy' });
  let background;
  const events = Fold({ title: '后台事件与发件箱', body: backgroundHost, onOpen: () => { background = createBackgroundPage({ api, element: node, root: backgroundHost }); background.load?.(); } });

  const hintsToggle = Check({ label: '显示每个功能右上角的作用说明', checked: hintsEnabled(), onChange: setHintsEnabled });
  const setupList = h('div', { class: 'stack' });
  const ui = Fold({ title: '界面', body: [hintsToggle,
    Button({ label: '预览开屏', size: 'sm', onClick: () => window.dispatchEvent(new CustomEvent('workspace:preview-splash')) }),
    Button({ label: '设置记忆整理 Agent', size: 'sm', onClick: () => router.go(`${router.href('memory')}?curator=1`) }),
    h('div', { class: 'stack' }, h('h3', null, '入门进度'), setupList)] });

  const diag = h('dl', { class: 'kv' });
  const diagnostics = Fold({ title: '诊断', body: diag });

  const el = h('details', { class: 'fold', id: 'agent-advanced' },
    h('summary', null, '高级：插件与排查'),
    h('div', { class: 'fold__body' }, plugins, files, events, ui, diagnostics));

  function paint(snapshot) {
    replace(pluginList, (snapshot.plugins ?? []).map((plugin) => {
      const [text, tone] = PLUGIN_STATUS[plugin.status] ?? [plugin.status, ''];
      return h('div', { class: 'item' },
        h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, systemText(plugin.name)),
          plugin.error && h('details', null, h('summary', { class: 'small muted' }, '诊断日志'), h('pre', null, plugin.error))),
        Pill(text, tone),
        Button({ label: plugin.enabled ? '停用' : '启用', size: 'sm', onClick: async () => { await api.post(`/plugins/${encodeURIComponent(plugin.id)}`, { enabled: !plugin.enabled }); await store.refresh(); } }));
    }));
    const setup = snapshot.setup ?? {};
    replace(setupList, [['配置 Agent', setup.agent], ['新建项目', setup.project], ['添加记忆', setup.memory], ['连接飞书', setup.channel]].map(([name, value]) =>
      h('div', { class: 'row row--between' }, h('span', null, name), value === true || value === 'done' ? Pill('已完成', 'ok') : value === 'skipped' ? Pill('已跳过') : Pill('未完成', 'warn'))));
    replace(diag,
      h('dt', null, '版本'), h('dd', null, snapshot.version),
      h('dt', null, '运行模式'), h('dd', null, snapshot.mode === 'demo' ? '演示' : '正式'),
      (snapshot.problems ?? []).map(item => [h('dt', null, item.area === 'agent' ? 'Agent' : '渠道'), h('dd', null, `${item.message}。${item.fix}`)]));
  }

  return { el, update: paint };
}
