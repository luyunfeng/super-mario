import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

/** A lost reply leaves the outcome unknown. Never retry or echo the request payload. */
export function terminalSocketRequest(path: string, method: 'pane.focus' | 'tab.create', params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection({ path });
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const interrupted = () => finish(new Error(method === 'pane.focus' ? 'Herdr 焦点请求未收到完整响应，请刷新确认当前窗格' : 'Herdr 创建请求未收到完整响应，请刷新确认当前窗格'));
    const timeout = setTimeout(interrupted, 5000);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.once('error', interrupted);
    socket.once('end', interrupted);
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > 64 * 1024) return interrupted();
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        const reply = JSON.parse(response.slice(0, newline));
        if (reply.id !== id || (!reply.error && !Object.hasOwn(reply, 'result'))) return interrupted();
        if (reply.error) return finish(new Error(method === 'pane.focus' ? 'Herdr 未能聚焦指定窗格，请检查版本及窗格状态' : 'Herdr 未能创建指定窗格，请检查版本及窗格状态'));
        finish(undefined, reply.result);
      } catch { interrupted(); }
    });
  });
}

export async function focusTerminalPane(path: string, paneId: string): Promise<void> {
  await terminalSocketRequest(path, 'pane.focus', { pane_id: paneId });
}
