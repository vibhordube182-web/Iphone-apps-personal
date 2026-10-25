// Opens instantly from the phone: the app shell, readings and fonts are served from the cache while a
// fresh copy is fetched in the background (stale-while-revalidate). The edition itself is network-first
// with a short timeout, because the page already paints the last saved edition on its own.
const CACHE = "lyceum-v8";
const FILES = ["./", "index.html", "manifest.webmanifest", "mark-192.png", "mark-touch.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function keyFor(url) { return url.origin + url.pathname; }

async function staleWhileRevalidate(request, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  // "reload" skips the phone's own HTTP cache, which can hold an old copy of the page for 10 minutes
  const network = fetch(request.mode === "navigate" ? new Request(request.url, { cache: "reload" }) : request).then((r) => {
    if (r && (r.ok || r.type === "opaque")) cache.put(key, r.clone());
    return r;
  }).catch(() => null);
  return hit || (await network) || (await cache.match("index.html")) || Response.error();
}

async function networkFirst(request, key, ms) {
  const cache = await caches.open(CACHE);
  try {
    const r = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), ms)),
    ]);
    if (r && r.ok) cache.put(key, r.clone());
    return r;
  } catch (_) {
    return (await cache.match(key)) || fetch(request).catch(() => Response.error());
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.endsWith("news.json")) { e.respondWith(networkFirst(req, keyFor(url), 4000)); return; }
    const key = req.mode === "navigate" ? new URL("index.html", location.href).href : keyFor(url);
    e.respondWith(staleWhileRevalidate(req, key));
  } else if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, req.url));
  }
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
