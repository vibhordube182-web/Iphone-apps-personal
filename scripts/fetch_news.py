#!/usr/bin/env python3
"""Fetch RSS/Atom feeds and write web/news.json (the morning edition)."""
import html, json, re, ssl, sys, time, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

FEEDS = [
    ("polis", "BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("polis", "The Guardian", "https://www.theguardian.com/world/rss"),
    ("polis", "Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
    ("polis", "DW", "https://rss.dw.com/xml/rss-en-all"),
    ("techne", "BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml"),
    ("techne", "Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    ("techne", "The Verge", "https://www.theverge.com/rss/index.xml"),
    ("techne", "The Guardian", "https://www.theguardian.com/technology/rss"),
    ("agora", "BBC News", "https://feeds.bbci.co.uk/news/rss.xml"),
    ("agora", "NPR", "https://feeds.npr.org/1001/rss.xml"),
    ("agora", "The Guardian", "https://www.theguardian.com/uk-news/rss"),
    ("oikonomia", "BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("oikonomia", "The Guardian", "https://www.theguardian.com/business/rss"),
    ("sophia", "Aeon", "https://aeon.co/feed.rss"),
]
LIMITS = {"polis": 4, "techne": 3, "agora": 3, "oikonomia": 2, "sophia": 1}


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


def fetch(feed):
    realm, name, url = feed
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
            elif tag in ("pubDate", "published", "updated", "date") and "date" not in f:
                f["date"] = parse_date((c.text or "").strip())
        title = clean(f.get("title"))
        link = f.get("link", "")
        if not title or not link.startswith("http"):
            continue
        summary = brief(clean(f.get("description") or f.get("summary") or f.get("content")))
        if len(summary) < 30 or summary.lower().startswith(title.lower()):
            summary = ""
        d = f.get("date") or datetime.now(timezone.utc)
        out.append({"realm": realm, "source": name, "title": title, "summary": summary,
                    "link": link, "date": d})
    out.sort(key=lambda s: s["date"], reverse=True)
    return out


def tokens(t):
    return {w for w in re.split(r"[^a-z0-9]+", t.lower()) if len(w) > 2}


def main():
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(fetch, FEEDS))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
    stories, seen = [], []
    for realm, limit in LIMITS.items():
        queues = [r for f, r in zip(FEEDS, results) if f[0] == realm]
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
            stories.append(cand)
            picked += 1
    if not stories:
        sys.exit("no stories fetched; keeping previous edition")
    for s in stories:
        s["date"] = s["date"].astimezone(timezone.utc).isoformat()
    maxims = json.loads(Path("web/maxims.json").read_text())
    Path("web/news.json").write_text(json.dumps(
        {"generated": datetime.now(timezone.utc).isoformat(), "stories": stories, "maxims": maxims},
        ensure_ascii=False, indent=1))
    print(f"wrote {len(stories)} stories")


if __name__ == "__main__":
    main()
