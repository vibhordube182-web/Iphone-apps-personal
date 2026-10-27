import * as T from "./taste.js";
import { TMDB, poster, profilePic, logo, streamers, REGION } from "./tmdb.js";
import { Room } from "./sync.js";
import { DEFAULT_DB } from "./config.js";

/* ============ helpers ============ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const b64 = { enc: (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), dec: (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))))) };
const fmtRuntime = (m) => (m.runtime ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m` : "");
const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const genreNames = (m, n = 3) => (m.genres || []).map((g) => T.GENRES[g]).filter(Boolean).slice(0, n);
const langName = (m) => (m.lang === "hi" ? "Bollywood" : "Hollywood");
const isStandalone = () => window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

/* ============ state ============ */
let cfg = lsGet("rm_cfg", null);            // { name, key, db, code, uid }
let settings = Object.assign({ mix: 0.6, onlyStreaming: false, services: [] }, lsGet("rm_settings", {}));
let tmdb, room;
let mySwipes = new Map(), theirSwipes = new Map(), watched = new Set(), watchedAt = new Map();
let members = {}, partnerUid = null, partnerName = "";
const movies = new Map();                    // id -> movie (list-level, enriched with details when loaded)
const dirty = new Set();
let deck = [], served = [], undoStack = [];
const tomb = new Set(); // swipes deleted this session
let lastRefillToast = 0, filling = false, cursor = 0, seeded = new Set(), providerList = null;
const inflight = new Map();
let seenMatches = new Set(), tab = "swipe", pollTimer, lastSyncOk = 0;

const sig = () => (settings.onlyStreaming ? "s:" + [...settings.services].sort().join(",") : "all");
const filterOpts = () => ({ onlyStreaming: settings.onlyStreaming, services: settings.services });

