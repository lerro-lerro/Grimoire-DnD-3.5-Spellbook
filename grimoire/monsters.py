"""The creatures that spells summon or call, from the SRD monster index (d20srd.org).

`list_items` finds the creature lists in a sheet (the tables of Summon Monster, or lines like "Call Undead
table, 2nd level: Allip, Ghoul, Skeleton (Large)" in a hand-written spell); `Library.resolve` matches each
name with the SRD index and downloads what is missing into <data>/monsters: the index (index.json), the
types and subtypes (types.json) and one file per creature (<page>--<anchor>.json), so they stay offline.

Pictures (`pictures_for`): the Monster Manual v.3.5 art gallery that Wizards of the Coast published in 2003
(through the Internet Archive; art.json lists its captions), the group pictures of a family ("Demons") for the
creatures without their own, and for real animals (not in the gallery) the photo of their Wikipedia article.
The image files are kept in <data>/monsters/images.
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import lxml.etree
import lxml.html

from . import units

SITE = "https://www.d20srd.org"
INDEX_URL = SITE + "/indexes/monsters.htm"
TYPES_URL = SITE + "/srd/typesSubtypes.htm"
GALLERY_URL = ("https://web.archive.org/web/20140213104222/"
               "http://www.wizards.com/default.asp?x=dnd/ag/20030712a")
GALLERY_IMAGE_URL = "https://web.archive.org/web/2014id_/http://www.wizards.com/dnd/images/MM35_gallery/{}"
WIKIPEDIA_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{}"
# animals whose SRD name isn't the title of their Wikipedia article
WIKIPEDIA_TITLES = {"Constrictor Snake": "Boa constrictor", "Giant Constrictor Snake": "Reticulated python",
                    "Viper Snake": "Viper", "Dog, Riding": "Dog"}
IMAGE_FILE_RE = re.compile(r"^[A-Za-z0-9_.-]+\.(?:jpe?g|png|gif|webp)$")
USER_AGENT = "Grimoire spellbook (personal use)"
RETRIES = 2

SIZES = {"fine", "diminutive", "tiny", "small", "medium", "medium-sized", "large", "huge", "gargantuan", "colossal"}
# "Celestial dog" is the dog with the Celestial Creature template
TEMPLATES = {"celestial": "Celestial Creature", "fiendish": "Fiendish Creature",
             "half-celestial": "Half-Celestial", "half-fiendish": "Half-Fiendish"}
TEXT_TAGS = {"p", "br", "em", "i", "strong", "b", "table", "thead", "tbody", "tr", "th", "td", "ul", "ol", "li",
             "h2", "h3", "h4", "h5", "h6", "sup", "sub"}
KEPT_ATTRIBUTES = {"colspan", "rowspan"}
# links to SRD spells ("At will—detect evil, sleep") stay, as <a data-spell="detect evil">: the page opens the spell
SRD_SPELL_LINK_RE = re.compile(r"/srd/spells/\w+\.htm")
# saved files of an older format are downloaded again: 2 = with the spell links
FORMAT = 2
# "you can call one undead creature from the 2nd-level list": in one sentence (Detect Magic mentions "summon" and has a table)
SUMMONS_RE = re.compile(r"\b(?:summon|call)\w*\b[^.]{0,120}\b(?:list|table)\b", re.I)
CREATURE_COLUMN_RE = re.compile(r"monster|creature|undead|animal|summon|name")
LIST_LINE_RE = re.compile(r"^(?P<label>[^:]{0,60}\b(?:level|list|table)\b[^:]{0,30}):\s*(?P<items>.+)$", re.I)
SIZE_TYPE_RE = re.compile(r"^(?:fine|diminutive|tiny|small|medium|large|huge|gargantuan|colossal)\s+"
                          r"(?P<type>[a-z][a-z ]*?)\s*(?:\((?P<subtypes>[^)]*)\))?\s*$", re.I)


class MonsterError(Exception):
    """Error with a message to show to the user."""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _spaces(text):
    return re.sub(r"\s+", " ", text or "").strip()


def _key(name):
    return _spaces(name).replace("’", "'").lower()


def _camel(text):
    """"magical beast" -> "magicalBeast" (the anchors of the SRD types page)."""
    words = re.findall(r"[a-z0-9']+", text.lower().replace("'", ""))
    return words[0] + "".join(w.capitalize() for w in words[1:]) if words else ""


def creature_id(url):
    """"/srd/monsters/elemental.htm#airElemental" -> "elemental--air-elemental"."""
    parsed = urllib.parse.urlparse(url)
    page = Path(parsed.path).stem
    slug = lambda text: re.sub(r"[^a-z0-9]+", "-", re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", text).lower()).strip("-")
    return slug(page) + (f"--{slug(parsed.fragment)}" if parsed.fragment else "")


def download(url):
    """Bytes of a page or image (the XML declaration of the SRD pages means lxml wants bytes).
    Retried like the dndtools pages."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    site = urllib.parse.urlparse(url).netloc.removeprefix("www.")
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == RETRIES:
                raise MonsterError(f"{site} answered with error {error.code} for {url}.")
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == RETRIES:
                raise MonsterError(f"Could not reach {site} ({error}). Are you connected to the internet?")
        time.sleep(0.5 * 3 ** attempt)


