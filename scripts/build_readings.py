#!/usr/bin/env python3
"""Download public-domain texts (Project Gutenberg) and cut them into ~5-6 minute passages.

Writes web/readings/index.json (one entry per passage) and web/readings/<n>.json (the text).
Run from the repository root. Prints diagnostics so a run can be checked in the Actions log.
"""
import json, re, sys, time, urllib.request
from pathlib import Path

WORDS_PER_MIN = 220
TARGET = 1100          # words per passage (about 5 minutes; passages run 1,100-1,400)
MIN_LAST = 450         # a shorter remainder is merged into the previous passage
OUT = Path("web/readings")

ORD = {"FIRST": 1, "SECOND": 2, "THIRD": 3, "FOURTH": 4, "FIFTH": 5, "SIXTH": 6, "SEVENTH": 7,
       "EIGHTH": 8, "NINTH": 9, "TENTH": 10, "ELEVENTH": 11, "TWELFTH": 12}
BOOK_BLURB = {
    1: "Marcus lists what he owes to each person who shaped him. Who shaped you?",
    2: "Opens with a plan for meeting difficult people. Useful before any meeting.",
    3: "Time, duty and keeping a clear mind as life moves on.",
    4: "Retreating into your own mind, and the brevity of life.",
    5: "Starts with getting out of bed: the case for doing your work.",
    6: "Reason, reputation and acting for the common good.",
    7: "Practical notes on anger, pain and living with nature.",
    8: "Includes the idea of the mind as an inner citadel.",
    9: "Justice, mortality and our common nature.",
    10: "Includes the line about being a good person instead of arguing about it.",
    11: "On the rational soul, and how to look at life from outside it.",
    12: "The last book: leaving the stage with good grace.",
}

# id: Gutenberg ebook number(s) tried in order. start: regex of the first sentence of the real text.
# title_hint: must appear near the top of the file, to catch a wrong ebook number.
WORKS = [
    dict(key="meditations", work="Meditations", author="Marcus Aurelius", ids=[2680], title_hint="Meditations",
         start=r"Of my grandfather Verus I have learned", end=r"^(GLOSSARY|NOTES|APPENDIX|INDEX)\b",
         heading=r"^(?:THE\s+)?(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH)\s+BOOK\.?$|^BOOK\s+([IVXL]+)\.?$",
         first_heading="Book 1", cap=None,
         url="https://classics.mit.edu/Antoninus/meditations.html",
         why="Marcus Aurelius wrote these private notes to himself while leading Rome’s armies. Read one passage slowly."),
    dict(key="enchiridion", work="Enchiridion", author="Epictetus", ids=[45109, 10661], title_hint=r"Ench[ei]+ridion",
         start=r"(?i)there are things which are within our power|of things some are in our power|some things are (?:in|within) our (?:control|power)|some things are up to us",
         start_alt=r"^(?:I|1)\.\s+\S",
         end=r"(?i)^(FRAGMENTS|NOTES|FOOTNOTES|THE LIBERAL ARTS PRESS)\b", heading=None, first_heading=None, cap=None,
         url="https://classics.mit.edu/Epictetus/epicench.html",
         why="Epictetus’s handbook for living: short, practical rules for staying calm and free."),
    dict(key="apology", work="Apology", author="Plato", ids=[1656], title_hint="Apology",
         start=r"How you, O Athenians, have been affected by my accusers", end=None, heading=None,
         first_heading=None, cap=None, strip_marginalia=True, url="https://classics.mit.edu/Plato/apology.html",
         why="Socrates defends a life of questioning before the Athenian jury that will condemn him."),
    dict(key="crito", work="Crito", author="Plato", ids=[1657], title_hint="Crito",
         start=r"Why have you come at this hour, Crito", end=None, heading=None, first_heading=None, cap=None,
         strip_marginalia=True, url="https://classics.mit.edu/Plato/crito.html",
         why="Socrates, in prison, explains why he will not escape."),
    dict(key="ethics", work="Nicomachean Ethics", author="Aristotle", ids=[8438], title_hint="Ethics",
         start=r"(?i)every art,? and every (?:scientific )?(?:inquiry|investigation|science)|every art and every inquiry",
         start_alt=r"(?i)aim at some good|aims, it is thought, at some good", end=None,
         heading=r"^BOOK\s+([IVXL]+)\.?$", first_heading="Book 1", cap=12,
         url="https://classics.mit.edu/Aristotle/nicomachaen.html",
         why="Aristotle on happiness, and on virtue as something you build by practice."),
    dict(key="symposium", work="Symposium", author="Plato", ids=[1600], title_hint="Symposium",
         start=r"Concerning the things about which you ask to be informed", end=None, heading=None,
         first_heading=None, cap=15, strip_marginalia=True, url="https://classics.mit.edu/Plato/symposium.html",
         why="A dinner party at which each guest gives a speech about love."),
    dict(key="republic", work="The Republic", author="Plato", ids=[1497], title_hint="Republic",
         start=r"I went down yesterday to the Piraeus with Glaucon", end=None, heading=None,
         first_heading=None, cap=60, strip_marginalia=True, url="https://classics.mit.edu/Plato/republic.html",
         why="Plato’s great dialogue on justice, the soul and the ideal city."),
    dict(key="phaedo", work="Phaedo", author="Plato", ids=[1658], title_hint="Phaedo",
         start=r"Were you yourself, Phaedo, in the prison with Socrates", end=None, heading=None,
         first_heading=None, cap=None, strip_marginalia=True, url="https://classics.mit.edu/Plato/phaedo.html",
         why="Socrates’ last day: a conversation about the soul and death, ending with the hemlock."),
    dict(key="discourses", work="Discourses", author="Epictetus", ids=[10661], title_hint=r"Discourses",
         start=r"(?i)of all the faculties", start_alt=r"(?i)things which are in our power",
         end=r"(?i)^(?:THE\s+)?ENCH[EI]+RIDION\b", heading=None, first_heading=None, cap=40, run_in_titles=True,
         url="https://classics.mit.edu/Epictetus/discourses.html",
         why="Epictetus’s classroom talks, recorded by his student Arrian: Stoic practice for everyday situations."),
    dict(key="seneca", work="Letters to Lucilius", author="Seneca", ids=[56075], search="seneca moral letters lucilius",
         find_title=r"(?i)letters|epistul|lucilius", title_hint=r"(?i)Seneca|Lucilius|Epistul",
         start=r"(?i)seneca (?:greets|to|sends greetings to) (?:his friend )?lucilius|greetings from seneca|seneca (?:wishes )?health to lucilius",
         end=None, heading=None, first_heading=None, cap=40,
         url="https://en.wikisource.org/wiki/Moral_letters_to_Lucilius",
         why="Practical letters on time, friendship, fear and death from the Stoic statesman Seneca."),
]

ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def roman(s):
    total = 0
    for i, ch in enumerate(s):
        v = ROMAN[ch]
        total += -v if i + 1 < len(s) and ROMAN[s[i + 1]] > v else v
    return total


