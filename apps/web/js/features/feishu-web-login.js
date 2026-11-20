import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const waiting = new Map([
  ['starting', '正在准备二维码'], ['waiting', '请用飞书扫描二维码'], ['scanned', '已扫码，请在飞书确认登录'],
]);
const terminal = new Map([
  ['expired', '二维码已失效'], ['failed', '网关登录失败'], ['idle', '当前没有进行中的登录'],
]);

// Each explicit click owns one drawer and one sequential poll loop.
export function openFeishuWebLogin(api, refreshStatus) {
  let timer, qr;
  const drawer = openDrawer({ title: '网页版网关扫码登录', body: '正在请求登录…', onClose: () => clearTimeout(timer) });
  async function request(path) {
    try {
      const result = await api.post(path, {});
      if (!drawer.el.open) return;
      const pending = waiting.has(result?.state);
      const done = result?.state === 'success';
      const label = waiting.get(result?.state) ?? terminal.get(result?.state) ?? (done ? '网关登录成功' : '无法确认网关登录状态');
      if (result.qrDataUrl !== undefined) {
        qr = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(result.qrDataUrl) ? result.qrDataUrl : undefined;
      }
      replace(drawer.body, h('div', { class: 'stack', role: 'status' }, h('strong', null, label),
        typeof result.message === 'string' && result.message && h('p', null, result.message),
        pending && qr && h('img', { class: 'qr', src: qr, alt: '用飞书扫码登录网页版网关', width: 240, height: 240 }),
        !pending && !done && Button({ label: '重新发起登录', onClick: start })));
      if (pending) timer = setTimeout(() => { if (drawer.el.open) request('/feishu/web/login/poll'); }, 1500);
      if (done) await refreshStatus();
    } catch {
      if (drawer.el.open) replace(drawer.body, h('p', { role: 'alert' }, '无法读取登录结果，请检查网关配置和连接。'),
        Button({ label: '重新发起登录', onClick: start }));
    }
  }
  function start() {
    qr = undefined;
    replace(drawer.body, '正在请求登录…');
    return request('/feishu/web/login');
  }
  return start();
}