# --- the creature lists in a spell ---

def _split_items(text):
    """"Allip, Ghoul, Skeleton (Large)" -> the names; commas inside parentheses don't split."""
    items, depth, current = [], 0, ""
    for char in text:
        depth += char == "("
        depth -= char == ")"
        if char == "," and depth <= 0:
            items.append(current)
            current = ""
        else:
            current += char
    items.append(current)
    return [_spaces(item).rstrip(".;") for item in items if _spaces(item).rstrip(".;")]


def list_items(sheet):
    """The creatures a summoning or calling spell lists: [{heading, text}] in the order of the description.
    Lists are tables (under the heading before them, e.g. "1st level"): the creature column, or the first one,
    and lines like "Call Undead table, 2nd level: Allip, Ghoul". Table rows labeled with a level above the
    spell's own ("5th" in Summon Undead II) are left out. Empty for a spell that doesn't summon or call."""
    html = sheet.get("description_html") or ""
    text = re.sub(r"<[^>]+>", " ", html)
    calling = {"Summoning", "Calling"} & set(sheet.get("subschools") or [])
    if not html or not (calling or SUMMONS_RE.search(text)):
        return []
    root = lxml.html.fragment_fromstring(html, create_parent="div")
    spell_level = min((entry["level"] for entry in sheet.get("levels") or []), default=None)
    items, heading = [], None
    for element in root:
        if element.tag in ("h3", "h4", "h5", "h6"):
            heading = _spaces(element.text_content()).capitalize()
        elif element.tag == "table":
            headers = [_spaces(th.text_content()).lower() for th in (element.xpath(".//tr[th]") or [[]])[0]]
            column = next((i for i, h in enumerate(headers) if CREATURE_COLUMN_RE.search(h)), 0)
            for row in element.xpath(".//tr[td]"):
                cells = row.xpath("./td")
                if len(cells) <= column or _spaces(cells[0].text_content())[:1].isdigit() and not column:
                    continue  # "¹ may be summoned only into…"
                cell = deepcopy(cells[column])
                for note in cell.xpath(".//sup"):  # footnote marks
                    note.drop_tree()
                names = _spaces(cell.text_content())
                row_heading = heading
                if column:  # "1st | Human warrior skeleton (MM 226), kobold zombie (MM 267)"
                    label = _spaces(cells[0].text_content())
                    level = re.fullmatch(r"(\d)(?:st|nd|rd|th)(?: level)?", label, re.I)
                    if level and spell_level is not None and int(level[1]) > spell_level:
                        continue
                    row_heading = f"{label} level" if level and "level" not in label.lower() else label
                for name in _split_items(names) if column else [names]:  # "Fiendish shark, Medium" is one
                    if name and len(name) <= 60:
                        items.append({"heading": row_heading, "text": name})
        elif element.tag == "p":
            line = LIST_LINE_RE.match(_spaces(element.text_content()))
            if line:
                items += [{"heading": _spaces(line["label"]), "text": name} for name in _split_items(line["items"])]
    return items


# --- matching the names with the SRD index ---

def parse_index(html):
    """[{name, url}] of the SRD monster index, in its order, once per name."""
    root = lxml.html.fromstring(html)
    entries, seen = [], set()
    for link in root.xpath('//a[starts-with(@href, "/srd/")]'):
        name = _spaces(link.text_content())
        if name and _key(name) not in seen:
            seen.add(_key(name))
            entries.append({"name": name, "url": SITE + link.get("href")})
    return entries


