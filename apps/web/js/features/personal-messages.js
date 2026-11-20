import { h, replace } from '../lib/dom.js';
import { Banner, Button, Card, Dot } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const waiting = new Set(['preparing', 'waiting_for_scan', 'verifying']);
const labels = { disconnected: '未授权', preparing: '正在准备授权…', waiting_for_scan: '请用飞书扫码并确认授权', verifying: '正在核验账号和读取权限…', connected: '已授权，采集未开启', failed: '授权未完成', expired: '二维码已过期', cancelled: '授权已取消' };
function safeLink(value, hosts) {
  try { const url = new URL(value); return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port ? value : undefined; } catch { return undefined; }
}

/** The browser sees only public consent state. CLI names and device codes remain server-side. */
export function createPersonalMessagesUI({ api, store, router, onConnectApplication }) {
  let state = { status: 'disconnected', enabled: false };
  let drawer;
  let timer;
  let loadError = '';
  let revision = 0;
  let working = false;
  let loaded = false;
  const body = h('div', { class: 'stack' });
  const el = Card({ title: '个人消息采集（可选）', hint: 'channel.collect', id: 'channel-collect', body });
  const summary = () => state.enabled ? state.collecting ? '正在读取一批消息…' : '自动采集已开启' : state.status === 'connected' ? '已停止采集（账号已授权）' : labels[state.status] ?? '未授权';
  function completeness() {
    const completed = typeof state.lastCompletedThrough === 'string' && Number.isFinite(Date.parse(state.lastCompletedThrough));
    // Only show the public boundary explanation, never configuration or cursor diagnostics.
    const boundary = typeof state.collectionBoundary === 'string' ? state.collectionBoundary.trim() : '';
    const privateBoundary = /profile|page[\s_-]*token|cursor|access[\s_-]*token|refresh[\s_-]*token|https?:\/\/|配置名称|分页令牌|游标/i.test(boundary);
    return h('dl', { class: 'kv small', 'aria-label': '采集完整性' },
      h('dt', null, '私聊最近读到'), h('dd', null, state.privateCompletedThrough && Number.isFinite(Date.parse(state.privateCompletedThrough))
        ? new Date(state.privateCompletedThrough).toLocaleString('zh-CN') : '尚无已完成的私聊批次。'),
      h('dt', null, '最近完整读到'), h('dd', null, completed
        ? h('time', { datetime: state.lastCompletedThrough }, new Date(state.lastCompletedThrough).toLocaleString('zh-CN'))
        : '未提供完整性证据，不能确认窗口已完整读取。'),
      h('dt', null, '当前窗口'), h('dd', null, state.hasMore === true ? `仍有后续页，尚未完整读取。${state.enabled ? '' : '采集已停止，后续页尚未继续读取。'}`
        : state.hasMore === false ? '当前没有待续页；完整性以完成水位和采集边界为准。' : '未提供分页状态。'),
      h('dt', null, '已采集页数'), h('dd', null, Number.isSafeInteger(state.collectionPages) && state.collectionPages >= 0 ? `${state.collectionPages} 页（检查点累计）` : '未提供页数。'),
      h('dt', null, '采集边界'), h('dd', null, boundary && !privateBoundary ? boundary : privateBoundary ? '边界说明含内部配置或分页信息，已隐藏。' : '未提供采集边界。'),
      completed && !state.enabled && h('dt', null, '历史水位'), completed && !state.enabled && h('dd', null, '采集已停止，保留以上历史完成水位；不代表停止后的消息已读取。'));
  }
  async function action(path, payload, method = 'post') {
    if (working || !loaded || state.demo) return;
    working = true; revision++;
    clearTimeout(timer); paint();
    try {
      let value, collectionError;
      try { value = await api[method](`/feishu/personal${path}`, payload); }
      catch (error) { if (path !== '/collect') throw error; collectionError = error; }
      // collect returns a count, not an authorization/progress snapshot.
      // A failed collection can also stop the backend; read its authoritative state.
      state = path === '/collect' ? await api.get('/feishu/personal') : value;
      loadError = collectionError?.message ?? '';
    }
    catch (error) { loadError = error.message; }
    finally { working = false; }
    paint(); schedule(); store.refresh();
  }
  function schedule() {
    clearTimeout(timer);
    if ((!waiting.has(state.status) && !state.enabled) || (!drawer && router.current.page !== 'channels')) return;
    timer = setTimeout(() => { refresh().catch(() => {}); }, 1500);
  }
  function paint() {
    replace(body,
      h('p', { class: 'small' }, '授权读取你的飞书消息，整理出需要处理的事项。只读，不会代你回复。'),
      h('div', { class: 'row row--between' }, h('div', { class: 'row' }, Dot(state.enabled ? 'ok' : waiting.has(state.status) ? 'warn' : ''),
        h('span', null, `${state.account?.name ? `${state.account.name} · ` : ''}${summary()}`)),
      Button({ label: state.status === 'connected' ? '管理采集' : waiting.has(state.status) ? '查看授权进度' : '授权飞书账号', kind: 'primary', size: 'sm', onClick: open })),
      loaded && completeness(),
      h('p', { class: 'small muted' }, '特别关注智能纪要助手：收集会议消息，优先分析决定、进展和待跟进事项。'),
      h('a', { class: 'small', href: router.href('inbox') }, '查看采集消息 → 收件箱'),
      loadError && Banner({ tone: 'danger', children: loadError, action: Button({ label: '重试读取', size: 'sm', onClick: () => refresh() }) }));
    if (!drawer) return;
    const url = safeLink(state.url, ['accounts.feishu.cn', 'accounts.larksuite.com']);
    const permissionUrl = safeLink(state.permissionUrl, ['open.feishu.cn']);
    const connected = state.status === 'connected';
    replace(drawer.body,
      h('ol', { class: 'howto small' }, h('li', null, '点击“授权飞书账号”'), h('li', null, '用飞书扫码，确认允许读取消息'), h('li', null, '授权成功后，点击“开启采集”')),
      Banner({ tone: 'info', children: '应用连接和账号设置由工作台处理，你不需要填写配置名称。授权后可读取允许范围内的群聊、私聊和上下文；工作台不会以你的名义发送消息。' }),
      state.demo && Banner({ tone: 'warn', children: '当前为演示模式，不会授权或读取真实飞书账号。' }),
      h('p', { role: 'status' }, summary()),
      state.account && h('p', null, `飞书账号：${state.account.name}`),
      state.status === 'waiting_for_scan' && url && h('div', { class: 'stack' },
        /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(state.qrDataUrl ?? '') && h('img', { class: 'qr', src: state.qrDataUrl, alt: '用飞书扫码授权个人消息读取', width: 240, height: 240 }),
        h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, '在浏览器中打开飞书授权页'),
        state.expiresAt && h('p', { class: 'muted small' }, `有效期至 ${new Date(state.expiresAt).toLocaleTimeString('zh-CN')}`)),
      state.error && Banner({ tone: 'danger', children: state.error }),
      loadError && Banner({ tone: 'danger', children: loadError }),
      state.recovery === 'connect_application' && Button({ label: '扫码连接飞书应用', disabled: working, onClick: () => { drawer.close(); onConnectApplication(); } }),
      state.recovery === 'permissions' && permissionUrl && h('a', { href: permissionUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开此应用的飞书权限设置（应用管理员操作）'),
      state.lastCollectedAt && h('p', { class: 'small muted' }, `最近一批：${new Date(state.lastCollectedAt).toLocaleString('zh-CN')}，读取并提交 ${state.collected ?? 0} 条消息记录。`),
      state.lastCollectedAt && state.collected === 0 && h('p', { class: 'small muted' }, state.hasMore ? '本批没有可入箱消息；其余读取仍在继续，不能据此判断所有来源都没有新消息。' : '本批没有可入箱消息。起点以前的历史消息不会自动回填。'),
      loaded && completeness());
    const disabled = working || !loaded || state.demo;
    replace(drawer.foot,
      h('a', { class: 'btn btn--sm', href: router.href('inbox'), onclick: () => drawer.close() }, '查看收件箱'),
      Button({ label: '关闭', onClick: () => drawer.close() }),
      waiting.has(state.status) ? Button({ label: '取消授权', disabled, onClick: () => action('/cancel') })
        : connected ? Button({ label: state.enabled ? '停止采集' : '开启采集', disabled, kind: state.enabled ? 'secondary' : 'primary', onClick: () => action('', { enabled: !state.enabled }, 'put') })
          : Button({ label: ['failed', 'expired', 'cancelled'].includes(state.status) ? '重新授权' : '授权飞书账号', kind: 'primary', disabled, onClick: () => action('/authorize') }),
      connected && state.enabled && Button({ label: '采集一次', disabled, onClick: () => action('/collect') }),
      connected && !state.enabled && Button({ label: '更换账号 / 重新授权', disabled, onClick: () => action('/authorize') }));
  }
  function open() {
    if (drawer) return;
    drawer = openDrawer({ title: '个人消息采集', subtitle: '扫码授权，开启后才会采集', body: [], footer: [], onClose: () => { drawer = undefined; schedule(); } });
    paint(); refresh().catch(() => {});
  }
  async function refresh() {
    if (working) return;
    const stamp = ++revision;
    try { const value = await api.get('/feishu/personal'); if (stamp !== revision) return; state = value; loadError = ''; loaded = true; }
    catch (error) { if (stamp !== revision) return; loadError = '无法读取飞书授权状态，请检查连接后重试。'; paint(); schedule(); throw error; }
    paint(); schedule();
  }
  paint();
  return { el, refresh };
}
