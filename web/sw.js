// Network-first for pages and the edition, so updates arrive immediately and Lyceum still opens offline.
const CACHE = "lyceum-v5";
const FILES = ["./", "index.html", "manifest.webmanifest", "glyph-192.png", "glyph-touch.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy)); }
      return r;
    }).catch(() => caches.match(url.origin + url.pathname).then((hit) => hit || caches.match("index.html")))
  );
});

// Morning push: show the notification (iOS requires one) and put the story count on the icon.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  const count = Number(d.count) || 0;
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Your morning edition is ready", {
      body: d.body || "Open Lyceum to read today’s briefing.",
      icon: "glyph-192.png",
      tag: "lyceum-morning",
    }),
    (async () => {
      try {
        const nav = self.navigator;
        if (nav && nav.setAppBadge) { count > 0 ? await nav.setAppBadge(count) : await nav.clearAppBadge(); }
      } catch (_) {}
    })(),
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