def index_table(entries):
    """Lowercase name -> entry; "Dog, Riding" is also "riding dog", "Hellcat (Bezekira)" also "hellcat"."""
    table = {}
    for entry in entries:
        key = _key(entry["name"])
        table.setdefault(key, entry)
        key = _key(re.sub(r"\([^)]*\)", " ", key))
        table.setdefault(key, entry)
        if key.count(",") == 1:
            first, second = (part.strip() for part in key.split(","))
            table.setdefault(f"{second} {first}", entry)
    return table


def match(text, table):
    """The SRD entry of a listed name: {name, url} or None, the templates ([{name, url}]) and a note
    (the size or what was in parentheses: "Skeleton (Large)" -> Skeleton, "Large")."""
    notes = re.findall(r"\(([^)]*)\)", text)
    words = _key(re.sub(r"\([^)]*\)", " ", text))
    templates = []
    while True:
        first = words.split(" ", 1)
        if len(first) == 2 and first[0] in TEMPLATES and TEMPLATES[first[0]].lower() in table:
            templates.append(table[TEMPLATES[first[0]].lower()])
            words = first[1]
        else:
            break
    sizes = []

    def without_sizes(part):
        kept = []
        for word in part.split():
            (sizes if word in SIZES else kept).append(word)
        return " ".join(kept)

    parts = [without_sizes(part) for part in words.split(",")]
    main, extra = parts[0], " ".join(p for p in parts[1:] if p)
    candidates = [f"{extra} {main}", f"{main}, {extra}", main] if extra else [main]
    found = next((table[c] for c in candidates if c in table), None)
    if not found:  # "giant fire beetle"... then fewer words from the start, then the singular
        for candidate in candidates:
            words_left = candidate.split()
            for start in range(1, len(words_left)):
                if " ".join(words_left[start:]) in table:
                    found = table[" ".join(words_left[start:])]
                    break
            found = found or table.get(candidate.removesuffix("s"))
            if found:
                break
    notes = [_spaces(n) for n in notes if _spaces(n) and not re.fullmatch(r"[A-Z][A-Za-z]{1,4}\s*\d+", _spaces(n))]
    note = ", ".join([s.capitalize() for s in sizes] + notes)
    return found, templates, note


# --- the SRD pages ---

def _content(root):
    """The elements of the page's text: from the h1 to the footer, without ads and scripts."""
    body = root.xpath("//body")
    elements, started = [], False
    for element in (body[0] if body else []):
        if not isinstance(element.tag, str):
            continue
        if element.tag == "h1":
            started = True
        if element.tag == "div" and "footer" in (element.get("class") or ""):
            break
        if started and element.tag not in ("div", "script", "noscript", "ins", "iframe", "style"):
            elements.append(element)
    return elements


def _level(element):
    return int(element.tag[1]) if re.fullmatch(r"h[1-6]", element.tag or "") else None


def _section(elements, anchor):
    """(heading text, the elements of the section with that id, the page's introduction before it).
    Without an anchor, or if it isn't there: the whole page and no introduction."""
    start = next((i for i, e in enumerate(elements) if e.get("id") == anchor), None) if anchor else None
    if start is None:
        return _spaces(elements[0].text_content()) if elements else "", elements, []
    level = _level(elements[start]) or 2
    end = next((i for i in range(start + 1, len(elements))
                if _level(elements[i]) and _level(elements[i]) <= level), len(elements))
    intro_end = next((i for i, e in enumerate(elements[:start])
                      if i and e.get("id") and _level(e) and _level(e) <= level), start)
    return _spaces(elements[start].text_content()), elements[start + 1:end], elements[1:intro_end]


