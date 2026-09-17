#!/usr/bin/env python3
"""Downloads the metamagic feats from dndtools (https://dndtools.net/feats/categories/metamagic/)
and saves them to web/metamagic.json, used by the "Prepared" tab.

server.py downloads them by itself when the file is missing (`stored`, `download_feats`, `save`).
By hand, from the project folder:
        python3 -B -m grimoire.metamagic                      (about 150 pages, a couple of minutes)
        python3 -B -m grimoire.metamagic --cache /tmp/feats   (keeps the pages, to retry the parsing)
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
from lxml import etree  # noqa: E402
from lxml import html as LH  # noqa: E402

from . import dndtools, units  # noqa: E402

LIST_URL = "https://dndtools.net/feats/categories/metamagic/"
OUTPUT = Path(__file__).resolve().parent.parent / "web" / "metamagic.json"
PAUSE = 0.25  # seconds between one page and the next, to go easy on dndtools

NUMBER_WORDS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
                "six": 6, "seven": 7, "eight": 8, "nine": 9}
HIGHER_RE = re.compile(r"\b(zero|one|two|three|four|five|six|seven|eight|nine|\d)(?:\s+|-)levels?\s+higher", re.I)
SAME_LEVEL_RE = re.compile(
    r"slot of the (?:spell'?s normal|same|appropriate spell|original spell'?s?) level|same level as the"
    r"|without increasing the level", re.I)


def download(url, cache):
    if cache:
        file = cache / (re.sub(r"[^a-z0-9]+", "_", url.lower()).strip("_") + ".html")
        if file.exists():
            return file.read_text(encoding="utf-8")
    time.sleep(PAUSE)
    text = dndtools._download_page(url)
    if cache:
        file.write_text(text, encoding="utf-8")
    return text


def spaces(text):
    return re.sub(r"\s+", " ", text or "").strip()


def level_increase(text):
    """Extra slot levels, read from the feat text; None if the text doesn't say."""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if "slot" not in sentence.lower():
            continue
        found = HIGHER_RE.search(sentence)
        if found:
            value = found.group(1).lower()
            return NUMBER_WORDS.get(value, int(value) if value.isdigit() else None)
        if SAME_LEVEL_RE.search(sentence):
            return 0
    return None


def text_html(block):
    """Benefit / Normal / Special sections: text tags only, no attributes or links."""
    root = dndtools._clean_html(block)
    for link in root.xpath(".//a"):
        link.drop_tag()
    parts = []
    for child in root:
        html = etree.tostring(child, encoding="unicode", method="html", with_tail=False)
        if spaces(child.text_content()):
            parts.append(spaces(html))
    return "".join(parts)


def parse_feat(page_html, url, summary):
    content = LH.fromstring(page_html).xpath('//div[@id="content"]')[0]
    rulebook = content.xpath('.//a[starts-with(@href, "/rulebooks/")]')
    page = re.search(r"p\.\s*(\d+)", rulebook[0].tail or "") if rulebook else None
    prerequisites = ""
    for title in content.xpath(".//h4"):
        if spaces(title.text_content()).startswith("Prerequisite"):
            following = title.getnext()
            prerequisites = spaces(following.text_content()).strip(" ,") if following is not None else ""
    block = content.xpath('.//div[contains(concat(" ", @class, " "), " nice-textile ")]')
    benefit = spaces(block[0].text_content()) if block else ""
    name = spaces(content.xpath(".//h2")[0].text_content())
    variable = name in ("Heighten Spell", "Improved Heighten Spell")
    sudden = name.startswith("Sudden ")
    return {
        "id": re.search(r"--(\d+)/$", url).group(1),
        "name": name,
        "url": url,
        "rulebook": spaces(rulebook[0].text_content()) if rulebook else "",
        "page": int(page.group(1)) if page else None,
        "edition_35": bool(rulebook) and "-35--" in rulebook[0].get("href", ""),
        "summary": units.convert_text(summary),
        "prerequisites": re.sub(r"\s+,", ",", prerequisites),
        "text_html": units.convert_text(text_html(block[0])) if block else "",  # metric measurements
        # Heighten: the level is chosen; Sudden: no increase, once per day when casting
        "increase": None if variable else 0 if sudden else level_increase(benefit),
        "variable": variable,
        "raises_level": variable,  # save DCs and effects use the increased level
        "sudden": sudden,
    }


def stored(path=OUTPUT):
    """True if the file is there with its feats."""
    try:
        feats = json.loads(Path(path).read_text(encoding="utf-8"))["feats"]
        return bool(feats) and all(f["id"] and f["name"] for f in feats)
    except (OSError, ValueError, TypeError, KeyError):
        return False


def save(data, path=OUTPUT):
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def download_feats(cache=None, log=print):
    """Every metamagic feat of dndtools; ValueError if none is found, dndtools.DndtoolsError if it can't be reached."""
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    entries, page = [], 1
    while True:
        doc = LH.fromstring(download(f"{LIST_URL}?page={page}", cache))
        rows = doc.xpath('//table[contains(@class, "common")]//tr[td]')
        for row in rows:
            link = row.xpath("./td[1]/a")[0]
            entries.append(("https://dndtools.net" + link.get("href"), row.xpath("./td[2]")[0].get("title", "")))
        if not rows or not doc.xpath('//div[@class="pagination"]//a[@class="next"]'):
            break
        page += 1
    log(f"{len(entries)} metamagic feats listed, downloading them…")

    feats = []
    for number, (url, summary) in enumerate(entries, 1):
        try:
            feats.append(parse_feat(download(url, cache), url, spaces(summary)))
        except (dndtools.DndtoolsError, IndexError) as error:
            log(f"  skipped {url}: {error}")
        if number % 25 == 0:
            log(f"  {number}/{len(entries)}")
    if not feats:
        raise ValueError("no feats found: has dndtools changed?")
    feats.sort(key=lambda t: (t["name"].lower(), not t["edition_35"], t["rulebook"]))
    return {"source": LIST_URL, "feats": feats}


def main():
    parser = argparse.ArgumentParser(description="Download the metamagic feats from dndtools.")
    parser.add_argument("--cache", help="folder where downloaded pages are kept")
    args = parser.parse_args()
    try:
        data = download_feats(Path(args.cache) if args.cache else None)
    except (dndtools.DndtoolsError, ValueError) as error:
        raise SystemExit(f"Metamagic feats not downloaded: {error}")
    save(data)
    feats = data["feats"]
    unknown = [t["name"] for t in feats if t["increase"] is None and not t["variable"]]
    print(f"Saved {len(feats)} feats to {OUTPUT}")
    if unknown:
        print(f"Level adjustment not stated ({len(unknown)}, asked when preparing): {', '.join(unknown)}")


if __name__ == "__main__":
    main()
