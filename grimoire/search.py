"""Searches the dndtools spell list with the filters of https://dndtools.net/spells/.

Public functions:
    filter_options() -> {filter name: [{value, label, group?}]}, read from the dndtools search form
    clean_filters(filters) -> only the known filters, with valid values
    search(filters, pool, progress) -> {"results": [...], "incomplete": bool, "stopped": bool}

dndtools quirks handled here:
- its class and domain filters don't tie the level to that class or domain ("Wizard" + level 1 also
  returns Resist Energy, which is Ranger 1 but Wizard 2): for a class the exact lists
  /classes/<class>/spells-level-<n>/ are used, for a domain the page of every candidate is checked;
- its "items per page" option answers with an error, so results come 20 per page: the pages are
  fetched in parallel (`pool`), and `progress.add(n)` / `progress.step()` report how many are done. There is no
  limit on the pages: when `progress.cancelled` becomes true (the user pressed "Stop") the pages not yet
  downloaded are skipped and the results found so far are returned;
- the same spell can appear more than once in the results;
- names are "Invisibility, Greater", "Cure Light Wounds, Mass": a name is searched word by word, in any order
  (dndtools gets only the longest word, the rest is checked here);
- a few spell links have capital letters ("/Solipism--4190/"): they are kept as they are.

The editions are always checked here, not by dndtools, so the search can tell how many spells only the
editions left out (`other_editions`).
"""

import math
import re
import threading
import urllib.parse

from lxml import html as LH

from . import dndtools, units

BASE = "https://dndtools.net"
PAGE_SIZE = 20
WORKERS = 4            # parallel requests to dndtools

TEXT_FILTERS = ("name", "casting_time", "range", "area", "duration", "saving_throw", "spell_resistance", "description")
SELECT_FILTERS = ("school__slug", "sub_school__slug", "descriptors__slug", "rulebook__slug",
                  "class_levels__slug", "domain_levels__slug")
COMPONENT_FILTERS = ("verbal_component", "somatic_component", "material_component",
                     "arcane_focus_component", "divine_focus_component", "xp_component")
MULTI_FILTERS = ("rulebook__dnd_edition__slug", "spellclasslevel__level", "spelldomainlevel__level")
# filters that the exact class lists can check by themselves; the others need the dndtools search
LOCAL_FILTERS = ("name", "school__slug", "rulebook__slug", "rulebook__dnd_edition__slug")
SLUG_RE = re.compile(r"^[a-z0-9-]{1,80}$")
ROW_BOOK_RE = re.compile(r"^/rulebooks/([A-Za-z0-9-]+)--\d+/([A-Za-z0-9-]+)--\d+/")


def _spaces(text):
    return re.sub(r"\s+", " ", text or "").strip()


def name_words(text):
    """"Greater Invisibility" -> ["greater", "invisibility"]; curly apostrophes (phones) become straight ones."""
    text = (text or "").lower().replace("’", "'").replace("‘", "'")
    return [word.strip("'") for word in re.findall(r"[\w']+", text) if word.strip("'")]


def name_matches(name, words):
    """True if every word is in the name, in any order ("greater invisibility" finds "Invisibility, Greater")."""
    name = " ".join(name_words(name))
    return all(word in name for word in words)


def remote_filters(filters):
    """The filters sent to dndtools: no editions (checked here) and only the longest word of the name."""
    remote = {key: value for key, value in filters.items() if key != "rulebook__dnd_edition__slug"}
    words = name_words(filters.get("name"))
    if words:
        remote["name"] = max(words, key=len)
    else:
        remote.pop("name", None)
    return remote


def filter_options():
    """Choices of every select of the dndtools search form ("---------" and "Unknown" left out).
    Component filters keep dndtools' values: 1 = any, 2 = yes, 3 = no."""
    doc = LH.fromstring(dndtools._download_page(BASE + "/spells/"))
    forms = doc.xpath('//form[@action="/spells/"]')
    if not forms:
        raise dndtools.DndtoolsError("The dndtools search page has changed: its filters were not found.")
    options = {}
    for select in forms[0].xpath(".//select"):
        choices = []
        for option in select.xpath(".//option"):
            value = option.get("value") or ""
            if not value:
                continue
            parent = option.getparent()
            group = parent.get("label") if parent.tag == "optgroup" else None
            choices.append({"value": value, "label": _spaces(option.text_content()), **({"group": group} if group else {})})
        options[select.get("name")] = choices
    return options