def clean(elements):
    """HTML of the elements with text and table tags only, measurements in metric units. Links are dropped,
    except those to SRD spells, which become <a data-spell="name">."""
    parts = []
    for original in elements:
        element = deepcopy(original)
        for node in list(element.iter()):
            if not isinstance(node.tag, str) or node.tag in ("script", "style", "noscript", "iframe"):
                if node is not element:
                    node.drop_tree()
                continue
            spell = node.tag == "a" and SRD_SPELL_LINK_RE.search(node.get("href") or "")
            for name in list(node.attrib):
                if name not in KEPT_ATTRIBUTES:
                    del node.attrib[name]
            if spell and _spaces(node.text_content()):
                node.set("data-spell", _spaces(node.text_content()))
            elif node.tag not in TEXT_TAGS and node is not element:
                node.drop_tag()
        if element.tag in TEXT_TAGS:
            parts.append(lxml.html.tostring(element, encoding="unicode", with_tail=False))
    return units.convert_text(re.sub(r"\s+", " ", "".join(parts)).strip())


def types_of(elements):
    """Type and subtypes from the "Size/Type:" rows of the stat blocks ("Medium Undead (Incorporeal)").
    Only the subtypes every stat block has: the sample skeletons include a red dragon one (Fire)."""
    kind, subtypes = None, None
    for row in (r for e in elements for r in e.xpath(".//tr")):
        header = row.xpath("./th")
        if not header or not _spaces(header[0].text_content()).lower().startswith("size/type"):
            continue
        for cell in row.xpath("./td"):
            found = SIZE_TYPE_RE.match(_spaces(cell.text_content()))
            if not found:
                continue
            kind = kind or found["type"].title()
            these = [_spaces(s).title() for s in (found["subtypes"] or "").split(",") if _spaces(s)]
            subtypes = these if subtypes is None else [s for s in subtypes if s in these]
    return kind, subtypes or []


def parse_creature(html, entry):
    root = lxml.html.fromstring(html)
    elements = _content(root)
    anchor = urllib.parse.urlparse(entry["url"]).fragment
    heading, section, intro = _section(elements, anchor)
    kind, subtypes = types_of(section)
    return {
        "id": creature_id(entry["url"]),
        "format": FORMAT,
        "name": entry["name"],
        "url": entry["url"],
        "type": kind,
        "subtypes": subtypes,
        "html": clean(section),
        # e.g. the demons' traits above the Dretch, or what all elementals share
        "intro_name": _spaces(elements[0].text_content()) if intro else None,
        "intro_html": clean(intro) if intro else None,
        "heading": heading,
        "downloaded_at": now(),
    }


def parse_types(html):
    """"undeadType" / "incorporealSubtype" -> {name, html} from the SRD types and subtypes page."""
    elements = _content(lxml.html.fromstring(html))
    found = {}
    for i, element in enumerate(elements):
        if element.tag == "h3" and element.get("id"):
            end = next((j for j in range(i + 1, len(elements)) if elements[j].tag in ("h1", "h2", "h3")), len(elements))
            found[element.get("id")] = {"name": _spaces(element.text_content()), "html": clean(elements[i + 1:end])}
    if not any(key.endswith("Type") for key in found):
        raise MonsterError("the SRD types page has changed: no types found.")
    return found


# --- pictures ---

def parse_gallery(html):
    """[{file, caption, artist, page}] of the Monster Manual v.3.5 art gallery: each picture is a table cell
    with its thumbnail (tn_MM35_PG10.jpg: page 10), the caption under it and "Artist: …" in the alt text."""
    root = lxml.html.fromstring(html)
    pictures = []
    for cell in root.xpath('//td[not(.//td)][.//img[contains(@src, "tn_MM35_PG")]]'):
        image = cell.xpath('.//img[contains(@src, "tn_MM35_PG")]')[0]
        found = re.search(r"tn_(MM35_PG(\w+)\.jpg)", image.get("src"))
        caption = _spaces(" ".join(cell.xpath(".//span//text()")))
        if found and caption and len(caption) <= 40:  # the introduction is in a cell of its own
            pictures.append({"file": found[1], "caption": caption.replace('"', ""),
                             "artist": re.sub(r"^Artist:\s*", "", image.get("alt") or "").strip(), "page": found[2]})
    return pictures


def _names(name):
    """"Dog, Riding" -> "dog, riding", "riding dog"; "Hellcat (Bezekira)" -> also "hellcat"."""
    key = _key(name)
    names = {key, _key(re.sub(r"\([^)]*\)", " ", key))}
    for item in list(names):
        if item.count(",") == 1:
            first, second = (part.strip() for part in item.split(","))
            names.add(f"{second} {first}")
    return names


