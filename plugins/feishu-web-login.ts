import QRCode from 'qrcode';

const messages = {
  idle: '尚未发起网页登录',
  starting: '网关正在准备登录',
  waiting: '请使用飞书或 Lark 扫描二维码',
  scanned: '已扫码，请在客户端确认',
  success: '网页登录成功',
  failed: '网页登录失败，请重新发起',
  expired: '二维码已过期，请重新发起',
};
type State = keyof typeof messages;
interface LoginView { state: State; message: string; qrDataUrl?: string }

// Each instance belongs to one validated gateway configuration. The upstream
// poll operates on the gateway's current login and takes no session identifier.
export function createFeishuWebLogin(config: { baseUrl: string; token: string }) {
  let view: LoginView = { state: 'idle', message: messages.idle };
  async function request(action: 'qr' | 'poll'): Promise<LoginView> {
    try {
      if (!config.token) throw new Error('请先配置网页网关令牌');
      const response = await fetch(new URL('/api/lark-avatar/login/' + action, config.baseUrl), {
        method: 'POST', headers: { Cookie: 'agentdock_web=' + encodeURIComponent(config.token) },
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        view = { state: 'failed', message: '网页网关登录请求失败（HTTP ' + response.status + '）' };
      } else {
        const row = await response.json();
        if (typeof row?.state !== 'string' || !Object.hasOwn(messages, row.state)) throw new Error('无效登录状态');
        const state = row.state as State;
        const next: LoginView = { state, message: messages[state] };
        if ((state === 'waiting' || state === 'scanned') && row.qrContent !== undefined) {
          // The gateway QR is JSON, not a URL or an image supplied by the remote server.
          if (typeof row.qrContent !== 'string' || row.qrContent.length > 4096) throw new Error('无效二维码');
          const token = JSON.parse(row.qrContent)?.qrlogin?.token;
          if (typeof token !== 'string' || !token.trim() || token === config.token) throw new Error('无效二维码');
          next.qrDataUrl = await QRCode.toDataURL(JSON.stringify({ qrlogin: { token } }), { width: 280, margin: 2 });
        }
        view = next;
      }
    } catch {
      view = { state: 'failed', message: config.token ? '无法获取网页网关登录状态，请检查连接并重新发起' : '请先配置网页网关令牌' };
    }
    return { ...view };
  }
  return {
    start: () => request('qr'),
    poll: () => ['starting', 'waiting', 'scanned'].includes(view.state) ? request('poll') : Promise.resolve({ ...view }),
  };
}
