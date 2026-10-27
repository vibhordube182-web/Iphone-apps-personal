import assert from "node:assert/strict";
import { test } from "node:test";
import * as T from "../taste.js";

const mk = (id, over = {}) => ({ id, lang: "en", genres: [28], year: 2015, vote: 7, votes: 2000, pop: 50, ...over });
const rng = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test("profile learns genres and ranks them", () => {
  const recs = [];
  for (let i = 0; i < 15; i++) recs.push(T.makeRecord(mk(i, { genres: [35] }), T.LIKE, i));
  for (let i = 15; i < 30; i++) recs.push(T.makeRecord(mk(i, { genres: [27] }), T.NOPE, i));
  const p = T.buildProfile(recs);
  assert.ok(T.affinity(p, mk(100, { genres: [35] })) > T.affinity(p, mk(101, { genres: [27] })));
  assert.deepEqual(T.topGenres(p, 1), ["Comedy"]);
  assert.deepEqual(T.topGenres(p, 1, -1), ["Horror"]);
});

test("a single swipe is shrunk, many swipes are trusted", () => {
  const one = T.buildProfile([T.makeRecord(mk(1, { genres: [35] }), T.LIKE, 1), T.makeRecord(mk(2), T.NOPE, 2)]);
  const many = T.buildProfile(Array.from({ length: 20 }, (_, i) => T.makeRecord(mk(i, { genres: [35] }), T.LIKE, i)).concat(
    Array.from({ length: 20 }, (_, i) => T.makeRecord(mk(50 + i), T.NOPE, 50 + i))));
  assert.ok(Math.abs(many.f.get("g35")) > Math.abs(one.f.get("g35")));
});

test("partner's like boosts, partner's nope buries", () => {
  const ctx = { mine: T.buildProfile([]), partner: null, rand: () => 0.5, partnerSwipes: new Map([[1, T.LIKE], [2, T.NOPE]]) };
  const s = (id) => T.score(mk(id), ctx, false);
  assert.ok(s(1) > s(3) && s(3) > s(2));
});

test("matches need both to like; super-both ranks first", () => {
  const rec = (r, t) => ({ r, t });
  const mine = new Map([[1, rec(1, 1)], [2, rec(2, 2)], [3, rec(-1, 3)], [4, rec(1, 4)]]);
  const theirs = new Map([[1, rec(1, 5)], [2, rec(2, 6)], [3, rec(1, 7)], [4, rec(-1, 8)], [5, rec(1, 9)]]);
  const m = T.computeMatches(mine, theirs);
  assert.deepEqual(m.map((x) => x.id), [2, 1]);
  assert.equal(m[0].level, 2);
});

test("compatibility needs enough overlap", () => {
  const a = new Map(), b = new Map();
  for (let i = 0; i < 10; i++) { a.set(i, { r: 1 }); b.set(i, { r: i < 8 ? 1 : -1 }); }
  assert.equal(T.compatibility(a, b).percent, 80);
  assert.equal(T.compatibility(new Map([[1, { r: 1 }]]), new Map([[1, { r: 1 }]])), null);
});

test("pickNext honours the Hollywood/Bollywood ratio and varies genres", () => {
  const pool = [];
  for (let i = 0; i < 200; i++) pool.push(mk(i, { lang: i % 2 ? "hi" : "en", genres: [[28, 35, 18, 27][i % 4]] }));
  const ctx = { mine: T.buildProfile([]), partner: null, rand: rng(7), partnerSwipes: new Map() };
  for (const ratio of [0.5, 0.75, 0.25, 1, 0]) {
    const picks = T.pickNext(pool, ctx, 40, { ratio });
    const h = picks.filter((m) => m.lang === "en").length / picks.length;
    assert.ok(Math.abs(h - ratio) < 0.12, `ratio ${ratio} got ${h}`);
    assert.equal(new Set(picks.map((p) => p.id)).size, picks.length);
  }
  const g = T.pickNext(pool, ctx, 12, { ratio: 0.5 }).map((m) => m.genres[0]);
  assert.ok(new Set(g).size >= 3);
});

test("deck follows learned taste", () => {
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push(T.makeRecord(mk(i, { genres: [878] }), T.LIKE, i));
  for (let i = 30; i < 60; i++) recs.push(T.makeRecord(mk(i, { genres: [10749] }), T.NOPE, i));
  const ctx = { mine: T.buildProfile(recs), partner: null, rand: rng(3), partnerSwipes: new Map() };
  const pool = [];
  for (let i = 0; i < 100; i++) pool.push(mk(1000 + i, { genres: [i % 2 ? 878 : 10749] }));
  const picks = T.pickNext(pool, ctx, 20, { ratio: 1 });
  assert.ok(picks.filter((m) => m.genres[0] === 878).length >= 14);
});

test("two people with the same seed and empty profiles see mostly the same first cards", () => {
  const pool = Array.from({ length: 80 }, (_, i) => mk(i, { genres: [[28, 35, 18, 27][i % 4]], lang: i % 2 ? "hi" : "en", vote: 5 + (i % 40) / 10, pop: 10 + (i * 7) % 90 }));
  const top = (seed) => new Set(T.pickNext(pool, { mine: T.buildProfile([]), partner: null, rand: rng(seed), seed: "room1", partnerSwipes: new Map() }, 12, { ratio: 0.5 }).map((m) => m.id));
  const a = top(11), b = top(99);
  assert.ok([...a].filter((x) => b.has(x)).length >= 6, "overlap " + [...a].filter((x) => b.has(x)).length);
});
