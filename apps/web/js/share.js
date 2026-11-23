import {renderSharedTools} from './lib/shared-excerpt-tools.js';

// This page uses only the capability in the URL fragment. Keep it out of navigation, cookies and disk caches.
(() => {
  const status = document.querySelector('[role="status"]');
  const list = document.querySelector('ol');
  const expiry = document.querySelector('time');
  const refreshInterval = 30_000;
  let pending, polling, deadline, revision;

  function clear(message) {
    clearTimeout(polling);
    clearTimeout(deadline);
    pending?.abort();
    pending = undefined;
    revision = undefined;
    list.replaceChildren();
    expiry.hidden = true;
    expiry.removeAttribute('datetime');
    expiry.textContent = '';
    status.textContent = message;
  }

  function display(message) {
    if (!['user','assistant'].includes(message.role) || typeof message.text !== 'string') throw new Error();
    const row = document.createElement('li');
    const role = document.createElement('h2');
    role.textContent = message.role === 'user' ? '用户' : '助手';
    const text = document.createElement('p');
    text.textContent = message.text;
    row.append(role,text);
    const tools = renderSharedTools(message.tools);
    if (tools) row.append(tools);
    return row;
  }

  async function read() {
    if (pending || document.hidden) return;
    const token = location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      clear('分享链接不完整。');
      return;
    }
    const request = new AbortController();
    pending = request;
    const timeout = setTimeout(()=>request.abort(),15_000);
    let retry = true;
    try {
      const response = await fetch('/api/v1/public/conversation-share', {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({token,knownRevision:revision}),
        credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', redirect:'error', signal:request.signal,
      });
      if (!response.ok) {
        retry = response.status >= 500 || response.status === 429;
        throw new Error();
      }
      const page = await response.json();
      if (pending !== request) return;
      const until = Date.parse(page.expiresAt);
      if (!Number.isFinite(until) || until <= Date.now() || !Number.isSafeInteger(page.revision) || page.revision < 1) throw new Error();
      if (page.unchanged === true) {
        if (revision !== page.revision) throw new Error();
      } else {
        if (!Array.isArray(page.messages)) throw new Error();
        list.replaceChildren(...page.messages.map(display));
      }
      revision = page.revision;
      expiry.dateTime = page.expiresAt;
      expiry.textContent = '有效期至 ' + new Date(until).toLocaleString();
      expiry.hidden = false;
      status.textContent = '';
      clearTimeout(deadline);
      function expire() {
        const remaining = until - Date.now();
        if (remaining <= 0) clear('分享已过期。');
        else deadline = setTimeout(expire,Math.min(remaining,2147483647));
      }
      expire();
    } catch {
      if (pending !== request) return;
      clear('无法读取这份摘录。分享可能已过期、已撤销或暂时无法访问。');
    } finally {
      clearTimeout(timeout);
    }
    if (pending === request) pending = undefined;
    if (retry && !document.hidden) polling = setTimeout(read,refreshInterval);
  }

  function restart() {
    clear('正在读取摘录…');
    void read();
  }
  window.addEventListener('hashchange',restart);
  document.addEventListener('visibilitychange',restart);
  window.addEventListener('pagehide',()=>clear('正在读取摘录…'));
  window.addEventListener('pageshow',event=>{if (event.persisted) restart();});
  void read();
})();
