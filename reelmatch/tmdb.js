// TMDB client: discovery queries, movie details (cast, trailer, Australian streaming providers).
// Streaming data comes from JustWatch via TMDB, so the app shows their attribution.

const API = "https://api.themoviedb.org/3";
export const IMG = "https://image.tmdb.org/t/p/";
export const REGION = "AU";

export const poster = (p, size = "w780") => (p ? IMG + size + p : "");
export const profilePic = (p) => (p ? IMG + "w185" + p : "");
export const logo = (p) => (p ? IMG + "w92" + p : "");

const year = (d) => (d ? Number(String(d).slice(0, 4)) || 0 : 0);

export function fromList(r) {
  return {
    id: r.id, title: r.title || r.original_title, year: year(r.release_date), date: r.release_date || "",
    lang: r.original_language, genres: r.genre_ids || [], vote: r.vote_average || 0, votes: r.vote_count || 0,
    pop: r.popularity || 0, poster: r.poster_path, backdrop: r.backdrop_path, overview: r.overview || "",
  };
}

export function fromDetails(d) {
  const cast = ((d.credits && d.credits.cast) || []).slice(0, 12).map((c) => ({ id: c.id, name: c.name, character: c.character, photo: c.profile_path }));
  const dir = ((d.credits && d.credits.crew) || []).find((c) => c.job === "Director");
  const wp = d["watch/providers"] && d["watch/providers"].results && d["watch/providers"].results[REGION];
  const prov = (list) => (list || []).map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path }));
  const vids = ((d.videos && d.videos.results) || []).filter((v) => v.site === "YouTube");
  const trailer = vids.find((v) => v.type === "Trailer" && v.official) || vids.find((v) => v.type === "Trailer") || vids[0];
  return {
    ...fromList({ ...d, genre_ids: (d.genres || []).map((g) => g.id) }),
    runtime: d.runtime || 0, tagline: d.tagline || "", cast, director: dir ? dir.id : 0, directorName: dir ? dir.name : "",
    providers: wp ? { link: wp.link, flatrate: prov(wp.flatrate), free: prov(wp.free), ads: prov(wp.ads), rent: prov(wp.rent), buy: prov(wp.buy) }
      : { link: "", flatrate: [], free: [], ads: [], rent: [], buy: [] },
    trailer: trailer ? trailer.key : "", imdb: d.imdb_id || "", detailsAt: Date.now(),
  };
}

// Streamable = subscription, free or ad-supported (not rent/buy)
export const streamers = (m) => {
  const p = m.providers;
  if (!p) return [];
  const seen = new Set(), out = [];
  for (const x of [...p.flatrate, ...p.free, ...p.ads]) if (!seen.has(x.id)) { seen.add(x.id); out.push(x); }
  return out;
};

/* Discovery sources. Both phones walk the SAME ordered list, so they build overlapping pools and can match. */
const SOURCES = [
  { sort: "popularity.desc" },
  { sort: "vote_average.desc", mult: 4 },
  { sort: "popularity.desc", recent: true, mult: 0.34 },
  { sort: "popularity.desc", from: "2000-01-01", to: "2019-12-31" },
  { sort: "popularity.desc", genres: "28|12|53" },
  { sort: "popularity.desc", genres: "35|10749" },
  { sort: "popularity.desc", genres: "18|36|80" },
  { sort: "popularity.desc", genres: "878|14|16" },
  { sort: "popularity.desc", genres: "27|9648" },
  { sort: "vote_average.desc", mult: 4, to: "1999-12-31" },
];
const LANGS = [{ lang: "en", votes: 300 }, { lang: "hi", votes: 40 }];

export function sourceParams(i, lang, opts = {}) {
  const s = SOURCES[i % SOURCES.length];
  const L = LANGS.find((x) => x.lang === lang);
  const today = new Date();
  const p = {
    sort_by: s.sort, page: Math.floor(i / SOURCES.length) + 1, with_original_language: lang, include_adult: "false",
    "vote_count.gte": Math.round(L.votes * (s.mult || 1)), without_genres: "99|10770", watch_region: REGION, region: REGION,
    "primary_release_date.lte": s.to || today.toISOString().slice(0, 10),
  };
  if (s.recent) p["primary_release_date.gte"] = new Date(today.getFullYear() - 3, today.getMonth(), 1).toISOString().slice(0, 10);
  else if (s.from) p["primary_release_date.gte"] = s.from;
  if (s.genres) p.with_genres = s.genres;
  if (opts.onlyStreaming) {
    p.with_watch_monetization_types = "flatrate|free|ads";
    if (opts.services && opts.services.length) p.with_watch_providers = opts.services.join("|");
  }
  return p;
}

export class TMDB {
  constructor(key) { this.key = (key || "").trim(); }

  async get(path, params = {}) {
    const url = new URL(API + path);
    const headers = {};
    if (this.key.startsWith("eyJ")) headers.Authorization = "Bearer " + this.key; else url.searchParams.set("api_key", this.key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    let r;
    try { r = await fetch(url, { headers, signal: ctl.signal }); }
    catch (e) { throw new Error(e.name === "AbortError" ? "TMDB timed out" : "Network error"); }
    finally { clearTimeout(timer); }
    if (r.status === 401) throw new Error("TMDB rejected the API key. Check it in Settings.");
    if (!r.ok) throw new Error("TMDB error " + r.status);
    return r.json();
  }

  async source(i, opts) {
    const res = await Promise.all(LANGS.map((L) => this.get("/discover/movie", { language: "en-AU", ...sourceParams(i, L.lang, opts) }).catch((e) => { if (/API key/.test(e.message)) throw e; return { results: [] }; })));
    return res.flatMap((r) => r.results.map(fromList)).filter((m) => m.poster && m.overview && m.title);
  }

  async details(id) {
    const d = await this.get("/movie/" + id, { language: "en-AU", append_to_response: "credits,watch/providers,videos", include_video_language: "en,hi,null" });
    return fromDetails(d);
  }

  async recommendations(id) {
    const r = await this.get(`/movie/${id}/recommendations`, { language: "en-AU", page: 1 });
    return r.results.map(fromList).filter((m) => m.poster && m.overview && (m.lang === "en" || m.lang === "hi") && m.votes >= (m.lang === "hi" ? 25 : 150));
  }

  async providers() {
    const r = await this.get("/watch/providers/movie", { watch_region: REGION, language: "en-AU" });
    return (r.results || []).filter((p) => p.display_priorities && p.display_priorities[REGION] <= 40)
      .sort((a, b) => a.display_priorities[REGION] - b.display_priorities[REGION])
      .map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path }));
  }
}
