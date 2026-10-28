#!/usr/bin/env python3
"""Downloads the condition summary from the SRD (d20srd.org) and saves it to web/conditions.json.

The interface uses the file, offline, to make the conditions mentioned in spell descriptions clickable.
server.py downloads it by itself when the file is missing or incomplete (`stored`, `download`, `save`);
`python3 -B -m grimoire.conditions` (from the project folder) downloads it again by hand, e.g. after changing
FORMS or EXCLUDED.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

sys.dont_write_bytecode = True
import lxml.html  # noqa: E402

from . import units  # noqa: E402

URL = "https://www.d20srd.org/srd/conditionSummary.htm"
# "Ability Score Loss": what a score of 0 does, ability by ability (the user asked for it in Ability Damaged/Drained)
ABILITY_LOSS_URL = "https://www.d20srd.org/srd/specialAbilities.htm"
ABILITY_CONDITIONS = ("abilityDamaged", "abilityDrained")
ABILITIES = ("Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma")
FORMAT = 2  # 2: with the ability scores at 0; an older file is downloaded again
OUTPUT = Path(__file__).resolve().parent.parent / "web" / "conditions.json"
TEXT_TAGS = {"p", "em", "i", "strong", "b", "a"}

# Words that name the condition in spell descriptions (lowercase, possibly several words).
FORMS = {
    "abilityDamaged": ["ability damaged", "ability damage"],
    "abilityDrained": ["ability drained", "ability drain"],
    "blinded": ["blinded", "blinds", "blindness", "blind"],
    "blownAway": ["blown away"],
    "checked": ["checked"],
    "confused": ["confused", "confusion"],
    "cowering": ["cowering", "cowers", "cower"],
    "dazed": ["dazed", "dazes"],
    "dazzled": ["dazzled", "dazzles"],
    "dead": ["dead"],
    "deafened": ["deafened", "deafens", "deafness", "deaf"],
    "disabled": ["disabled"],
    "dying": ["dying"],
    "energyDrained": ["energy drained", "energy drain", "negative levels", "negative level"],
    "entangled": ["entangled", "entangles"],
    "exhausted": ["exhausted", "exhaustion"],
    "fascinated": ["fascinated", "fascinates"],
    "fatigued": ["fatigued", "fatigue"],
    "flatFooted": ["flat-footed"],
    "frightened": ["frightened"],
    "grappling": ["grappling", "grappled", "grapples", "grapple"],
    "helpless": ["helpless"],
    "incorporeal": ["incorporeal"],
    "invisible": ["invisible"],
    "knockedDown": ["knocked down", "knocks down", "knock down"],
    "nauseated": ["nauseated", "nauseates"],
    "panicked": ["panicked"],
    "paralyzed": ["paralyzed", "paralyzes", "paralysis"],
    "petrified": ["petrified", "petrifies", "petrification"],
    "pinned": ["pinned"],
    "prone": ["prone"],
    "shaken": ["shaken"],
    "sickened": ["sickened", "sickens"],
    "stable": ["stable"],
    "staggered": ["staggered"],
    "stunned": ["stunned", "stuns"],
    "turned": ["turned undead", "turn undead"],
    "unconscious": ["unconscious", "unconsciousness"],
}

# Phrases that contain a form but are not about the condition: they stay plain text.
EXCLUDED = ["raise dead", "speak with dead", "dead magic", "stable ground", "stable surface"]


def clean(paragraph):
    """Inner HTML of the paragraph (or list item) with text tags only; links to other conditions become
    <a data-condition>."""
    for node in list(paragraph.iter()):
        if node is paragraph:
            continue
        if not isinstance(node.tag, str) or node.tag not in TEXT_TAGS:
            node.drop_tag()
            continue
        href = node.get("href", "")
        node.attrib.clear()
        if node.tag == "a":
            found = re.search(r"conditionSummary\.htm#(\w+)", href)
            if found:
                node.set("data-condition", found.group(1))
            else:
                node.drop_tag()
    html = lxml.html.tostring(paragraph, encoding="unicode")
    html = re.sub(rf"^<{paragraph.tag}>|</{paragraph.tag}>$", "", html.strip())
    return re.sub(r"\s+", " ", html).strip()


def parse(html):
    """html: bytes of the SRD page (the XML declaration prevents passing a string)."""
    root = lxml.html.fromstring(html)
    conditions = []
    for heading in root.xpath("//h2[@id]"):
        paragraphs = []
        for sibling in heading.itersiblings():
            if sibling.tag != "p":
                break
            paragraphs.append(f"<p>{clean(sibling)}</p>")
        condition_id = heading.get("id")
        conditions.append({
            "id": condition_id,
            "name": heading.text_content().strip(),
            "description_html": units.convert_text("".join(paragraphs)),  # metric measurements
            "forms": FORMS.get(condition_id, [heading.text_content().strip().lower()]),
        })
    intro = root.xpath("//h1/following-sibling::p[1]")
    return {
        "source": URL,
        "note": units.convert_text(intro[0].text_content().strip()) if intro else "",
        "excluded": EXCLUDED,
        "conditions": conditions,
    }


def parse_ability_loss(html):
    """The "Ability Score Loss" rules of a score at 0, as HTML to add to Ability Damaged and Ability Drained.
    html: bytes of the SRD special abilities page. ValueError if the section has changed."""
    root = lxml.html.fromstring(html)
    heading = root.xpath('//*[@id="abilityScoreLoss"]')
    items = heading[0].xpath("following-sibling::ul[1]/li") if heading else []
    lines = [clean(item) for item in items]
    if [line.split(" ", 1)[0] for line in lines] != list(ABILITIES):
        raise ValueError("the SRD page has changed: the ability scores at 0 are missing")
    after = heading[0].xpath("following-sibling::ul[1]/following-sibling::p[1]")
    return units.convert_text("<h4>An ability score at 0</h4><ul>%s</ul>%s" % (
        "".join(re.sub(r"^(\w+ 0)", r"<li><strong>\1</strong>", line) + "</li>" for line in lines), f"<p>{clean(after[0])}</p>" if after else ""))


def _read(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def stored(path=OUTPUT):
    """True if the file is there and has every condition (it can be used, even in an older format)."""
    try:
        data = _read(path)
        return not set(FORMS) - {c["id"] for c in data["conditions"] if c.get("description_html")}
    except (TypeError, KeyError):
        return False


def current(path=OUTPUT):
    """True if the file has every condition and is in this FORMAT."""
    return stored(path) and _read(path).get("format") == FORMAT


def _get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Grimoire spellbook (personal use)"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def download():
    """The conditions from the SRD; ValueError if the page has changed, OSError without a connection."""
    data = parse(_get(URL))
    missing = set(FORMS) - {c["id"] for c in data["conditions"]}
    if not data["conditions"] or missing:
        raise ValueError(f"the SRD page has changed: missing {', '.join(sorted(missing)) or 'all conditions'}")
    at_zero = parse_ability_loss(_get(ABILITY_LOSS_URL))
    for condition in data["conditions"]:
        if condition["id"] in ABILITY_CONDITIONS:
            condition["description_html"] += at_zero
    data["format"] = FORMAT
    return data


def save(data, path=OUTPUT):
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def main():
    argparse.ArgumentParser(description="Download the SRD conditions again into web/conditions.json.").parse_args()
    try:
        data = download()
    except (OSError, ValueError) as error:
        raise SystemExit(f"Conditions not downloaded: {error}")
    save(data)
    print(f"Saved {len(data['conditions'])} conditions to {OUTPUT}")


if __name__ == "__main__":
    main()