/* ============ movie cache (IndexedDB) ============ */
let idb;
const idbOpen = () => new Promise((res) => {
  try {
    const r = indexedDB.open("reelmatch", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("movies", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  } catch (_) { res(null); }
});
async function loadCache() {
  idb = await idbOpen();
  if (!idb) return;
  await new Promise((res) => {
    const rq = idb.transaction("movies").objectStore("movies").getAll();
    rq.onsuccess = () => { for (const m of rq.result) movies.set(m.id, m); res(); };
    rq.onerror = () => res();
  });
}
let flushT;
function touch(m) { dirty.add(m.id); clearTimeout(flushT); flushT = setTimeout(flushCache, 800); }
function flushCache() {
  if (!idb || !dirty.size) return;
  try {
    const st = idb.transaction("movies", "readwrite").objectStore("movies");
    for (const id of dirty) { const m = movies.get(id); if (m) { const { detailsErr, ...clean } = m; st.put(clean); } }
  } catch (_) {}
  dirty.clear();
}
function remember(m, extra = {}) {
  const old = movies.get(m.id);
  const merged = { ...(old || {}), ...m, ...extra };
  if (old && old.detailsAt && !m.detailsAt) { // keep details when a plain list entry arrives later
    for (const k of ["runtime", "tagline", "cast", "director", "directorName", "providers", "trailer", "imdb", "detailsAt"]) merged[k] = old[k];
  }
  movies.set(m.id, merged); touch(merged);
  return merged;
}

/* ============ details ============ */
async function ensureDetails(id, maxAgeH = 12) {
  const m = movies.get(id);
  if (m && m.detailsAt && Date.now() - m.detailsAt < maxAgeH * 3.6e6) return m;
  if (inflight.has(id)) return inflight.get(id);
  const attempt = async (n) => { try { return await tmdb.details(id); } catch (e) { if (n < 2 && !/API key/.test(e.message)) { await sleep(1200 * (n + 1)); return attempt(n + 1); } throw e; } };
  const p = attempt(0).then((d) => { const merged = remember(d); delete merged.detailsErr; onDetails(merged); return merged; })
    .catch(() => { const cur = movies.get(id); if (cur) { cur.detailsErr = true; cur.detailsErrAt = Date.now(); onDetails(cur, true); } return cur || null; })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/* ============ pool + deck ============ */
const poolSig = (m) => m.sig === sig();
const passes = (m) => {
  if (!settings.onlyStreaming) return true;
  if (!m.providers) return true; // unknown yet: discover already filtered it
  const s = streamers(m);
  return settings.services.length ? s.some((x) => settings.services.includes(x.id)) : s.length > 0;
};
function unseen() {
  const inDeck = new Set(deck.map((m) => m.id));
  return [...movies.values()].filter((m) => poolSig(m) && m.poster && m.overview && !mySwipes.has(m.id) && !watched.has(m.id) && !inDeck.has(m.id) && passes(m));
}
const ctx = () => ({
  mine: T.buildProfile([...mySwipes.values()]),
  partner: theirSwipes.size ? T.buildProfile([...theirSwipes.values()]) : null,
  partnerSwipes: new Map([...theirSwipes].map(([id, r]) => [Number(id), r.r])),
  rand: Math.random, seed: cfg.code,
});

async function seedRecommendations() {
  const likes = [...mySwipes.entries(), ...theirSwipes.entries()]
    .filter(([id, r]) => r.r > 0 && !seeded.has(String(id))).sort((a, b) => b[1].r - a[1].r || (b[1].t || 0) - (a[1].t || 0)).slice(0, 3);
  for (const [id] of likes) {
    seeded.add(String(id)); lsSet("rm_seeded", [...seeded]);
    try {
      const recs = await tmdb.recommendations(id);
      for (const r of recs) {
        const old = movies.get(r.id);
        if (settings.onlyStreaming && !(old && old.providers)) {
          const d = await ensureDetails(r.id); if (!d || !passes(d) || !streamers(d).length) continue;
        }
        remember(r, { sig: sig(), recCount: (old && old.recCount || 0) + 1 });
      }
    } catch (_) {}
  }
}

async function refill() {
  if (filling) return 0; filling = true;
  let added = 0;
  try {
    await seedRecommendations();
    let guard = 0;
    while (unseen().length < 45 && guard++ < 4 && cursor < 400) {
      const list = await tmdb.source(cursor, filterOpts()); // throws on failure, so the page is retried, not skipped
      cursor++; lsSet("rm_cursor_" + sig(), cursor);
      for (const m of list) { const old = movies.get(m.id); remember(m, { sig: sig(), recCount: old && old.recCount }); added++; }
    }
  } catch (e) { if (/API key/.test(e.message)) { toast(e.message, 4000); showSetup(e.message); } else if (Date.now() - lastRefillToast > 30000) { lastRefillToast = Date.now(); toast("Having trouble reaching the movie database. Retrying…", 3000); } }
  filling = false;
  return added;
}

async function fillDeck() {
  const want = 4;
  if (deck.length < want) {
    const pool = unseen();
    if (pool.length < 20 && !filling) refill().then((n) => n && fillDeck());
    const picks = T.pickNext(pool, ctx(), want - deck.length, { ratio: settings.mix, recent: served });
    for (const m of picks) { deck.push(m); served.push(m); }
    served = served.slice(-30);
  }
  deck.slice(0, 5).forEach((m) => { ensureDetails(m.id); const i = new Image(); i.src = poster(m.poster); });
  renderDeck();
}

/* ============ deck rendering + gestures ============ */
function provHtml(m) {
  if (!m.providers) return m.detailsErr ? `<span class="none">Couldn't load streaming info</span>` : `<span class="skel"></span>`;
  const s = streamers(m);
  if (s.length) return `<span class="lbl">Stream</span>` + s.slice(0, 6).map((p) => `<img src="${logo(p.logo)}" alt="${esc(p.name)}" title="${esc(p.name)}">`).join("");
  const rb = [...m.providers.rent, ...m.providers.buy];
  return rb.length ? `<span class="none">Rent / buy only in Australia</span>` : `<span class="none">Not streaming in Australia right now</span>`;
}
function infoHtml(m) {
  const sub = [genreNames(m).join(" · "), fmtRuntime(m)].filter(Boolean).join(" · ");
  const cast = (m.cast || []).slice(0, 4).map((c) => c.name).join(", ");
  return `<div class="tags"><span class="tag ${m.lang === "hi" ? "b" : "h"}">${langName(m)}</span><span class="tag">★ ${m.vote.toFixed(1)}</span></div>
    <h2>${esc(m.title)}<small>${m.year || ""}</small></h2>
    <p class="meta">${esc(sub)}</p>
    <p class="syn">${esc(m.overview)}</p>
    ${cast ? `<p class="cast"><b>Starring</b> ${esc(cast)}</p>` : ""}
    <div class="prov">${provHtml(m)}</div>`;
}
function cardEl(m) {
  const el = document.createElement("div");
  el.className = "card"; el.dataset.id = m.id;
  el.innerHTML = `<div class="fallback">${esc(m.title)}</div><img class="poster" alt="" draggable="false" src="${poster(m.poster)}">
    <div class="shade"></div><div class="stamp like">LIKE</div><div class="stamp nope">NOPE</div><div class="stamp super">SUPER</div><div class="stamp seen">ALREADY WATCHED</div>
    <div class="info">${infoHtml(m)}</div>`;
  $(".poster", el).onerror = (e) => e.target.remove();
  attachDrag(el);
  return el;
}
function onDetails(m, failed) {
  const c = $(`.card[data-id="${m.id}"] .info`);
  if (c) c.innerHTML = infoHtml(m);
  if (document.querySelector("#overlay .sheet") && openSheetId === m.id) buildSheet();
  if (failed) return; // don't re-render lists on a failure: that would immediately re-request and loop
  if (tab === "matches") scheduleMatches();
  if (tab === "likes") scheduleLikes();
  if (tab === "watched") scheduleWatched();
}
function renderDeck() {
  const box = $("#deck");
  const want = deck.slice(0, 3);
  $$(".card", box).forEach((el) => { if (!want.some((m) => String(m.id) === el.dataset.id) && !el.classList.contains("fly")) el.remove(); });
  want.forEach((m, i) => {
    let el = $(`.card[data-id="${m.id}"]`, box);
    if (!el) { el = cardEl(m); box.appendChild(el); }
    if (el.dataset.pos !== String(i)) { el.dataset.pos = i; el.style.transform = ""; el.style.opacity = ""; $$(".stamp", el).forEach((s) => (s.style.opacity = 0)); }
  });
  let e = $(".empty", box);
  if (!want.length) {
    if (!e) { e = document.createElement("div"); e.className = "empty"; box.appendChild(e); }
    e.innerHTML = filling || unseen().length ? `<div><div class="spin"></div>Finding movies for you two…</div>` : `<div><b>You've seen everything in the pool!</b><br>Change the filters in <i>Us</i> to dig up more.</div>`;
  } else if (e) e.remove();
}

function attachDrag(card) {
  let sx, sy, dx = 0, dy = 0, t0, on = false;
  const stamps = () => {
    $(".stamp.like", card).style.opacity = Math.min(1, Math.max(0, dx / 100));
    $(".stamp.nope", card).style.opacity = Math.min(1, Math.max(0, -dx / 100));
    $(".stamp.super", card).style.opacity = dy < -30 && Math.abs(dy) > Math.abs(dx) ? Math.min(1, -dy / 110) : 0;
    $(".stamp.seen", card).style.opacity = dy > 30 && Math.abs(dy) > Math.abs(dx) ? Math.min(1, dy / 110) : 0;
  };
  card.addEventListener("pointerdown", (e) => {
    if (card.dataset.pos !== "0" || card.classList.contains("fly")) return;
    on = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; t0 = Date.now(); card.setPointerCapture(e.pointerId); card.classList.add("drag");
  });
  card.addEventListener("pointermove", (e) => {
    if (!on) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    card.style.transform = `translate(${dx}px, ${dy * 0.5}px) rotate(${dx / 18}deg)`; stamps();
  });
  const end = () => {
    if (!on) return; on = false; card.classList.remove("drag");
    const dt = Math.max(1, Date.now() - t0), v = Math.abs(dx) / dt;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 400) { card.style.transform = ""; return openSheet(Number(card.dataset.id), "deck"); }
    const horiz = Math.abs(dx) > Math.abs(dy);
    if (horiz && (dx > 110 || (v > 0.6 && dx > 40))) fly(card, 1);
    else if (horiz && (dx < -110 || (v > 0.6 && dx < -40))) fly(card, -1);
    else if (dy < -120 && Math.abs(dy) > Math.abs(dx)) fly(card, 2);
    else if (dy > 120 && Math.abs(dy) > Math.abs(dx)) fly(card, 3);
    else { card.style.transform = ""; dx = dy = 0; $$(".stamp", card).forEach((s) => (s.style.opacity = 0)); }
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { // a system gesture took over: snap back, never commit
    if (!on) return; on = false; dx = dy = 0; card.classList.remove("drag"); card.style.transform = ""; $$(".stamp", card).forEach((s) => (s.style.opacity = 0));
  });
}
function fly(card, r) { // 1 like, -1 nope, 2 super like (up), 3 already watched (down)
  if (!card || card.classList.contains("fly")) return;
  const id = Number(card.dataset.id), m = movies.get(id);
  card.classList.remove("drag"); card.classList.add("fly");
  const W = window.innerWidth;
  const stamp = $(r === 3 ? ".stamp.seen" : r === 2 ? ".stamp.super" : r > 0 ? ".stamp.like" : ".stamp.nope", card); if (stamp) stamp.style.opacity = 1;
  card.style.transform = r === 2 ? "translate(0,-110vh) scale(.92)" : r === 3 ? "translate(0,110vh) scale(.92)" : `translate(${(r > 0 ? 1 : -1) * W * 1.4}px, 60px) rotate(${(r > 0 ? 1 : -1) * 24}deg)`;
  setTimeout(() => { card.remove(); commitSwipe(m, r === 3 ? T.SEEN : r === 2 ? T.SUPER : r > 0 ? T.LIKE : T.NOPE); }, 260);
}
function topCard() { return $('.card[data-pos="0"]:not(.fly)'); }

/* ============ swiping, undo, matches ============ */
function commitSwipe(m, r) {
  if (!m) return;
  const rec = T.makeRecord(movies.get(m.id) || m, r);
  tomb.delete(m.id); mySwipes.set(m.id, rec); lsSet("rm_swipes_" + cfg.code, [...mySwipes]);
  room.swipe(m.id, rec);
  if (r === T.SEEN) { watched.add(m.id); watchedAt.set(m.id, Date.now()); room.watched(m.id, true); }
  undoStack.push(m.id);
  deck = deck.filter((x) => x.id !== m.id);
  const th = theirSwipes.get(m.id) || theirSwipes.get(String(m.id));
  if (r > 0 && th && th.r > 0) celebrate([m.id]);
  fillDeck(); updateBadge();
}
function undo() {
  const id = undoStack.pop();
  if (id == null) return toast("Nothing to undo");
  const th = theirSwipes.get(id) || theirSwipes.get(String(id));
  if (mySwipes.get(id) && mySwipes.get(id).r === T.SEEN && !(th && th.r === T.SEEN)) { watched.delete(id); watchedAt.delete(id); room.watched(id, false); }
  mySwipes.delete(id); tomb.add(id); lsSet("rm_swipes_" + cfg.code, [...mySwipes]); room.unswipe(id);
  const m = movies.get(id); if (m) { deck.unshift(m); served = served.filter((x) => x.id !== id); }
  seenMatches.delete(id); lsSet("rm_seenm_" + cfg.code, [...seenMatches]);
  renderDeck(); updateBadge();
}
const matches = () => T.computeMatches(mySwipes, new Map([...theirSwipes].map(([k, v]) => [Number(k), v])));
function updateBadge() {
  const fresh = matches().filter((x) => !seenMatches.has(x.id)).length;
  const b = $("#badge"); b.textContent = fresh; b.classList.toggle("hidden", !fresh || tab === "matches");
}
let popupQueue = [];
function celebrate(ids) {
  for (const id of ids) { if (seenMatches.has(id)) continue; seenMatches.add(id); popupQueue.push(id); }
  lsSet("rm_seenm_" + cfg.code, [...seenMatches]);
  if (!$("#overlay .pop") && popupQueue.length) showMatchPopup(popupQueue.shift());
}
async function showMatchPopup(id) {
  const m = (await ensureDetails(id)) || movies.get(id); if (!m) return;
  const ov = $("#overlay"); ov.classList.remove("hidden");
  ov.innerHTML = ""; ov.onclick = null; openSheetId = null;
  const d = document.createElement("div"); d.className = "pop";
  d.innerHTML = `<h2>It's a match!</h2><img class="pp" src="${poster(m.poster)}" alt=""><div class="tt">${esc(m.title)}</div>
    <div class="meta muted">You and ${esc(partnerName || "your partner")} both want to watch this</div><div class="prov">${provHtml(m)}</div>
    <div class="btns"><button class="btn" data-a="m">See all matches</button><button class="btn alt" data-a="k">Keep swiping</button></div>`;
  ov.appendChild(d); navigator.vibrate && navigator.vibrate([60, 40, 60]);
  d.onclick = (e) => {
    e.stopPropagation(); const a = e.target.dataset.a; if (!a) return;
    d.remove(); closeOverlayIfEmpty();
    if (popupQueue.length) showMatchPopup(popupQueue.shift()); else if (a === "m") setTab("matches");
  };
}
const closeOverlayIfEmpty = () => { if (!$("#overlay").children.length) $("#overlay").classList.add("hidden"); };

/* ============ detail sheet ============ */
let openSheetId = null, openSheetMode = "deck";
async function openSheet(id, mode) {
  openSheetId = id; openSheetMode = mode;
  const ov = $("#overlay"); ov.classList.remove("hidden"); ov.innerHTML = "";
  buildSheet();
  ensureDetails(id, 6);
}
function buildSheet() {
  const m = movies.get(openSheetId); if (!m) return;
  const ov = $("#overlay"); const keep = $(".sheet", ov); const scroll = keep ? keep.scrollTop : 0;
  ov.innerHTML = "";
  const meta = [m.year, fmtRuntime(m), `★ ${m.vote.toFixed(1)} (${kfmt(m.votes)})`, langName(m)].filter(Boolean).join(" · ");
  const p = m.providers;
  const group = (label, list, note) => list && list.length ? `<div class="pgroup"><div class="l">${label}</div><div class="pitems">${list.map((x) => `<div class="pit"><img src="${logo(x.logo)}" alt="">${esc(x.name)}${note ? ` <span class="muted">${note}</span>` : ""}</div>`).join("")}</div></div>` : "";
  let where;
  if (!p) where = m.detailsErr ? `<p class="muted">Couldn't load streaming info.</p><button class="btn alt sm" data-a="retry">Try again</button>` : `<span class="skel"></span>`;
  else {
    where = group("Included with subscription", p.flatrate) + group("Free", p.free, "") + group("Free with ads", p.ads) + group("Rent", p.rent) + group("Buy", p.buy);
    if (!where) where = `<p class="muted">Not available to stream, rent or buy in Australia right now.</p>`;
  }
  const cast = (m.cast || []).map((c) => `<div class="cm">${c.photo ? `<img src="${profilePic(c.photo)}" alt="" loading="lazy">` : `<div class="ph"></div>`}<b>${esc(c.name)}</b><span>${esc(c.character || "")}</span></div>`).join("");
  const bar = openSheetMode === "deck"
    ? `<button class="act nope" data-a="n" aria-label="Nope"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button><button class="act super" data-a="s" aria-label="Super like"><svg viewBox="0 0 24 24" class="fill"><path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.3 6.4 20.3l1.2-6.3L3 9.6l6.3-.8z"/></svg></button><button class="act like" data-a="l" aria-label="Like"><svg viewBox="0 0 24 24" class="fill"><path d="M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z"/></svg></button><button class="act small" data-a="e" aria-label="Already watched"><svg viewBox="0 0 24 24"><path d="M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12z"/><circle cx="12" cy="12" r="2.6"/></svg></button>`
    : `<button class="btn sm ${watched.has(m.id) ? "alt" : ""}" data-a="w">${watched.has(m.id) ? "Remove from watched" : "Mark as watched"}</button>` + (openSheetMode === "likes" ? `<button class="btn sm alt" data-a="rm">Remove from my likes</button>` : "");
  const root = document.createElement("div");
  root.innerHTML = `<div class="scrim" data-a="x"></div><div class="sheet">
    <button class="x" data-a="x"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <div class="hero"><img src="${poster(m.poster)}" alt=""></div>
    <div class="body"><h1>${esc(m.title)}</h1><div class="muted">${esc(meta)}</div>
      <div class="tags" style="margin-top:10px">${genreNames(m, 5).map((g) => `<span class="tag" style="background:#ffffff18">${g}</span>`).join("")}</div>
      ${m.tagline ? `<p class="tagline">${esc(m.tagline)}</p>` : ""}
      <p class="overview">${esc(m.overview)}</p>
      <h3>Where to watch in Australia</h3>${where}<div class="credit">Streaming data by JustWatch</div>
      ${cast ? `<h3>Cast${m.directorName ? ` · Directed by ${esc(m.directorName)}` : ""}</h3><div class="cast-s">${cast}</div>` : !m.detailsAt ? `<h3>Cast</h3><span class="skel"></span>` : ""}
      <div class="links">${m.trailer ? `<a target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=${m.trailer}">Watch trailer</a>` : ""}${p && p.link ? `<a target="_blank" rel="noopener" href="${esc(p.link)}">JustWatch</a>` : ""}${m.imdb ? `<a target="_blank" rel="noopener" href="https://www.imdb.com/title/${m.imdb}/">IMDb</a>` : ""}</div>
    </div>${bar ? `<div class="bar2">${bar}</div>` : ""}</div>`;
  while (root.firstChild) ov.appendChild(root.firstChild);
  const sh = $(".sheet", ov); sh.scrollTop = scroll;
  ov.onclick = (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a || !$(".sheet", ov)) return;
    if (a === "x") return closeSheet();
    if (a === "retry") { delete m.detailsErr; buildSheet(); return ensureDetails(m.id, 0); }
    if (a === "rm") { removeLike(m.id); return closeSheet(); }
    if (a === "w") { toggleWatched(m.id); return buildSheet(); }
    const dir = a === "l" ? 1 : a === "n" ? -1 : a === "e" ? 3 : 2;
    closeSheet(); const c = $(`.card[data-id="${m.id}"]`);
    if (c && c.dataset.pos === "0") fly(c, dir);
  };
}
function closeSheet() { openSheetId = null; $("#overlay").innerHTML = ""; $("#overlay").classList.add("hidden"); if (popupQueue.length) showMatchPopup(popupQueue.shift()); }
function toggleWatched(id) {
  const on = !watched.has(id);
  if (on) { watched.add(id); watchedAt.set(id, Date.now()); }
  else {
    watched.delete(id); watchedAt.delete(id);
    const mine = mySwipes.get(id); // if I marked it watched by swiping down, put it back in my pool
    if (mine && mine.r === T.SEEN) { mySwipes.delete(id); tomb.add(id); lsSet("rm_swipes_" + cfg.code, [...mySwipes]); room.unswipe(id); }
  }
  room.watched(id, on);
  if (tab === "matches") renderMatches(); if (tab === "likes") renderLikes(); if (tab === "watched") renderWatched();
  if (!on) fillDeck();
}
function removeLike(id) {
  mySwipes.delete(id); tomb.add(id); lsSet("rm_swipes_" + cfg.code, [...mySwipes]); room.unswipe(id);
  seenMatches.delete(id); lsSet("rm_seenm_" + cfg.code, [...seenMatches]);
  toast("Removed. It can show up in your deck again."); renderLikes(); updateBadge(); fillDeck();
}

/* ============ matches tab ============ */
let svcFilter = "all", matchTimer;
const scheduleMatches = () => { clearTimeout(matchTimer); matchTimer = setTimeout(() => tab === "matches" && !openSheetId && renderMatches(), 150); };
function renderMatches() {
  const v = $("#v-matches"); const scrollTop = v.scrollTop;
  const list = matches().filter((x) => !watched.has(x.id));
  list.forEach((x) => { const mv = movies.get(x.id); if (mv && mv.detailsErr) return; if (!mv?.detailsAt || Date.now() - mv.detailsAt > 12 * 3.6e6) ensureDetails(x.id, 12); });
  const counts = new Map(); let none = 0;
  for (const x of list) { const s = streamers(movies.get(x.id) || {}); if (!s.length) none++; s.forEach((p) => counts.set(p.id, { p, n: (counts.get(p.id)?.n || 0) + 1 })); }
  const chips = [`<button class="chip ${svcFilter === "all" ? "on" : ""}" data-f="all">All ${list.length}</button>`]
    .concat([...counts.values()].sort((a, b) => b.n - a.n).map(({ p, n }) => `<button class="chip ${svcFilter == p.id ? "on" : ""}" data-f="${p.id}"><img src="${logo(p.logo)}" alt="">${esc(p.name)} ${n}</button>`));
  if (none) chips.push(`<button class="chip ${svcFilter === "none" ? "on" : ""}" data-f="none">Rent/buy only ${none}</button>`);
  let shown = list.filter((x) => {
    const s = streamers(movies.get(x.id) || {});
    return svcFilter === "all" || (svcFilter === "none" ? !s.length : s.some((p) => String(p.id) === String(svcFilter)));
  });
  const rows = shown.map((x) => {
    const m = movies.get(x.id); if (!m) return "";
    const s = streamers(m);
    const pv = !m.providers ? `<span class="skel"></span>` : s.length ? s.slice(0, 5).map((p) => `<img src="${logo(p.logo)}" alt="${esc(p.name)}">`).join("") + `<span>${esc(s.slice(0, 2).map((p) => p.name).join(", "))}</span>` : `<span>${[...m.providers.rent, ...m.providers.buy].length ? "Rent / buy only" : "Not available in AU"}</span>`;
    return `<div class="row" data-id="${x.id}">
      <img class="th" src="${poster(m.poster, "w342")}" alt="" loading="lazy">
      <div><div class="t">${esc(m.title)}</div><div class="m">${m.year} · ${esc(genreNames(m, 2).join(", "))} · ★ ${m.vote.toFixed(1)}</div><div class="pv">${pv}</div></div>
      ${x.level >= 2 ? `<span class="love max">Both super-liked</span>` : x.level > 1 ? `<span class="love">Super-liked</span>` : ""}</div>`;
  }).join("");
  v.innerHTML = `<h1 class="page">Your matches</h1><p class="sub">${list.length ? `Movies you and ${esc(partnerName || "your partner")} both liked.` : "Nothing yet. Keep swiping — the moment you both like the same movie it lands here."}</p>
    ${list.length ? `<div class="chips">${chips.join("")}</div><button class="btn solid" id="pick" style="margin-bottom:14px">Choose for us</button>` : ""}${rows}`;
  v.scrollTop = scrollTop;
}
let pickedBefore = new Set();
function pickForUs() {
  let cands = matches().filter((x) => !watched.has(x.id)).filter((x) => {
    const s = streamers(movies.get(x.id) || {});
    return svcFilter === "all" || (svcFilter === "none" ? !s.length : s.some((p) => String(p.id) === String(svcFilter)));
  }).filter((x) => movies.get(x.id));
  if (!cands.length) return toast("No unwatched matches in this filter");
  const fresh = cands.filter((x) => !pickedBefore.has(x.id));
  if (!fresh.length) pickedBefore = new Set(); else cands = fresh;
  // favour super-likes, higher-rated films and anything you can stream right now
  const win = T.weightedPick(cands, (x) => x.level + (movies.get(x.id).vote || 6) / 10 + (streamers(movies.get(x.id)).length ? 0.5 : 0));
  pickedBefore.add(win.id);
  const m = movies.get(win.id);
  const why = win.level >= 2 ? "You both super-liked this one." : win.level > 1 ? "One of you super-liked it and the other liked it." : `You both liked it, and it's rated ${m.vote.toFixed(1)}.`;
  const ov = $("#overlay"); ov.classList.remove("hidden"); ov.innerHTML = "";
  const d = document.createElement("div"); d.className = "pop pick"; ov.appendChild(d);
  d.innerHTML = `<div class="eyebrow">Tonight's pick</div><img class="pick-img" src="${poster(m.poster, "w500")}" alt="">
    <div class="tt">${esc(m.title)}</div><div class="muted">${[m.year, fmtRuntime(m), genreNames(m, 2).join(", ")].filter(Boolean).join(" · ")}</div>
    <div class="why">${why}</div><div class="prov">${provHtml(m)}</div>
    <div class="btns"><button class="btn solid" data-a="d">Sounds good</button><button class="btn alt" data-a="r">Show another</button><button class="btn alt" data-a="i">Details</button></div>`;
  d.onclick = (e) => { e.stopPropagation(); const x = e.target.dataset.a; if (x === "r") pickForUs(); else if (x === "i") openSheet(m.id, "match"); else if (x === "d") closeSheet(); };
  ensureDetails(m.id, 12);
}

/* ============ Watched together tab ============ */
let watchedTimer;
const scheduleWatched = () => { clearTimeout(watchedTimer); watchedTimer = setTimeout(() => tab === "watched" && !openSheetId && renderWatched(), 200); };
function renderWatched() {
  const v = $("#v-watched"), scrollTop = v.scrollTop;
  const ids = [...watched].sort((a, b) => (watchedAt.get(b) || 0) - (watchedAt.get(a) || 0));
  loadDetailsGently(ids.filter((id) => !movies.get(id)));
  const theirs = (id) => theirSwipes.get(id) || theirSwipes.get(String(id));
  const rows = ids.map((id) => {
    const m = movies.get(id);
    if (!m) return `<div class="row"><div class="th"></div><div><div class="t"><span class="skel"></span></div></div></div>`;
    const when = watchedAt.get(id) ? new Date(watchedAt.get(id)).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
    const both = mySwipes.get(id)?.r > 0 && theirs(id)?.r > 0;
    return `<div class="row" data-id="${id}"><img class="th" src="${poster(m.poster, "w342")}" alt="" loading="lazy">
      <div><div class="t">${esc(m.title)}</div><div class="m">${m.year} · ${esc(genreNames(m, 2).join(", "))} · ★ ${m.vote.toFixed(1)}</div><div class="m" style="margin:0">${when ? "Watched " + when : "Watched"}</div></div>${both ? `<span class="love plain">Matched</span>` : ""}</div>`;
  }).join("");
  v.innerHTML = `<h1 class="page">Watched together</h1><p class="sub">${ids.length ? `${ids.length} ${ids.length === 1 ? "movie" : "movies"} you've already seen. They won't show up in either of your decks.` : "Nothing here yet. Swipe a movie down, or tap the eye button, to mark it as already watched."}</p>${rows}`;
  v.scrollTop = scrollTop;
}

/* ============ My likes tab ============ */
let likeFilter = "all", likeTimer, detailQueue = [], detailActive = 0;
const scheduleLikes = () => { clearTimeout(likeTimer); likeTimer = setTimeout(() => tab === "likes" && !openSheetId && renderLikes(), 200); };
function loadDetailsGently(ids) { // a few at a time, so a long list doesn't flood TMDB
  for (const id of ids) if (!detailQueue.includes(id)) detailQueue.push(id);
  const next = () => {
    while (detailActive < 3 && detailQueue.length) {
      const id = detailQueue.shift(), m = movies.get(id);
      if (m && m.detailsErr) continue;
      if (m && m.detailsAt && Date.now() - m.detailsAt < 24 * 3.6e6) continue;
      detailActive++; ensureDetails(id, 24).finally(() => { detailActive--; next(); });
    }
  };
  next();
}
function renderLikes() {
  const v = $("#v-likes"), scrollTop = v.scrollTop;
  const mine = [...mySwipes.entries()].filter(([, r]) => r.r > 0).sort((a, b) => b[1].r - a[1].r || (b[1].t || 0) - (a[1].t || 0)).map(([id, r]) => ({ id: Number(id), super: r.r > 1 }))
    .sort((a, b) => 0).filter((x) => movies.get(x.id));
  // newest first, super-likes pinned on top
  mine.sort((a, b) => (b.super - a.super) || ((mySwipes.get(b.id).t || 0) - (mySwipes.get(a.id).t || 0)));
  loadDetailsGently(mine.slice(0, 60).map((x) => x.id));
  const counts = new Map(); let none = 0;
  for (const x of mine) { const s = streamers(movies.get(x.id)); if (movies.get(x.id).providers && !s.length) none++; s.forEach((p) => counts.set(p.id, { p, n: (counts.get(p.id)?.n || 0) + 1 })); }
  const chips = [`<button class="chip ${likeFilter === "all" ? "on" : ""}" data-lf="all">All ${mine.length}</button>`]
    .concat([...counts.values()].sort((a, b) => b.n - a.n).map(({ p, n }) => `<button class="chip ${likeFilter == p.id ? "on" : ""}" data-lf="${p.id}"><img src="${logo(p.logo)}" alt="">${esc(p.name)} ${n}</button>`));
  if (none) chips.push(`<button class="chip ${likeFilter === "none" ? "on" : ""}" data-lf="none">Rent/buy only ${none}</button>`);
  const shown = mine.filter((x) => {
    const s = streamers(movies.get(x.id));
    return likeFilter === "all" || (likeFilter === "none" ? movies.get(x.id).providers && !s.length : s.some((p) => String(p.id) === String(likeFilter)));
  });
  const theirs = (id) => theirSwipes.get(id) || theirSwipes.get(String(id));
  const rows = shown.map((x) => {
    const m = movies.get(x.id), s = streamers(m), t = theirs(x.id);
    const pv = !m.providers ? (m.detailsErr ? `<span>Couldn't load streaming info</span>` : `<span class="skel"></span>`) : s.length ? s.slice(0, 5).map((p) => `<img src="${logo(p.logo)}" alt="${esc(p.name)}">`).join("") + `<span>${esc(s.slice(0, 2).map((p) => p.name).join(", "))}</span>` : `<span>${[...m.providers.rent, ...m.providers.buy].length ? "Rent / buy only" : "Not available in AU"}</span>`;
    const badge = t && t.r > 0 ? `<span class="love max">Matched</span>` : x.super ? `<span class="love">Super-liked</span>` : "";
    return `<div class="row" data-id="${x.id}"><img class="th" src="${poster(m.poster, "w342")}" alt="" loading="lazy">
      <div><div class="t">${esc(m.title)}</div><div class="m">${m.year} · ${esc(genreNames(m, 2).join(", "))} · ★ ${m.vote.toFixed(1)}</div><div class="pv">${pv}</div></div>${badge}</div>`;
  }).join("");
  v.innerHTML = `<h1 class="page">My likes</h1><p class="sub">${mine.length ? `Everything you've liked, ${mine.filter((x) => x.super).length} super-liked. Tap one for details or to remove it.` : "Nothing yet. Movies you like will collect here."}</p>
    ${mine.length ? `<div class="chips">${chips.join("")}</div>` : ""}${rows}`;
  v.scrollTop = scrollTop;
}

/* ============ Us tab ============ */
function bars(profile) {
  if (!profile || profile.n < 5) return `<p class="muted">Needs a few more swipes.</p>`;
  const top = [...profile.f.entries()].filter(([k]) => k[0] === "g" && profile.cnt.get(k) >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const mx = Math.max(0.05, ...top.map(([, v]) => Math.abs(v)));
  return top.map(([k, v]) => `<div class="bar"><span>${T.GENRES[k.slice(1)] || ""}</span><div><i style="width:${Math.max(4, Math.round(100 * Math.max(0, v) / mx))}%"></i></div></div>`).join("");
}
async function renderUs() {
  const v = $("#v-us");
  const mine = T.buildProfile([...mySwipes.values()]);
  const theirs = theirSwipes.size ? T.buildProfile([...theirSwipes.values()]) : null;
  const comp = T.compatibility(mySwipes, new Map([...theirSwipes].map(([k, x]) => [Number(k), x])));
  const shared = theirs ? T.topGenres(mine, 6).filter((g) => T.topGenres(theirs, 6).includes(g)) : [];
  const link = inviteLink();
  const svc = providerList ? providerList.map((p) => `<button class="chip ${settings.services.includes(p.id) ? "on" : ""}" data-svc="${p.id}"><img src="${logo(p.logo)}" alt="">${esc(p.name)}</button>`).join("") : `<span class="muted">Loading services…</span>`;
  v.innerHTML = `<h1 class="page">You two</h1>
  <div class="card2" style="text-align:center"><div class="big">${comp ? comp.percent + "%" : "—"}</div><div class="muted">${comp ? `taste match over ${comp.common} movies you both swiped` : partnerUid ? "Swipe a few more to see your taste match" : "Waiting for your partner to join"}</div>
    ${shared.length ? `<p>You both love <b>${shared.join(", ")}</b></p>` : ""}</div>
  <div class="card2"><h3>${esc(cfg.name)} likes</h3>${bars(mine)}<div class="muted" style="font-size:12px">${mySwipes.size} swiped · ${mine.likes} liked</div></div>
  <div class="card2"><h3>${esc(partnerName || "Partner")} likes</h3>${partnerUid ? bars(theirs) : `<p class="muted">Not joined yet.</p>`}${partnerUid ? `<div class="muted" style="font-size:12px">${theirSwipes.size} swiped</div>` : ""}</div>
  <div class="card2"><h3>What to show</h3>
    <div class="muted" id="mixLbl">Hollywood ${Math.round(settings.mix * 100)}% · Bollywood ${Math.round((1 - settings.mix) * 100)}%</div>
    <input id="mix" type="range" min="0" max="100" step="5" value="${Math.round(settings.mix * 100)}">
    <div class="toggle"><div>Only things I can stream in Australia<div class="muted" style="font-size:12px">Subscription, free or ad-supported — no rent/buy-only</div></div><button class="sw ${settings.onlyStreaming ? "on" : ""}" id="onlyS" aria-label="toggle"></button></div>
    ${settings.onlyStreaming ? `<div class="muted" style="font-size:12px;margin:4px 0 8px">Pick your services (none = any service):</div><div class="chips" style="flex-wrap:wrap">${svc}</div>` : ""}</div>
  <div class="card2"><h3>Room</h3><p style="margin-top:0">Room code <b style="user-select:text;font-size:20px;letter-spacing:.04em">${esc(cfg.code)}</b>${room.enabled ? "" : " · <span class='muted'>sync is off (solo mode)</span>"}</p>${room.enabled ? `<p class="muted" style="font-size:12px;margin-top:-4px">To join, your partner opens the app, types her name and this code.</p>` : ""}
    ${room.enabled ? `<button class="btn alt" id="invite">Share invite link</button><div style="height:8px"></div>` : ""}
    <button class="btn alt" id="redo">Redo my swipes</button><div style="height:8px"></div><button class="btn alt" id="leave">Leave room / change settings</button>
    <p class="credit" >Build 10 · Movie data and images from TMDB. Streaming availability from JustWatch. This product uses the TMDB API but is not endorsed or certified by TMDB.</p></div>`;
  if (settings.onlyStreaming && !providerList) loadProviders();
}
async function loadProviders() {
  providerList = lsGet("rm_providers", null);
  if (!providerList) { try { providerList = await tmdb.providers(); lsSet("rm_providers", providerList); } catch (_) { providerList = []; } }
  if (tab === "us") renderUs();
}
const inviteLink = () => location.origin + location.pathname + "#r=" + cfg.code;
async function shareInvite() {
  const url = inviteLink();
  try { if (navigator.share) return await navigator.share({ title: "AshKey Entertainment", text: `Join our AshKey Entertainment room. Open the link, type your name and this room code: ${cfg.code}`, url }); } catch (_) { return; }
  try { await navigator.clipboard.writeText(url); toast("Invite link copied"); } catch (_) { prompt("Copy this invite link", url); }
}
function applySettings(rebuild) {
  lsSet("rm_settings", settings);
  if (rebuild) { cursor = lsGet("rm_cursor_" + sig(), 0); deck = []; served = []; $$("#deck .card").forEach((c) => c.remove()); fillDeck(); refill().then(fillDeck); }
}
document.addEventListener("input", (e) => {
  if (e.target.id !== "mix") return;
  settings.mix = Number(e.target.value) / 100;
  $("#mixLbl").textContent = `Hollywood ${e.target.value}% · Bollywood ${100 - e.target.value}%`;
  lsSet("rm_settings", settings);
});
document.addEventListener("change", (e) => { if (e.target.id === "mix") { deck = deck.slice(0, 1); $$("#deck .card").forEach((c) => c.dataset.pos !== "0" && c.remove()); fillDeck(); } });

/* ============ sync ============ */
let syncing = false, lastBeat = 0, freshInstall = false;
async function syncNow() {
  if (!room.enabled || syncing) return;
  syncing = true;
  if (Date.now() - lastBeat > 45000) { lastBeat = Date.now(); room.setName(cfg.name); }
  try {
    room.flush();
    const snap = await room.snapshot();
    lastSyncOk = Date.now();
    if (snap) {
      members = snap.members || {};
      const sw = snap.swipes || {};
      const same = (u) => (members[u].name || "").trim().toLowerCase() === cfg.name.trim().toLowerCase();
      // Same name = same person. If you re-add the app or reinstall, every copy of "you" converges on the
      // lowest ID and keeps all swipes, so there's never a duplicate partner.
      const twins = Object.keys(members).filter((u) => u !== cfg.uid && same(u));
      if (twins.length) {
        const canon = [cfg.uid, ...twins].sort()[0];
        let merged = false;
        for (const u of twins) for (const [k, v] of Object.entries(sw[u] || {})) if (!mySwipes.has(Number(k))) { mySwipes.set(Number(k), v); merged = true; }
        if (merged || canon === cfg.uid) room.putMany(mySwipes); // never delete a twin's copy before ours is saved
        if (canon !== cfg.uid) {
          const old = cfg.uid;
          room.outbox = room.outbox.filter((o) => !o.path.includes("/" + old)); room.save();
          cfg.uid = canon; room.uid = canon; lsSet("rm_cfg", cfg);
          room.setName(cfg.name);
          room.putMany(mySwipes);
          room.forget(old); delete members[old]; delete sw[old];
        }
        for (const u of twins.filter((x) => x !== canon)) { room.forget(u); delete members[u]; delete sw[u]; }
        lsSet("rm_swipes_" + cfg.code, [...mySwipes]);
      }
      partnerUid = Object.keys(members).find((u) => u !== cfg.uid && !same(u)) || null;
      partnerName = partnerUid ? members[partnerUid].name : "";
      theirSwipes = new Map(partnerUid && sw[partnerUid] ? Object.entries(sw[partnerUid]).map(([k, v]) => [Number(k), v]) : []);
      for (const [k, v] of Object.entries(sw[cfg.uid] || {})) if (!mySwipes.has(Number(k)) && !tomb.has(Number(k)) && !room.outbox.some((o) => o.path === `swipes/${cfg.uid}/${k}`)) mySwipes.set(Number(k), v);
      watched = new Set(Object.keys(snap.watched || {}).map(Number));
      watchedAt = new Map(Object.entries(snap.watched || {}).map(([k, v]) => [Number(k), typeof v === "number" ? v : 0]));
      // a movie I marked watched that someone un-watched: give it back to my deck instead of hiding it forever
      for (const [id, rec] of [...mySwipes]) if (rec.r === T.SEEN && !watched.has(id) && !room.outbox.some((o) => o.path === `watched/${id}`)) { mySwipes.delete(id); tomb.add(id); room.unswipe(id); }
      if (tab === "watched") scheduleWatched();
      if (deck.some((m) => watched.has(m.id)) && !$(".card.drag")) { // already watched together: pull it out of this deck too
        const gone = new Set(deck.filter((m) => watched.has(m.id)).map((m) => String(m.id)));
        deck = deck.filter((m) => !watched.has(m.id));
        $$("#deck .card").forEach((c) => gone.has(c.dataset.id) && c.remove());
        fillDeck();
      }
      lsSet("rm_swipes_" + cfg.code, [...mySwipes]);
      const m = matches();
      if (freshInstall) { m.forEach((x) => seenMatches.add(x.id)); lsSet("rm_seenm_" + cfg.code, [...seenMatches]); freshInstall = false; } // existing matches on a new install aren't news
      const fresh = m.filter((x) => !seenMatches.has(x.id)).map((x) => x.id);
      for (const id of fresh) if (!movies.get(id)) await ensureDetails(id);
      if (fresh.length && tab !== "matches" && !openSheetId) celebrate(fresh);
      if (tab === "matches") { fresh.forEach((id) => seenMatches.add(id)); scheduleMatches(); }
      if (tab === "us" && !document.activeElement?.matches?.("input")) renderUs();
      if (deck.length < 4) fillDeck();
      seedRecommendations();
    }
  } catch (_) { /* offline */ }
  for (const mv of movies.values()) if (mv.detailsErr && Date.now() - (mv.detailsErrAt || 0) > 60000) delete mv.detailsErr;
  deck.slice(0, 3).forEach((m) => { const c = movies.get(m.id); if (c && !c.providers && !inflight.has(m.id)) { delete c.detailsErr; ensureDetails(m.id); } });
  if (openSheetId != null) { const c = movies.get(openSheetId); if (c && !c.providers && !inflight.has(c.id)) { delete c.detailsErr; ensureDetails(c.id, 0); } }
  syncing = false;
  updateStatus(); updateBadge();
}
function updateStatus() {
  const b = $("#partnerStatus");
  const online = !!partnerUid && Date.now() - ((members[partnerUid] && members[partnerUid].t) || 0) < 100000;
  if (!room.enabled) b.innerHTML = `<i></i>Solo`;
  else if (!partnerUid) b.innerHTML = `<i></i>Invite partner`;
  else b.innerHTML = `<i class="${online ? "on" : ""}"></i>${esc(partnerName)} · ${theirSwipes.size}`;
  const bn = $("#banner");
  if (room.enabled && !partnerUid) { bn.classList.remove("hidden"); bn.innerHTML = `<span>Your partner hasn't joined yet</span><button id="bInv">Invite</button>`; }
  else if (!room.enabled) { bn.classList.remove("hidden"); bn.innerHTML = `<span>Solo mode: no sync, so no matches</span>`; }
  else bn.classList.add("hidden");
}
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) syncNow(); }, 4000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && room) syncNow(); });
window.addEventListener("online", () => room && syncNow());