def clean_filters(filters):
    filters = filters if isinstance(filters, dict) else {}
    clean = {}
    for key in TEXT_FILTERS:
        value = _spaces(str(filters.get(key) or ""))[:100]
        if value:
            clean[key] = value
    for key in SELECT_FILTERS:
        value = str(filters.get(key) or "").strip()
        if SLUG_RE.match(value):
            clean[key] = value
    for key in COMPONENT_FILTERS:
        value = str(filters.get(key) or "")
        if value in ("2", "3"):
            clean[key] = value
    for key in MULTI_FILTERS:
        values = filters.get(key) or []
        values = [str(v) for v in (values if isinstance(values, list) else [values])]
        if key.endswith("__level"):
            values = [v for v in values if v.isdigit() and int(v) <= 9]
        values = sorted({v for v in values if SLUG_RE.match(v)})
        if values:
            clean[key] = values
    return clean


def query(filters):
    """URL parameters for the dndtools search (lists become repeated parameters)."""
    params = []
    for key, value in filters.items():
        params += [(key, v) for v in value] if isinstance(value, list) else [(key, value)]
    return params


def page_url(path, params, page):
    params = list(params) + ([("page", page)] if page > 1 else [])
    return BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")


def parse_rows(page_html):
    """Rows of a dndtools spell table (search results, class and domain lists), and the total count."""
    doc = LH.fromstring(page_html)
    rows = []
    for tr in doc.xpath('//table[contains(concat(" ", @class, " "), " common ")]//tr[td]'):
        cells = tr.xpath("./td")
        link = cells[0].xpath('.//a[starts-with(@href, "/spells/")]') if len(cells) >= 8 else []
        if not link:
            continue
        try:
            url, spell_id = dndtools.normalize_url(BASE + link[0].get("href"))
        except dndtools.DndtoolsError:
            continue
        book = cells[2].xpath('.//a[starts-with(@href, "/rulebooks/")]/@href')
        book = ROW_BOOK_RE.match(book[0]) if book else None
        rows.append({
            "id": spell_id,
            "url": url,
            "name": _spaces(link[0].text_content()),
            "school": _spaces(cells[1].text_content()),
            "schools": re.findall(r"/spells/schools/([a-z0-9-]+)/", " ".join(cells[1].xpath(".//a/@href")).lower()),
            "rulebook": _spaces(cells[2].text_content()),
            "rulebook_slug": book.group(2).lower() if book else "",
            "edition": book.group(1).lower() if book else "",
            "duration": units.convert_text(_spaces(cells[4].text_content()), is_stat=True),
            "range": units.convert_text(_spaces(cells[5].text_content()), is_stat=True),
            "components": [_spaces(a.text_content()) for a in cells[6].xpath(".//abbr")],
            "casting_time": _spaces(cells[7].text_content()),
        })
    total = re.search(r"\(total ([\d,]+) items\)", page_html)
    return rows, int(total.group(1).replace(",", "")) if total else len(rows)


def stopped(progress):
    return bool(getattr(progress, "cancelled", False))


def fetch_lists(specs, pool, progress):
    """specs: [(key, path, params)] -> ({key: rows}, incomplete).
    Page 1 of every list first (it gives the totals), then all the other pages together."""
    progress.add(len(specs))

    def first(spec):
        _, path, params = spec
        if stopped(progress):
            progress.step()
            return [], 0
        try:
            return parse_rows(dndtools._download_page(page_url(path, params, 1)))
        except dndtools.NotFound:  # e.g. a level the class doesn't have
            return [], 0
        finally:
            progress.step()

    firsts = list(pool.map(first, specs))
    rest = []
    for spec, (_, total) in zip(specs, firsts):
        rest += [(spec, page) for page in range(2, math.ceil(total / PAGE_SIZE) + 1)]
    progress.add(len(rest))
    failed = threading.Event()

    def other(job):
        (key, path, params), page = job
        if stopped(progress):
            progress.step()
            return key, []
        try:
            return key, parse_rows(dndtools._download_page(page_url(path, params, page)))[0]
        except dndtools.DndtoolsError:
            failed.set()
            return key, []
        finally:
            progress.step()

    lists = {spec[0]: list(rows) for spec, (rows, _) in zip(specs, firsts)}
    for key, rows in pool.map(other, rest):
        lists[key] += rows
    return lists, failed.is_set()


