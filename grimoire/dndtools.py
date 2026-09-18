"""Downloads and parses the spell pages of dndtools.net.

Public functions:
    normalize_url(url) -> (canonical_url, spell_id)
    download_spell(url) -> dict with all the data of the sheet
    parse_page(html, url) -> dict (also used in tests, without network)

Measurements in the stats and in the description are converted to metric units (units.py).
"""

import html
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from lxml import etree
from lxml import html as LH

from . import units

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"

# A few slugs have capital letters (/spell-compendium--86/Solipism--4190/): dndtools serves them only that way
URL_RE = re.compile(
    r"^https?://(?:www\.)?dndtools\.net/spells/"
    r"(?P<rulebook>[A-Za-z0-9-]+--\d+)/(?P<slug>[A-Za-z0-9-]+)--(?P<id>\d+)/?(?:[?#].*)?$"
)

# Stat labels on dndtools -> key in the JSON
STATS = {
    "Casting Time": "casting_time",
    "Range": "range",
    "Target": "target",
    "Targets": "target",
    "Area": "area",
    "Effect": "effect",
    "Duration": "duration",
    "Saving Throw": "saving_throw",
    "Spell Resistance": "spell_resistance",
}

ALLOWED_TAGS = {"p", "br", "em", "i", "strong", "b", "table", "thead", "tbody",
                "tr", "th", "td", "ul", "ol", "li", "h3", "h4", "h5", "sup", "sub"}

# A line starting with "Something:" (e.g. "Material Component:", "2nd Round:") starts a paragraph
LABEL_RE = re.compile(r"^(?:<[^>]+>)*[A-Z0-9][^.:<>]{0,45}:")


# Link to another spell inside the description (relative or absolute)
SPELL_LINK_RE = re.compile(
    r"^(?:https?://(?:www\.)?dndtools\.net)?/spells/(?P<rulebook>[A-Za-z0-9-]+--\d+)/(?P<slug>[A-Za-z0-9-]+)--(?P<id>\d+)/?$")
# "This spell functions like <a>protection from evil</a>, except..."
BASED_ON_RE = re.compile(
    r"(?:functions?|works?|operates?|is\s+(?:identical|similar))\s+(?:just\s+|exactly\s+|much\s+)?"
    r"(?:like|as|to)\s+(?:an?\s+|the\s+)?(?:<[^>]+>\s*)*<a data-ref=\"(\d+)\"", re.I)


# Same sentence without a link: "functions like hold person, except", "As fly (see page 232...)"
NAME_END = r"(?=\s*(?:[,.;:(]|\bexcept\b|\bwith\b|\bbut\b|\bspell\b|\bin\s+that\b|$))"
BASED_ON_TEXT_RE = [
    re.compile(r"\b(?:functions?|works?|operates?)\s+(?:just\s+|exactly\s+|much\s+)?(?:like|as)\s+(?:an?\s+|the\s+)?"
               r"(?P<name>[A-Za-z'’][\w'’ /-]{1,45}?)" + NAME_END, re.I),
    re.compile(r"\bis\s+(?:identical|similar)\s+to\s+(?:an?\s+|the\s+)?(?P<name>[A-Za-z'’][\w'’ /-]{1,45}?)" + NAME_END, re.I),
    re.compile(r"^\s*As\s+(?:an?\s+|the\s+)?(?P<name>[A-Za-z'’][\w'’ /-]{1,45}?)" + NAME_END),
]
SEARCH_PAGES = 8  # the dndtools search shows 20 results per page, in alphabetical order
RETRIES = 2  # extra attempts after a server error or a network problem (dndtools is sometimes slow or busy)


class DndtoolsError(Exception):
    """Error with a message to show to the user."""


class NotFound(DndtoolsError):
    """dndtools has no such page (HTTP 404)."""


