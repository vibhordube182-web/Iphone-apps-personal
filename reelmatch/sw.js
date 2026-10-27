// Offline shell. Every file of one build lives in one versioned cache, installed atomically, so the app can
// never run a mix of old and new files. A new build installs in the background and the page reloads once.
const CACHE = "ashkey-v10";
const FILES = ["./", "index.html", "style.css?v=10", "app.js", "taste.js", "tmdb.js", "sync.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-touch.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/db/")) return; // API, images and the database go straight to the network
  e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request, { ignoreSearch: true })) || fetch(e.request).catch(() => c.match("index.html"))));
});