def download(ids):
    last = None
    for n in ids:
        for url in (f"https://www.gutenberg.org/cache/epub/{n}/pg{n}.txt",
                    f"https://www.gutenberg.org/files/{n}/{n}-0.txt",
                    f"https://www.gutenberg.org/ebooks/{n}.txt.utf-8"):
            for attempt in range(2):
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; Lyceum/1.0)"})
                    with urllib.request.urlopen(req, timeout=60) as r:
                        raw = r.read().decode("utf-8-sig", errors="replace")
                    if len(raw) > 5000:
                        return n, raw
                except Exception as e:
                    last = e
                    time.sleep(2)
    raise RuntimeError(f"could not download {ids}: {last}")


def smart(t):
    t = re.sub(r"(^|[\s(\[—-])\"", r"\1“", t)
    t = t.replace('"', "”")
    t = re.sub(r"(^|[\s(\[—“-])'", r"\1‘", t)
    t = t.replace("'", "’")
    t = t.replace("--", "—")
    return t


def paragraphs(raw):
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    m = re.search(r"\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\n", raw)
    if m: raw = raw[m.end():]
    m = re.search(r"\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG", raw)
    if m: raw = raw[:m.start()]
    out = []
    for block in re.split(r"\n\s*\n", raw):
        t = " ".join(line.strip() for line in block.split("\n")).strip()
        t = re.sub(r"\[Illustration[^\]]*\]", "", t)
        t = re.sub(r"\[Footnote[^\]]*\]", "", t)
        t = re.sub(r"\[\d+\]", "", t)
        t = re.sub(r"_([^_]+)_", r"\1", t).replace("_", "")
        t = re.sub(r"\s+", " ", t).strip()
        if t: out.append(t)
    return out


