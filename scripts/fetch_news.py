#!/usr/bin/env python3
"""Fetch RSS/Atom feeds and write web/news.json (the morning edition)."""
import html, json, os, re, ssl, sys, time, urllib.parse, urllib.request
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
    ("schole", "youtube", 4),
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
    ("youtube", "Sidemen", "https://www.youtube.com/feeds/videos.xml?channel_id=UCDogdKl7t7NHzQ95aEwkdMw"),
    ("youtube", "Linus Tech Tips", "https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw"),
    ("youtube", "MrWhoseTheBoss", "https://www.youtube.com/feeds/videos.xml?channel_id=UCMiJRAwDNSNzuYeN2uWa0pA"),
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
    ("out", "Concrete Playground", "https://concreteplayground.com/melbourne/feed"),
    ("out", "Broadsheet", "https://www.broadsheet.com.au/melbourne/rss"),
    ("out", "Time Out Melbourne", "https://www.timeout.com/melbourne/rss"),
    ("music", "Music Feeds", "https://musicfeeds.com.au/feed/"),
    ("music", "Rolling Stone Australia", "https://au.rollingstone.com/feed/"),
    ("music", "NME", "https://www.nme.com/feed"),
    ("comedy", "Chortle", "https://www.chortle.co.uk/news/rss"),
    ("out", "*", GN + "Melbourne+(festival+OR+%22this+weekend%22+OR+%22night+market%22+OR+event)"),
    ("out", "*", GN + "Melbourne+(MCG+OR+%22Marvel+Stadium%22+OR+%22AAMI+Park%22)+(match+OR+tickets+OR+tour)"),
    ("out", "*", GN + "Melbourne+(startup+OR+tech)+(event+OR+conference+OR+summit)"),
]
ODEON_LIMITS = {"radar": 4, "music": 6, "comedy": 5, "out": 5}

# The same four rows for when you are in Mumbai. The app picks the city from the phone's timezone (or the switch in the Odeon).
GN_IN = "https://news.google.com/rss/search?hl=en-IN&gl=IN&ceid=IN:en&q="
MUMBAI_FEEDS = [
    ("radar", "*", GN_IN + "(" + FAV_Q + ")+(tour+OR+concert+OR+tickets+OR+%22live+in%22)+India"),
    ("radar", "*", GN_IN + "(" + FAV_Q + ")+India+tour"),
    ("radar", "Louder", "https://www.loudersound.com/feeds/all"),
    ("music", "Rolling Stone India", "https://rollingstoneindia.com/feed/"),
    ("music", "*", GN_IN + "Mumbai+(concert+OR+gig+OR+%22live+music%22+OR+tour)+(rock+OR+metal+OR+band)"),
    ("music", "*", GN_IN + "India+tour+announced+rock+OR+metal+OR+%22classic+rock%22"),
    ("comedy", "*", GN_IN + "(%22stand-up%22+OR+comedian)+(Mumbai+OR+India)+(tour+OR+show+OR+tickets)"),
    ("comedy", "*", GN_IN + "(%22Zakir+Khan%22+OR+%22Vir+Das%22+OR+%22Anubhav+Singh+Bassi%22+OR+%22Kenny+Sebastian%22)+tour"),
    ("out", "*", GN_IN + "Mumbai+(festival+OR+%22this+weekend%22+OR+event+OR+concert)"),
    ("out", "*", GN_IN + "Mumbai+(%22Mumbai+City+FC%22+OR+ISL+OR+football+OR+%22Premier+League%22)+(match+OR+tickets)"),
    ("out", "*", GN_IN + "Mumbai+(startup+OR+tech+OR+AI)+(event+OR+summit+OR+conference)"),
]

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


# Things never to show anywhere in the app.
BLOCKED = re.compile(r"(?i)\b(k-?pop|blackpink|stray kids|newjeans|aespa|le sserafim|enhypen|itzy|ateez|babymonster|illit|got7|korean idol|idol group)\b")
BLOCKED_CASE = re.compile(r"\bBTS\b")


def blocked(text):
    return bool(BLOCKED.search(text) or BLOCKED_CASE.search(text))


# Favourite YouTube channels: name -> (handle, a word the feed's title must contain, so a wrong channel is never shown).
YT_CHANNELS = {"PewDiePie": ("@PewDiePie", "pewdie"), "Sidemen": ("@Sidemen", "sidemen"),
               "Linus Tech Tips": ("@LinusTechTips", "linus"), "MrWhoseTheBoss": ("@Mrwhosetheboss", "whose")}