def _singular(text):
    return re.sub(r"(?<=[a-z])s$", "", text)


def pictures_for(creature, art, families=()):
    """The gallery pictures of a creature: its own (by name), otherwise the group pictures of its family
    ("Demons", "More Demons"… for a Dretch). `families`: the name of the page it shares with the others, and its
    subtypes (a Leonal has its own page, but it is a Guardinal). A picture of another member ("Earth Elemental"
    for the air elemental) isn't used: it shows someone else."""
    names = _names(creature["name"]) | _names(creature.get("heading") or "")
    own = [{**p, "source": "mm35", "group": False} for p in art if _key(p["caption"]) in names]
    if own:
        return own
    families = {_singular(_key(family).split(",")[0]) for family in families if family}
    return [{**p, "source": "mm35", "group": True} for p in art
            if _singular(re.sub(r"^(?:(?:even|still)\s+)?more\s+", "", _key(p["caption"]))) in families]


def wikipedia_picture(creature):
    """The photo of a real animal's Wikipedia article: {file, caption, source, url} or None.
    MonsterError when Wikipedia can't be reached."""
    if creature.get("type") != "Animal" or "dire" in _key(creature["name"]):
        return None
    titles = [WIKIPEDIA_TITLES[creature["name"]]] if creature["name"] in WIKIPEDIA_TITLES else []
    titles += sorted(_names(creature["name"]), key=lambda n: ("," in n, len(n)))
    for title in titles:
        try:
            summary = json.loads(download(WIKIPEDIA_URL.format(urllib.parse.quote(title.replace(" ", "_")))))
        except MonsterError as error:
            if "error 404" in str(error):
                continue
            raise
        except ValueError:
            continue
        original, thumbnail = summary.get("originalimage") or {}, summary.get("thumbnail") or {}
        if summary.get("type") != "standard" or not (original or thumbnail):
            continue
        source = original.get("source", "")
        if not source or original.get("width", 10000) > 800 or not IMAGE_FILE_RE.match(Path(urllib.parse.urlparse(source).path).name.lower()):
            # 500 px: Wikimedia only makes its standard thumbnail widths (330, 500, 960…), 640 is refused
            source = re.sub(r"/\d+px-", "/500px-", thumbnail.get("source", ""))
        extension = Path(urllib.parse.urlparse(source).path).suffix.lower()
        if not source or extension not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            continue
        return {"file": f"wikipedia--{creature['id']}{extension}", "image_url": source, "source": "wikipedia",
                "caption": summary.get("title") or title,
                "url": ((summary.get("content_urls") or {}).get("desktop") or {}).get("page", "")}
    return None


def type_keys(creature):
    keys = [_camel(creature["type"]) + "Type"] if creature.get("type") else []
    return keys + [_camel(s) + "Subtype" for s in creature.get("subtypes") or []]


