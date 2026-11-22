import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

/** pane.focus is a Herdr socket method. A lost reply leaves the outcome unknown. */
export function focusTerminalPane(path: string, paneId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection({ path });
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const interrupted = () => finish(new Error('Herdr 焦点请求未收到完整响应，请刷新确认当前窗格'));
    const timeout = setTimeout(interrupted, 5000);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ id, method: 'pane.focus', params: { pane_id: paneId } }) + '\n'));
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
        if (reply.error) return finish(new Error('Herdr 未能聚焦指定窗格，请检查版本及窗格状态'));
        finish();
      } catch { interrupted(); }
    });
  });
}
