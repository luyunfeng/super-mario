// 来源读取同意与整理 worker 分开保存；连接状态不代表来源权限已经核验。
import { h, replace } from '../lib/dom.js';
import { Button, Banner, Card, Check, Field, Input } from '../ui/kit.js';

export function createKnowledgeReaderCard({ api, store, isCurrent }) {
  let disposed = false;
  let request = 0;
  let saving = false;
  let ready = false;
  let queued = false;
  const dirty = new Set();
  const enabled = Check({ label: '启用受保护来源读取', checked: false });
  const checkbox = enabled.querySelector('input');
  const profile = Input({ placeholder: '留空使用已授权的个人飞书账号', spellcheck: false });
  const hosts = Input({ placeholder: 'docs.example.com, files.example.com', spellcheck: false });
  const status = h('div', { role: 'status', style: { overflowWrap: 'anywhere' } }, '连接状态未知，正在读取配置…');
  const message = h('div', { role: 'status', style: { overflowWrap: 'anywhere' } });
  const controls = { enabled: checkbox, profile, trustedHosts: hosts };
  for (const [key, control] of Object.entries(controls)) control.addEventListener(key === 'enabled' ? 'change' : 'input', () => dirty.add(key));
  const current = () => !disposed && isCurrent();
  const values = () => ({ enabled: checkbox.checked, profile: profile.value, trustedHosts: hosts.value });
  const save = Button({ label: '保存来源读取设置', disabled: true, onClick: async () => {
    if (!current() || !ready || saving) return;
    const draft = values();
    const trustedHosts = draft.trustedHosts.split(/[,，\s]+/u).filter(Boolean);
    // 仅允许精确主机名；URL、路径、端口和通配符不能扩大受信范围。
    if (trustedHosts.length > 32 || trustedHosts.some(host => host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host))) {
      replace(message, Banner({ tone: 'danger', children: '请填写精确受信域名，最多 32 个；不含协议、路径、端口或通配符。' })); return;
    }
    const body = { enabled: draft.enabled, ...(draft.profile.trim() ? { profile: draft.profile.trim() } : {}), trustedHosts };
    saving = true; save.disabled = true; ++request;
    try {
      const result = await api.put('/knowledge/source-reader', body);
      if (!current()) return;
      connection(result);
      for (const key of Object.keys(draft)) if (values()[key] === draft[key]) dirty.delete(key);
      replace(message, Banner({ children: '来源读取设置已保存。提交 URL 后才会尝试读取，读取权限尚未检查。' }));
    } catch (error) {
      if (!current()) return;
      status.textContent = '连接状态未知；草稿已保留。';
      replace(message, Banner({ tone: 'danger', children: `保存未确认，请核对状态后再试：${error.message}` }));
    } finally {
      saving = false;
      if (current()) { save.disabled = !ready; if (queued) { queued = false; refresh(); } }
    }
  } });
  function connection(result) {
    const names = { 'personal-feishu': '当前连接：已授权飞书账号', 'explicit-profile': '当前连接：自定义命令行连接（账号和权限尚未检查）', missing: '当前连接：缺少连接，请先连接飞书账号' };
    status.textContent = `${names[result.connection] ?? '当前连接：未知'}。读取权限尚未检查。`;
  }
  async function refresh() {
    if (!current()) return;
    if (saving) { queued = true; return; }
    const stamp = ++request;
    try {
      const result = await api.get('/knowledge/source-reader');
      if (!current() || stamp !== request) return;
      if (typeof result?.enabled !== 'boolean' || !Array.isArray(result.trustedHosts)) throw new Error('服务返回的来源配置无效');
      if (!dirty.has('enabled')) checkbox.checked = result.enabled;
      if (!dirty.has('profile')) profile.value = result.profile ?? '';
      if (!dirty.has('trustedHosts')) hosts.value = result.trustedHosts.join(', ');
      ready = true; save.disabled = false; connection(result);
      replace(message);
    } catch (error) {
      if (!current() || stamp !== request) return;
      ready = false; save.disabled = true;
      status.textContent = '连接状态未知；草稿和上次读取的配置已保留。';
      replace(message, Banner({ tone: 'danger', children: error.status === 404
        ? '服务端缺少受保护来源读取能力，请升级服务端。原整理设置仍可使用。'
        : `读取来源配置失败：${error.message}` }));
    }
  }
  const el = Card({ title: '受保护来源读取', className: 'card--tight', body: [
    enabled, status, h('a', { href: '#channels', onClick: () => el.dispatchEvent(new CustomEvent('reader-channel', { bubbles: true })) }, '去渠道连接飞书账号'),
    h('p', { class: 'muted small' }, '连接飞书账号后即可启用，无需填写连接名称。此开关独立于消息采集和整理 Agent；启用不会自动读文件、申请权限、登录或调用模型。提交 URL 后才尝试读取；权限不足会显示在来源任务错误中。'),
    h('details', null, h('summary', null, '高级设置'), h('div', { class: 'stack' },
      Field({ label: '已有命令行连接名称', control: profile, hint: '仅填写已配置的自定义 profile 名称，不是 token 或密钥。留空复用已核验个人飞书账号，其内部连接名称不会显示。' }),
      Field({ label: '额外精确受信域名', control: hosts, hint: '用逗号或空格分隔。不支持通配符；只添加你信任的精确域名。' }),
      h('p', { class: 'muted small' }, '支持标准 Feishu/Lark 文档、知识库文档、UTF-8 文本附件、PDF 文字层和 DOCX。附件最多 1 MiB，PDF 最多 100 页；扫描件不做 OCR，旧版 Office、Excel 和演示文件暂不支持。'))),
    h('div', null, save), message,
  ] });
  // 复用已有事件驱动快照；不增加定时轮询。事件连接失败不能继续显示确定状态。
  const unsubscribe = store.subscribe?.(view => {
    if (!current()) return;
    if (view.loadError || view.connection === 'offline' || view.unauthorized) {
      ++request; ready = false; save.disabled = true;
      status.textContent = '连接状态未知：事件或状态读取失败；草稿已保留。';
      return;
    }
    refresh();
  });
  refresh();
  return { el, destroy() { disposed = true; ++request; unsubscribe?.(); } };
}
