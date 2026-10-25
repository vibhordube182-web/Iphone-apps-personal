// Opens instantly from the phone: the app shell, readings and fonts are served from the cache while a
// fresh copy is fetched in the background (stale-while-revalidate). The edition itself is network-first
// with a short timeout, because the page already paints the last saved edition on its own.
const CACHE = "lyceum-v9";
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


// ---- TEMPORARY launch-flash test: each cold launch serves the next, more complete version of the page
// (V0 plain black ... V4 the real page) with a label, so the version that flashes can be identified. ----
async function nextRung() {
  const c = await caches.open("lyceum-ladder");
  const r = await c.match("n");
  const n = r ? parseInt(await r.text(), 10) || 0 : 0;
  await c.put("n", new Response(String((n + 1) % 5)));
  return n;
}

function ladder(html, n) {
  const label = '<style>@keyframes vl{to{opacity:1}}</style><div style="position:fixed;z-index:99999;left:0;right:0;bottom:90px;text-align:center;color:#fff;font:600 22px -apple-system,sans-serif;opacity:0;animation:vl 0s 2.5s forwards">V' + n + '</div>';
  const head = html.slice(html.indexOf("<head>") + 6, html.indexOf("</head>"));
  const body = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"));
  const viewport = (head.match(/<meta name="viewport"[^>]*>/) || [""])[0];
  const tags = (head.match(/<(meta|link)\b[^>]*>/g) || []).filter((t) => !/charset|viewport|preload|preconnect/.test(t)).join("\n");
  const styles = (head.match(/<style>[\s\S]*?<\/style>/g) || []).join("\n");
  const plain = "<style>html,body{margin:0;background:#000;height:100%}</style>";
  const noJs = (t) => t.replace(/<script\b[\s\S]*?<\/script>/g, "");
  const doc = (htmlAttrs, headInner, bodyInner) =>
    "<!doctype html><html " + htmlAttrs + "><head><meta charset=\"utf-8\">" + viewport + "<title>Lyceum</title>" + headInner + "</head><body>" + bodyInner + label + "</body></html>";
  if (n === 0) return doc('lang="en"', plain, "");
  if (n === 1) return doc('lang="en"', plain + tags, "");
  const attrs = 'lang="en" class="booting" style="background:#000"';
  const cut = body.indexOf('<svg class="defs"');
  if (n === 2) return doc(attrs, tags + styles, body.slice(0, cut));
  if (n === 3) return doc(attrs, tags + styles, noJs(body));
  return html.replace("</body>", label + "</body>");
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === "navigate") {
      e.respondWith((async () => {
        const base = await staleWhileRevalidate(req, new URL("index.html", location.href).href);
        if (!base || !base.ok) return base;
        const html = await base.text();
        const n = await nextRung();
        return new Response(ladder(html, n), { headers: { "content-type": "text/html; charset=utf-8" } });
      })());
      return;
    }
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
