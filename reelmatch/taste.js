// AshKey taste engine. Pure functions only (no DOM, no network) so it can be unit-tested in Node.
//
// Pipeline for every card you see:
//   1. Each person's swipes are folded into a TASTE PROFILE: a smoothed, recency-weighted, mean-centred
//      affinity for every feature (genre, language, decade, lead cast, director).
//   2. Every candidate movie is scored: own affinity + a "both of us" term + quality prior + popularity,
//      nudged by what the partner already swiped and by "because you liked X" recommendations.
//   3. The next cards are picked greedily with a Hollywood/Bollywood quota, a genre-diversity penalty
//      and a little decaying exploration noise, so the deck never turns into one genre on repeat.

export const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
  10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery",
  10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};

export const NOPE = -1, LIKE = 1, SUPER = 2;

const ALPHA = 2;            // smoothing: a feature seen once is trusted only ~1/3 as much as one seen often
const DECAY = 0.997;        // per swipe; the swipe 230 swipes ago counts half
const LAMBDA = { g: 0.45, l: 0.15, y: 0.10, c: 0.15, d: 0.15 };

export const group = (m) => (m.lang === "hi" ? "b" : "h"); // b = Bollywood, h = Hollywood/other

/* ---------- compact swipe records (what is synced between phones) ---------- */

const csv = (a) => (a && a.length ? a.join(",") : "");
const unCsv = (s) => (s ? String(s).split(",").map(Number).filter((n) => !Number.isNaN(n)) : []);

export function makeRecord(m, r, t = Date.now()) {
  const rec = { r, t, l: m.lang || "", g: csv(m.genres), y: m.year || 0, q: Math.round((m.vote || 0) * 10) };
  if (m.cast && m.cast.length) rec.c = csv(m.cast.slice(0, 3).map((c) => (typeof c === "object" ? c.id : c)));
  if (m.director) rec.d = m.director;
  return rec;
}

const recordMovie = (rec) => ({ lang: rec.l, genres: unCsv(rec.g), year: rec.y, cast: unCsv(rec.c), director: rec.d });

export function featuresOf(m) {
  const f = [];
  for (const g of m.genres || []) f.push(["g", "g" + g]);
  if (m.lang) f.push(["l", "l" + m.lang]);
  if (m.year) f.push(["y", "y" + Math.floor(m.year / 10) * 10]);
  for (const c of (m.cast || []).slice(0, 3)) f.push(["c", "c" + (typeof c === "object" ? c.id : c)]);
  if (m.director) f.push(["d", "d" + m.director]);
  return f;
}

/* ---------- taste profile ---------- */

export function buildProfile(records) {
  const recs = [...records].sort((a, b) => (a.t || 0) - (b.t || 0));
  const n = recs.length;
  let sumW = 0, sumD = 0;
  recs.forEach((rec, i) => { const d = Math.pow(DECAY, n - 1 - i); sumW += rec.r * d; sumD += d; });
  const mu = sumD ? sumW / sumD : 0; // the person's overall appetite: features are judged against it
  const num = new Map(), den = new Map(), cnt = new Map();
  recs.forEach((rec, i) => {
    const d = Math.pow(DECAY, n - 1 - i);
    for (const [, key] of featuresOf(recordMovie(rec))) {
      num.set(key, (num.get(key) || 0) + (rec.r - mu) * d);
      den.set(key, (den.get(key) || 0) + d);
      cnt.set(key, (cnt.get(key) || 0) + 1);
    }
  });
  const f = new Map();
  for (const [k, s] of num) f.set(k, s / (den.get(k) + ALPHA));
  const likes = recs.filter((r) => r.r > 0).length;
  return { f, cnt, n, likes, mu };
}

export function affinity(profile, m) {
  if (!profile || !profile.n) return 0;
  const by = {};
  for (const [type, key] of featuresOf(m)) (by[type] = by[type] || []).push(profile.f.get(key) || 0);
  let sum = 0, wsum = 0;
  for (const type in by) {
    const v = by[type];
    // cast / director: the single strongest signal; genres, language, decade: the average
    const val = type === "c" || type === "d" ? v.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : v.reduce((a, b) => a + b, 0) / v.length;
    sum += LAMBDA[type] * val; wsum += LAMBDA[type];
  }
  return wsum ? sum / wsum : 0;
}

export function topGenres(profile, n = 3, sign = 1) {
  if (!profile) return [];
  return [...profile.f.entries()]
    .filter(([k]) => k[0] === "g" && (profile.cnt.get(k) || 0) >= 3)
    .sort((a, b) => sign * (b[1] - a[1]))
    .slice(0, n)
    .filter(([, v]) => sign * v > 0.02)
    .map(([k]) => GENRES[k.slice(1)])
    .filter(Boolean);
}

export const quality = (m) => {
  const v = m.votes || 0, C = 6.5, k = 300;
  const q = ((v * (m.vote || 0)) + k * C) / (v + k);
  return Math.max(-1, Math.min(1.5, (q - 6.5) / 2));
};
export const popularity = (m) => Math.max(0, Math.min(1, Math.log10((m.pop || 0) + 1) / 3));

export const joint = (a, b) => 0.5 * (a + b) - 0.25 * Math.abs(a - b);

/* ---------- scoring ---------- */