/* ============ tabs + events ============ */
function setTab(t) {
  tab = t;
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $("#v-swipe").classList.toggle("hidden", t !== "swipe"); $("#v-matches").classList.toggle("hidden", t !== "matches"); $("#v-likes").classList.toggle("hidden", t !== "likes"); $("#v-watched").classList.toggle("hidden", t !== "watched"); $("#v-us").classList.toggle("hidden", t !== "us");
  if (t === "matches") { renderMatches(); matches().forEach((x) => seenMatches.add(x.id)); lsSet("rm_seenm_" + cfg.code, [...seenMatches]); }
  if (t === "likes") renderLikes();
  if (t === "watched") renderWatched();
  if (t === "us") renderUs();
  updateBadge();
}
function bind() {
  $$(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $("#b-like").onclick = () => fly(topCard(), 1);
  $("#b-nope").onclick = () => fly(topCard(), -1);
  $("#b-super").onclick = () => fly(topCard(), 2);
  $("#b-undo").onclick = undo;
  $("#b-seen").onclick = () => fly(topCard(), 3);
  $("#partnerStatus").onclick = () => (!partnerUid && room.enabled ? shareInvite() : setTab("us"));
  $("#banner").onclick = (e) => { if (e.target.id === "bInv") shareInvite(); };
  $("#v-matches").onclick = (e) => {
    const f = e.target.closest("[data-f]"); if (f) { svcFilter = f.dataset.f; return renderMatches(); }
    if (e.target.closest("#pick")) return pickForUs();
    const r = e.target.closest(".row"); if (r) openSheet(Number(r.dataset.id), "match");
  };
  $("#v-likes").onclick = (e) => {
    const f = e.target.closest("[data-lf]"); if (f) { likeFilter = f.dataset.lf; return renderLikes(); }
    const r = e.target.closest(".row"); if (r) openSheet(Number(r.dataset.id), "likes");
  };
  $("#v-watched").onclick = (e) => { const r = e.target.closest(".row[data-id]"); if (r) openSheet(Number(r.dataset.id), "watched"); };
  $("#v-us").onclick = (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.id === "onlyS") { settings.onlyStreaming = !settings.onlyStreaming; applySettings(true); renderUs(); if (settings.onlyStreaming) loadProviders(); }
    else if (t.dataset.svc) { const id = Number(t.dataset.svc); settings.services = settings.services.includes(id) ? settings.services.filter((x) => x !== id) : [...settings.services, id]; applySettings(true); renderUs(); }
    else if (t.id === "invite") shareInvite();
    else if (t.id === "redo") { if (confirm("Clear all YOUR swipes and start over? Your partner's swipes stay.")) redoSwipes(); }
    else if (t.id === "leave") { if (confirm("Leave this room and go back to setup?")) { localStorage.removeItem("rm_cfg"); location.hash = ""; location.reload(); } }
  };
  window.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") fly(topCard(), 1); if (e.key === "ArrowLeft") fly(topCard(), -1); if (e.key === "ArrowUp") fly(topCard(), 2); if (e.key === "ArrowDown") fly(topCard(), 3); if (e.key === "Escape") closeSheet(); });
}
async function redoSwipes() {
  for (const id of mySwipes.keys()) tomb.add(id);
  room.clearMine();
  mySwipes = new Map(); undoStack = []; seenMatches = new Set(); lsSet("rm_swipes_" + cfg.code, []); lsSet("rm_seenm_" + cfg.code, []);
  deck = []; served = []; $$("#deck .card").forEach((c) => c.remove()); fillDeck(); setTab("swipe");
}

