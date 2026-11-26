// The workbench's service worker. It does one thing: show what the server pushes while no page
// is open (Web Push), and take a click to the page the notice is about. It does not cache the
// app or touch the API: the page is always the server's own, and a stale one is worse than a slow one.
//
// It is a classic worker, on purpose. It must not import a module the page also imports: a page
// module becomes a chunk with values of its own, which a classic worker cannot load.

// What the server sends, as web-push-subscriptions.ts writes it. Every field is optional: the
// server may send less, never something this worker must understand.
function readPushMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { title: '', body: '', tag: '', url: '', quiet: false };
  const message = raw;
  const text = (key) => (typeof message[key] === 'string' ? message[key] : '');
  return {
    title: text('title'), body: text('body'), tag: text('tag'), url: text('url'),
    quiet: message.quiet === true,
  };
}

// A hash route of the app, and nothing else: a push cannot take the owner to another site.
function safeUrl(url, scope) {
  if (!/^#[A-Za-z0-9_/?=&%.-]*$/.test(url)) return scope;
  return scope + url;
}

self.addEventListener('push', (event) => {
  let raw;
  try { raw = event.data ? event.data.json() : undefined; } catch { raw = undefined; }
  const message = readPushMessage(raw);
  const scope = self.registration.scope;
  // Always one notification: a push the worker does not show costs the subscription, as browsers
  // revoke one that shows nothing. A push that carries nothing readable is still the app's name.
  const title = message.title || 'super-mario';
  const body = message.body.length > 400 ? message.body.slice(0, 399) + '…' : message.body;
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: message.tag || undefined, icon: '/favicon.svg', silent: message.quiet,
    data: { url: safeUrl(message.url, scope) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && typeof event.notification.data.url === 'string' ? event.notification.data.url : self.registration.scope);
  event.waitUntil((async () => {
    // A page that is already open is brought forward and taken to the notice; otherwise one is opened.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = clients.find((client) => new URL(client.url).origin === new URL(target).origin);
    if (open) {
      await open.focus();
      if ('navigate' in open) await open.navigate(target).catch(() => {});
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('activate', (event) => {
  // Take over from an older worker at once: there is nothing cached to hand over.
  event.waitUntil(self.clients.claim());
});
