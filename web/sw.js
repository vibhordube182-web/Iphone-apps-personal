// Network-first for pages and the edition, so updates arrive immediately and Lyceum still opens offline.
const CACHE = "lyceum-v2";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"];

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