/* ============ setup ============ */
function parseInvite(s) {
  s = (s || "").trim(); if (!s) return null;
  const mm = s.match(/(?:^|#)i=([A-Za-z0-9_-]+)/); if (mm) s = mm[1];
  try { const o = b64.dec(s); return o && o.k && o.c ? o : null; } catch (_) { return null; }
}
async function showSetup(error = "") {
  $("#app").classList.add("hidden"); const s = $("#setup"); s.classList.remove("hidden");
  const old = cfg || {};
  const sameOrigin = DEFAULT_DB ? false : await Room.ping(location.origin + "/db");
  const defDb = old.db || DEFAULT_DB || (sameOrigin ? location.origin + "/db" : "");
  const fromHash = (location.hash.match(/(?:#|&)r=([a-z0-9]+)/) || [])[1] || (parseInvite(location.hash.slice(1)) || {}).c || "";
  const startCode = old.code || fromHash;
  s.innerHTML = `<div class="logo">Ash<b>Key</b><small>Entertainment</small></div><p class="muted" style="margin-top:14px">Swipe movies together. See what you both want to watch.</p>
    <label class="field"><span>Your name</span><input id="f-name" value="${esc(old.name || "")}" placeholder="e.g. Vibhor" autocomplete="off"></label>
    <label class="field"><span>Room code</span><input id="f-code" value="${esc(startCode)}" placeholder="Enter your room code" autocapitalize="off" autocorrect="off" autocomplete="off"><small id="f-hint"></small></label>
    <label class="field hidden" id="w-key"><span>TMDB API key</span><input id="f-key" value="${esc(old.key || "")}" placeholder="Paste your TMDB key" autocapitalize="off" autocorrect="off"></label>
    <label class="field ${defDb ? "hidden" : ""}"><span>Sync database URL</span><input id="f-db" value="${esc(defDb)}" placeholder="https://your-project-default-rtdb.firebaseio.com" autocapitalize="off" autocorrect="off"></label>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}<div class="err hidden" id="f-err"></div>
    <button class="btn" id="f-go">Continue</button>`;
  const code = $("#f-code"), refresh = () => {
    const empty = !code.value.trim();
    $("#w-key").classList.toggle("hidden", !empty);
    $("#f-hint").textContent = empty ? "No code? Leave this empty to start a new room, then share its code with your partner." : "Joining an existing room.";
    $("#f-go").textContent = empty ? "Start a new room" : "Join room";
  };
  code.oninput = refresh; refresh();
  $("#f-go").onclick = async () => {
    const err = (m) => { const e = $("#f-err"); e.textContent = m; e.classList.remove("hidden"); $("#f-go").disabled = false; refresh(); };
    const name = $("#f-name").value.trim(); if (!name) return err("What should your partner see as your name?");
    const raw = code.value.trim(), inv = parseInvite(raw);
    const rc = inv ? inv.c : raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    let db = inv && inv.d ? inv.d : $("#f-db").value.trim().replace(/\/+$/, ""), key = inv ? inv.k : "";
    $("#f-go").disabled = true; $("#f-go").textContent = "One moment…";
    let c;
    if (rc) {
      if (!key && old.code === rc && old.key) key = old.key;
      if (!key && db) key = await Room.fetchKey(db, rc);
      if (!key) return err("Couldn't find that room. Check the code, and ask your partner to open the app once.");
      c = { key, db, code: rc };
    } else {
      key = $("#f-key").value.trim(); if (!key) return err("Paste your TMDB API key to start a room.");
      c = { key, db, code: rid(10) };
    }
    cfg = { name, uid: old.uid || rid(10), ...c };
    lsSet("rm_cfg", cfg); history.replaceState(null, "", location.pathname);
    s.classList.add("hidden"); boot();
  };
}

/* ============ boot ============ */
async function boot() {
  if (!cfg || !cfg.key || !cfg.code) return showSetup();
  $("#app").classList.remove("hidden"); $("#setup").classList.add("hidden");
  tmdb = new TMDB(cfg.key); room = new Room(cfg.db, cfg.code, cfg.uid);
  mySwipes = new Map(lsGet("rm_swipes_" + cfg.code, []).map(([k, v]) => [Number(k), v]));
  const storedSeen = lsGet("rm_seenm_" + cfg.code, null); freshInstall = storedSeen === null;
  seenMatches = new Set(storedSeen || []); seeded = new Set(lsGet("rm_seeded", []));
  cursor = lsGet("rm_cursor_" + sig(), 0);
  await loadCache();
  if (room.enabled) { room.setName(cfg.name); room.setKey(cfg.key); }
  bind(); updateStatus(); renderDeck();
  await syncNow();
  await refill(); await fillDeck();
  startPolling(); updateBadge();
  if (!room.enabled) toast("Solo mode: add a sync database in setup to match with your partner", 4500);
}

(async () => {
  const inv = parseInvite(location.hash.slice(1)), hc = (location.hash.match(/(?:#|&)r=([a-z0-9]+)/) || [])[1];
  if ((inv || hc) && (!cfg || cfg.code !== (inv ? inv.c : hc))) { await showSetup(); return; }
  if ("serviceWorker" in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !window.__reloaded) { window.__reloaded = true; location.reload(); } });
  }
  boot();
})();

/* ============ no zooming ============ */
["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
let lastTap = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTap < 350 && !e.target.closest("button, input, a, .card, .row, .chip")) e.preventDefault(); // double-tap zoom
  lastTap = now;
}, { passive: false });
