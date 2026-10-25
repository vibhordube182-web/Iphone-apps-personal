// Network-first for pages and the edition, so updates arrive immediately and Lyceum still opens offline.
const CACHE = "lyceum-v6";
const FILES = ["./", "index.html", "manifest.webmanifest", "mark-192.png", "mark-touch.png"];

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

function readList() {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open("lyceum", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onerror = () => resolve([]);
      r.onsuccess = () => {
        try {
          const g = r.result.transaction("kv").objectStore("kv").get("read");
          g.onsuccess = () => resolve(g.result || []);
          g.onerror = () => resolve([]);
        } catch (_) { resolve([]); }
      };
    } catch (_) { resolve([]); }
  });
}

// Stories in the freshest edition that have not been opened; falls back to the count in the push.
async function unreadCount(fallback) {
  try {
    const res = await fetch("news.json?t=" + Date.now(), { cache: "no-store" });
    const data = await res.json();
    const read = new Set(await readList());
    return data.stories.filter((s) => !read.has(s.link)).length;
  } catch (_) { return fallback; }
}

// Push: show the notification (iOS requires one) and put the story count on the icon.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  // Show the notification straight away (iOS needs one per push); set the badge alongside it.
  const notify = self.registration.showNotification(d.title || "Lyceum", {
    body: d.body || "Open Lyceum to read today’s briefing.",
    icon: "mark-192.png",
    tag: d.tag || "lyceum-alert",
  });
  const badge = unreadCount(Number(d.count) || 0).then(async (count) => {
    try {
      const nav = self.navigator;
      if (nav && nav.setAppBadge) { count > 0 ? await nav.setAppBadge(count) : await nav.clearAppBadge(); }
    } catch (_) {}
  });
  e.waitUntil(Promise.all([notify, badge]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
