self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = {}; }
  const title = typeof message.title === 'string' ? message.title.slice(0, 80) : 'Vibe Hub';
  const body = typeof message.body === 'string' ? message.body.slice(0, 240) : 'There is an update waiting for review.';
  const tag = typeof message.tag === 'string' ? message.tag.slice(0, 120) : 'vibe-hub';
  event.waitUntil(self.registration.showNotification(title, { body, tag, data: { url: message.url } }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    let target = new URL(scope.href);
    const candidate = event.notification.data && event.notification.data.url;
    if (typeof candidate === 'string') {
      try {
        const parsed = new URL(candidate, scope.origin);
        const scopedPath = scope.pathname.replace(/\/$/, '');
        if (parsed.origin === scope.origin && (parsed.pathname === scope.pathname || parsed.pathname === scopedPath) && parsed.search === '' && /^#reviews(?:\?review=[A-Za-z0-9_-]{1,200})?$/.test(parsed.hash)) target = parsed;
      } catch { /* use the scoped hub home */ }
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      const current = new URL(client.url);
      if (current.origin === scope.origin && current.pathname.startsWith(scope.pathname) && 'focus' in client) {
        if ('navigate' in client && `${current.pathname}${current.search}${current.hash}` !== `${target.pathname}${target.search}${target.hash}`) await client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
