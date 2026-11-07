#!/usr/bin/env python3
"""Fetch RSS/Atom feeds and write web/news.json (the morning edition)."""
import html, json, re, ssl, sys, time, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

GN = "https://news.google.com/rss/search?hl=en-AU&gl=AU&ceid=AU:en&q="
BANDS = "%22Led+Zeppelin%22+OR+%22Foo+Fighters%22+OR+%22Red+Hot+Chili+Peppers%22+OR+%22Tool%22+band+OR+%22System+of+a+Down%22+OR+Beatles+OR+%22Elton+John%22+OR+%22Elvis%22"
MUSK = "SpaceX+OR+Tesla+OR+xAI+OR+Neuralink+OR+Starlink+OR+%22The+Boring+Company%22"
BRYAN = "%22Bryan+Johnson%22+OR+%22Blueprint%22+longevity"

# (realm, group, how many stories the group contributes), in display order.
GROUPS = [
    ("polis", "polis", 3),
    ("oikos", "australia", 2),
    ("oikos", "india", 2),
    ("techne", "techne", 2),
    ("kosmos", "kosmos", 2),
    ("oikonomia", "economy", 2),
    ("arete", "arete", 2),
    ("sophia", "sophia", 1),
    ("schole", "music", 2),
    ("schole", "football", 1),
    ("schole", "youtube", 1),
]

