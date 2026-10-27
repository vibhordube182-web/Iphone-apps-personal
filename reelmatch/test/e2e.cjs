// End-to-end test: two phones (two browser contexts) against ./server.js, with TMDB mocked.
// Run:  NODE_PATH=$(npm root -g) node test/e2e.cjs   (needs playwright)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const PORT = 8123, BASE = `http://localhost:${PORT}/`;
const GEN = [28, 12, 35, 18, 27, 878, 10749, 53];
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const movie = (id) => { const hi = id % 2 === 1; return { id, title: `${hi ? "Bolly" : "Holly"} Movie ${id}`, original_title: "x", release_date: `${2000 + (id % 24)}-05-01`, original_language: hi ? "hi" : "en", genre_ids: [GEN[id % 8], GEN[(id + 3) % 8]], vote_average: 5 + (id % 40) / 10, vote_count: 900, popularity: 40 + (id % 50), poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`, overview: `Synopsis for movie ${id}. A long enough story to read.` }; };
async function mockTmdb(ctx) {
  await ctx.route('https://reelmatch-687be-default-rtdb.firebaseio.com/**', async (r) => { const u = new URL(r.request().url()); const resp = await r.fetch({ url: BASE + 'db' + u.pathname + u.search }); await r.fulfill({ response: resp }); });
  await ctx.route("https://image.tmdb.org/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#${(hash(r.request().url()) & 0xffffff).toString(16).padStart(6, "0")}"/></svg>` }));
  await ctx.route("https://api.themoviedb.org/3/**", (r) => {
    const u = new URL(r.request().url()), p = u.pathname.replace("/3", ""), q = u.searchParams;
    const json = (o) => r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(o) });
    if (q.get("api_key") !== "testkey") return r.fulfill({ status: 401, headers: { "access-control-allow-origin": "*" }, body: "{}" });
    if (p === "/discover/movie") { const base = hash(q.get("sort_by") + q.get("with_genres") + q.get("page") + (q.get("primary_release_date.gte") || "")) % 40 * 100; const hi = q.get("with_original_language") === "hi"; return json({ results: Array.from({ length: 20 }, (_, k) => movie(base + k * 2 + (hi ? 1 : 0) + 2)) }); }
    let m = p.match(/^\/movie\/(\d+)\/recommendations/); if (m) return json({ results: [1, 2, 3].map((k) => movie(Number(m[1]) + k * 2)) });
    m = p.match(/^\/movie\/(\d+)$/); if (m) { const id = Number(m[1]), b = movie(id); return json({ ...b, genres: b.genre_ids.map((g) => ({ id: g })), runtime: 100 + (id % 60), tagline: "Tagline " + id, imdb_id: "tt" + id, credits: { cast: Array.from({ length: 6 }, (_, i) => ({ id: id * 10 + i % 3, name: `Actor ${id % 7}-${i}`, character: "Role " + i })), crew: [{ job: "Director", id: id % 5, name: "Dir " + (id % 5) }] }, videos: { results: [{ site: "YouTube", type: "Trailer", key: "abc" }] }, "watch/providers": { results: { AU: { link: "https://justwatch/x", flatrate: id % 3 ? [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.jpg" }] : [{ provider_id: 21, provider_name: "Stan", logo_path: "/s.jpg" }], rent: [{ provider_id: 2, provider_name: "Apple TV", logo_path: "/a.jpg" }] } } } }); }
    if (p === "/watch/providers/movie") return json({ results: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.jpg", display_priorities: { AU: 1 } }, { provider_id: 21, provider_name: "Stan", logo_path: "/s.jpg", display_priorities: { AU: 2 } }] });
    json({ results: [] });
  });
}
const clear = async (p) => { for (let i = 0; i < 3; i++) { await p.evaluate(() => document.querySelector('.pop [data-a=k]')?.click()); await p.waitForTimeout(250); } };
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("ok  -", m); };
(async () => {
  const srv = spawn("node", [path.join(__dirname, "../server.js"), PORT], { env: { ...process.env, RM_DATA: "/tmp/rm-e2e.json" } });
  require("fs").rmSync("/tmp/rm-e2e.json", { force: true });
  await new Promise((r) => setTimeout(r, 600));
  const b = await chromium.launch();
  const mk = async () => { const c = await b.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true }); await mockTmdb(c); return [c, await c.newPage()]; };
  const [c1, a] = await mk(), [c2, g] = await mk();
  const errs = []; for (const p of [a, g]) { p.on("pageerror", (e) => { errs.push(e.message); console.log('PAGEERR', e.message); }); p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text())); }
  try {
    await a.goto(BASE);
    await a.fill("#f-name", "Vibhor"); await a.fill("#f-key", "testkey"); assert(await a.locator("#f-key").isVisible(), "key field shown only when starting a new room");
    await a.click("#f-go", { timeout: 4000 }).catch((e) => console.log("CLICKERR", e.message.slice(0, 100)));
    await a.waitForSelector('.card[data-pos="0"]', { timeout: 8000 }).catch(async (e) => { console.log('BODY', await a.evaluate(() => document.body.innerText.slice(0, 300)), errs); throw e; });
    assert(await a.locator(".card").count() === 3, "three cards stacked");
    assert((await a.textContent('.card[data-pos="0"] h2')).includes("Movie"), "card shows a title");
    await a.waitForSelector('.card[data-pos="0"] .cast');
    assert((await a.textContent('.card[data-pos="0"] .prov')).match(/Stream/), "AU streaming shown on card");
    await a.click("#b-undo"); // nothing to undo
    await a.$eval('[data-tab=\"us\"]', (e) => e.click()); await a.click("#invite").catch(() => {});
    const code = await a.evaluate(() => JSON.parse(localStorage.getItem("rm_cfg")).code);
    await a.$eval('[data-tab=\"swipe\"]', (e) => e.click());
    await g.goto(BASE + "#r=" + code); await g.waitForSelector("#f-name"); assert(!(await g.locator("#f-key").isVisible()), "joiner is not asked for a key"); await g.fill("#f-name", "Partner"); await g.click("#f-go");
    await g.waitForSelector('.card[data-pos="0"]');
    // both swipe: Vibhor likes everything, Partner likes everything -> pools overlap -> matches
    const swipe = async (p, n, btn) => { for (let i = 0; i < n; i++) { await p.evaluate(() => document.querySelector('.pop [data-a=k]')?.click()); await p.waitForSelector('.card[data-pos="0"]:not(.fly)'); await p.$eval(btn, (e) => e.click()); await p.waitForTimeout(330); } };
    await swipe(a, 8, "#b-like"); await swipe(g, 8, "#b-like");
    await a.waitForTimeout(500);
    const nA = await a.evaluate(() => JSON.parse(localStorage.getItem("rm_swipes_" + JSON.parse(localStorage.getItem("rm_cfg")).code)).length);
    assert(nA === 8, "swipes stored locally");
    await a.waitForSelector("#partnerStatus:has-text('Partner')"); await a.waitForTimeout(5000);
    const stat = await a.textContent("#partnerStatus"); assert(/Partner · 8/.test(stat), "partner progress synced: " + stat.trim());
    // a match must exist because both liked the first deck cards (same pool, same ordering signal)
    const popup = await Promise.race([a.waitForSelector(".pop", { timeout: 6000 }).then(() => true), g.waitForSelector(".pop", { timeout: 6000 }).then(() => true)]).catch(() => false);
    assert(popup, "match popup appeared on a phone");
    for (const p of [a, g]) await p.evaluate(() => document.querySelector(".pop [data-a=m]")?.click());
    await clear(g); await g.$eval('[data-tab=\"matches\"]', (e) => e.click()); await g.waitForSelector(".row");
    const rows = await g.locator(".row").count(); assert(rows >= 1, `matches list shows ${rows} matches`);
    await g.waitForSelector(".row .pv img"); assert(true, "match rows show streaming service");
    await g.click(".row"); await g.waitForSelector(".sheet .cast-s .cm"); assert((await g.textContent(".sheet")).includes("Where to watch in Australia"), "detail sheet with providers and cast");
    await g.click(".sheet [data-a=w]"); await g.waitForTimeout(200); await g.click(".sheet .x"); await g.waitForTimeout(300);
    assert((await g.locator("#v-matches .row").count()) === rows - 1, "marking a match as watched moves it out of Matches");
    await g.$eval('[data-tab="watched"]', (e) => e.click()); await g.waitForSelector("#v-watched .row[data-id]");
    assert((await g.locator("#v-watched .row[data-id]").count()) === 1, "...and into Watched together");
    await g.$eval('[data-tab="matches"]', (e) => e.click());
    await g.click("#pick"); await g.waitForSelector(".pop .btn", { timeout: 6000 }); assert(true, "pick-for-us lands on a movie");
    await g.waitForTimeout(900); await g.screenshot({ path: "/tmp/rm-pick.png" });
    await g.$eval(".pop [data-a=i]", (e) => e.click()); await g.waitForTimeout(600);
    assert(await g.locator(".sheet").isVisible(), "Details from the pick screen stays open");
    await g.click(".sheet .x"); await g.waitForTimeout(300);
    await g.waitForTimeout(900); await g.screenshot({ path: "/tmp/rm-pick.png" }); await g.evaluate(() => document.querySelector(".pop [data-a=d]")?.click());
    for (let i = 0; i < 4; i++) await a.evaluate(() => document.querySelector(".pop [data-a=k]")?.click());
    await a.$eval('[data-tab=\"swipe\"]', (e) => e.click()); await a.screenshot({ path: "/tmp/rm-swipe.png" });
    await clear(a); await a.$eval('[data-tab=\"matches\"]', (e) => e.click()); await a.waitForSelector(".row"); await a.screenshot({ path: "/tmp/rm-matches.png" });
    await clear(a); await a.$eval('[data-tab=\"us\"]', (e) => e.click()); await a.screenshot({ path: "/tmp/rm-us.png" });
    await clear(a); await a.$eval('[data-tab=\"likes\"]', (e) => e.click()); await a.waitForSelector("#v-likes .row");
    const nl = await a.locator("#v-likes .row").count(); assert(nl >= 8, `My likes lists ${nl} liked movies`);
    await a.waitForSelector("#v-likes .row .pv img"); assert(true, "likes rows show streaming logos");
    await a.click("#v-likes .row"); await a.waitForSelector(".sheet [data-a=rm]"); await a.click(".sheet [data-a=rm]"); await a.waitForTimeout(400);
    assert((await a.locator("#v-likes .row").count()) === nl - 1, "remove from likes works");
    await a.screenshot({ path: "/tmp/rm-likes.png" });
    // re-adding the app with the same name merges into the same person instead of making a duplicate
    const [c3, h] = await mk(); await h.goto(BASE + "#r=" + code); await h.fill("#f-name", "vibhor"); await h.click("#f-go");
    await h.waitForSelector('.card[data-pos="0"]'); await h.waitForTimeout(6000);
    const mem = await a.evaluate(async (c) => Object.values((await (await fetch("https://reelmatch-687be-default-rtdb.firebaseio.com/rooms/" + c + "/members.json")).json()) || {}).map((m) => m.name).sort(), code);
    assert(mem.length === 2 && mem.includes("Partner"), "same name merges: members are " + mem.join(","));
    const counts = await a.evaluate(async (c) => Object.values((await (await fetch("https://reelmatch-687be-default-rtdb.firebaseio.com/rooms/" + c + "/swipes.json")).json()) || {}).map((o) => Object.keys(o).length).sort((x, y) => y - x), code);
    assert(counts.length === 2 && counts[0] >= 8, "no swipes lost on the server after the merge: " + counts.join(","));
    await clear(h); await h.$eval('[data-tab=\"likes\"]', (e) => e.click()); await h.waitForTimeout(500);
    assert((await h.locator("#v-likes .row").count()) >= 1, "re-added install gets the old swipes back");
    await c3.close();
    await clear(a); await a.$eval('[data-tab="swipe"]', (e) => e.click()); await a.waitForSelector('.card[data-pos="0"]:not(.fly)');
    const seenId = await a.getAttribute('.card[data-pos="0"]', "data-id");
    await a.$eval("#b-seen", (e) => e.click()); await a.waitForTimeout(500);
    await a.$eval('[data-tab="watched"]', (e) => e.click()); await a.waitForSelector(`#v-watched .row[data-id="${seenId}"]`);
    assert(true, "swiping down marks a movie as already watched"); await a.screenshot({ path: "/tmp/rm-watched.png" });
    await g.waitForTimeout(5000); await clear(g); await g.$eval('[data-tab="watched"]', (e) => e.click());
    await g.waitForSelector(`#v-watched .row[data-id="${seenId}"]`); assert(true, "partner sees it under Watched together too");
    assert(!(await g.evaluate((id) => [...document.querySelectorAll(".card")].some((c) => c.dataset.id === id), seenId)), "watched movie is out of the partner's deck");
    assert(/user-scalable=no/.test(await a.evaluate(() => document.querySelector("meta[name=viewport]").content)), "zoom is disabled");
    // drag gesture
    await clear(a); await a.$eval('[data-tab=\"swipe\"]', (e) => e.click()); await a.waitForSelector('.card[data-pos="0"]:not(.fly)');
    const box = await a.locator('.card[data-pos="0"]').boundingBox(); const id0 = await a.getAttribute('.card[data-pos="0"]', "data-id");
    await a.mouse.move(box.x + box.width / 2, box.y + 300); await a.mouse.down(); await a.mouse.move(box.x + box.width / 2 - 200, box.y + 320, { steps: 6 }); await a.mouse.up(); await a.waitForTimeout(600);
    const rec = await a.evaluate((id) => JSON.parse(localStorage.getItem("rm_swipes_" + JSON.parse(localStorage.getItem("rm_cfg")).code)).find(([k]) => k == id), id0);
    assert(rec && rec[1].r === -1, "drag left records a nope");
    await a.click("#b-undo"); await a.waitForTimeout(300); assert((await a.getAttribute('.card[data-pos="0"]', "data-id")) === id0, "undo brings the card back");
    assert(errs.length === 0, "no console errors " + errs.join(" | "));
  } catch (e) { console.log("page errors:", errs); try { console.log("G BODY", await g.evaluate(() => document.body.innerText.slice(0, 300))); } catch (_) {} throw e; } finally { await b.close(); srv.kill(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