export function gaussian(rand) {
  const u = Math.max(rand(), 1e-9), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Noise that is identical on both phones (same room seed + movie id), so two people with similar taste
// are shown largely the same movies in the same order. That overlap is what makes matches possible.
export function sharedNoise(seed, id) {
  let h = 2166136261;
  for (const ch of seed + ":" + id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const u = (k) => { let x = (h + k * 0x9e3779b9) | 0; x = Math.imul(x ^ (x >>> 15), 2246822519); x = Math.imul(x ^ (x >>> 13), 3266489917); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
  return (u(1) + u(2) + u(3) - 1.5) * 2; // roughly N(0,1)
}

// ctx: { mine, partner, partnerSwipes: Map(id -> r), rand, seed }
export function score(m, ctx, noise = true) {
  const au = affinity(ctx.mine, m);
  const ap = ctx.partner && ctx.partner.n ? affinity(ctx.partner, m) : au;
  let s = 0.40 * au + 0.30 * joint(au, ap) + 0.20 * quality(m) + 0.05 * popularity(m);
  const pr = ctx.partnerSwipes && ctx.partnerSwipes.get(m.id);
  if (pr > 0) s += pr > 1 ? 0.6 : 0.4;  // they liked it: a chance to match, so show it sooner
  if (pr < 0) s -= 0.8;                 // they passed: it can never match, so save our swipes
  if (m.recCount) s += 0.12 * Math.min(3, m.recCount); // "because you (or they) liked ..."
  if (noise) {
    const n = ctx.mine ? ctx.mine.n : 0;
    if (ctx.seed) s += 0.3 * sharedNoise(ctx.seed, m.id);
    s += gaussian(ctx.rand || Math.random) * (ctx.seed ? 0.35 : 1) * Math.max(0.12, 0.35 / Math.sqrt(1 + n / 20));
  }
  return s;
}

/* ---------- picking the next cards ---------- */

// pool: unseen candidates. recent: movies already served (newest last). ratio: share of Hollywood (0..1).
export function pickNext(pool, ctx, k, { ratio = 0.5, recent = [] } = {}) {
  const rand = ctx.rand || Math.random;
  const scored = pool.map((m) => ({ m, s: score(m, ctx) }));
  const served = recent.slice(-10);
  const picks = [];
  const used = new Set();
  for (let i = 0; i < k; i++) {
    const window = served.concat(picks.map((p) => p.m)).slice(-10);
    const hCount = window.filter((m) => group(m) === "h").length;
    const total = window.length || 1;
    const want = window.length ? (ratio - hCount / total) : ratio - 0.5; // positive => Hollywood is under-served
    let g = ratio >= 0.999 ? "h" : ratio <= 0.001 ? "b" : want > 0 || (want === 0 && ratio >= 0.5) ? "h" : "b";
    let cands = scored.filter((x) => group(x.m) === g && !used.has(x.m.id));
    if (!cands.length) cands = scored.filter((x) => !used.has(x.m.id) && (ratio > 0.001 && ratio < 0.999 || group(x.m) === g));
    if (!cands.length) break;
    const last3 = window.slice(-3);
    const baitRecent = last3.some((m) => ctx.partnerSwipes && ctx.partnerSwipes.get(m.id) > 0);
    let best = null;
    if (rand() < 0.1 && cands.length > 5) {
      // wildcard: a surprise from the better half of the pool, to find tastes you haven't revealed yet
      const top = [...cands].sort((a, b) => quality(b.m) - quality(a.m)).slice(0, 25);
      best = top[Math.floor(rand() * top.length)];
    } else {
      let bestV = -Infinity;
      for (const x of cands) {
        let v = x.s;
        const pg = x.m.genres && x.m.genres[0];
        for (const r of last3) if (pg && r.genres && r.genres[0] === pg) v -= 0.12;  // variety
        if (baitRecent && ctx.partnerSwipes.get(x.m.id) > 0) v -= 0.4;                // at most ~1 in 3 "they liked it"
        if (v > bestV) { bestV = v; best = x; }
      }
    }
    used.add(best.m.id);
    picks.push(best);
  }
  return picks.map((p) => p.m);
}

/* ---------- matches and compatibility ---------- */

// mine / theirs: Map(id -> record)
export function computeMatches(mine, theirs) {
  const out = [];
  for (const [id, a] of mine) {
    const b = theirs.get(id);
    if (!b || a.r <= 0 || b.r <= 0) continue;
    out.push({ id: Number(id), level: a.r >= 2 && b.r >= 2 ? 2 : a.r >= 2 || b.r >= 2 ? 1.5 : 1, t: Math.max(a.t || 0, b.t || 0) });
  }
  return out.sort((x, y) => y.level - x.level || y.t - x.t);
}

export function compatibility(mine, theirs) {
  let common = 0, agree = 0;
  for (const [id, a] of mine) {
    const b = theirs.get(id);
    if (!b) continue;
    common++;
    if (Math.sign(a.r) === Math.sign(b.r)) agree++;
  }
  return common < 5 ? null : { common, percent: Math.round((100 * agree) / common) };
}

// Weighted random pick for "decide for us": favours super-liked and higher-quality matches
export function weightedPick(items, weightOf, rand = Math.random) {
  const ws = items.map((x) => Math.max(0.05, weightOf(x)));
  let r = rand() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}