def normalize_url(url):
    match = URL_RE.match((url or "").strip())
    if not match:
        raise DndtoolsError(
            "The link must point to a spell page on dndtools.net, for example "
            "https://dndtools.net/spells/players-handbook-v35--6/grease--2396/"
        )
    canonical = (f"https://dndtools.net/spells/{match['rulebook']}/"
                 f"{match['slug']}--{match['id']}/")
    return canonical, match["id"]


def _download_page(url):
    """Text of a dndtools page. Server errors and network problems are retried after 0.5 s and 1.5 s."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise NotFound("dndtools has no such page (error 404): check the link.")
            if error.code < 500 or attempt == RETRIES:
                raise DndtoolsError(f"dndtools answered with error {error.code}. Try again in a moment.")
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == RETRIES:
                raise DndtoolsError(f"Could not reach dndtools.net ({error}). Are you connected to the internet?")
        time.sleep(0.5 * 3 ** attempt)


def download_spell(url):
    canonical, _ = normalize_url(url)
    return parse_page(_download_page(canonical), canonical)


def name_variants(name):
    """"greater invisibility" -> also "invisibility, greater" (the dndtools naming)."""
    name = _spaces(name).replace("’", "'").strip(" '")
    variants = [name]
    found = re.match(r"^(greater|lesser|mass|improved|quickened|swift)\s+(.+)$", name, re.I)
    if found:
        variants.append(f"{found.group(2)}, {found.group(1)}")
    return variants


def search_spell(name, preferred_url=""):
    """URL of the sheet with exactly this name, searched on dndtools. With equal names it prefers
    the rulebook of the spell that references it, then the Player's Handbook 3.5, then any 3.5 rulebook."""
    url_match = URL_RE.match(preferred_url or "")
    preferred_rulebook = url_match.group("rulebook") if url_match else None
    for variant in name_variants(name):
        target = variant.lower()
        candidates = []
        for page in range(1, SEARCH_PAGES + 1):
            address = "https://dndtools.net/spells/?" + urllib.parse.urlencode({"name": variant, "page": page})
            try:
                doc = LH.fromstring(_download_page(address))
            except DndtoolsError:
                if page == 1:
                    raise  # dndtools unreachable: the caller will try again later
                break
            rows = doc.xpath("//table//tr[td]")
            for row in rows:
                cells = row.xpath("./td")
                link = cells[0].xpath('.//a[starts-with(@href, "/spells/")]')
                if link and _spaces(link[0].text_content()).replace("’", "'").lower() == target:
                    rulebook = cells[2].xpath('.//a/@href') if len(cells) > 2 else []
                    candidates.append(("https://dndtools.net" + link[0].get("href"), rulebook[0] if rulebook else ""))
            last = _spaces(rows[-1].xpath("./td")[0].text_content()).lower() if rows else ""
            if len(rows) < 20 or last > target:
                break
        if candidates:
            def score(candidate):
                url, rulebook = candidate
                return (preferred_rulebook is None or f"/{preferred_rulebook}/" not in url,
                        "/players-handbook-v35--6/" not in url, "-35--" not in rulebook)
            return sorted(candidates, key=score)[0][0]
    return None


def unlinked_base_name(description_html):
    """Name of the spell this one "functions like", when dndtools didn't add the link."""
    text = _spaces(re.sub(r"<[^>]+>", " ", description_html))
    for pattern in BASED_ON_TEXT_RE:
        found = pattern.search(text)
        if found and len(found.group("name").split()) <= 6:
            return found.group("name").strip()
    return None


def link_name(description_html, name, spell_id):
    """Turns the first occurrence of the name (outside tags and existing links) into a data-ref link."""
    pattern = re.compile(r"(?<![\w'])(" + re.escape(name).replace(r"\ ", r"\s+") + r")(?![\w'])", re.I)
    parts = re.split(r"(<a\b[^>]*>.*?</a>|<[^>]+>)", description_html, flags=re.S)
    for i, part in enumerate(parts):
        if part.startswith("<"):
            continue
        linked, count = pattern.subn(lambda m: f'<a data-ref="{spell_id}">{m.group(1)}</a>', part, count=1)
        if count:
            parts[i] = linked
            return "".join(parts)
    return description_html


