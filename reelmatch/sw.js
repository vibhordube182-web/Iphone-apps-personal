// Offline shell + image cache. The TMDB API and the sync database are never cached.
const CACHE = "ashkey-v8", IMG = "ashkey-img-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "taste.js", "tmdb.js", "sync.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-touch.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== IMG).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.hostname === "image.tmdb.org") {
    e.respondWith(caches.open(IMG).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request).catch(() => null);
      if (r && (r.ok || r.type === "opaque")) { c.put(e.request, r.clone()); trim(c); }
      return r || Response.error();
    }));
    return;
  }
  if (u.origin !== location.origin || u.pathname.includes("/db/")) return;
  // app files: network first (so fixes arrive on the next open), cached copy if offline or slow
  e.respondWith(caches.open(CACHE).then(async (c) => {
    try {
      const r = await Promise.race([fetch(new Request(e.request, { cache: "no-cache" })), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 3000))]);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (_) {
      return (await c.match(e.request, { ignoreSearch: true })) || (await c.match("index.html")) || Response.error();
    }
  }));
});
async function trim(c) { const ks = await c.keys(); if (ks.length > 400) for (const k of ks.slice(0, ks.length - 400)) c.delete(k); }