def split_long(p, limit=320):
    """Split a very long paragraph at sentence ends so it reads well on a phone."""
    if len(p.split()) <= limit:
        return [p]
    sentences = re.split(r"(?<=[.!?;:”’])\s+(?=[“‘A-Z])", p)
    n = -(-len(p.split()) // 260)
    target = len(p.split()) / n
    out, cur, cw = [], [], 0
    for sen in sentences:
        cur.append(sen); cw += len(sen.split())
        if cw >= target and len(out) < n - 1:
            out.append(" ".join(cur)); cur, cw = [], 0
    if cur: out.append(" ".join(cur))
    return out


def find_ids(query, title_re):
    """Look an ebook up by title: Gutenberg's own search page first, the gutendex API as a fallback."""
    import urllib.parse
    headers = {"User-Agent": "Mozilla/5.0 (compatible; Lyceum/1.0)"}
    found = []
    try:
        url = "https://www.gutenberg.org/ebooks/search/?query=" + urllib.parse.quote_plus(query)
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as r:
            page = r.read().decode("utf-8", errors="replace")
        for m in re.finditer(r'<li class="booklink">(.*?)</li>', page, re.S):
            blk = m.group(1)
            idm = re.search(r"/ebooks/(\d+)", blk); tm = re.search(r'<span class="title">(.*?)</span>', blk, re.S)
            if idm and tm and re.search(title_re, tm.group(1), re.I):
                found.append((int(idm.group(1)), re.sub(r"\s+", " ", tm.group(1)).strip()))
        print(f"[find] gutenberg search '{query}': {found[:6]}")
    except Exception as e:
        print(f"[find] gutenberg search failed: {e}")
    if not found:
        try:
            url = "https://gutendex.com/books/?languages=en&search=" + urllib.parse.quote(query)
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
                results = json.load(r)["results"]
            hits = sorted((x for x in results if re.search(title_re, x["title"], re.I)), key=lambda x: -x.get("download_count", 0))
            found = [(x["id"], x["title"][:60]) for x in hits]
            print(f"[find] gutendex '{query}': {found[:6]}")
        except Exception as e:
            print(f"[find] gutendex failed: {e}")
    return [n for n, _ in found[:4]]


def build_work(cfg):
    last = None
    tried = []
    for stage in ("configured", "search"):
        ids = cfg["ids"] if stage == "configured" else (
            [n for n in find_ids(cfg["search"], cfg.get("find_title", cfg["title_hint"])) if n not in tried] if cfg.get("search") else [])
        for n in ids:
            tried.append(n)
            try:
                return build_from(cfg, n)
            except Exception as e:
                last = e; print(f"[{cfg['key']}] ebook {n} rejected: {e}")
    raise last or RuntimeError("no candidate ebooks found")


def build_from(cfg, n):
    n, raw = download([n])
    head = " | ".join([l.strip() for l in raw.split("\n")[:25] if l.strip()][:6])
    print(f"[{cfg['key']}] ebook {n}: {head[:200]}")
    if not re.search(cfg["title_hint"], raw[:4000], re.I):
        raise RuntimeError(f"title '{cfg['title_hint']}' not near top of ebook {n}")
    paras = paragraphs(raw)
    start = next((i for i, p in enumerate(paras) if re.search(cfg["start"], p)), None)
    if start is None and cfg.get("start_alt"):
        start = next((i for i, p in enumerate(paras) if re.search(cfg["start_alt"], p)), None)
        if start is not None: print(f"[{cfg['key']}] used fallback start at paragraph {start}: {paras[start][:100]!r}")
    if start is None:
        print(f"[{cfg['key']}] start phrase not found; paragraphs near the top:")
        for k, p in enumerate(paras[:60]):
            if len(p) > 60: print(f"    {k}: {p[:110]!r}")
        raise RuntimeError("start phrase not found")
    end = len(paras)
    if cfg["end"]:
        end = next((i for i in range(start + 1, len(paras)) if re.match(cfg["end"], paras[i])), end)
    body = paras[start:end]
    items, heading = [], cfg["first_heading"]
    headings_seen = []
    for p in body:
        h = None
        if cfg["heading"]:
            m = re.match(cfg["heading"], p)
            if m:
                num = ORD.get(m.group(1)) if m.group(1) in ORD else None
                if num is None:
                    g = next((g for g in m.groups() if g), None)
                    num = roman(g) if g and re.fullmatch(r"[IVXL]+", g) else None
                if num: h = f"Book {num}"
        if h:
            heading = h; headings_seen.append(h); items.append({"h": h}); continue
        if len(p) < 3 or re.fullmatch(r"[A-Z .,]{3,}", p) and len(p) < 40:
            continue
        if cfg.get("strip_marginalia"):
            # Jowett's marginal summaries sit in the text as "(Capitalised note.)"
            p = re.sub(r"\s*\((?=[A-Z])[^()]{3,140}\.\)", "", p)
            p = re.sub(r"\s+([;,:])", r"\1", p).strip()
        if cfg.get("run_in_titles"):
            m = re.match(r"^([A-Z][A-Z ,'’;:()\-]{8,}?)\.?\s*[—-]+\s*(.+)$", p)
            if m:
                t = m.group(1).strip().capitalize()
                items.append({"h": t}); p = m.group(2)
        items.extend(split_long(smart(p)))
    words = sum(len(i.split()) for i in items if isinstance(i, str))
    print(f"[{cfg['key']}] paragraphs={len(items)} words={words} headings={headings_seen}")

    # cut into chunks at paragraph boundaries
    chunks, cur, cw, cur_heading = [], [], 0, cfg["first_heading"]
    start_heading = cur_heading
    def close():
        nonlocal cur, cw, start_heading
        if cur: chunks.append((start_heading, cur, cw))
        cur, cw = [], 0
    for it in items:
        if isinstance(it, dict):
            if cw >= TARGET: close()
            cur_heading = it["h"]
            if not cur: start_heading = cur_heading
            cur.append(it); continue
        if not cur: start_heading = cur_heading
        cur.append(it); cw += len(it.split())
        if cw >= TARGET: close()
    close()
    if len(chunks) > 1 and chunks[-1][2] < MIN_LAST:
        h, c, w = chunks.pop(); ph, pc, pw = chunks.pop(); chunks.append((ph, pc + c, pw + w))
    if cfg["cap"]: chunks = chunks[:cfg["cap"]]

    result = []
    for k, (h, c, w) in enumerate(chunks, 1):
        nums = []
        for it in c:
            if isinstance(it, str):
                m = re.match(r"^(\d+|[IVXLC]+)\.\s", it)
                if m: nums.append(int(m.group(1)) if m.group(1).isdigit() else roman(m.group(1)))
        # label: books for book-structured works, numbered sections otherwise, else "Part k of n"
        nbooks = [int(m.group(1)) for x in ([{"h": h}] if h else []) + [i for i in c if isinstance(i, dict)]
                  if (m := re.match(r"Book (\d+)", x["h"]))]
        label_h = h
        if cfg["heading"] and nbooks:
            lo, hi = min(nbooks), max(nbooks)
            label = f"Book {lo}" if lo == hi else f"Books {lo}–{hi}"
        elif nums and nums[0] <= nums[-1]:
            label = f"§{nums[0]}–{nums[-1]}"
        else:
            label = f"Part {k} of {len(chunks)}"
        why = cfg["why"]
        if cfg["key"] == "meditations":
            m = re.match(r"Book (\d+)", label_h or "")
            if m: why = BOOK_BLURB.get(int(m.group(1)), why)
        result.append(dict(work=cfg["work"], part=label, author=cfg["author"], why=why, url=cfg["url"],
                           minutes=max(1, round(w / WORDS_PER_MIN)), words=w, paras=c))
    # passages that share a label (e.g. several from Book 1) become "Book 1 · part 2 of 3"
    counts = {}
    for r in result: counts[r["part"]] = counts.get(r["part"], 0) + 1
    seen = {}
    for r in result:
        if counts[r["part"]] > 1 and not r["part"].startswith("Part "):
            seen[r["part"]] = seen.get(r["part"], 0) + 1
            r["part"] = f"{r['part']} · part {seen[r['part']]} of {counts[r['part']]}"
    ws = [r["words"] for r in result]
    print(f"[{cfg['key']}] passages={len(result)} words min/max={min(ws)}/{max(ws)}")
    print(f"[{cfg['key']}] first passage begins: {first_text(result[0])[:150]!r}")
    print(f"[{cfg['key']}] last passage ends: ...{last_text(result[-1])[-120:]!r}")
    print(f"[{cfg['key']}] labels: {[r['part'] for r in result][:6]} ...")
    return result


def first_text(r): return next(p for p in r["paras"] if isinstance(p, str))
def last_text(r): return [p for p in r["paras"] if isinstance(p, str)][-1]


def interleave(per_work):
    """Spread every work evenly across the whole cycle (always take from the least-finished work)."""
    taken = {k: 0 for k in per_work}
    order = []
    total = sum(len(v) for v in per_work.values())
    while len(order) < total:
        key = min((k for k in per_work if taken[k] < len(per_work[k])),
                  key=lambda k: (taken[k] / len(per_work[k]), list(per_work).index(k)))
        order.append(per_work[key][taken[key]]); taken[key] += 1
    return order


def main():
    per_work, failed = {}, []
    for cfg in WORKS:
        try:
            per_work[cfg["key"]] = build_work(cfg)
        except Exception as e:
            failed.append(cfg["key"]); print(f"[{cfg['key']}] FAILED: {e}")
    if not per_work:
        sys.exit("no readings built")
    order = interleave(per_work)
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*.json"): f.unlink()
    index = []
    for i, r in enumerate(order):
        (OUT / f"{i}.json").write_text(json.dumps({"p": r["paras"]}, ensure_ascii=False, separators=(",", ":")))
        index.append({k: r[k] for k in ("work", "part", "author", "why", "url", "minutes", "words")} | {"file": f"readings/{i}.json"})
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
    print(f"wrote {len(index)} passages from {list(per_work)}; failed: {failed}")
    print("first 12 days:", [f"{x['work']} {x['part']} ({x['minutes']}m)" for x in index[:12]])


if __name__ == "__main__":
    main()