def _spaces(text):
    return re.sub(r"\s+", " ", html.unescape(text or "")).strip()


def _text_until_break(element):
    """Text following an element (e.g. <strong>Range:</strong>) up to the next <br> or <strong>."""
    parts = [element.tail or ""]
    for sibling in element.itersiblings():
        if sibling.tag in ("br", "strong", "div"):
            break
        parts.append(sibling.text_content())
        parts.append(sibling.tail or "")
    return _spaces("".join(parts))


def _clean_html(element):
    """Copies the tree keeping only the allowed tags and no attributes."""
    for child in list(element.iter()):
        if not isinstance(child.tag, str):  # comments etc.
            child.drop_tree()
    for child in list(element.iterdescendants()):
        link = SPELL_LINK_RE.match(child.get("href", "")) if child.tag == "a" else None
        if link:  # links to other spells stay, with just the numeric ID
            child.attrib.clear()
            child.set("data-ref", link.group("id"))
        elif child.tag not in ALLOWED_TAGS:
            child.drop_tag()
        else:
            child.attrib.clear()
    return element


def _serialize_inner(element):
    text = html.escape(element.text or "", quote=False)
    for child in element:
        text += etree.tostring(child, encoding="unicode", method="html", with_tail=True)
    return text


def _reflow_paragraph(paragraph):
    """dndtools often separates every sentence with <br>: rebuilds real paragraphs."""
    segments = re.split(r"<br\s*/?>", _serialize_inner(paragraph))
    blocks, current = [], ""
    for segment in (s.strip() for s in segments):
        if not segment:
            continue
        new_block = not current or LABEL_RE.match(segment) or current.rstrip().endswith(":")
        if new_block:
            if current:
                blocks.append(current)
            current = segment
        else:
            current += " " + segment
    if current:
        blocks.append(current)
    return "".join(f"<p>{b}</p>" for b in blocks)


def _description(content):
    block = content.xpath('.//div[contains(concat(" ", @class, " "), " nice-textile ")]')
    if not block:
        return "", "", []
    references = {}
    for link in block[0].xpath(".//a[@href]"):
        found = SPELL_LINK_RE.match(link.get("href"))
        if found and found.group("id") not in references:
            references[found.group("id")] = {
                "id": found.group("id"),
                "name": _spaces(link.text_content()),
                "url": f"https://dndtools.net/spells/{found.group('rulebook')}/{found.group('slug')}--{found.group('id')}/",
            }
    root = _clean_html(block[0])
    parts = []
    if root.text and root.text.strip():
        parts.append(f"<p>{html.escape(root.text.strip(), quote=False)}</p>")
    for child in root:
        if child.tag == "p":
            parts.append(_reflow_paragraph(child))
        elif child.tag != "br":
            parts.append(etree.tostring(child, encoding="unicode", method="html", with_tail=False))
        if child.tail and child.tail.strip():
            parts.append(f"<p>{html.escape(child.tail.strip(), quote=False)}</p>")
    description_html = "".join(parts)
    return description_html, _summary(description_html), list(references.values())


def _summary(description_html, minimum=140, maximum=280):
    paragraphs = re.findall(r"<p>(.*?)</p>", description_html, flags=re.S)
    # skip the leading italic flavor text (typical of the Spell Compendium)
    useful = [p for p in paragraphs if not re.fullmatch(r"\s*<(em|i)>.*</\1>\s*", p, flags=re.S)]
    text = _spaces(re.sub(r"<[^>]+>", "", " ".join(useful or paragraphs)))
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", text)
    summary = ""
    for sentence in sentences:
        if summary and len(summary) >= minimum:
            break
        summary = f"{summary} {sentence}".strip()
    if len(summary) > maximum:
        summary = summary[:maximum].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return summary