def matches_locally(row, filters, editions=True):
    """The filters of LOCAL_FILTERS; editions=False leaves the editions out (to count what they hide)."""
    wanted = filters.get("rulebook__dnd_edition__slug") if editions else None
    return (name_matches(row["name"], name_words(filters.get("name")))
            and (not filters.get("school__slug") or filters["school__slug"] in row["schools"])
            and (not filters.get("rulebook__slug") or filters["rulebook__slug"] == row["rulebook_slug"])
            and (not wanted or row["edition"] in wanted))


def unique(rows):
    first = {}
    for row in rows:
        first.setdefault(row["id"], row)
    return list(first.values())


def check_domain_levels(rows, domain, levels, pool, progress):
    """Keeps the spells whose level in `domain` is one of `levels`, read from each spell's page."""
    wanted = {int(level) for level in levels}
    progress.add(len(rows))

    def domain_level(row):
        if stopped(progress):
            progress.step()
            return row, None
        try:
            doc = LH.fromstring(dndtools._download_page(row["url"]))
        except dndtools.DndtoolsError:
            return row, None
        finally:
            progress.step()
        for link in doc.xpath(f'//div[@id="content"]//a[@href="/spells/domains/{domain}/"]'):
            number = re.match(r"\s*(\d+)", link.tail or "")
            if number:
                return row, int(number.group(1))
        return row, None

    return [{**row, "domain_level": level} for row, level in pool.map(domain_level, rows) if level in wanted]


def search(filters, pool, progress):
    filters = clean_filters(filters)
    caster_class = filters.get("class_levels__slug")
    domain = filters.get("domain_levels__slug")
    domain_levels = filters.get("spelldomainlevel__level")
    if caster_class:
        levels = [int(level) for level in filters.get("spellclasslevel__level", [])] or list(range(10))
        specs = [(level, f"/classes/{caster_class}/spells-level-{level}/", []) for level in levels]
        lists, incomplete = fetch_lists(specs, pool, progress)
        found = {}
        for level in levels:
            for row in lists[level]:
                found.setdefault(row["id"], {**row, "level": level})
        rows = list(found.values())
        others = [key for key in filters if key not in LOCAL_FILTERS
                  and key not in ("class_levels__slug", "spellclasslevel__level")]
        if others and any(matches_locally(row, filters, editions=False) for row in rows):
            # the other filters need the dndtools search; without the level it is much faster,
            # and the level is already exact here
            narrowed = {key: value for key, value in filters.items() if key != "spellclasslevel__level"}
            searched, more_incomplete = fetch_lists([("search", "/spells/", query(remote_filters(narrowed)))], pool, progress)
            ids = {row["id"] for row in searched["search"]}
            rows = [row for row in rows if row["id"] in ids]
            incomplete = incomplete or more_incomplete
    else:
        lists, incomplete = fetch_lists([("search", "/spells/", query(remote_filters(filters)))], pool, progress)
        rows = unique(lists["search"])
    # dndtools had only the longest word of the name and no editions: the rest is checked here
    rows = [row for row in rows if matches_locally(row, filters, editions=False)]
    if domain and domain_levels:
        rows = check_domain_levels(rows, domain, domain_levels, pool, progress)
    shown = [row for row in rows if matches_locally(row, filters)]
    shown.sort(key=lambda row: (row.get("level", row.get("domain_level", 0)), row["name"].lower()))
    return {"results": shown, "other_editions": len(rows) - len(shown),
            "incomplete": incomplete and not stopped(progress), "stopped": stopped(progress)}
