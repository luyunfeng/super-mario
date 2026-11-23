// Public links carry their own capability. This page has no workbench session or credential store.
(() => {
  const status = document.querySelector('[role="status"]');
  const list = document.querySelector('ol');
  const expiry = document.querySelector('time');
  let pending, timer;

  function clear(message) {
    pending?.abort();
    pending = undefined;
    clearTimeout(timer);
    list.replaceChildren();
    expiry.hidden = true;
    expiry.removeAttribute('datetime');
    expiry.textContent = '';
    status.textContent = message;
  }

  async function read() {
    clear('正在读取摘录…');
    const token = location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      clear('分享链接不完整。');
      return;
    }
    const request = new AbortController();
    pending = request;
    try {
      const response = await fetch('/api/v1/public/conversation-share', {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({token}),
        credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', redirect:'error', signal:request.signal,
      });
      if (!response.ok) throw new Error();
      const {messages,expiresAt} = await response.json();
      if (pending !== request) return;
      const until = Date.parse(expiresAt);
      if (!Number.isFinite(until) || until <= Date.now() || !Array.isArray(messages)) throw new Error();
      const rows = messages.map(message => {
        if (!['user','assistant'].includes(message.role) || typeof message.text !== 'string') throw new Error();
        const row = document.createElement('li');
        const role = document.createElement('h2');
        role.textContent = message.role === 'user' ? '用户' : '助手';
        const text = document.createElement('p');
        text.textContent = message.text;
        row.append(role,text);
        return row;
      });
      list.replaceChildren(...rows);
      expiry.dateTime = expiresAt;
      expiry.textContent = '有效期至 ' + new Date(until).toLocaleString();
      expiry.hidden = false;
      status.textContent = '';
      function expire() {
        const remaining = until - Date.now();
        if (remaining <= 0) clear('分享已过期。');
        else timer = setTimeout(expire,Math.min(remaining,2147483647));
      }
      expire();
    } catch {
      if (pending === request) clear('无法读取这份摘录。分享可能已过期、已撤销或暂时无法访问。');
    }
  }

  window.addEventListener('hashchange',read);
  window.addEventListener('pagehide',()=>clear('正在读取摘录…'));
  window.addEventListener('pageshow',event=>{if (event.persisted) void read();});
  void read();
})();