def parse_page(page_html, url):
    canonical, spell_id = normalize_url(url)
    doc = LH.fromstring(page_html)
    found = doc.xpath('//div[@id="content"]')
    title = found[0].xpath(".//h2") if found else []
    if not title:
        raise DndtoolsError("This page does not look like a spell page: no spell name found.")
    content = found[0]

    rulebook = content.xpath('.//a[starts-with(@href, "/rulebooks/")]')
    page = re.search(r"p\.\s*(\d+)", _spaces(rulebook[0].tail)) if rulebook else None
    rulebook_href = rulebook[0].get("href", "") if rulebook else ""

    levels = []
    for link in content.xpath('.//a[starts-with(@href, "/classes/")][contains(@href, "spells-level-")]'):
        number = re.search(r"spells-level-(\d+)", link.get("href"))
        caster_class = re.sub(r"\s+\d+$", "", _spaces(link.text_content()))
        levels.append({"caster_class": caster_class, "level": int(number.group(1))})
    domains = []
    for link in content.xpath('.//a[starts-with(@href, "/spells/domains/")]'):
        number = re.match(r"\s*(\d+)", link.tail or "")
        if number:
            domains.append({"domain": _spaces(link.text_content()), "level": int(number.group(1))})

    stats, components = {}, []
    for label in content.xpath(".//strong"):
        name = _spaces(label.text_content()).rstrip(":")
        if name == "Components":
            items = []
            for sibling in label.itersiblings():
                if sibling.tag in ("br", "strong", "div"):
                    break
                items.append(_spaces(sibling.text_content()))
            components = [c for c in dict.fromkeys(items) if c]
        elif name in STATS:
            stats[STATS[name]] = _text_until_break(label)

    also_appears = []
    for heading in content.xpath(".//h3"):
        if "Also appears" in heading.text_content():
            following = heading.getnext()
            if following is not None:
                also_appears = [_spaces(a.text_content()) for a in following.xpath(".//a")]

    description_html, summary, references = _description(content)
    references = [r for r in references if r["id"] != spell_id]
    based_on = BASED_ON_RE.search(description_html)
    based_on = based_on.group(1) if based_on and based_on.group(1) != spell_id else None
    based_on_name = None
    if not based_on:
        based_on_name = unlinked_base_name(description_html)
        by_name = {r["name"].lower(): r["id"] for r in references}
        if based_on_name and based_on_name.lower() in by_name:
            based_on, based_on_name = by_name[based_on_name.lower()], None
    if not based_on and not based_on_name and not stats and references:
        based_on = references[0]["id"]  # no stats of its own: they come from the first referenced spell
    slug = re.search(r"/([A-Za-z0-9-]+)--\d+/$", canonical).group(1)

    return units.convert_spell({
        "id": spell_id,
        "slug": slug,
        "url": canonical,
        "name": _spaces(title[0].text_content()),
        "rulebook": _spaces(rulebook[0].text_content()) if rulebook else "",
        "page": int(page.group(1)) if page else None,
        "edition_35": "-35--" in rulebook_href,
        "school": _spaces(" ".join(a.text_content() for a in content.xpath('.//a[starts-with(@href, "/spells/schools/")]'))),
        "subschools": [_spaces(a.text_content()) for a in content.xpath('.//a[starts-with(@href, "/spells/sub-schools/")]')],
        "descriptors": [_spaces(a.text_content()) for a in content.xpath('.//a[starts-with(@href, "/spells/descriptors/")]')],
        "levels": levels,
        "domains": domains,
        "components": components,
        "stats": stats,
        "description_html": description_html,
        "summary": summary,
        "references": references,
        "based_on": based_on,
        "based_on_name": based_on_name,  # unlinked name, to search on dndtools (see server.py)
        "also_appears_in": also_appears,
        "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