# (group, source name, url). A source name of "*" takes the publisher from the item (Google News).
FEEDS = [
    ("polis", "BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("polis", "The Guardian", "https://www.theguardian.com/world/rss"),
    ("polis", "Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
    ("polis", "DW", "https://rss.dw.com/xml/rss-en-all"),
    ("australia", "ABC News", "https://www.abc.net.au/news/feed/51120/rss.xml"),
    ("australia", "The Guardian", "https://www.theguardian.com/australia-news/rss"),
    ("australia", "The Age", "https://www.theage.com.au/rss/feed.xml"),
    ("india", "The Hindu", "https://www.thehindu.com/news/national/feeder/default.rss"),
    ("india", "Times of India", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"),
    ("india", "Indian Express", "https://indianexpress.com/section/india/feed/"),
    ("techne", "BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml"),
    ("techne", "Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    ("techne", "The Verge", "https://www.theverge.com/rss/index.xml"),
    ("techne", "TechCrunch", "https://techcrunch.com/feed/"),
    ("kosmos", "SpaceNews", "https://spacenews.com/feed/"),
    ("kosmos", "Electrek", "https://electrek.co/feed/"),
    ("kosmos", "*", GN + MUSK),
    ("economy", "BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("economy", "The Guardian", "https://www.theguardian.com/business/rss"),
    ("arete", "*", GN + BRYAN),
    ("arete", "Fight Aging!", "https://www.fightaging.org/feed/"),
    ("sophia", "Aeon", "https://aeon.co/feed.rss"),
    ("sophia", "Daily Stoic", "https://dailystoic.com/feed/"),
    ("sophia", "Farnam Street", "https://fs.blog/feed/"),
    ("music", "Louder", "https://www.loudersound.com/feeds/all"),
    ("music", "Ultimate Classic Rock", "https://ultimateclassicrock.com/feed/"),
    ("music", "*", GN + BANDS),
    ("football", "BBC Football", "https://feeds.bbci.co.uk/sport/football/rss.xml"),
    ("football", "The Guardian", "https://www.theguardian.com/football/rss"),
    ("youtube", "PewDiePie", "https://www.youtube.com/feeds/videos.xml?channel_id=UC-lHJZR3Gqxm24_Vd_AJ5Yw"),
]

# ---- The Odeon: music, comedy and nights out, tuned to taste ----
# Edit these lists to retune it. Feeds that fail or move are skipped quietly.
FAVOURITES = ["Led Zeppelin", "Foo Fighters", "Red Hot Chili Peppers", "System of a Down", "The Beatles", "Beatles",
              "Elvis", "Elton John", "Tool"]
RELATED = ["Pearl Jam", "Metallica", "AC/DC", "Queens of the Stone Age", "Pink Floyd", "Rolling Stones", "Nirvana",
           "Green Day", "Rage Against the Machine", "Black Sabbath", "Deep Purple", "Guns N' Roses", "Soundgarden",
           "Audioslave", "Paul McCartney", "Robert Plant", "Jimmy Page", "Dave Grohl", "Serj Tankian", "Anthony Kiedis"]
GIG_WORDS = r"\b(tour|tours|concert|tickets?|on sale|gig|gigs|live|festival|headline[sd]?|announces?|australian|australia|melbourne|stadium|residency)\b"

FAV_Q = ("%22Led+Zeppelin%22+OR+%22Foo+Fighters%22+OR+%22Red+Hot+Chili+Peppers%22+OR+%22System+of+a+Down%22"
         "+OR+%22Elton+John%22+OR+%22Paul+McCartney%22+OR+%22Tool%22+band+OR+Beatles")
ODEON_FEEDS = [
    ("radar", "*", GN + "(" + FAV_Q + ")+(tour+OR+concert+OR+tickets+OR+%22live+in%22)+Australia"),
    ("radar", "*", GN + "(" + FAV_Q + ")+(tour+OR+concert+OR+tickets)"),
    ("radar", "Louder", "https://www.loudersound.com/feeds/all"),
    ("radar", "Ultimate Classic Rock", "https://ultimateclassicrock.com/feed/"),
    ("music", "Beat", "https://beat.com.au/feed/"),
    ("music", "The Music", "https://themusic.com.au/rss"),
    ("music", "*", GN + "Melbourne+(gig+OR+concert+OR+%22live+music%22+OR+tour)+rock"),
    ("music", "*", GN + "Australian+tour+announced+rock+OR+metal+OR+%22classic+rock%22"),
    ("comedy", "The Guardian", "https://www.theguardian.com/stage/comedy/rss"),
    ("comedy", "*", GN + "(%22stand-up%22+OR+comedian)+(Melbourne+OR+Australia)+(tour+OR+show+OR+tickets)"),
    ("comedy", "*", GN + "%22Melbourne+International+Comedy+Festival%22"),
    ("out", "*", GN + "Melbourne+(festival+OR+%22this+weekend%22+OR+%22night+market%22+OR+event)"),
    ("out", "*", GN + "Melbourne+(MCG+OR+%22Marvel+Stadium%22+OR+%22AAMI+Park%22)+(match+OR+tickets+OR+tour)"),
    ("out", "*", GN + "Melbourne+(startup+OR+tech)+(event+OR+conference+OR+summit)"),
]
ODEON_LIMITS = {"radar": 4, "music": 6, "comedy": 5, "out": 5}

CITIES = [("Melbourne", -37.81, 144.96), ("Mumbai", 19.08, 72.88)]
WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
       51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
       61: "Rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
       71: "Snow", 73: "Snow", 75: "Heavy snow", 77: "Snow", 80: "Showers", 81: "Showers",
       82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm",
       96: "Thunderstorm", 99: "Thunderstorm"}


def clean(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def brief(text, limit=230):
    if len(text) <= limit:
        return text
    head = text[:limit]
    i = head.rfind(". ")
    if i > limit // 2:
        return head[: i + 1]
    return head[: head.rfind(" ")] + "…"


def parse_date(s):
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def pick_image(el, raw_html):
    """Largest image advertised by the item (media:thumbnail/content, enclosure) or its first <img>."""
    best, best_w = None, -1
    for c in el.iter():
        tag = c.tag.split("}")[-1]
        url = c.get("url") if tag in ("thumbnail", "content", "enclosure") else None
        if not url:
            continue
        if tag in ("content", "enclosure"):
            kind = c.get("type") or c.get("medium") or ""
            if not kind.startswith("image") and not re.search(r"\.(jpe?g|png|webp)(\?|$)", url, re.I):
                continue
        try:
            w = int(c.get("width") or 0)
        except ValueError:
            w = 0
        if url.startswith("http") and (w == 0 or w >= 100) and w > best_w:
            best, best_w = url, w
    if not best:
        m = re.search(r"<img[^>]+src=[\"']([^\"']+)", raw_html or "")
        if m and m.group(1).startswith("http"):
            best = html.unescape(m.group(1))
    return best


def fetch(feed):
    group, name, url = feed
    req = urllib.request.Request(url, headers={"User-Agent": "Lyceum/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            root = ET.fromstring(r.read())
    except Exception as e:
        print(f"skip {name} ({url}): {e}", file=sys.stderr)
        return []
    out = []
    for el in root.iter():
        if el.tag.split("}")[-1] not in ("item", "entry"):
            continue
        f = {}
        for c in el:
            tag = c.tag.split("}")[-1]
            if tag == "link":
                href = c.get("href")
                if href and c.get("rel") in (None, "alternate"):
                    f["link"] = href
                elif c.text and c.text.strip():
                    f["link"] = c.text.strip()
            elif tag in ("title", "description", "summary", "content") and tag not in f:
                f[tag] = c.text or ""
                if tag != "title":
                    f["raw"] = f.get("raw", "") + (c.text or "")
            elif tag == "source" and c.text and c.text.strip():
                f["publisher"] = c.text.strip()
            elif tag in ("pubDate", "published", "updated", "date") and "date" not in f:
                f["date"] = parse_date((c.text or "").strip())
        title = clean(f.get("title"))
        source = name
        if name == "*":
            source = f.get("publisher") or "Google News"
            if title.endswith(" - " + source):
                title = title[: -len(source) - 3]
        link = f.get("link", "")
        if not title or not link.startswith("http"):
            continue
        summary = brief(clean(f.get("description") or f.get("summary") or f.get("content")))
        if len(summary) < 30 or summary.lower().startswith(title.lower()):
            summary = ""
        d = f.get("date") or datetime.now(timezone.utc)
        image = pick_image(el, f.get("raw"))
        alt = None
        if image:
            image = image.replace("http://", "https://", 1)
            if "ichef.bbci.co.uk" in image and re.search(r"/(standard|news)/\d+/", image):
                alt, image = image, re.sub(r"/(standard|news)/\d+/", r"/\1/800/", image)
        out.append({"group": group, "source": source, "title": title, "summary": summary,
                    "link": link, "date": d, "image": image, "image_alt": alt})
    out.sort(key=lambda s: s["date"], reverse=True)
    return out


def tokens(t):
    return {w for w in re.split(r"[^a-z0-9]+", t.lower()) if len(w) > 2}


def taste(item):
    """(score, artist) for an item: 3 per favourite artist named, 1 per related one, plus a nudge for gig words."""
    text = item["title"] + " " + item["summary"]
    score, artist = 0, ""
    for name in FAVOURITES:
        pat = r"\b" + re.escape(name) + r"\b"
        if name == "Tool":
            # a very common word: only count the band, in a music context
            if re.search(pat, text) and re.search(r"(?i)\b(band|tour|album|maynard|concert|tickets|live)\b", text):
                score, artist = score + 3, artist or name
        elif re.search(pat, text, re.I):
            score, artist = score + 3, artist or ("The Beatles" if name == "Beatles" else name)
    for name in RELATED:
        if re.search(r"\b" + re.escape(name) + r"\b", text, re.I):
            score += 1
            artist = artist or name
    if re.search(GIG_WORDS, text, re.I):
        score += 1
    return score, artist


def build_odeon(results, taken_links):
    """Pick the Odeon rows from fetched items: {radar, music, comedy, out}. Never raises."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    by_group = {}
    for feed, items in zip(ODEON_FEEDS, results):
        by_group.setdefault(feed[0], []).extend(items)
    used, seen_words, out = set(taken_links), [], {}

    def take(items, limit, key, min_score=0):
        fresh = [i for i in items if i["date"] > cutoff]
        pool = fresh if len(fresh) >= limit else items
        scored = []
        for i in pool:
            sc, artist = taste(i)
            if sc >= min_score and i["link"] not in used:
                scored.append((key(sc, i), i, artist))
        scored.sort(key=lambda t: t[0], reverse=True)
        picked = []
        for _, i, artist in scored:
            words = tokens(i["title"])
            if any(len(words & o) / max(1, len(words | o)) > 0.5 for o in seen_words):
                continue
            seen_words.append(words)
            used.add(i["link"])
            i = dict(i, tag=artist)
            i.pop("group", None)
            i["date"] = i["date"].astimezone(timezone.utc).isoformat()
            picked.append(i)
            if len(picked) >= limit:
                break
        return picked

    # newest first, taste as a boost; the radar needs a favourite artist actually named
    recency = lambda sc, i: sc * 3 + (i["date"] - cutoff).total_seconds() / 86400.0
    out["radar"] = take(by_group.get("radar", []) + by_group.get("music", []), ODEON_LIMITS["radar"], recency, 3)
    for k in ("music", "comedy", "out"):
        out[k] = take(by_group.get(k, []), ODEON_LIMITS[k], recency)
    return out


def weather():
    out = []
    for city, lat, lon in CITIES:
        url = ("https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
               "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1" % (lat, lon))
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                d = json.load(r)["daily"]
            out.append({"city": city, "hi": round(d["temperature_2m_max"][0]), "lo": round(d["temperature_2m_min"][0]),
                        "desc": WMO.get(d["weather_code"][0], "")})
        except Exception as e:
            print(f"skip weather {city}: {e}", file=sys.stderr)
    return out


def main():
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(fetch, FEEDS))
        odeon_results = list(ex.map(fetch, ODEON_FEEDS))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
    stories, seen = [], []
    for realm, group, limit in GROUPS:
        queues = [r for f, r in zip(FEEDS, results) if f[0] == group]
        fresh = [[s for s in q if s["date"] > cutoff] for q in queues]
        if sum(map(len, fresh)) >= limit:
            queues = fresh
        picked = turn = 0
        while picked < limit and any(queues):
            q = queues[turn % len(queues)]
            turn += 1
            if not q:
                continue
            cand = q.pop(0)
            words = tokens(cand["title"])
            if any(len(words & o) / max(1, len(words | o)) > 0.5 for o in seen):
                continue
            seen.append(words)
            cand["realm"] = realm
            cand.pop("group", None)
            stories.append(cand)
            picked += 1
    if not stories:
        sys.exit("no stories fetched; keeping previous edition")
    try:
        odeon = build_odeon(odeon_results, {x["link"] for x in stories})
    except Exception as e:
        print(f"skip odeon: {e}", file=sys.stderr)
        odeon = {}
    for s in stories:
        s["date"] = s["date"].astimezone(timezone.utc).isoformat()
    Path("web/news.json").write_text(json.dumps(
        {"generated": datetime.now(timezone.utc).isoformat(), "stories": stories, "odeon": odeon, "weather": weather(),
         "maxims": json.loads(Path("web/maxims.json").read_text()),
         "reading": json.loads(Path("web/readings/index.json" if Path("web/readings/index.json").exists()
                                   else "web/reading.json").read_text())},
        ensure_ascii=False, indent=1))
    print(f"wrote {len(stories)} stories; odeon " + ", ".join(f"{k} {len(v)}" for k, v in odeon.items()))


if __name__ == "__main__":
    main()
