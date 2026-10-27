import * as T from "./taste.js";
import { TMDB, poster, profilePic, logo, streamers, REGION } from "./tmdb.js";
import { Room } from "./sync.js";

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
let mySwipes = new Map(), theirSwipes = new Map(), watched = new Set();
let members = {}, partnerUid = null, partnerName = "";
const movies = new Map();                    // id -> movie (list-level, enriched with details when loaded)
const dirty = new Set();
let deck = [], served = [], undoStack = [];
let filling = false, cursor = 0, seeded = new Set(), providerList = null;
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
    for (const id of dirty) { const m = movies.get(id); if (m) st.put(m); }
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
  const p = tmdb.details(id).then((d) => { const merged = remember(d); onDetails(merged); return merged; }).catch(() => m || null).finally(() => inflight.delete(id));
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
  return [...movies.values()].filter((m) => poolSig(m) && m.poster && m.overview && !mySwipes.has(m.id) && !inDeck.has(m.id) && passes(m));
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
      const list = await tmdb.source(cursor++, filterOpts());
      lsSet("rm_cursor_" + sig(), cursor);
      for (const m of list) { const old = movies.get(m.id); remember(m, { sig: sig(), recCount: old && old.recCount }); added++; }
    }
  } catch (e) { toast(e.message, 4000); if (/API key/.test(e.message)) showSetup(e.message); }
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
  if (!m.providers) return `<span class="skel"></span>`;
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
    <div class="shade"></div><div class="stamp like">LIKE</div><div class="stamp nope">NOPE</div><div class="stamp super">SUPER</div>
    <div class="info">${infoHtml(m)}</div>`;
  $(".poster", el).onerror = (e) => e.target.remove();
  attachDrag(el);
  return el;
}
function onDetails(m) {
  const c = $(`.card[data-id="${m.id}"] .info`);
  if (c) c.innerHTML = infoHtml(m);
  if (document.querySelector("#overlay .sheet") && openSheetId === m.id) buildSheet();
  if (tab === "matches") scheduleMatches();
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
    if (dx > 110 || (v > 0.6 && dx > 40)) fly(card, 1);
    else if (dx < -110 || (v > 0.6 && dx < -40)) fly(card, -1);
    else if (dy < -120 && Math.abs(dy) > Math.abs(dx)) fly(card, 2);
    else { card.style.transform = ""; dx = dy = 0; $$(".stamp", card).forEach((s) => (s.style.opacity = 0)); }
  };
  card.addEventListener("pointerup", end); card.addEventListener("pointercancel", end);
}
function fly(card, r) {
  if (!card || card.classList.contains("fly")) return;
  const id = Number(card.dataset.id), m = movies.get(id);
  card.classList.remove("drag"); card.classList.add("fly");
  const W = window.innerWidth;
  const stamp = $(r > 1 ? ".stamp.super" : r > 0 ? ".stamp.like" : ".stamp.nope", card); if (stamp) stamp.style.opacity = 1;
  card.style.transform = r === 2 ? "translate(0,-110vh) scale(.92)" : `translate(${(r > 0 ? 1 : -1) * W * 1.4}px, 60px) rotate(${(r > 0 ? 1 : -1) * 24}deg)`;
  setTimeout(() => { card.remove(); commitSwipe(m, r === 2 ? T.SUPER : r > 0 ? T.LIKE : T.NOPE); }, 260);
}
function topCard() { return $('.card[data-pos="0"]:not(.fly)'); }

/* ============ swiping, undo, matches ============ */
function commitSwipe(m, r) {
  if (!m) return;
  const rec = T.makeRecord(movies.get(m.id) || m, r);
  mySwipes.set(m.id, rec); lsSet("rm_swipes_" + cfg.code, [...mySwipes]);
  room.swipe(m.id, rec);
  undoStack.push(m.id);
  deck = deck.filter((x) => x.id !== m.id);
  const th = theirSwipes.get(m.id) || theirSwipes.get(String(m.id));
  if (r > 0 && th && th.r > 0) celebrate([m.id]);
  fillDeck(); updateBadge();
}
function undo() {
  const id = undoStack.pop();
  if (id == null) return toast("Nothing to undo");
  mySwipes.delete(id); lsSet("rm_swipes_" + cfg.code, [...mySwipes]); room.unswipe(id);
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
  const old = $("#overlay .sheet"); if (old) old.parentElement.remove();
  const d = document.createElement("div"); d.className = "pop";
  d.innerHTML = `<h2>It's a match!</h2><img class="pp" src="${poster(m.poster)}" alt=""><div class="tt">${esc(m.title)}</div>
    <div class="meta muted">You and ${esc(partnerName || "your partner")} both want to watch this</div><div class="prov">${provHtml(m)}</div>
    <div class="btns"><button class="btn" data-a="m">See all matches</button><button class="btn alt" data-a="k">Keep swiping</button></div>`;
  ov.appendChild(d); navigator.vibrate && navigator.vibrate([60, 40, 60]);
  d.onclick = (e) => {
    const a = e.target.dataset.a; if (!a) return;
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
  if (!p) where = `<span class="skel"></span>`;
  else {
    where = group("Included with subscription", p.flatrate) + group("Free", p.free, "") + group("Free with ads", p.ads) + group("Rent", p.rent) + group("Buy", p.buy);
    if (!where) where = `<p class="muted">Not available to stream, rent or buy in Australia right now.</p>`;
  }
  const cast = (m.cast || []).map((c) => `<div class="cm">${c.photo ? `<img src="${profilePic(c.photo)}" alt="" loading="lazy">` : `<div class="ph"></div>`}<b>${esc(c.name)}</b><span>${esc(c.character || "")}</span></div>`).join("");
  const isMatch = mySwipes.get(m.id)?.r > 0 && (theirSwipes.get(m.id) || theirSwipes.get(String(m.id)))?.r > 0;
  const bar = openSheetMode === "deck"
    ? `<button class="act nope" data-a="n"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button><button class="act super" data-a="s"><svg viewBox="0 0 24 24" class="fill"><path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.3 6.4 20.3l1.2-6.3L3 9.6l6.3-.8z"/></svg></button><button class="act like" data-a="l"><svg viewBox="0 0 24 24" class="fill"><path d="M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z"/></svg></button>`
    : isMatch ? `<button class="btn sm ${watched.has(m.id) ? "alt" : ""}" data-a="w">${watched.has(m.id) ? "Mark as not watched" : "✓ We've watched it"}</button>` : "";
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
      <div class="links">${m.trailer ? `<a target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=${m.trailer}">▶ Trailer</a>` : ""}${p && p.link ? `<a target="_blank" rel="noopener" href="${esc(p.link)}">JustWatch</a>` : ""}${m.imdb ? `<a target="_blank" rel="noopener" href="https://www.imdb.com/title/${m.imdb}/">IMDb</a>` : ""}</div>
    </div>${bar ? `<div class="bar2">${bar}</div>` : ""}</div>`;
  while (root.firstChild) ov.appendChild(root.firstChild);
  const sh = $(".sheet", ov); sh.scrollTop = scroll;
  ov.onclick = (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a || !$(".sheet", ov)) return;
    if (a === "x") return closeSheet();
    if (a === "w") { toggleWatched(m.id); return buildSheet(); }
    const r = a === "l" ? T.LIKE : a === "n" ? T.NOPE : T.SUPER;
    closeSheet(); const c = $(`.card[data-id="${m.id}"]`);
    if (c && c.dataset.pos === "0") fly(c, r === T.SUPER ? 2 : r > 0 ? 1 : -1);
  };
}
function closeSheet() { openSheetId = null; $("#overlay").innerHTML = ""; $("#overlay").classList.add("hidden"); if (popupQueue.length) showMatchPopup(popupQueue.shift()); }
function toggleWatched(id) {
  const on = !watched.has(id); on ? watched.add(id) : watched.delete(id); room.watched(id, on); if (tab === "matches") renderMatches();
}

/* ============ matches tab ============ */
let svcFilter = "all", matchTimer;
const scheduleMatches = () => { clearTimeout(matchTimer); matchTimer = setTimeout(() => tab === "matches" && !openSheetId && renderMatches(), 150); };
function renderMatches() {
  const v = $("#v-matches"); const scrollTop = v.scrollTop;
  const list = matches();
  list.forEach((x) => { if (!movies.get(x.id)?.detailsAt) ensureDetails(x.id, 12); else if (Date.now() - movies.get(x.id).detailsAt > 12 * 3.6e6) ensureDetails(x.id, 12); });
  const counts = new Map(); let none = 0;
  for (const x of list) { const s = streamers(movies.get(x.id) || {}); if (!s.length) none++; s.forEach((p) => counts.set(p.id, { p, n: (counts.get(p.id)?.n || 0) + 1 })); }
  const chips = [`<button class="chip ${svcFilter === "all" ? "on" : ""}" data-f="all">All ${list.length}</button>`]
    .concat([...counts.values()].sort((a, b) => b.n - a.n).map(({ p, n }) => `<button class="chip ${svcFilter == p.id ? "on" : ""}" data-f="${p.id}"><img src="${logo(p.logo)}" alt="">${esc(p.name)} ${n}</button>`));
  if (none) chips.push(`<button class="chip ${svcFilter === "none" ? "on" : ""}" data-f="none">Rent/buy only ${none}</button>`);
  let shown = list.filter((x) => {
    const s = streamers(movies.get(x.id) || {});
    return svcFilter === "all" || (svcFilter === "none" ? !s.length : s.some((p) => String(p.id) === String(svcFilter)));
  });
  shown = [...shown.filter((x) => !watched.has(x.id)), ...shown.filter((x) => watched.has(x.id))];
  const rows = shown.map((x) => {
    const m = movies.get(x.id); if (!m) return "";
    const s = streamers(m);
    const pv = !m.providers ? `<span class="skel"></span>` : s.length ? s.slice(0, 5).map((p) => `<img src="${logo(p.logo)}" alt="${esc(p.name)}">`).join("") + `<span>${esc(s.slice(0, 2).map((p) => p.name).join(", "))}</span>` : `<span>${[...m.providers.rent, ...m.providers.buy].length ? "Rent / buy only" : "Not available in AU"}</span>`;
    return `<div class="row ${watched.has(x.id) ? "watched" : ""}" data-id="${x.id}">
      <img class="th" src="${poster(m.poster, "w342")}" alt="" loading="lazy">
      <div><div class="t">${esc(m.title)}</div><div class="m">${m.year} · ${esc(genreNames(m, 2).join(", "))} · ★ ${m.vote.toFixed(1)}${watched.has(x.id) ? " · watched" : ""}</div><div class="pv">${pv}</div></div>
      ${x.level >= 2 ? `<span class="love max">♥ Both super</span>` : x.level > 1 ? `<span class="love">★ Super</span>` : ""}</div>`;
  }).join("");
  v.innerHTML = `<h1 class="page">Your matches</h1><p class="sub">${list.length ? `Movies you and ${esc(partnerName || "your partner")} both liked.` : "Nothing yet. Keep swiping — the moment you both like the same movie it lands here."}</p>
    ${list.length ? `<div class="chips">${chips.join("")}</div><button class="btn" id="pick" style="margin-bottom:14px">🎲 Pick one for us</button>` : ""}${rows}`;
  v.scrollTop = scrollTop;
}
function pickForUs() {
  const cands = matches().filter((x) => !watched.has(x.id)).filter((x) => {
    const s = streamers(movies.get(x.id) || {});
    return svcFilter === "all" || (svcFilter === "none" ? !s.length : s.some((p) => String(p.id) === String(svcFilter)));
  });
  if (!cands.length) return toast("No unwatched matches in this filter");
  const win = T.weightedPick(cands, (x) => x.level + (movies.get(x.id)?.vote || 6) / 10);
  const ov = $("#overlay"); ov.classList.remove("hidden"); ov.innerHTML = "";
  const d = document.createElement("div"); d.className = "pop"; ov.appendChild(d);
  let i = 0, steps = 14;
  const tick = async () => {
    const x = i++ < steps ? cands[Math.floor(Math.random() * cands.length)] : win;
    const m = movies.get(x.id);
    const last = i > steps;
    d.innerHTML = `<h2>${last ? "Tonight we watch…" : "Choosing…"}</h2><img class="pick-img" src="${poster(m.poster, "w500")}" alt="">${last ? `<div class="tt">${esc(m.title)}</div><div class="prov">${provHtml(m)}</div><div class="btns"><button class="btn" data-a="d">Let's watch it</button><button class="btn alt" data-a="r">Pick again</button><button class="btn alt" data-a="i">Details</button></div>` : ""}`;
    if (!last) setTimeout(tick, 70 + i * 14);
    else d.onclick = (e) => { const a = e.target.dataset.a; if (a === "r") pickForUs(); else if (a === "i") openSheet(m.id, "match"); else if (a === "d") { closeSheet(); } };
  };
  tick();
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
  <div class="card2"><h3>Room</h3><p style="margin-top:0">Room code <b style="user-select:text">${esc(cfg.code)}</b>${room.enabled ? "" : " · <span class='muted'>sync is off (solo mode)</span>"}</p>
    ${room.enabled ? `<button class="btn alt" id="invite">Share invite link</button><div style="height:8px"></div>` : ""}
    <button class="btn alt" id="redo">Redo my swipes</button><div style="height:8px"></div><button class="btn alt" id="leave">Leave room / change settings</button>
    <p class="credit" id="dbg">Build 5 · Movie data and images from TMDB. Streaming availability from JustWatch. This product uses the TMDB API but is not endorsed or certified by TMDB.</p></div>`;
  if (settings.onlyStreaming && !providerList) loadProviders();
  showDebug();
}
function showDebug() {
  const d = $("#dbg"); if (!d) return;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;top:0;left:0;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)";
  document.body.appendChild(probe); const cs = getComputedStyle(probe);
  const vv = window.visualViewport, app = $("#app").getBoundingClientRect(), tabs = $(".tabs").getBoundingClientRect();
  const info = `inner ${innerWidth}x${innerHeight} · screen ${screen.width}x${screen.height} · vv ${vv ? Math.round(vv.width) + "x" + Math.round(vv.height) : "-"} · safe ${cs.paddingTop}/${cs.paddingBottom} · app ${Math.round(app.top)}-${Math.round(app.bottom)} · tabs ${Math.round(tabs.top)}-${Math.round(tabs.bottom)} · standalone ${!!navigator.standalone} · dpr ${devicePixelRatio}`;
  probe.remove();
  d.insertAdjacentHTML("afterend", `<p class="credit" style="user-select:text">${info}</p>`);
}
async function loadProviders() {
  providerList = lsGet("rm_providers", null);
  if (!providerList) { try { providerList = await tmdb.providers(); lsSet("rm_providers", providerList); } catch (_) { providerList = []; } }
  if (tab === "us") renderUs();
}
const inviteLink = () => location.origin + location.pathname + "#i=" + inviteCode();
const inviteCode = () => b64.enc({ k: cfg.key, d: cfg.db, c: cfg.code });
async function shareInvite() {
  const url = inviteLink();
  try { if (navigator.share) return await navigator.share({ title: "AshKey Entertainment", text: `Join our AshKey Entertainment room`, url }); } catch (_) { return; }
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
async function syncNow() {
  if (!room.enabled) return;
  try {
    room.flush();
    const snap = await room.snapshot();
    lastSyncOk = Date.now();
    if (snap) {
      members = snap.members || {};
      partnerUid = Object.keys(members).find((u) => u !== cfg.uid) || null;
      partnerName = partnerUid ? members[partnerUid].name : "";
      const sw = snap.swipes || {};
      theirSwipes = new Map(partnerUid && sw[partnerUid] ? Object.entries(sw[partnerUid]).map(([k, v]) => [Number(k), v]) : []);
      for (const [k, v] of Object.entries(sw[cfg.uid] || {})) if (!mySwipes.has(Number(k)) && !room.outbox.some((o) => o.path === `swipes/${cfg.uid}/${k}`)) mySwipes.set(Number(k), v);
      watched = new Set(Object.keys(snap.watched || {}).map(Number));
      lsSet("rm_swipes_" + cfg.code, [...mySwipes]);
      const m = matches();
      const fresh = m.filter((x) => !seenMatches.has(x.id)).map((x) => x.id);
      for (const id of fresh) if (!movies.get(id)) await ensureDetails(id);
      if (fresh.length && tab !== "matches" && !openSheetId) celebrate(fresh);
      if (tab === "matches") { fresh.forEach((id) => seenMatches.add(id)); scheduleMatches(); }
      if (tab === "us" && !document.activeElement?.matches?.("input")) renderUs();
      if (deck.length < 4) fillDeck();
      seedRecommendations();
    }
  } catch (_) { /* offline */ }
  updateStatus(); updateBadge();
}
function updateStatus() {
  const b = $("#partnerStatus");
  const online = Date.now() - lastSyncOk < 15000;
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
  $("#v-swipe").classList.toggle("hidden", t !== "swipe"); $("#v-matches").classList.toggle("hidden", t !== "matches"); $("#v-us").classList.toggle("hidden", t !== "us");
  if (t === "matches") { renderMatches(); matches().forEach((x) => seenMatches.add(x.id)); lsSet("rm_seenm_" + cfg.code, [...seenMatches]); }
  if (t === "us") renderUs();
  updateBadge();
}
function bind() {
  $$(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $("#b-like").onclick = () => fly(topCard(), 1);
  $("#b-nope").onclick = () => fly(topCard(), -1);
  $("#b-super").onclick = () => fly(topCard(), 2);
  $("#b-undo").onclick = undo;
  $("#b-info").onclick = () => { const c = topCard(); if (c) openSheet(Number(c.dataset.id), "deck"); };
  $("#partnerStatus").onclick = () => (!partnerUid && room.enabled ? shareInvite() : setTab("us"));
  $("#banner").onclick = (e) => { if (e.target.id === "bInv") shareInvite(); };
  $("#v-matches").onclick = (e) => {
    const f = e.target.closest("[data-f]"); if (f) { svcFilter = f.dataset.f; return renderMatches(); }
    if (e.target.closest("#pick")) return pickForUs();
    const r = e.target.closest(".row"); if (r) openSheet(Number(r.dataset.id), "match");
  };
  $("#v-us").onclick = (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.id === "onlyS") { settings.onlyStreaming = !settings.onlyStreaming; applySettings(true); renderUs(); if (settings.onlyStreaming) loadProviders(); }
    else if (t.dataset.svc) { const id = Number(t.dataset.svc); settings.services = settings.services.includes(id) ? settings.services.filter((x) => x !== id) : [...settings.services, id]; applySettings(true); renderUs(); }
    else if (t.id === "invite") shareInvite();
    else if (t.id === "redo") { if (confirm("Clear all YOUR swipes and start over? Your partner's swipes stay.")) redoSwipes(); }
    else if (t.id === "leave") { if (confirm("Leave this room and go back to setup?")) { localStorage.removeItem("rm_cfg"); location.hash = ""; location.reload(); } }
  };
  window.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") fly(topCard(), 1); if (e.key === "ArrowLeft") fly(topCard(), -1); if (e.key === "ArrowUp") fly(topCard(), 2); if (e.key === "Escape") closeSheet(); });
}
async function redoSwipes() {
  for (const id of [...mySwipes.keys()]) room.unswipe(id);
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
  const sameOrigin = await Room.ping(location.origin + "/db");
  const defDb = old.db || (sameOrigin ? location.origin + "/db" : "");
  let mode = parseInvite(location.hash.slice(1)) || old.invited ? "join" : "new";
  const pre = parseInvite(location.hash.slice(1));
  const draw = () => {
    s.innerHTML = `<div class="logo">Ash<b>Key</b><small>Entertainment</small></div><p class="muted" style="margin-top:0">Swipe movies together. See what you both want to watch.</p>
    <label class="field"><span>Your name</span><input id="f-name" value="${esc(old.name || "")}" placeholder="e.g. Vibhor" autocomplete="off"></label>
    <div class="seg"><button data-m="new" class="${mode === "new" ? "on" : ""}">Start a room</button><button data-m="join" class="${mode === "join" ? "on" : ""}">Join partner's room</button></div>
    ${mode === "join" ? `<label class="field"><span>Invite link or code</span><input id="f-inv" value="${pre ? esc(location.href) : ""}" placeholder="Paste the invite link or code" autocapitalize="off" autocorrect="off"><small>Your partner gets this from Us → Share invite link. If you opened the link in Safari first, copy it again here: the Home Screen app keeps its own storage.</small></label>`
    : `<label class="field"><span>TMDB API key</span><input id="f-key" value="${esc(old.key || "")}" placeholder="API key or read access token" autocapitalize="off" autocorrect="off"><small>Free at themoviedb.org → Settings → API (choose "Developer", any URL is fine).</small></label>
      <label class="field"><span>Sync database URL</span><input id="f-db" value="${esc(defDb)}" placeholder="https://your-project-default-rtdb.firebaseio.com" autocapitalize="off" autocorrect="off"><small>Free Firebase Realtime Database that connects your two phones (see README). Leave empty to try it solo.</small></label>`}
    ${error ? `<div class="err">${esc(error)}</div>` : ""}<div class="err hidden" id="f-err"></div>
    <button class="btn" id="f-go">${mode === "new" ? "Create room" : "Join room"}</button>
    ${pre && !isStandalone() ? `<button class="btn alt" id="f-copy" style="margin-top:10px">Copy invite (for the Home Screen app)</button>` : ""}`;
    $$(".seg button", s).forEach((b) => (b.onclick = () => { old.name = $("#f-name").value; mode = b.dataset.m; draw(); }));
    const cp = $("#f-copy"); if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast("Copied. Now Add to Home Screen, open it, and paste."); } catch (_) {} };
    $("#f-go").onclick = () => {
      const name = $("#f-name").value.trim(), err = (m) => { const e = $("#f-err"); e.textContent = m; e.classList.remove("hidden"); };
      if (!name) return err("What should your partner see as your name?");
      let c;
      if (mode === "join") {
        const inv = parseInvite($("#f-inv").value); if (!inv) return err("That invite doesn't look right. Ask for a fresh link.");
        c = { key: inv.k, db: inv.d || "", code: inv.c };
      } else {
        const key = $("#f-key").value.trim(); if (!key) return err("Add your TMDB API key.");
        c = { key, db: $("#f-db").value.trim().replace(/\/+$/, ""), code: old.code && old.key === key ? old.code : rid(10) };
      }
      cfg = { name, uid: old.uid || rid(10), ...c };
      lsSet("rm_cfg", cfg); history.replaceState(null, "", location.pathname);
      s.classList.add("hidden"); boot();
    };
  };
  draw();
}

/* ============ boot ============ */
async function boot() {
  if (!cfg || !cfg.key || !cfg.code) return showSetup();
  $("#app").classList.remove("hidden"); $("#setup").classList.add("hidden");
  tmdb = new TMDB(cfg.key); room = new Room(cfg.db, cfg.code, cfg.uid);
  mySwipes = new Map(lsGet("rm_swipes_" + cfg.code, []).map(([k, v]) => [Number(k), v]));
  seenMatches = new Set(lsGet("rm_seenm_" + cfg.code, [])); seeded = new Set(lsGet("rm_seeded", []));
  cursor = lsGet("rm_cursor_" + sig(), 0);
  await loadCache();
  if (room.enabled) room.setName(cfg.name);
  bind(); updateStatus(); renderDeck();
  await syncNow();
  await refill(); await fillDeck();
  startPolling(); updateBadge();
  if (!room.enabled) toast("Solo mode: add a sync database in setup to match with your partner", 4500);
}

(async () => {
  const inv = parseInvite(location.hash.slice(1));
  if (inv && (!cfg || cfg.code !== inv.c)) { await showSetup(); return; }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  boot();
})();