YT_FEED = "https://www.youtube.com/feeds/videos.xml?"


def _xml(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Lyceum/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return ET.fromstring(r.read())


def youtube_channel_id(handle):
    """Look a channel's id up from its @handle page (used only when its feed will not load)."""
    try:
        req = urllib.request.Request("https://www.youtube.com/" + handle,
                                     headers={"User-Agent": "Mozilla/5.0 (compatible; Lyceum/1.0)", "Cookie": "CONSENT=YES+1"})
        with urllib.request.urlopen(req, timeout=20) as r:
            page = r.read(400000).decode("utf-8", "ignore")
        m = re.search(r'channel_id=(UC[\w-]{22})', page) or re.search(r'"(?:channelId|externalId)":"(UC[\w-]{22})"', page)
        return m.group(1) if m else None
    except Exception as e:
        print(f"skip youtube lookup ({handle}): {e}", file=sys.stderr)
        return None


def _youtube_root(name, url):
    """The channel's feed root, trying the channel feed, the uploads playlist, then the id found from its handle."""
    handle, token = YT_CHANNELS[name]
    cid = re.search(r"channel_id=(UC[\w-]{22})", url)
    tried = []
    for ident in ([cid.group(1)] if cid else []) + [None]:
        if ident is None:                                  # last resort: find the id from the handle page
            ident = youtube_channel_id(handle)
            if not ident or ident in tried:
                break
        tried.append(ident)
        for query in ("channel_id=" + ident, "playlist_id=UU" + ident[2:]):
            try:
                root = _xml(YT_FEED + query)
            except Exception as e:
                print(f"skip {name} ({YT_FEED + query}): {e}", file=sys.stderr)
                continue
            title = next((c.text or "" for c in root if c.tag.split("}")[-1] == "title"), "")
            if token in title.lower():
                return root
            print(f"skip {name}: feed is for '{title}', not this channel", file=sys.stderr)
    return None


def fetch(feed):
    group, name, url = feed
    try:
        root = _youtube_root(name, url) if group == "youtube" and name in YT_CHANNELS else _xml(url)
        if root is None:
            return []
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
            elif tag in ("title", "description", "summary", "content", "encoded") and tag not in f:
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
        if blocked(title + " " + summary):
            continue
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


WIKI_TITLES = {"Elvis": "Elvis_Presley", "Tool": "Tool_(band)", "The Beatles": "The_Beatles", "Beatles": "The_Beatles"}
UA = "Lyceum/1.0 (https://github.com/vibhordube182-web/Iphone-apps-personal; personal news app)"
PERSON_DESC = re.compile(r"(?i)comedian|stand-?up|actor|actress|musician|singer|rapper|band|presenter|entertainer|songwriter|guitarist|drummer|youtuber|host")
_img_cache = {}
_img_alt = {}      # picture -> the exact link Wikipedia handed out, kept as a fallback if the larger one will not load


def _json(url, timeout=10):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
        return json.load(r)


def deezer_image(name):
    """A picture of a musician from Deezer (free, no key); only when the name matches exactly."""
    try:
        d = _json("https://api.deezer.com/search/artist?limit=3&q=" + urllib.parse.quote(name))
        for a in d.get("data", []):
            if a.get("name", "").lower() == name.lower() and a.get("picture_xl"):
                return a["picture_xl"]
    except Exception as e:
        print(f"skip deezer image ({name}): {e}", file=sys.stderr)
    return None


def wiki_image(name, people_only=False):
    """A photo from Wikipedia (free). With people_only, the page must describe a performer, so a headline's first
    words are not mistaken for a person."""
    key = (name, people_only)
    if key in _img_cache:
        return _img_cache[key]
    title = WIKI_TITLES.get(name, name.replace(" ", "_"))
    img = None
    try:
        d = _json("https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title, safe="()_"))
        if d.get("type") == "standard" and (not people_only or PERSON_DESC.search(d.get("description", ""))):
            src = (d.get("thumbnail") or {}).get("source") or (d.get("originalimage") or {}).get("source")
            if src:
                # Wikipedia only serves a fixed list of widths, so ask for a standard one (500) and keep its own link as the backup
                img = re.sub(r"/(\d+)px-", "/500px-", src, count=1)
                _img_alt[img] = src
    except Exception as e:
        print(f"skip wikipedia image ({name}): {e}", file=sys.stderr)
    _img_cache[key] = img
    return img


def lead_names(title):
    """Capitalised word runs at the start of a headline: 'Urzila Carlson to bring ...' -> ['Urzila Carlson', 'Urzila']."""
    m = re.match(r"((?:[A-Z][\w'’.-]+)(?:\s+(?:[A-Z][\w'’.-]+|of|the|de|van|von)){1,3})", title)
    if not m:
        return []
    words = m.group(1).split()
    return [" ".join(words[:n]) for n in (3, 2) if len(words) >= n]


def og_image(link):
    """The og:image of an article page, for headlines whose feed carries no picture. Skips Google News redirects."""
    if "news.google." in link:
        return None
    try:
        req = urllib.request.Request(link, headers={"User-Agent": "Mozilla/5.0 (compatible; Lyceum/1.0)"})
        with urllib.request.urlopen(req, timeout=8) as r:
            page = r.read(250000).decode("utf-8", "ignore")
    except Exception:
        return None
    for pat in (r"<meta[^>]+property=[\"']og:image[\"'][^>]+content=[\"']([^\"']+)",
                r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']og:image[\"']"):
        m = re.search(pat, page, re.I)
        if m and m.group(1).startswith("http"):
            return html.unescape(m.group(1)).replace("http://", "https://", 1)
    return None


# What a headline is about, as a Wikipedia page whose photo can stand in for it (a club, venue, event or company).
TOPIC_PAGES = [
    (r"(?i)melbourne victory", "Melbourne Victory FC"), (r"(?i)melbourne city", "Melbourne City FC"),
    (r"(?i)socceroos", "Australia men's national soccer team"), (r"(?i)a-league", "A-League Men"),
    (r"(?i)mumbai city fc", "Mumbai City FC"), (r"(?i)indian super league|\bisl\b", "Indian Super League"),
    (r"(?i)premier league", "Premier League"), (r"(?i)champions league", "UEFA Champions League"),
    (r"(?i)marvel stadium|docklands stadium", "Marvel Stadium"), (r"(?i)\bmcg\b|melbourne cricket ground", "Melbourne Cricket Ground"),
    (r"(?i)aami park", "AAMI Park"), (r"(?i)rod laver", "Rod Laver Arena"), (r"(?i)federation square", "Federation Square"),
    (r"(?i)queen victoria market|queen vic", "Queen Victoria Market"), (r"(?i)st kilda", "St Kilda, Victoria"),
    (r"(?i)wankhede", "Wankhede Stadium"), (r"(?i)nsci|worli", "Worli"), (r"(?i)gateway of india", "Gateway of India"),
    (r"(?i)marine drive", "Marine Drive, Mumbai"), (r"(?i)bandra", "Bandra"), (r"(?i)\bbkc\b|bandra kurla", "Bandra Kurla Complex"),
    (r"(?i)spacex|starship", "SpaceX"), (r"(?i)tesla", "Tesla, Inc."), (r"(?i)neuralink", "Neuralink"), (r"(?i)\bxai\b", "XAI (company)"),
    (r"(?i)diwali", "Diwali"), (r"(?i)\bholi\b", "Holi"), (r"(?i)bollywood", "Bollywood"),
    (r"(?i)greek|hellenic|antipodes", "Greek Orthodox Church of Australia"), (r"(?i)stoic", "Stoicism"),
    (r"(?i)comedy festival", "Melbourne International Comedy Festival"), (r"(?i)night market", "Queen Victoria Market"),
]
_CITY_PAGE = {"melbourne": "Melbourne", "mumbai": "Mumbai"}


def topic_image(text):
    """A photo for what a headline is about: the first matching club, venue or topic from TOPIC_PAGES."""
    for pat, page in TOPIC_PAGES:
        if re.search(pat, text):
            img = wiki_image(page)
            if img:
                return img
    return None


def add_odeon_images(odeon, city="melbourne"):
    """Give picture-less Odeon items a photo: the artist's photo, a person named in the headline, the article's own
    picture, then a photo of the venue/club/topic it is about, and for 'Out & about' the city itself as a last resort."""
    jobs = []
    for k in ("radar", "music", "comedy", "out"):
        for it in odeon.get(k, []):
            if not it.get("image"):
                jobs.append((it, it.get("tag") or "", it["link"], k))
        for e in (odeon.get("events") or {}).get(k, []):
            if not e.get("image") and e.get("tag"):
                jobs.append((e, e["tag"], "", k))
    def work(job):
        item, tag, link, row = job
        img = None
        title = item.get("title") or item.get("name") or ""
        if tag:
            img = deezer_image(tag) or wiki_image(tag)
        if not img:
            for name in lead_names(title):            # a person named at the start of the headline
                img = deezer_image(name) or wiki_image(name, people_only=True)
                if img:
                    break
        if not img and link:
            img = og_image(link)
        if not img:
            img = topic_image(title + " " + (item.get("summary") or ""))
        if not img and row == "out":
            img = wiki_image(_CITY_PAGE.get(city, "Melbourne"))
        if img:
            item["image"] = img
            if img in _img_alt and _img_alt[img] != img:
                item["image_alt"] = _img_alt[img]
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(work, jobs))

# What each Odeon row should be about, for Vibhor: rock and its heroes, comedy he is likely to enjoy (stand-up from India
# and the big touring names), and Melbourne nights out around football, tech/space, longevity, India and Greece.
# Edit freely. A headline has to match its row's taste and be about Australia, or it is not shown.
LOCAL = re.compile(r"(?i)\b(australia|australian|aussie|melbourne|victoria|sydney|brisbane|adelaide|perth|canberra)\b")
LOCAL_MEL = re.compile(r"(?i)\b(melbourne|victoria|mcg|marvel stadium|aami park|docklands|st kilda|fitzroy|carlton)\b")
ROCK_WORDS = re.compile(r"(?i)\b(rock|metal|grunge|punk|blues|guitar|stadium|alt-rock|hard rock|classic rock|reunion)\b")
COMEDY_LIKES = ["Zakir Khan", "Vir Das", "Anubhav Singh Bassi", "Abhishek Upmanyu", "Kenny Sebastian", "Biswa Kalyan Rath",
                "Samay Raina", "Rahul Subramanian", "Aditi Mittal", "Kanan Gill", "Tanmay Bhat", "Russell Peters",
                "Hasan Minhaj", "Bill Burr", "Joe Rogan", "Ricky Gervais", "Jimmy Carr", "Dave Chappelle", "Jim Jefferies",
                "Tim Minchin", "Hannah Gadsby", "Nikki Glaser", "Jo Koy", "Nate Bargatze", "John Mulaney", "Trevor Noah",
                "Jerry Seinfeld", "Kevin Hart", "Ali Wong", "Bo Burnham", "Dave Hughes", "Tom Gleeson", "Adam Hills",
                "Indian comedian", "Indian stand-up", "Bollywood"]
COMEDY_CONTEXT = re.compile(r"(?i)\b(stand-?up|comedian|comedy (show|festival|gala|tour)|live comedy)\b")
OUT_LIKES = re.compile(r"(?i)\b(socceroos|melbourne victory|melbourne city|a-league|premier league|champions league|football|soccer|"
                       r"spacex|tesla|starship|xai|neuralink|bryan johnson|longevity|biohack\w*|artificial intelligence|startup|"
                       r"mumbai city fc|indian super league|isl|tech conference|diwali|holi|bollywood|indian|india|greek|hellenic|philosophy|stoic\w*|ai summit|"
                       r"rock|led zeppelin|foo fighters|elton john|beatles|elvis)\b")


LOCAL_IN = re.compile(r"(?i)\b(india|indian|mumbai|bombay|delhi|bengaluru|bangalore|pune|hyderabad|chennai|kolkata)\b")
LOCAL_MUM = re.compile(r"(?i)\b(mumbai|bombay|navi mumbai|thane|bandra|worli|andheri|juhu|bkc|powai|wankhede|nsci)\b")


def likes_comedy(item, local=LOCAL):
    text = item["title"] + " " + item["summary"]
    if not local.search(text):
        return False                      # a favourite touring somewhere else is no use to you in Melbourne
    return any(re.search(r"\b" + re.escape(n) + r"\b", text, re.I) for n in COMEDY_LIKES) or bool(COMEDY_CONTEXT.search(text))


def likes_music(item, local=LOCAL):
    sc, _ = taste(item)
    text = item["title"] + " " + item["summary"]
    return sc >= 4 or (sc >= 2 and bool(local.search(text))) or bool(ROCK_WORDS.search(text) and local.search(text))


def likes_out(item, city=LOCAL_MEL):
    text = item["title"] + " " + item["summary"]
    return bool(city.search(text) and OUT_LIKES.search(text))


def build_odeon(results, taken_links, feeds=None, local=LOCAL, city=LOCAL_MEL, other=LOCAL_IN):
    """Pick the Odeon rows from fetched items: {radar, music, comedy, out}. Never raises."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    by_group = {}
    for feed, items in zip(feeds or ODEON_FEEDS, results):
        by_group.setdefault(feed[0], []).extend(items)
    used, seen_words, out = set(taken_links), [], {}

    def take(items, limit, key, min_score=0, pred=None):
        fresh = [i for i in items if i["date"] > cutoff]
        pool = fresh if len(fresh) >= limit else items
        scored = []
        for i in pool:
            sc, artist = taste(i)
            if sc >= min_score and i["link"] not in used and (pred is None or pred(i)):
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
    # a picture is worth about a day and a half of freshness, so poster-style cards are not all gradients
    recency = lambda sc, i: sc * 3 + (i["date"] - cutoff).total_seconds() / 86400.0 + (1.5 if i.get("image") else 0)
    # a favourite's tour of the other city (an Australian tour while you are in Mumbai) is no use to you
    elsewhere = lambda i: not (other.search(i["title"] + " " + i["summary"]) and not local.search(i["title"] + " " + i["summary"]))
    out["radar"] = take(by_group.get("radar", []) + by_group.get("music", []), ODEON_LIMITS["radar"], recency, 3, elsewhere)
    preds = {"music": lambda i: likes_music(i, local), "comedy": lambda i: likes_comedy(i, local),
             "out": lambda i: likes_out(i, city)}
    for k in ("music", "comedy", "out"):
        out[k] = take(by_group.get(k, []), ODEON_LIMITS[k], recency, 0, preds[k])
    return out


# ---- Ticketmaster Discovery API: real dates, venues, price ranges and ticket links (needs TICKETMASTER_API_KEY) ----
TM_URL = "https://app.ticketmaster.com/discovery/v2/events.json"
NOT_THE_ACT = re.compile(r"(?i)\b(tribute|experience|celebrat|performed by|plays|symphon|orchestra|cover|salute|karaoke|kids|vip upgrade)\b")

# General seating advice by venue (lower-case fragment of the venue name). Not live availability.
VENUE_TIPS = [
    ("marvel stadium", "Concerts here: the floor is closest but the view is flat. Lower-bowl seats towards the sides, a little back from the stage, usually balance sound and view best. The far end-zone upper seats are distant."),
    ("melbourne cricket ground", "For stadium shows, lower-tier seats side-on to the stage tend to balance view and sound. The ground floor is standing. The top of the upper tier is a long way back."),
    ("mcg", "For stadium shows, lower-tier seats side-on to the stage tend to balance view and sound. The ground floor is standing. The top of the upper tier is a long way back."),
    ("rod laver arena", "Centre-facing lower-tier seats give a clear view and strong sound. The floor is best for energy, but flat. Seats at the extreme sides or back of the upper tier are the weakest."),
    ("john cain arena", "Lower-tier seats facing the stage are best value. On the floor, aim for near the sound desk for the clearest sound."),
    ("margaret court arena", "A smaller arena, so most seats are decent. Lower-tier centre is best; the floor is for the front-of-stage crowd."),
    ("forum melbourne", "Standing venue with a balcony: the front of the upstairs balcony gives a clear, unobstructed view; downstairs, near the sound desk has the best sound."),
    ("palais theatre", "In the stalls, the middle rows near the centre balance view and sound; the front of the dress circle is excellent and often cheaper."),
    ("hamer hall", "The stalls centre and the front of the first tier give the best sound. Seats at the very sides can have angled views."),
    ("princess theatre", "Dress circle front rows or the stalls from the middle back give the best view of the stage."),
    ("regent theatre", "Stalls from the middle back, or the front of the dress circle, give a full view of the stage."),
    ("comedy theatre", "A small room: stalls centre rows are best. Upper seats are still close enough to hear every line."),
    ("corner hotel", "Small standing room. For sound, stand mid-room near the sound desk; for atmosphere, closer to the stage. Arrive early for the front."),
    ("the tote", "Very small and loud; earplugs help. The best view is near the front or on the raised side."),
    ("northcote social club", "Mid-room near the sound desk has the best sound. The upstairs seated area is a calmer, clear view."),
    ("sidney myer music bowl", "Seated: the reserved seats in the middle of the shell are best. On the lawn, bring a rug and sit mid-lawn for sound and view."),
    ("nsci dome", "Big indoor dome in Worli: the floor near the sound desk has the best sound; lower-tier seats facing the stage give a clear view. Allow extra time for Worli traffic."),
    ("jio world", "A large convention-centre venue: seated blocks facing the stage centre give the clearest view; the standing area is best a little back from the front for sound."),
    ("dy patil", "Stadium shows: lower-tier seats side-on to the stage balance sound and view. The ground is standing. Navi Mumbai is a long trip, so plan your return."),
    ("wankhede", "Lower-tier seats towards the middle of the stand give the best view of the stage or pitch. The upper tier is far back."),
    ("mmrda", "Open-air ground: stand a little back from the front barriers for the best sound and room to move."),
    ("ncpa", "Seated halls: the middle of the stalls gives the best sound; the front of the dress circle is excellent."),
    ("canvas laugh club", "A small comedy room: most seats are close, so the middle rows are best. Book early for popular acts."),
    ("royal opera house", "Stalls from the middle back, or the front of the lower balcony, give the best view and sound."),
    ("aami park", "Floor is standing. Lower-tier seats at the side give a good, close view."),
]
VENUE_TIP_BY_TYPE = [
    (r"(?i)stadium|ground|oval", "Stadium shows: lower-tier seats side-on to the stage usually balance sound and view. The floor is standing."),
    (r"(?i)arena", "Arena shows: centre-facing lower-tier seats give the best view and sound. The extreme sides and back of the upper tier are weakest."),
    (r"(?i)theatre|theater|hall|opera", "Seated theatre: the middle of the stalls or the front of the dress circle usually gives the best view and sound."),
    (r"(?i)hotel|club|bar|pub|social|tote", "Small room: near the sound desk gives the best sound, and closer to the stage gives the best atmosphere. Arrive early."),
]


def venue_tip(venue):
    v = (venue or "").lower()
    for frag, tip in VENUE_TIPS:
        if frag in v:
            return tip
    for pat, tip in VENUE_TIP_BY_TYPE:
        if re.search(pat, venue or ""):
            return tip
    return ""


def tm_events(key, **params):
    q = {"apikey": key, "countryCode": "AU", "size": "20", "sort": "date,asc",
         "startDateTime": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    q.update(params)
    req = urllib.request.Request(TM_URL + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "Lyceum/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
    except Exception as e:
        print(f"skip ticketmaster ({params}): {e}", file=sys.stderr)
        return []
    time.sleep(0.3)
    out = []
    for ev in (data.get("_embedded") or {}).get("events", []):
        try:
            start = ev["dates"]["start"]
            venue = ((ev.get("_embedded") or {}).get("venues") or [{}])[0]
            price = (ev.get("priceRanges") or [{}])[0]
            imgs = sorted(ev.get("images") or [], key=lambda i: i.get("width") or 0, reverse=True)
            img = next((i["url"] for i in imgs if (i.get("width") or 0) >= 600 and i.get("ratio") == "16_9"), None) \
                or (imgs[0]["url"] if imgs else None)
            attractions = [a.get("name", "") for a in (ev.get("_embedded") or {}).get("attractions", [])]
            vname = venue.get("name", "")
            if blocked(ev["name"] + " " + " ".join(attractions)):
                continue
            out.append({
                "name": clean(ev["name"]), "link": ev["url"], "date": start.get("localDate", ""),
                "time": (start.get("localTime") or "")[:5], "venue": vname,
                "city": (venue.get("city") or {}).get("name", ""),
                "min": price.get("min"), "max": price.get("max"), "currency": price.get("currency", "AUD"),
                "image": img, "acts": attractions, "tip": venue_tip(vname),
            })
        except Exception:
            continue
    return out


def bit_events(app_id, artist, countries=("australia", "au")):
    """Upcoming shows in the given countries for an artist from Bandsintown: dates and venues from any seller, no prices."""
    url = "https://rest.bandsintown.com/artists/%s/events?app_id=%s&date=upcoming" % (
        urllib.parse.quote(artist, safe=""), urllib.parse.quote(app_id, safe=""))
    req = urllib.request.Request(url, headers={"User-Agent": "Lyceum/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
    except Exception as e:
        print(f"skip bandsintown ({artist}): {e}", file=sys.stderr)
        return []
    time.sleep(0.3)
    if not isinstance(data, list):
        return []
    out = []
    for ev in data:
        try:
            venue = ev.get("venue") or {}
            if (venue.get("country") or "").lower() not in countries:
                continue
            when = ev.get("starts_at") or ev.get("datetime") or ""
            offers = ev.get("offers") or []
            link = next((o["url"] for o in offers if o.get("type") == "Tickets" and o.get("url")), "") or ev.get("url", "")
            if not when or not link.startswith("http"):
                continue
            vname = clean(venue.get("name", ""))
            out.append({"name": clean(ev.get("title") or "") or artist + " live", "link": link, "date": when[:10],
                        "time": when[11:16] if len(when) > 15 else "", "venue": vname,
                        "city": venue.get("city", ""), "min": None, "max": None, "currency": "AUD", "image": None,
                        "acts": [artist], "tip": venue_tip(vname)})
        except Exception:
            continue
    return out


FILM_LANGUAGES = ("en", "hi")


def tmdb_get(path, key, **params):
    """One TMDB v3 request; the key may be a v3 API key or a v4 read-access token."""
    headers = {"User-Agent": "Lyceum/1.0"}
    q = dict(params)
    if key.startswith("eyJ"):
        headers["Authorization"] = "Bearer " + key
    else:
        q["api_key"] = key
    url = "https://api.themoviedb.org/3/%s?%s" % (path, urllib.parse.urlencode(q))
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
        return json.load(r)


_details = {}


def movie_details(key, m):
    """Quick facts for one film: tagline, runtime, genres, Australian rating, director, cast, trailer."""
    if m["id"] in _details:
        return _details[m["id"]]
    try:
        d = tmdb_get("movie/%d" % m["id"], key, language="en-AU", append_to_response="credits,videos,release_dates")
    except Exception as e:
        print(f"skip tmdb details ({m.get('title')}): {e}", file=sys.stderr)
        return {}
    certs = {}
    for c in (d.get("release_dates") or {}).get("results", []):
        if c.get("iso_3166_1") in ("AU", "IN"):
            certs[c["iso_3166_1"]] = next((x.get("certification") for x in c.get("release_dates", []) if x.get("certification")), "")
    crew = (d.get("credits") or {}).get("crew", [])
    cast = (d.get("credits") or {}).get("cast", [])
    vids = [v for v in (d.get("videos") or {}).get("results", []) if v.get("site") == "YouTube" and v.get("type") == "Trailer"]
    vids.sort(key=lambda v: (not v.get("official"), v.get("published_at") or ""), reverse=False)
    out = {"tagline": clean(d.get("tagline") or ""), "runtime": d.get("runtime") or 0,
            "genres": [g["name"] for g in d.get("genres", [])][:3], "certs": certs,
            "director": [c["name"] for c in crew if c.get("job") == "Director"][:2],
            "cast": [c["name"] for c in cast][:5],
            "trailer": "https://www.youtube.com/watch?v=" + vids[0]["key"] if vids else "",
            "overview": brief(clean(d.get("overview") or m.get("overview") or ""), 480)}
    _details[m["id"]] = out
    return out


def tmdb_movies(key, region="AU"):
    """The most popular English and Hindi films in cinemas in the given region (AU or IN) now, plus a few popular ones coming
    soon, from TMDB, with quick facts for each. No session times: those live in each cinema's own system."""
    if not key:
        return []
    out, seen = [], set()
    for kind, max_pages, cap in (("now_playing", 12, 20), ("upcoming", 5, 6)):
        found = []
        for page in range(1, max_pages + 1):
            try:
                data = tmdb_get("movie/" + kind, key, region=region, language="en-AU", page=page)
            except Exception as e:
                print(f"skip tmdb {kind} page {page}: {e}", file=sys.stderr)
                break
            for m in data.get("results", []):
                if not m.get("poster_path") or not m.get("title") or m["id"] in seen or blocked(m["title"]):
                    continue
                if m.get("original_language") not in FILM_LANGUAGES:     # English and Hindi (Bollywood) only
                    continue
                seen.add(m["id"])
                found.append({"id": m["id"], "title": m["title"], "date": m.get("release_date", ""), "kind": kind,
                              "popularity": round(m.get("popularity") or 0, 1),
                              "rating": round(m.get("vote_average") or 0, 1), "votes": m.get("vote_count") or 0,
                              "poster": "https://image.tmdb.org/t/p/w342" + m["poster_path"],
                              "overview": brief(clean(m.get("overview", "")), 480)})
            if page >= data.get("total_pages", 1):
                break
        found.sort(key=lambda m: m["popularity"], reverse=True)       # most popular first
        out += found[:cap]
    with ThreadPoolExecutor(8) as ex:
        for m, extra in zip(out, ex.map(lambda m: movie_details(key, m), out)):
            extra = dict(extra)
            m["cert"] = (extra.pop("certs", {}) or {}).get(region, "")
            m.update({k: v for k, v in extra.items() if v})
    return out

def build_events(key, bit_id="", countries=("australia", "au"), use_tm=True):
    """Event rows {radar, music, comedy, out}, soonest first: Ticketmaster (prices, tickets) plus Bandsintown tour dates
    for the artist radar (any seller). Empty dict if neither key is set."""
    if not use_tm:
        key = ""
    if not key and not bit_id:
        return {}
    seen = set()

    def fresh(items, limit, tag=None, only=None):
        picked = []
        for e in items:
            if e["link"] in seen or not e["date"] or (only and not only(e)):
                continue
            seen.add(e["link"])
            e = dict(e)
            e.pop("acts", None)
            if tag:
                e["tag"] = tag
            picked.append(e)
            if len(picked) >= limit:
                break
        return picked

    radar = []
    for name in ["Led Zeppelin", "Foo Fighters", "Red Hot Chili Peppers", "System of a Down", "The Beatles",
                 "Elvis", "Elton John", "Tool", "Pearl Jam", "Metallica", "Queens of the Stone Age"]:
        exact = lambda e, n=name: any(a.lower() == n.lower() for a in e["acts"]) and not NOT_THE_ACT.search(e["name"])
        mine = fresh(tm_events(key, keyword=name, classificationName="music"), 3, tag=name, only=exact) if key else []
        if bit_id:
            have = {e["date"] for e in mine}   # Ticketmaster already has the price and ticket link for those dates
            extra = [e for e in bit_events(bit_id, name, countries) if e["date"] not in have and not NOT_THE_ACT.search(e["name"])]
            mine += fresh(extra, 3, tag=name)
        radar += mine
    radar.sort(key=lambda e: (e["date"], e["time"]))
    out = {"radar": radar[:10]}
    if not key:
        return out
    out["music"] = fresh(tm_events(key, city="Melbourne", classificationName="music", keyword="rock"), 6) or \
        fresh(tm_events(key, city="Melbourne", classificationName="music"), 6)
    out["comedy"] = fresh(tm_events(key, city="Melbourne", classificationName="comedy"), 6)
    out["out"] = fresh(tm_events(key, city="Melbourne", classificationName="sports", keyword="football"), 5)
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
        mumbai_results = list(ex.map(fetch, MUMBAI_FEEDS))
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
    key = os.environ.get("TICKETMASTER_API_KEY", "").strip()
    bit_id = os.environ.get("BANDSINTOWN_APP_ID", "").strip()
    tmdb_key = os.environ.get("TMDB_API_KEY", "").strip()
    try:
        odeon["events"] = build_events(key, bit_id)
    except Exception as e:
        print(f"skip events: {e}", file=sys.stderr)
        odeon["events"] = {}
    odeon["events_connected"] = bool(key or bit_id)
    try:
        odeon["movies"] = tmdb_movies(tmdb_key)
    except Exception as e:
        print(f"skip movies: {e}", file=sys.stderr)
        odeon["movies"] = []
    odeon["movies_connected"] = bool(tmdb_key)
    try:
        mumbai = build_odeon(mumbai_results, {x["link"] for x in stories}, MUMBAI_FEEDS, LOCAL_IN, LOCAL_MUM, LOCAL)
        mumbai["events"] = build_events("", bit_id, ("india", "in"), use_tm=False)   # Ticketmaster has no India; tours come from Bandsintown
        mumbai["events_connected"] = bool(bit_id)
        mumbai["movies"] = tmdb_movies(tmdb_key, "IN")
        mumbai["movies_connected"] = bool(tmdb_key)
        odeon["regions"] = {"mumbai": mumbai}
    except Exception as e:
        print(f"skip mumbai odeon: {e}", file=sys.stderr)
    try:
        add_odeon_images(odeon)
        add_odeon_images(odeon.get("regions", {}).get("mumbai", {}), "mumbai")
    except Exception as e:
        print(f"skip odeon images: {e}", file=sys.stderr)
    for s in stories:
        s["date"] = s["date"].astimezone(timezone.utc).isoformat()
    Path("web/news.json").write_text(json.dumps(
        {"generated": datetime.now(timezone.utc).isoformat(), "stories": stories, "odeon": odeon, "weather": weather(),
         "maxims": json.loads(Path("web/maxims.json").read_text()),
         "reading": json.loads(Path("web/readings/index.json" if Path("web/readings/index.json").exists()
                                   else "web/reading.json").read_text())},
        ensure_ascii=False, indent=1))
    print(f"wrote {len(stories)} stories; odeon news " + ", ".join(f"{k} {len(odeon.get(k, []))}" for k in ("radar", "music", "comedy", "out"))
          + "; events " + ", ".join(f"{k} {len(v)}" for k, v in odeon["events"].items())
          + f"; movies {len(odeon['movies'])}"
          + "; mumbai " + ", ".join(f"{k} {len(v)}" for k, v in (odeon.get("regions", {}).get("mumbai", {})).items() if isinstance(v, list)))


if __name__ == "__main__":
    main()