class Library:
    """The SRD index, types and creatures saved in <data>/monsters. One download at a time (lock)."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self.lock = threading.Lock()
        self._memory = {}

    def _file(self, name):
        return self.folder / f"{name}.json"

    def _load(self, name):
        if name not in self._memory:
            try:
                self._memory[name] = json.loads(self._file(name).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return None
        return self._memory[name]

    def _save(self, name, data):
        self.folder.mkdir(parents=True, exist_ok=True)
        tmp = self._file(name).with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self._file(name))
        self._memory[name] = data

    def _index(self):
        data = self._load("index")
        if not data:
            try:
                entries = parse_index(download(INDEX_URL))
            except (lxml.etree.LxmlError, ValueError) as error:
                raise MonsterError(f"the SRD monster index could not be read ({error}).")
            if len(entries) < 100:
                raise MonsterError("the SRD monster index has changed: too few monsters found.")
            data = {"source": INDEX_URL, "downloaded_at": now(), "entries": entries}
            self._save("index", data)
        return data["entries"]

    def _types(self):
        data = self._load("types")
        if not data or data.get("format", 1) < FORMAT:
            try:
                types = parse_types(download(TYPES_URL))
            except (lxml.etree.LxmlError, ValueError) as error:
                raise MonsterError(f"the SRD types page could not be read ({error}).")
            data = {"source": TYPES_URL, "format": FORMAT, "downloaded_at": now(), "types": types}
            self._save("types", data)
        return data["types"]

    def _art(self):
        data = self._load("art")
        if not data:
            try:
                images = parse_gallery(download(GALLERY_URL))
            except (lxml.etree.LxmlError, ValueError) as error:
                raise MonsterError(f"the Monster Manual art gallery could not be read ({error}).")
            if len(images) < 150:
                raise MonsterError("the Monster Manual art gallery has changed: too few pictures found.")
            data = {"source": GALLERY_URL, "downloaded_at": now(), "images": images}
            self._save("art", data)
        return data["images"]

    def image_file(self, name):
        """Path of a saved picture, or None (also for names that aren't plain image file names)."""
        path = self.folder / "images" / name
        return path if IMAGE_FILE_RE.match(name or "") and path.is_file() else None

    def _add_pictures(self, keys, entries):
        """Adds `pictures` to the creatures that don't have it yet (it stays missing, to be tried again later,
        if the gallery or Wikipedia can't be reached), then downloads the image files not saved yet. Pictures
        are a bonus: nothing here makes the creatures fail."""
        family_pages = {e["url"].split("#")[0] for e in entries if "#" in e["url"]}
        page_names = {e["url"]: e["name"] for e in entries if "#" not in e["url"]}
        try:
            art = self._art()
        except MonsterError:
            return
        for key in keys:
            creature = self._load(key)
            if "pictures" in creature:
                continue
            page = creature["url"].split("#")[0]
            family = (page_names.get(page) or creature.get("intro_name")) if page in family_pages else None
            pictures = pictures_for(creature, art, [family, *creature.get("subtypes", [])])
            try:
                photo = None if pictures else wikipedia_picture(creature)
            except MonsterError:
                continue
            self._save(key, {**creature, "pictures": pictures + ([photo] if photo else [])})
        wanted = {}
        for key in keys:
            for picture in self._load(key).get("pictures", []):
                if not self.image_file(picture["file"]):
                    wanted[picture["file"]] = picture.get("image_url") or GALLERY_IMAGE_URL.format(picture["file"])
        folder = self.folder / "images"
        folder.mkdir(parents=True, exist_ok=True)

        def fetch(item):
            name, url = item
            try:
                data = download(url)
            except MonsterError:
                return  # tried again the next time
            tmp = folder / f"{name}.tmp"
            tmp.write_bytes(data)
            os.replace(tmp, folder / name)

        with ThreadPoolExecutor(2) as pool:  # the Internet Archive is slow: two at a time
            list(pool.map(fetch, wanted.items()))

    def resolve(self, groups):
        """groups: [{…, items: [{heading, text}]}]. Adds to every item `creature` (id or None), `templates`
        (ids) and `note`, downloading what is missing; returns (groups, creatures by id, types by key).
        MonsterError when d20srd can't be reached and something is missing."""
        with self.lock:
            table = index_table(self._index())
            wanted = {}
            for group in groups:
                for item in group["items"]:
                    found, templates, note = match(item["text"], table)
                    item.update(creature=creature_id(found["url"]) if found else None, note=note,
                                templates=[creature_id(t["url"]) for t in templates])
                    for entry in ([found] if found else []) + templates:
                        wanted[creature_id(entry["url"])] = entry
            # an older file is read again (its pictures are worked out again from the saved files)
            missing = [entry for key, entry in wanted.items() if (self._load(key) or {}).get("format", 1) < FORMAT]
            pages = {}
            for entry in missing:
                pages.setdefault(entry["url"].split("#")[0], []).append(entry)
            with ThreadPoolExecutor(4) as pool:
                for (page, page_entries), html in zip(pages.items(), pool.map(download, pages)):
                    for entry in page_entries:
                        try:
                            creature = parse_creature(html, entry)
                        except (lxml.etree.LxmlError, ValueError) as error:
                            raise MonsterError(f"{page} could not be read ({error}).")
                        self._save(creature_id(entry["url"]), creature)
            self._add_pictures(list(wanted), self._index())
            creatures = {key: {**self._load(key), "type_keys": type_keys(self._load(key))} for key in wanted}
            types = self._types() if any(type_keys(c) for c in creatures.values()) else {}
            shown_types = {key: types[key] for c in creatures.values() for key in type_keys(c) if key in types}
            return groups, creatures, shown_types
