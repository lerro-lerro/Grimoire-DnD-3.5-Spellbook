#!/usr/bin/env python3
"""Grimoire: local server for D&D 3.5 spellbooks.

Usage:  python3 server.py              (opens the browser at http://my-grimoire.localhost:8765)
        python3 server.py --start      (the same, in the background without a window: what the start scripts do)
        python3 server.py --stop       (stops the server started on the same data folder)
        python3 server.py --port 9000 --no-browser
        python3 server.py --data /other/folder   (use a different data folder)
        python3 server.py --network              (phones on the same Wi-Fi open http://my-grimoire.local:8765/)
"""

import argparse
import gzip
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
import webbrowser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.dont_write_bytecode = True  # no __pycache__ next to the data
if sys.version_info < (3, 9):
    sys.exit("Grimoire needs Python 3.9 or newer.")
try:
    from grimoire import conditions, dndtools, metamagic, search, units  # noqa: E402
    MISSING_MODULE = None
except ImportError as missing:  # --stop works without lxml; everything else says what to install
    MISSING_MODULE = missing.name

APP_DIR = Path(__file__).resolve().parent
WEB = APP_DIR / "web"
CONDITIONS_FILE = WEB / "conditions.json"  # the SRD conditions, kept offline
CONDITIONS_LOCK = threading.Lock()
METAMAGIC_FILE = WEB / "metamagic.json"  # the dndtools metamagic feats, kept offline
METAMAGIC_LOCK = threading.Lock()
METAMAGIC_JOB = {"thread": None, "error": None, "failed_at": 0.0}
LOCAL_NAME = "my-grimoire.local"  # name announced on the home network, instead of the computer's IP
START_TOKEN = secrets.token_hex(4)  # part of every ETag: answers cached before a restart are never reused
# explicit types: on Windows the registry can map .js to text/plain, which browsers refuse for modules
for mime_type, extension in (("text/javascript", ".js"), ("text/css", ".css"), ("application/json", ".json"),
                             ("application/manifest+json", ".webmanifest"), ("image/svg+xml", ".svg"),
                             ("image/png", ".png"), ("text/html", ".html")):
    mimetypes.add_type(mime_type, extension)
ID_RE = re.compile(r"^[a-z0-9-]{1,80}$")
# spell file names: "<level>-<name>--<id>" (1-grease--2396); "x" when the level is unknown
SPELL_FILE_RE = re.compile(r"^(?:\d|x)-(?P<slug>[a-z0-9]+(?:-[a-z0-9]+)*)--(?P<id>[a-z0-9-]+)$")
LOCK = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "book"


def spell_slug(name):
    """Name part of a spell file: like slugify, but never with "--" or a hyphen at the end."""
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40].strip("-") or "spell"


def shown(entries):
    """The spells of a book that are shown. A removed spell stays in the book file with "removed_at", hidden,
    so its level, prepared copies, scrolls and favorite mark come back if it is added again."""
    return [entry for entry in entries if not entry.get("removed_at")]


UNAVAILABLE_REASONS = {"lost": "Lost", "stolen": "Stolen", "other": "Not available"}


def valid_unavailable(value, previous=None):
    """null (the book is available) or {"reason": "lost"|"stolen"|"other", "note", "since"}: a lost or stolen
    book keeps everything, but its spells can't be prepared and the book can't be changed."""
    if not value:
        return None
    if not isinstance(value, dict) or value.get("reason") not in UNAVAILABLE_REASONS:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Choose why the book is not available: lost, stolen or other.")
    return {"reason": value["reason"], "note": re.sub(r"\s+", " ", str(value.get("note") or "")).strip()[:300],
            "since": (previous or {}).get("since") or now()}


def ensure_available(book):
    """Refuses changes to a book that is lost or stolen."""
    status = book.get("unavailable")
    if status:
        reason = UNAVAILABLE_REASONS.get(status.get("reason"), "Not available").lower()
        raise ApiError(HTTPStatus.CONFLICT,
                       f"“{book.get('name', '')}” is not available ({reason}): mark it as available in its Settings before changing it.")


def lowest_level(spell):
    """Lowest level listed on a sheet (classes and domains), or None."""
    levels = [v["level"] for v in spell.get("levels", [])] + [d["level"] for d in spell.get("domains", [])]
    return min(levels) if levels else None


def spell_file_levels(books):
    """Level of each spell for its file name: the lowest in the books that show it, otherwise the lowest in
    the books it was removed from."""
    shown_levels, removed_levels = {}, {}
    for book in books:
        for entry in book.get("spells", []):
            levels = removed_levels if entry.get("removed_at") else shown_levels
            levels[entry["id"]] = min(levels.get(entry["id"], 9), entry["level"])
    return {**removed_levels, **shown_levels}


class Store:
    """Books and spells saved as readable JSON files."""

    def __init__(self, data_folder):
        self.books = Path(data_folder) / "books"
        self.spells = Path(data_folder) / "spells"
        self.characters = Path(data_folder) / "characters"
        for folder in (self.books, self.spells, self.characters):
            folder.mkdir(parents=True, exist_ok=True)
        # spell files are renamed when a level changes: reads, writes and renames of spell files take turns
        self.spell_lock = threading.RLock()
        self._spell_paths, self._scanned = {}, None
        # with thousands of spells, reading and completing the sheets again for every request is what makes the app
        # slow: sheets are kept in memory (checked against the file), completed sheets until any sheet changes
        self._sheets = {}          # id -> (path, mtime_ns, sheet); the sheets returned must not be changed in place
        self.generation = 0        # +1 when a sheet changes: completed and light sheets are made again
        self.completed = {}        # id -> (generation, expand_spell), see completed_spell
        self.light = {}            # id -> (generation, light sheet), see light_spell
        self.version = 0           # +1 on every write: part of the ETags

    @staticmethod
    def _read(path):
        return json.loads(path.read_text(encoding="utf-8"))

    def _write(self, path, data):
        self.version += 1
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        for attempt in range(20):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:  # Windows: another request is reading the file right now
                if attempt == 19:
                    raise
                time.sleep(0.05)

    # --- spells (cache shared by all books) ---
    # A spell file is named "<level>-<name>--<id>.json" (1-grease--2396.json), so the folder reads like a spell
    # list. The level is the one in the books (spell_file_levels), or the lowest on the sheet for a spell that is
    # in no book; the ID after "--" is what identifies the spell.
    def _scan_spells(self):
        """ID -> file, read again when the folder changed. Files with the old kind of name (2396.json) are
        found too; if a spell has two files, the one with the new kind of name wins."""
        stamp = self.spells.stat().st_mtime_ns
        if stamp == self._scanned:
            return
        paths = {}
        for path in sorted(self.spells.glob("*.json")):
            match = SPELL_FILE_RE.match(path.stem)
            if match or path.stem not in paths:
                paths[match["id"] if match else path.stem] = path
        self._spell_paths, self._scanned = paths, stamp

    def _spell_path(self, spell_id):
        """Current file of a spell, or None. Call it holding spell_lock."""
        if not ID_RE.match(spell_id or ""):
            raise KeyError(spell_id)
        path = self._spell_paths.get(spell_id)
        if path is None or not path.exists():
            self._scan_spells()
            path = self._spell_paths.get(spell_id)
        return path

    def _spell_target(self, spell_id, slug, level):
        return self.spells / f"{'x' if level is None else level}-{slug}--{spell_id}.json"

    def spell(self, spell_id):
        """The saved sheet (from memory when the file hasn't changed), or None. Don't change it in place."""
        with self.spell_lock:
            path = self._spell_path(spell_id)
            if not path:
                return None
            try:
                mtime = path.stat().st_mtime_ns
            except OSError:
                return None
            cached = self._sheets.get(spell_id)
            if cached and cached[0] == path and cached[1] == mtime:
                return cached[2]
            data = self._read(path)
            if cached:
                self.generation += 1  # changed outside the app
            self._sheets[spell_id] = (path, mtime, data)
            return data

    def save_spell(self, data):
        with self.spell_lock:
            old = self._spell_path(data["id"])
            level = spell_file_levels(self.all_books()).get(data["id"], lowest_level(data))
            path = self._spell_target(data["id"], spell_slug(data.get("name")), level)
            self._write(path, data)
            if old and old != path:
                old.unlink(missing_ok=True)
            self._spell_paths[data["id"]] = path
            self._sheets[data["id"]] = (path, path.stat().st_mtime_ns, data)
            self.generation += 1

    def delete_spell(self, spell_id):
        """Deletes every file of a spell (an old <id>.json copy too). False if there was none."""
        with self.spell_lock:
            if not ID_RE.match(spell_id or ""):
                raise KeyError(spell_id)
            files = [path for path in self.spells.glob("*.json")
                     if (SPELL_FILE_RE.match(path.stem) or {"id": path.stem})["id"] == spell_id]
            for path in files:
                path.unlink(missing_ok=True)
            self._spell_paths.pop(spell_id, None)
            self._sheets.pop(spell_id, None)
            self.generation += 1
            self.version += 1
            return bool(files)

    def name_spell_files(self, ids=None):
        """Renames the spell files whose level changed (all the files when ids is None, e.g. the ones still
        called <id>.json). Returns how many were renamed."""
        with self.spell_lock:
            self._scan_spells()
            levels = spell_file_levels(self.all_books())
            renamed = 0
            for spell_id in sorted(self._spell_paths if ids is None else set(ids)):
                path = self._spell_path(spell_id) if ID_RE.match(spell_id) else None
                if not path or not path.exists():
                    continue
                match = SPELL_FILE_RE.match(path.stem)
                data = None if match and spell_id in levels else self._read(path)
                slug = match["slug"] if match else spell_slug(data.get("name"))
                target = self._spell_target(spell_id, slug, levels[spell_id] if spell_id in levels else lowest_level(data))
                if target != path:
                    os.replace(path, target)
                    self._spell_paths[spell_id] = target
                    cached = self._sheets.pop(spell_id, None)
                    if cached and cached[0] == path:
                        self._sheets[spell_id] = (target, target.stat().st_mtime_ns, cached[2])
                    renamed += 1
            return renamed

    # --- books ---
    def book_file(self, book_id):
        if not ID_RE.match(book_id or ""):
            raise KeyError(book_id)
        return self.books / f"{book_id}.json"

    def book(self, book_id):
        path = self.book_file(book_id)
        if not path.exists():
            raise KeyError(book_id)
        return self._read(path)

    def save_book(self, book):
        """Saves a book and renames the files of the spells whose level (or removal) changed."""
        book["updated_at"] = now()
        path = self.book_file(book["id"])
        state = lambda entries: {e["id"]: (e["level"], bool(e.get("removed_at"))) for e in entries}  # noqa: E731
        before = state(self._read(path).get("spells", [])) if path.exists() else {}
        after = state(book.get("spells", []))
        self._write(path, book)
        changed = {i for i in before.keys() | after.keys() if before.get(i) != after.get(i)}
        if changed:
            self.name_spell_files(changed)

    def all_books(self):
        return [self._read(p) for p in sorted(self.books.glob("*.json"))]

    def delete_book(self, book_id):
        path = self.book_file(book_id)
        ids = {entry["id"] for entry in self._read(path).get("spells", [])}
        path.unlink(missing_ok=False)
        self.name_spell_files(ids)

    def books_of(self, character_id):
        return [l for l in self.all_books() if l.get("character") == character_id]

    # --- characters: each with their own books and preparation ---
    def character_file(self, character_id):
        if not ID_RE.match(character_id or ""):
            raise KeyError(character_id)
        return self.characters / f"{character_id}.json"

    def character(self, character_id):
        path = self.character_file(character_id)
        if not path.exists():
            raise KeyError(character_id)
        return self._read(path)

    def save_character(self, character):
        character["updated_at"] = now()
        self._write(self.character_file(character["id"]), character)

    def all_characters(self):
        return sorted((self._read(p) for p in self.characters.glob("*.json")), key=lambda p: p.get("created_at") or "")

    def delete_character(self, character_id):
        self.character_file(character_id).unlink(missing_ok=False)

    def assign_characters(self):
        """At startup. Before characters existed there was a single caster (data/character.json, or the
        preparation inside the books): it becomes the first character and gets every book; the old file is
        kept as character.json.bak. Then every book without a valid character goes to the first character."""
        old = self.books.parent / "character.json"
        books = self.all_books()
        if not self.all_characters() and (books or old.exists()):
            base = self._read(old) if old.exists() else character_from_books(books)
            owners = Counter(l.get("owner") for l in books if l.get("owner"))
            name = owners.most_common(1)[0][0] if owners else "My character"
            self.save_character({**new_character(name), **{k: base[k] for k in PREPARATION_FIELDS if k in base}})
            if old.exists():
                os.replace(old, old.with_name("character.json.bak"))
        characters = self.all_characters()
        valid = {p["id"] for p in characters}
        for book in books:
            if characters and book.get("character") not in valid:
                book["character"] = characters[0]["id"]
                self._write(self.book_file(book["id"]), book)  # without changing updated_at

    def upgrade_classes(self):
        """At startup. Books saved before classes had a type get one (from the class name), and characters
        with a single preparation (daily_slots, ability_score and specialization at the top) get it moved
        under "classes", for the class used most in their books; prepared spells and scrolls get that class.
        Files already upgraded don't change, and updated_at is kept."""
        books = self.all_books()
        for book in books:
            if not book.get("class_type"):
                book["class_type"] = guess_class_type(book.get("caster_class"))
                self._write(self.book_file(book["id"]), book)
        old_fields = ("daily_slots", "ability_score", "specialization")
        for character in self.all_characters():
            if "classes" in character and not any(k in character for k in old_fields) \
                    and all("class" in e for e in character.get("prepared", []) + character.get("scrolls", [])):
                continue
            own = [l for l in books if l.get("character") == character["id"]]
            counts = Counter(book_class(l)[0] for l in own)
            key = counts.most_common(1)[0][0] if counts else "wizard"
            classes = character.get("classes") or {}
            if any(k in character for k in old_fields):
                old = {k: character.pop(k, None) for k in old_fields}
                classes.setdefault(key, {"daily_slots": old["daily_slots"] or {}, "ability_score": old["ability_score"],
                                         "specialization": old["specialization"]})
            character["classes"] = classes
            for entry in character.get("prepared", []) + character.get("scrolls", []):
                entry.setdefault("class", key)
            character.setdefault("scrolls", [])
            character.setdefault("favorites", [])
            self._write(self.character_file(character["id"]), character)

    def convert_units(self):
        """At startup. Sheets saved before the unit conversion (units.py) switch to metres and kilograms;
        sheets already converted don't change. Returns how many sheets were rewritten."""
        converted = 0
        with self.spell_lock:
            for path in sorted(self.spells.glob("*.json")):
                data = self._read(path)
                metric = units.convert_spell(data)
                if metric != data:
                    self._write(path, metric)
                    converted += 1
            self._sheets.clear()
            self.generation += 1
        return converted


def ensure_conditions():
    """The conditions are used offline from CONDITIONS_FILE: when it is missing or incomplete they are downloaded
    from the SRD and saved. Returns None when the file is ready, otherwise why it isn't."""
    with CONDITIONS_LOCK:
        if conditions.stored(CONDITIONS_FILE):
            return None
        try:
            data = conditions.download()
            conditions.save(data, CONDITIONS_FILE)
        except Exception as error:  # no connection, the SRD page has changed, the folder is read-only…
            return f"The conditions are not saved yet and could not be downloaded from the SRD ({error})."
        print(f"Downloaded {len(data['conditions'])} conditions from the SRD to {CONDITIONS_FILE.name}.", flush=True)
        return None


def ensure_metamagic():
    """The metamagic feats are used offline from METAMAGIC_FILE. When it is missing they are downloaded from dndtools
    in the background (about 150 pages, a couple of minutes; after a failure, again at most once a minute).
    Returns None when the file is ready, otherwise what is happening."""
    with METAMAGIC_LOCK:
        if metamagic.stored(METAMAGIC_FILE):
            return None
        job = METAMAGIC_JOB
        if job["thread"] and job["thread"].is_alive():
            return "The metamagic feats are being downloaded from dndtools: they will be ready in a couple of minutes."
        if job["error"] and time.time() - job["failed_at"] < 60:
            return job["error"]
        job["thread"] = threading.Thread(target=_download_metamagic, daemon=True)
        job["thread"].start()
        print("Downloading the metamagic feats from dndtools in the background (about 150 pages)…", flush=True)
        return "The metamagic feats are being downloaded from dndtools: they will be ready in a couple of minutes."


def _download_metamagic():
    try:
        data = metamagic.download_feats(log=lambda message: None)
        metamagic.save(data, METAMAGIC_FILE)
    except Exception as error:  # dndtools unreachable or changed, folder read-only…
        METAMAGIC_JOB.update(error=f"The metamagic feats could not be downloaded from dndtools ({error}).", failed_at=time.time())
        print(METAMAGIC_JOB["error"], flush=True)
        return
    METAMAGIC_JOB["error"] = None
    print(f"Downloaded {len(data['feats'])} metamagic feats from dndtools to {METAMAGIC_FILE.name}.", flush=True)


def pages(level):
    return max(1, int(level))


# --- casting classes ---
# Every book belongs to one class of its character. Named types have a fixed class name; the general types
# take the name the user writes (Bard, Favored Soul…), which is also used for the dndtools spell levels.
# The same table is CLASS_TYPES in web/app.js.
CLASS_TYPES = {
    "wizard": {"name": "Wizard", "tradition": "arcane", "casting": "prepared", "ability": "Intelligence",
               "fallback": ["Wizard", "Sorcerer"], "specializations": ["school", "domain"]},
    "sorcerer": {"name": "Sorcerer", "tradition": "arcane", "casting": "spontaneous", "ability": "Charisma",
                 "fallback": ["Sorcerer", "Wizard"], "specializations": []},
    "cleric": {"name": "Cleric", "tradition": "divine", "casting": "prepared", "ability": "Wisdom",
               "fallback": ["Cleric", "Druid"], "specializations": ["domain"]},
    "druid": {"name": "Druid", "tradition": "divine", "casting": "prepared", "ability": "Wisdom",
              "fallback": ["Druid", "Cleric"], "specializations": []},
    "arcane-prepared": {"name": "", "tradition": "arcane", "casting": "prepared", "ability": "Intelligence",
                        "fallback": ["Wizard", "Sorcerer"], "specializations": ["school", "domain"]},
    "arcane-spontaneous": {"name": "", "tradition": "arcane", "casting": "spontaneous", "ability": "Charisma",
                           "fallback": ["Sorcerer", "Wizard"], "specializations": []},
    "divine-prepared": {"name": "", "tradition": "divine", "casting": "prepared", "ability": "Wisdom",
                        "fallback": ["Cleric", "Druid"], "specializations": ["domain"]},
    "divine-spontaneous": {"name": "", "tradition": "divine", "casting": "spontaneous", "ability": "Charisma",
                           "fallback": ["Cleric", "Druid"], "specializations": []},
}
NAMED_TYPES = {slugify(info["name"]): key for key, info in CLASS_TYPES.items() if info["name"]}
ABILITIES = ("Intelligence", "Wisdom", "Charisma")
# general type guessed from a class name (books saved before classes had a type, or a request without it)
GUESSED_TYPES = {
    "bard": "arcane-spontaneous", "beguiler": "arcane-spontaneous", "warmage": "arcane-spontaneous",
    "duskblade": "arcane-spontaneous", "dread-necromancer": "arcane-spontaneous", "hexblade": "arcane-spontaneous",
    "favored-soul": "divine-spontaneous", "spirit-shaman": "divine-spontaneous",
    "paladin": "divine-prepared", "ranger": "divine-prepared", "archivist": "divine-prepared",
    "adept": "divine-prepared", "blackguard": "divine-prepared", "healer": "divine-prepared",
}


def class_key(name):
    return slugify(name or "Wizard")


def guess_class_type(name):
    key = class_key(name)
    return NAMED_TYPES.get(key) or GUESSED_TYPES.get(key) or "arcane-prepared"


def class_fields(body, current=None):
    """(class name, class type) of a book from a request, checked: named types have a fixed name, and a
    general class called like a named one ("wizard") is that class. Without a type the name decides."""
    current = current or {}
    if "caster_class" not in body and "class_type" not in body:
        return current.get("caster_class") or "Wizard", current.get("class_type") or guess_class_type(current.get("caster_class"))
    name = re.sub(r"\s+", " ", str(body.get("caster_class", current.get("caster_class")) or "")).strip()[:60]
    class_type = str(body.get("class_type") or "").strip() or guess_class_type(name)
    if class_type not in CLASS_TYPES:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Unknown class type.")
    if CLASS_TYPES[class_type]["name"]:
        return CLASS_TYPES[class_type]["name"], class_type
    if not name:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Write the name of the class, for example Bard or Favored Soul.")
    if class_key(name) in NAMED_TYPES:
        named = NAMED_TYPES[class_key(name)]
        return CLASS_TYPES[named]["name"], named
    return name, class_type


def book_class(book):
    name = book.get("caster_class") or "Wizard"
    return class_key(name), name, book.get("class_type") or guess_class_type(name)


def class_domains(store, book):
    """Lowercase domain names of the book's class (a cleric's "Fire, Sun"), for suggested_level."""
    try:
        data = (store.character(book.get("character")).get("classes") or {}).get(book_class(book)[0]) or {}
    except KeyError:
        return ()
    specialization = data.get("specialization") or {}
    if specialization.get("type") != "domain":
        return ()
    return tuple(d.strip().lower() for d in re.split(r"[/,]", specialization.get("name") or "") if d.strip())


def level_for_book(store, book, spell):
    _, class_name, class_type = book_class(book)
    return suggested_level(spell, class_name, class_type, class_domains(store, book))


def suggested_level(spell, caster_class, class_type=None, domains=()):
    """(level of the spell for the book's class, where it comes from): "class" when the spell lists the
    book's class, "domain" when it lists one of the class's domains, the name of another class of the same
    kind (Wizard, Cleric…) when it doesn't, "lowest" when only the lowest listed level is left."""
    levels = spell.get("levels", [])
    by_class = {entry["caster_class"].lower(): entry["level"] for entry in levels}
    wanted = [c.strip().lower() for c in re.split(r"[/,]", caster_class or "") if c.strip()]
    for name in wanted:
        if name in by_class:
            return by_class[name], "class"
    by_domain = {entry["domain"].lower(): entry["level"] for entry in spell.get("domains", [])}
    in_domains = [by_domain[d] for d in domains if d in by_domain]
    if in_domains:
        return min(in_domains), "domain"
    for name in CLASS_TYPES.get(class_type or guess_class_type(caster_class), CLASS_TYPES["wizard"])["fallback"]:
        if name.lower() in by_class:
            return by_class[name.lower()], name
    lowest = lowest_level(spell)
    return (0 if lowest is None else lowest), "lowest"


def level_from_class(source, class_type):
    """True when the suggested level needs no warning: the book's own class, or the other class of the
    same named type (a wizard book uses Sorcerer levels, as it always did)."""
    return source in ("class", "domain") or (source != "lowest" and bool(CLASS_TYPES.get(class_type, {}).get("name")))


def book_summary(store, book):
    entries = shown(book.get("spells", []))
    levels = [v["level"] for v in entries]
    key, name, class_type = book_class(book)
    return {
        **{k: book.get(k) for k in ("id", "name", "character", "owner", "max_pages",
                                    "notes", "color", "created_at", "updated_at")},
        "caster_class": name,
        "class_type": class_type,
        "class_key": key,
        "spell_count": len(entries),
        "pages_used": sum(pages(l) for l in levels),
        "per_level": {str(n): levels.count(n) for n in range(10) if n in levels},
        "removed_count": len(book.get("spells", [])) - len(entries),
        "unavailable": book.get("unavailable"),
    }


# --- characters: each has their own books, grouped by class; each class has its own preparation ---
PREPARATION_FIELDS = ("daily_slots", "ability_score", "specialization", "metamagic_feats", "prepared")


def new_character(name):
    return {
        "id": f"{slugify(name)}-{secrets.token_hex(3)}",
        "name": name,
        "created_at": now(),
        "classes": {}, "metamagic_feats": [], "prepared": [], "scrolls": [], "favorites": [],
    }


def prepared_key(entry):
    """Identity of a prepared entry: class + spell + feats with their increase (like preparedKey in app.js)."""
    return entry.get("class"), entry["id"], tuple((m["id"], m["increase"]) for m in entry.get("metamagic", []))


def character_from_books(books):
    """Before characters existed the preparation lived in each book: takes slots, ability score,
    specialization and feats from the most recently modified book that has them, and merges the prepared
    spells and the spells marked with ★ from every book."""
    with_data = sorted((l for l in books if any(l.get(k) for k in PREPARATION_FIELDS)),
                       key=lambda l: l.get("updated_at") or "", reverse=True)
    base = with_data[0] if with_data else {}
    prepared, seen = [], set()
    for book in with_data:
        for entry in book.get("prepared", []):
            if prepared_key(entry) not in seen:
                seen.add(prepared_key(entry))
                prepared.append(entry)
    specialization = base.get("specialization")
    if specialization:
        extra = [i for l in with_data for i in ((l.get("specialization") or {}).get("extra") or [])]
        specialization = {**specialization, "extra": list(dict.fromkeys(extra))}
    return {
        "daily_slots": base.get("daily_slots", {}),
        "ability_score": base.get("ability_score"),
        "specialization": specialization,
        "metamagic_feats": base.get("metamagic_feats", []),
        "prepared": prepared,
        "updated_at": base.get("updated_at"),
    }


def character_spells(books):
    """The spells shown in the books, once each. "books" says which books contain the spell, at which level and
    whether the book is available (not lost or stolen); "available_classes" are the classes with the spell in an
    available book, "available" is true if there is one. "level" is the lowest level in any book, "classes" the
    lowest level in the books of each class; both prefer the available books when there are some."""
    merged = {}
    for book in sorted(books, key=lambda l: l.get("created_at") or ""):
        key = book_class(book)[0]
        for entry in shown(book.get("spells", [])):
            merged_entry = merged.setdefault(entry["id"], {"id": entry["id"], "books": []})
            merged_entry["books"].append({"id": book["id"], "name": book["name"], "color": book.get("color"),
                                          "level": entry["level"], "class": key,
                                          "available": not book.get("unavailable")})
    for merged_entry in merged.values():
        by_class = {}
        for book in merged_entry["books"]:
            by_class.setdefault(book["class"], []).append(book)
        usable = lambda books_: [b for b in books_ if b["available"]] or books_  # noqa: E731
        merged_entry["level"] = min(b["level"] for b in usable(merged_entry["books"]))
        merged_entry["classes"] = {key: min(b["level"] for b in usable(own)) for key, own in by_class.items()}
        merged_entry["available_classes"] = [key for key, own in by_class.items() if any(b["available"] for b in own)]
        merged_entry["available"] = bool(merged_entry["available_classes"])
    return merged


def spells_by_class(books, removed=False, only_available=False):
    """{class key: IDs of the spells shown in that class's books}; with removed=True, the removed ones too;
    with only_available=True, only the books that are not lost or stolen."""
    ids = {}
    for book in books:
        entries = book.get("spells", []) if removed else shown(book.get("spells", []))
        ids.setdefault(book_class(book)[0], set())
        if not (only_available and book.get("unavailable")):
            ids[book_class(book)[0]].update(entry["id"] for entry in entries)
    return ids


def hidden_entries(entries, books):
    """Prepared spells or scrolls of spells removed from their class's books: kept in the file, not shown."""
    visible, known = spells_by_class(books), spells_by_class(books, removed=True)
    return [e for e in entries if e.get("id") in known.get(e.get("class"), set())
            and e.get("id") not in visible.get(e.get("class"), set())]


def visible_entries(entries, books):
    visible = spells_by_class(books)
    return [e for e in entries if e.get("id") in visible.get(e.get("class"), ())]


def hidden_favorites(favorites, books):
    visible = set(character_spells(books))
    known = set().union(*spells_by_class(books, removed=True).values())
    return [i for i in favorites if i in known and i not in visible]


def special_slot(cls, level):
    """1 extra slot at every level with a specialist school or a domain; divine domains start at level 1."""
    specialization = cls.get("specialization") or {}
    if specialization.get("type") not in ("school", "domain"):
        return 0
    return 0 if cls.get("tradition") == "divine" and level == 0 else 1


def total_slots(cls):
    """Spells per day by level = base written by the user + ability bonus + specialization slot.
    Bonus and special slot apply up to the highest level with at least one base slot; with a score
    below 10 + level that level can't be cast.
    Same rule as computeSlots in web/app.js."""
    base = {int(k): v for k, v in (cls.get("daily_slots") or {}).items()}
    score = cls.get("ability_score")
    maximum = max((n for n, v in base.items() if v), default=-1)
    totals = {}
    for n in range(maximum + 1):
        if score and score < 10 + n:
            continue
        bonus = bonus_spells(score, n) if score else 0
        total = base.get(n, 0) + bonus + special_slot(cls, n)
        if total:
            totals[str(n)] = total
    return totals


def character_classes(character, books):
    """The character's classes, in the order of their first book, each with its preparation and totals."""
    classes = {}
    for book in sorted(books, key=lambda l: l.get("created_at") or ""):
        key, name, class_type = book_class(book)
        cls = classes.setdefault(key, {"key": key, "name": name, "type": class_type, "book_count": 0})
        cls["book_count"] += 1
    stored = character.get("classes") or {}
    prepared = visible_entries(character.get("prepared", []), books)
    for key, cls in classes.items():
        info = CLASS_TYPES[cls["type"]]
        data = stored.get(key) or {}
        ability = data.get("ability") if not info["name"] and data.get("ability") in ABILITIES else info["ability"]
        cls.update({
            "tradition": info["tradition"],
            "casting": info["casting"],
            "ability": ability,
            "ability_score": data.get("ability_score"),
            "daily_slots": data.get("daily_slots") or {},
            "specialization": data.get("specialization") if info["specializations"] else None,
            "forbidden_schools": list(data.get("forbidden_schools") or []) if "school" in info["specializations"] else [],
            "used": (data.get("used") or {}) if info["casting"] == "spontaneous" else {},
        })
        cls["total_slots"] = total_slots(cls)
        cls["slot_total"] = sum(cls["total_slots"].values())
        own = [p for p in prepared if p.get("class") == key] if info["casting"] == "prepared" else []
        cls["prepared_total"] = sum(p["copies"] for p in own)
        cls["cast_total"] = sum(p["cast"] for p in own) + sum(cls["used"].values())
    return list(classes.values())


def character_summary(character, books):
    """The character as the interface sees it: prepared spells, scrolls and favorites of removed spells are left out."""
    prepared = visible_entries(character.get("prepared", []), books)
    scrolls = visible_entries(character.get("scrolls", []), books)
    classes = character_classes(character, books)
    present = character_spells(books)
    return {
        "id": character["id"],
        "name": character.get("name", ""),
        "created_at": character.get("created_at"),
        "book_count": len(books),
        "spell_count": len(present),
        "classes": classes,
        "metamagic_feats": character.get("metamagic_feats", []),
        "prepared": prepared,
        "scrolls": scrolls,
        "favorites": [i for i in character.get("favorites", []) if i in present],
        "slot_total": sum(c["slot_total"] for c in classes),
        "prepared_total": sum(c["prepared_total"] for c in classes),
        "cast_total": sum(c["cast_total"] for c in classes),
        "scroll_total": sum(s["count"] for s in scrolls),
        "updated_at": character.get("updated_at"),
    }


def full_character(store, character_id):
    """Preparation, plus every spell of the character's books (merged, as light sheets) and the book summaries."""
    character = store.character(character_id)
    books = store.books_of(character_id)
    entries = []
    for merged_entry in character_spells(books).values():
        light = light_spell(store, merged_entry["id"])
        if light:
            entries.append({**merged_entry, "spell": light})
    entries.sort(key=lambda v: (v["level"], v["spell"]["name"].lower()))
    return {
        **character_summary(character, books),
        "spells": entries,
        "books": sorted((book_summary(store, l) for l in books), key=lambda l: l["created_at"] or ""),
    }


def clean_character(store, character_id):
    """After deleting a book or a spell for good (or moving a book to another character or class): drops the
    prepared spells, scrolls, favorites and ★ marks of spells that are no longer in a book of that class
    (favorites: of any class). Spells removed from a book are still in it (hidden), so their data stays.
    Call it holding LOCK."""
    try:
        character = store.character(character_id)
    except KeyError:
        return
    books = store.books_of(character_id)
    by_class = spells_by_class(books, removed=True)
    present = set().union(*by_class.values())
    fits = lambda entry: entry.get("id") in by_class.get(entry.get("class"), ())  # noqa: E731
    changed = {
        "prepared": [p for p in character.get("prepared", []) if fits(p)],
        "scrolls": [s for s in character.get("scrolls", []) if fits(s)],
        "favorites": [i for i in character.get("favorites", []) if i in present],
    }
    dirty = any(len(value) != len(character.get(key, [])) for key, value in changed.items())
    for key, data in (character.get("classes") or {}).items():
        specialization = data.get("specialization")
        if specialization and specialization.get("extra"):
            extra = [i for i in specialization["extra"] if i in by_class.get(key, ())]
            if extra != specialization["extra"]:
                specialization["extra"] = extra
                dirty = True
    if dirty:
        character.update(changed)
        store.save_character(character)


def modifier(score):
    return (score - 10) // 2


def bonus_spells(score, level):
    """Bonus spells for a high ability score (Player's Handbook table)."""
    mod = modifier(score)
    return (mod - level) // 4 + 1 if level > 0 and mod >= level else 0


def valid_specialization(value, present, cls):
    """null or {"type": "school"|"domain", "name": "...", "extra": [ids of spells marked by hand]};
    school or domain only where the class type allows it (a cleric's two domains go in one name: "Fire, Sun")."""
    if not value:
        return None
    allowed = CLASS_TYPES[cls["type"]]["specializations"]
    if not isinstance(value, dict) or value.get("type") not in allowed:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"A {cls['name']} can't have that specialization.")
    name = str(value.get("name") or "").strip()[:80]
    extra = value.get("extra") or []
    if not isinstance(extra, list):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Marked specialization spells must be a list.")
    extra = list(dict.fromkeys(str(i) for i in extra if str(i) in present))
    return {"type": value["type"], "name": name, "extra": extra}


FORBIDDABLE_SCHOOLS = ("Abjuration", "Conjuration", "Divination", "Enchantment", "Evocation",
                       "Illusion", "Necromancy", "Transmutation")


def valid_forbidden(value):
    """["Illusion", "Necromancy"]: the schools a wizard (or a general arcane class that prepares) gives up; as many
    as wanted (house rules), in the usual order."""
    if not isinstance(value, list):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Forbidden schools must be a list.")
    unknown = [str(v) for v in value if v not in FORBIDDABLE_SCHOOLS]
    if unknown:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"Unknown school: {unknown[0][:40]}.")
    return [school for school in FORBIDDABLE_SCHOOLS if school in value]


def spell_schools(spell):
    """The schools of a sheet ("Conjuration", or several words when dndtools lists more than one)."""
    return set(re.split(r"[\s,/]+", (spell or {}).get("school") or "")) - {""}


def valid_used(value):
    """{"1": 2, ...}: slots already used today by a spontaneous caster, by level."""
    if not isinstance(value, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Used slots must be numbers by level.")
    used = {}
    for level in range(10):
        if value.get(str(level)) not in (None, ""):
            number = bounded_number(value[str(level)], 0, 99, "Used slots must be numbers.")
            if number:
                used[str(level)] = number
    return used


def valid_ability(value):
    if value not in ABILITIES:
        raise ApiError(HTTPStatus.BAD_REQUEST, "The ability must be Intelligence, Wisdom or Charisma.")
    return value


FEAT_ID_RE = re.compile(r"^\d{1,7}$")


def valid_metamagic_feats(value):
    """Known metamagic feats: dndtools feat IDs (see web/metamagic.json)."""
    if not isinstance(value, list):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Metamagic feats must be a list.")
    return list(dict.fromkeys(str(v) for v in value if FEAT_ID_RE.match(str(v))))[:300]


def valid_prepared_metamagic(value):
    """[{"id": "848", "increase": 2}]: feats applied to a prepared spell, sorted by ID.
    increase = extra slot levels (for Heighten Spell, the chosen ones)."""
    if not value:
        return []
    if not isinstance(value, list) or len(value) > 12:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Metamagic on a prepared spell must be a short list of feats.")
    feats = {}
    for entry in value:
        if not isinstance(entry, dict) or not FEAT_ID_RE.match(str(entry.get("id"))):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Unknown metamagic feat.")
        feats[str(entry["id"])] = bounded_number(entry.get("increase", 0), 0, 9, "The metamagic level adjustment must be a number.")
    return [{"id": i, "increase": a} for i, a in sorted(feats.items())]


def valid_ability_score(value):
    if value in (None, ""):
        return None
    return bounded_number(value, 1, 60, "The ability score must be a number.")


def bounded_number(value, minimum, maximum, message):
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, message)
    return max(minimum, min(maximum, number))


def valid_slots(value):
    """{"0": 4, "1": 3, ...}: spells per day by level, 0-99."""
    if not isinstance(value, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Spells per day must be a list of numbers by level.")
    slot = {}
    for level in range(10):
        if str(level) in value and value[str(level)] not in (None, ""):
            number = bounded_number(value[str(level)], 0, 99, "Spells per day must be numbers.")
            if number:
                slot[str(level)] = number
    return slot


MAX_LINKED = 8  # referenced spells to download/attach for each sheet (chains included)


def linked_ids(store, data):
    """IDs of the spells referenced in the description, and of those they reference, in visiting order."""
    found, to_visit = [], [r["id"] for r in data.get("references", [])]
    while to_visit and len(found) < MAX_LINKED:
        ref_id = to_visit.pop(0)
        if ref_id == data["id"] or ref_id in found:
            continue
        found.append(ref_id)
        ref = store.spell(ref_id)
        if ref:
            to_visit += [r["id"] for r in ref.get("references", [])]
    return found


def resolve_base_name(store, data):
    """"functions like hold person" without a link: searches dndtools for the spell by name, adds it to
    the references, makes the name clickable and saves. The search runs only once (based_on_searched),
    unless dndtools can't be reached: then it is tried again next time."""
    name = data.get("based_on_name")
    if not name or data.get("based_on") or data.get("based_on_searched"):
        return data
    try:
        url = dndtools.search_spell(name, data.get("url", ""))
    except dndtools.DndtoolsError as error:
        print(f"Base spell “{name}” not searched: {error}", file=sys.stderr)
        return data
    data = {**data, "based_on_searched": True}
    if url:
        _, base_id = dndtools.normalize_url(url)
        if base_id != data["id"]:
            data["based_on"] = base_id
            if base_id not in {r["id"] for r in data.get("references", [])}:
                data["references"] = [{"id": base_id, "name": name, "url": url}, *data.get("references", [])]
            data["description_html"] = dndtools.link_name(data["description_html"], name, base_id)
    else:
        print(f"Base spell “{name}” not found on dndtools.", file=sys.stderr)
    with LOCK:
        store.save_spell(data)
    return data


def download_with_linked(store, url, force=False):
    """Downloads a sheet (if it isn't cached, or if force) and the spells it references.
    Sheets saved before references existed are downloaded again."""
    _, spell_id = dndtools.normalize_url(url)
    data = store.spell(spell_id)
    if force or not data or "based_on_name" not in data:
        data = dndtools.download_spell(url)
        with LOCK:
            store.save_spell(data)
    data = resolve_base_name(store, data)
    tried = set()
    for _ in range(MAX_LINKED):
        linked = linked_ids(store, data)
        urls = {r["id"]: r["url"] for r in data.get("references", [])}
        for ref_id in linked:
            ref = store.spell(ref_id)
            for r in (ref or {}).get("references", []):
                urls.setdefault(r["id"], r["url"])
        missing = [i for i in linked if i in urls and i not in tried and not store.spell(i)]
        if not missing:
            break
        tried.add(missing[0])
        try:
            ref = dndtools.download_spell(urls[missing[0]])
        except dndtools.DndtoolsError as error:
            print(f"Linked spell {missing[0]} not downloaded: {error}", file=sys.stderr)
            continue
        with LOCK:
            store.save_spell(ref)
        resolve_base_name(store, ref)
    return data


TARGETING = ("target", "area", "effect")


def merge_base(data, sheets):
    """Copy of a sheet with the missing stats and components taken from the
    "functions like ..." chain (looked up by ID among the given sheets)."""
    result = {**data, "stats": dict(data.get("stats") or {}),
              "components": list(data.get("components") or [])}
    chain, keys = [], {}
    base, seen = data.get("based_on"), {data["id"]}
    while base in sheets and base not in seen:
        seen.add(base)
        source = sheets[base]
        chain.append({"id": base, "name": source["name"]})
        for key, value in (source.get("stats") or {}).items():
            # target, area and effect exclude each other: if the sheet has one, the others are not taken
            if key in TARGETING and any(result["stats"].get(k) for k in TARGETING):
                continue
            if value and not result["stats"].get(key):
                result["stats"][key] = value
                keys[key] = source["name"]
        if not result["components"] and source.get("components"):
            result["components"] = list(source["components"])
            keys["components"] = source["name"]
        base = source.get("based_on")
    if chain:
        result["inherited_from"] = {"chain": chain, "keys": keys}
    return result


def completed_spell(store, spell_id):
    """expand_spell of a saved sheet, kept in memory until any sheet changes. None if there is no such sheet."""
    generation = store.generation
    cached = store.completed.get(spell_id)
    if cached and cached[0] == generation:
        return cached[1]
    data = store.spell(spell_id)
    if data is None:
        return None
    value = expand_spell(store, data)
    store.completed[spell_id] = (generation, value)
    return value


# What lists (cards, rows, scrolls) don't need: the full sheet comes from GET /api/spells/<id> when it is opened
LIGHT_LEFT_OUT = ("description_html", "description_text", "linked", "references", "also_appears_in", "levels")
COST_LABEL_RE = re.compile(r"^(?:(?:arcane|divine)\s+)?material\s+components?\s*:|^xp\s+cost\s*:", re.I)
DICE_RE = re.compile(r"\b\d+d\d+(?:\s*[+×x]\s*\d+)?\b")  # the same as DICE_RE in app.js


def cost_paragraphs(description_html):
    """The "Material Component: …" and "XP Cost: …" paragraphs: the interface reads the scroll costs from them."""
    found = []
    for paragraph in re.findall(r"<p>.*?</p>", description_html or "", re.S):
        text = html.unescape(re.sub(r"<[^>]+>", "", paragraph[3:-4])).strip()
        if COST_LABEL_RE.match(text):
            found.append(paragraph)
    return "".join(found)


def light_spell(store, spell_id):
    """The completed sheet without the long texts, plus what the lists need from them: `costs_html` (and
    `base_costs_html` when the components come from the base spell) and `has_dice` (for Empower/Maximize)."""
    generation = store.generation
    cached = store.light.get(spell_id)
    if cached and cached[0] == generation:
        return cached[1]
    full = completed_spell(store, spell_id)
    if full is None:
        return None
    light = {key: value for key, value in full.items() if key not in LIGHT_LEFT_OUT}
    light["costs_html"] = cost_paragraphs(full.get("description_html"))
    inherited = full.get("inherited_from") or {}
    base_name = (inherited.get("keys") or {}).get("components")
    base = next((b for b in inherited.get("chain", []) if b["name"] == base_name), None)
    if base:
        light["base_costs_html"] = cost_paragraphs((store.spell(base["id"]) or {}).get("description_html"))
    light["has_dice"] = bool(DICE_RE.search(full.get("description_html") or ""))
    store.light[spell_id] = (generation, light)
    return light


def expand_spell(store, data):
    """Sheet ready for the interface: completed with merge_base, plus the referenced sheets
    (completed too) in "linked". The saved file stays as it is on dndtools."""
    sheets = {i: store.spell(i) for i in linked_ids(store, data)}
    sheets = {i: c for i, c in sheets.items() if c}
    all_sheets = {**sheets, data["id"]: data}
    return {**merge_base(data, all_sheets), "linked": [merge_base(c, all_sheets) for c in sheets.values()]}


def full_book(store, book):
    """The book with its spells ({id, level, added_at}: the sheets come with the character, GET /api/characters/<id>)
    and the removed ones (with name and school, for Settings)."""
    entries, removed = [], []
    for entry in book.get("spells", []):
        if entry.get("removed_at"):
            data = store.spell(entry["id"])
            if data:
                removed.append({**entry, "name": data["name"], "school": data.get("school", "")})
        elif store.spell(entry["id"]) is not None:
            entries.append(entry)
    entries.sort(key=lambda v: v["level"])
    removed.sort(key=lambda v: v["removed_at"], reverse=True)
    try:
        character_name = store.character(book.get("character")).get("name", "")
    except KeyError:
        character_name = ""
    return {**book_summary(store, book), "character_name": character_name, "spells": entries, "removed": removed}


def spell_in_use(store, spell_id):
    """True if a book of any character has the spell (removed ones too), or a spell of a book refers to it
    (a "functions like" base, whose stats it borrows)."""
    ids = {entry["id"] for book in store.all_books() for entry in book.get("spells", [])}
    if spell_id in ids:
        return True
    return any(spell_id in linked_ids(store, data) for data in map(store.spell, ids) if data)


def unused_spells(store, spell_ids):
    """The spells among spell_ids that no book has and no spell of a book refers to (see spell_in_use)."""
    ids = {entry["id"] for book in store.all_books() for entry in book.get("spells", [])}
    linked = set()
    for data in map(store.spell, ids):
        if data:
            linked.update(linked_ids(store, data))
    return [spell_id for spell_id in spell_ids if spell_id not in ids and spell_id not in linked]


def restore_spell(book, spell_id, level=None):
    """Shows again a spell removed from the book (at its old level, or at `level`). False if it wasn't removed."""
    entry = next((v for v in book["spells"] if v["id"] == spell_id and v.get("removed_at")), None)
    if not entry:
        return False
    del entry["removed_at"]
    if level is not None:
        entry["level"] = level
    return True


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# --- background jobs: dndtools searches and spell imports, whose progress the page polls ---
JOB_LIFETIME = 3600  # seconds a finished job stays available
IMPORT_WORKERS = 3   # spells downloaded at the same time during an import (no limit on how many)


class Job:
    """A download that runs in the background: the page follows it (GET /api/jobs/<id>) and lists the recent ones
    (GET /api/jobs), so its progress stays visible whatever the user does, even after a reload."""

    def __init__(self, kind, **info):
        self.id = secrets.token_hex(8)
        self.started = time.time()
        self.ended = None
        self.lock = threading.Lock()
        self.data = {"id": self.id, "kind": kind, "done": 0, "total": 0, "finished": False, "error": None,
                     "cancelled": False, "started_at": now(), "finished_at": None, **info}

    def summary(self):
        """Without the lists (search results, added spells…), only how many there are."""
        with self.lock:
            data = {**self.data, **self._timing()}
        lists = ("results", "added", "skipped", "failed")
        return {**{k: v for k, v in data.items() if k not in lists},
                "counts": {k: len(data.get(k) or []) for k in lists}}

    @property
    def cancelled(self):
        return self.data["cancelled"]

    def cancel(self):
        """"Stop": the work still to do is skipped, what is done stays."""
        with self.lock:
            if not self.data["finished"]:
                self.data["cancelled"] = True

    def add(self, count=1):
        with self.lock:
            self.data["total"] += count

    def step(self, count=1):
        with self.lock:
            self.data["done"] += count

    def update(self, **values):
        with self.lock:
            self.data.update(values)

    def append(self, key, value):
        with self.lock:
            self.data.setdefault(key, []).append(value)

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps({**self.data, **self._timing()}))

    def _timing(self):
        """elapsed seconds, and `remaining`: the seconds still needed at the pace so far (None until there is a
        pace to go by). A search finds its pages as it goes, so its estimate grows with them."""
        elapsed = (self.ended or time.time()) - self.started
        done, total = self.data["done"], self.data["total"]
        remaining = None
        if not self.data["finished"] and not self.data["cancelled"] and done and total > done and elapsed >= 1:
            remaining = round(elapsed / done * (total - done))
        return {"elapsed": round(elapsed, 1), "remaining": remaining}

    def end(self, **values):
        with self.lock:
            self.ended = time.time()
            self.data.update(finished=True, finished_at=now(), **values)


JOBS = {}
JOBS_LOCK = threading.Lock()
# set when the server stops: the downloads still running end without saving (the thread pools would otherwise
# keep the process alive until every queued spell is done, still writing to the books after "Grimoire stopped")
STOPPING = threading.Event()


def cancel_all_jobs():
    STOPPING.set()
    with JOBS_LOCK:
        for job in JOBS.values():
            job.cancel()


def forget_old_jobs():
    with JOBS_LOCK:
        for old_id in [i for i, j in JOBS.items() if j.data["finished"] and time.time() - j.started > JOB_LIFETIME]:
            del JOBS[old_id]


def start_job(kind, work, **info):
    """Runs work(job) in a thread; errors end up in job["error"]. info: label, book… shown by the page."""
    job = Job(kind, **info)
    forget_old_jobs()
    with JOBS_LOCK:
        JOBS[job.id] = job

    def run():
        try:
            work(job)
        except ApiError as error:
            job.update(error=error.message)
        except dndtools.DndtoolsError as error:
            job.update(error=str(error))
        except KeyError:
            job.update(error="The book was not found: it may have been deleted.")
        except Exception as error:  # unexpected error: show it on the page too
            job.update(error=f"Internal error: {error}")
            raise
        finally:
            job.end()

    threading.Thread(target=run, daemon=True).start()
    return job


FILTERS = {}


def dndtools_filters():
    """The dndtools search filters, downloaded once per server run."""
    if "options" not in FILTERS:
        FILTERS["options"] = search.filter_options()
    return FILTERS["options"]


def run_search(job, filters):
    with ThreadPoolExecutor(search.WORKERS) as pool:
        job.update(**search.search(filters, pool, job))


def import_spells(store, book_id, urls, job):
    """Downloads the spells (with the spells they reference) and adds each one to the book as soon as it is
    ready, at the level suggested for the book's class. Spells already in the book are skipped."""
    wanted = {}
    for url in urls:
        try:
            canonical, spell_id = dndtools.normalize_url(str(url))
        except dndtools.DndtoolsError:
            job.append("failed", {"url": str(url)[:200], "error": "This is not a link to a dndtools spell."})
            continue
        wanted.setdefault(spell_id, canonical)
    store.book(book_id)
    job.add(len(wanted))

    def add_one(item):
        spell_id, url = item
        if job.cancelled:
            job.step()
            return
        try:
            data = download_with_linked(store, url)
            if STOPPING.is_set():
                return
            with LOCK:
                book = store.book(book_id)
                if book.get("unavailable"):
                    job.append("failed", {"id": data["id"], "url": url, "error": "The book is not available any more."})
                    return
                if any(v["id"] == data["id"] for v in shown(book["spells"])):
                    job.append("skipped", {"id": data["id"], "name": data["name"]})
                    return
                if restore_spell(book, data["id"]):
                    store.save_book(book)
                    level = next(v["level"] for v in book["spells"] if v["id"] == data["id"])
                    job.append("added", {"id": data["id"], "name": data["name"], "level": level,
                                         "source": "restored", "from_class": True, "restored": True})
                    return
                level, source = level_for_book(store, book, data)
                class_type = book_class(book)[2]
                book["spells"].append({"id": data["id"], "level": level, "added_at": now()})
                store.save_book(book)
            job.append("added", {"id": data["id"], "name": data["name"], "level": level, "source": source,
                                 "from_class": level_from_class(source, class_type)})
        except dndtools.DndtoolsError as error:
            job.append("failed", {"id": spell_id, "url": url, "error": str(error)})
        finally:
            job.step()

    with ThreadPoolExecutor(IMPORT_WORKERS) as pool:
        list(pool.map(add_one, wanted.items()))


# --- hand-written spells (not from dndtools) ---
SCHOOLS = ["Abjuration", "Conjuration", "Divination", "Enchantment", "Evocation",
           "Illusion", "Necromancy", "Transmutation", "Universal"]
COMPONENTS = ["V", "S", "M", "F", "AF", "DF", "XP"]


def text_to_html(text):
    """Hand-written description -> HTML paragraphs. A line break after . ! ? : starts a paragraph (like an
    empty line); other line breaks join the lines (text pasted from a PDF). A line starting with
    "Label:" also starts a paragraph, so formatDescription shows it as a box."""
    blocks = []
    for piece in re.split(r"\n\s*\n", text.replace("\r", "").strip()):
        current = ""
        for line in (html.escape(r.strip(), quote=False) for r in piece.split("\n")):
            if not line:
                continue
            if current and (re.search(r"[.!?:]['\"’”)]?$", current) or dndtools.LABEL_RE.match(line)):
                blocks.append(current)
                current = line
            else:
                current = f"{current} {line}".strip()
        if current:
            blocks.append(current)
    return "".join(f"<p>{b}</p>" for b in blocks)


def levels_from_text(text):
    """"Sorcerer/Wizard 3, Cleric 4, Fire domain 3" -> (levels by class, domains)."""
    levels, domains = [], []
    for entry in re.split(r"[,;\n]", text or ""):
        found = re.fullmatch(r"\s*(.+?)\s+(\d)\s*", entry)
        if not found:
            if entry.strip():
                raise ApiError(HTTPStatus.BAD_REQUEST,
                               f"“{entry.strip()}” is not a spell level: write a class and a number, like “Wizard 3”.")
            continue
        name, level = found.group(1).strip(), int(found.group(2))
        domain = re.fullmatch(r"(.+?)\s+domain", name, re.I)
        if domain:
            domains.append({"domain": domain.group(1).strip()[:40], "level": level})
        else:
            levels += [{"caster_class": c.strip()[:40], "level": level} for c in name.split("/") if c.strip()]
    return levels, domains


def handwritten_sheet(body, previous=None):
    """Sheet of a hand-written spell, with the same keys as the dndtools ones
    (measurements in metric units here too, in case the text is copied from an English rulebook)."""
    if not isinstance(body, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "The spell must be an object.")

    def text(key, maximum=200):
        return re.sub(r"\s+", " ", str(body.get(key) or "")).strip()[:maximum]

    def text_list(key):
        return [v.strip()[:40] for v in re.split(r"[,;]", text(key)) if v.strip()]

    name = text("name", 120)
    if not name:
        raise ApiError(HTTPStatus.BAD_REQUEST, "The spell name is required.")
    school = text("school", 40)
    if school and school not in SCHOOLS:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Unknown school of magic.")
    description = str(body.get("description") or "").strip()[:30000]
    levels, domains = levels_from_text(text("levels", 400))
    components = [c for c in COMPONENTS if c in (body.get("components") or [])]
    page = str(body.get("page") or "").strip()
    description_html = text_to_html(description)
    # the card summary skips the "Material Component: …", "Special: …" lines
    without_labels = "".join(p for p in re.findall(r"<p>.*?</p>", description_html)
                             if not dndtools.LABEL_RE.match(p[3:]))
    slug = slugify(name)
    return units.convert_spell({
        "id": previous["id"] if previous else f"handwritten-{slug}-{secrets.token_hex(3)}",
        "slug": slug,
        "url": "",
        "name": name,
        "rulebook": text("rulebook", 120),
        "page": int(page) if page.isdigit() else None,
        "edition_35": True,
        "school": school,
        "subschools": text_list("subschools"),
        "descriptors": text_list("descriptors"),
        "levels": levels,
        "domains": domains,
        "components": components,
        "stats": {key: text(key) for key in dndtools.STATS.values() if text(key)},
        "description_html": description_html,
        "description_text": description,
        "summary": dndtools._summary(without_labels or description_html),
        "references": [],
        "based_on": None,
        "based_on_name": None,
        "based_on_searched": True,
        "also_appears_in": [],
        "handwritten": True,
        "created_at": previous.get("created_at") if previous else now(),
        "modified_at": now(),
    })


def required_text(body, key, maximum=120):
    value = str(body.get(key) or "").strip()
    if not value:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"The {key} is required.")
    return value[:maximum]


def valid_pages(value):
    try:
        return max(1, min(10000, int(value or 100)))
    except (TypeError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "The number of pages must be a number.")


def valid_level(value):
    try:
        level = int(value)
    except (TypeError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "The level must be a number from 0 to 9.")
    if not 0 <= level <= 9:
        raise ApiError(HTTPStatus.BAD_REQUEST, "The level must be a number from 0 to 9.")
    return level


def make_handler(store, network, control=None):
    """control: {"token", "server", "quiet"} for /api/shutdown and the request log."""
    control = control if control is not None else {}

    class Handler(BaseHTTPRequestHandler):
        server_version = "Grimoire/1.0"

        def log_message(self, fmt, *args):
            if not control.get("quiet") and "--quiet" not in sys.argv:
                sys.stderr.write("  %s\n" % (fmt % args))

        # --- responses ---
        def _json(self, data, status=HTTPStatus.OK, etag=None):
            body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            # an ETag lets the browser keep the answer and ask "has it changed?" next time (304)
            self._send(status, "application/json; charset=utf-8", body, "no-cache" if etag else "no-store", etag)

        def _send(self, status, content_type, body, cache, etag=None):
            """Sends a body, compressed when the browser accepts it (a big book is 10 times smaller for the phone)."""
            if etag and self.headers.get("If-None-Match") == etag:
                self.send_response(HTTPStatus.NOT_MODIFIED)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache)
                self.end_headers()
                return
            compress = len(body) > 1400 and "gzip" in (self.headers.get("Accept-Encoding") or "") and (
                content_type.startswith(("text/", "application/json", "image/svg")) or "javascript" in content_type)
            if compress:
                body = gzip.compress(body, compresslevel=5)
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("Vary", "Accept-Encoding")
            if compress:
                self.send_header("Content-Encoding", "gzip")
            if etag:
                self.send_header("ETag", etag)
            self.end_headers()
            self.wfile.write(body)

        def _data_etag(self):
            """Changes with every write of the data (and with every start of the server)."""
            return f'"{START_TOKEN}-{store.version}"'

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request too large.")
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except json.JSONDecodeError:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid JSON.")

        def _static(self, path):
            relative = unquote(path).lstrip("/") or "index.html"
            # rules kept offline: downloaded first when missing (503 with the reason while they aren't there)
            for name, file, ensure in (("conditions.json", CONDITIONS_FILE, ensure_conditions),
                                       ("metamagic.json", METAMAGIC_FILE, ensure_metamagic)):
                if relative == name:
                    error = ensure()
                    if error:
                        raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, error)
                    self._send_file(file, "application/json; charset=utf-8")
                    return
            file = (WEB / relative).resolve()
            if WEB not in file.parents or not file.is_file():
                file = WEB / "index.html"
            mime_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            if mime_type.startswith("text/") or mime_type in ("application/javascript", "image/svg+xml"):
                mime_type += "; charset=utf-8"
            self._send_file(file, mime_type)

        def _send_file(self, file, content_type):
            info = file.stat()
            etag = f'"{info.st_mtime_ns:x}-{info.st_size:x}"'
            if self.headers.get("If-None-Match") == etag:
                self._send(HTTPStatus.OK, content_type, b"", "no-cache", etag)
            else:
                self._send(HTTPStatus.OK, content_type, file.read_bytes(), "no-cache", etag)

        def _route(self, method):
            path = urlparse(self.path).path
            if not path.startswith("/api/"):
                if method != "GET":
                    raise ApiError(HTTPStatus.NOT_FOUND, "Unknown path.")
                return self._static(path)
            parts = [p for p in path.split("/")[2:] if p]
            try:
                response = self._api(method, parts)
            except KeyError:
                raise ApiError(HTTPStatus.NOT_FOUND, "Book or spell not found.")
            if isinstance(response, tuple):
                self._json(*response)
            else:
                self._json(response)

        def _handle(self, method):
            try:
                self._route(method)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the browser left the page before the answer was sent
            except ApiError as error:
                self._json({"error": error.message}, error.status)
            except dndtools.DndtoolsError as error:
                self._json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
            except Exception as error:  # unexpected error: show it instead of closing the connection
                self._json({"error": f"Internal error: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
                raise

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PATCH(self):
            self._handle("PATCH")

        def do_PUT(self):
            self._handle("PUT")

        def do_DELETE(self):
            self._handle("DELETE")

        # --- API ---
        def _api(self, method, parts):
            if parts == ["books"]:
                if method == "GET":
                    books = [book_summary(store, l) for l in store.all_books()]
                    return sorted(books, key=lambda l: l["created_at"] or "")
                if method == "POST":
                    return self._create_book(self._body())

            if len(parts) >= 2 and parts[0] == "books":
                book_id = parts[1]
                if len(parts) == 2:
                    if method == "GET":
                        etag = self._data_etag()  # before reading: a change made meanwhile gets a newer ETag
                        return full_book(store, store.book(book_id)), HTTPStatus.OK, etag
                    if method == "PATCH":
                        return self._edit_book(book_id, self._body())
                    if method == "DELETE":
                        with LOCK:
                            book = store.book(book_id)
                            ensure_available(book)
                            character_id = book.get("character")
                            store.delete_book(book_id)
                            clean_character(store, character_id)
                        return {"ok": True}
                if len(parts) == 3 and parts[2] == "spells" and method == "POST":
                    return self._add(book_id, self._body())
                if len(parts) == 3 and parts[2] == "import" and method == "POST":
                    return self._import(book_id, self._body())
                if len(parts) == 4 and parts[2] == "spells":
                    if method == "PATCH":
                        return self._change_level(book_id, parts[3], self._body())
                    if method == "DELETE":
                        return self._remove(book_id, parts[3])
                if parts[2:] == ["spells", "remove"] and method == "POST":
                    return self._remove_many(book_id, self._body())
                if parts[2:] == ["spells", "restore"] and method == "POST":
                    return self._restore_many(book_id, self._body())
                if len(parts) == 5 and parts[2] == "spells" and parts[4] == "restore" and method == "POST":
                    return self._restore(book_id, parts[3])
                if len(parts) == 5 and parts[2] == "spells" and parts[4] == "forever" and method == "DELETE":
                    return self._delete_forever(book_id, parts[3])

            if parts == ["characters"]:
                if method == "GET":
                    return [character_summary(p, store.books_of(p["id"])) for p in store.all_characters()]
                if method == "POST":
                    return self._create_character(self._body())
            if len(parts) == 2 and parts[0] == "characters":
                if method == "GET":
                    etag = self._data_etag()
                    if self.headers.get("If-None-Match") == etag:
                        store.character(parts[1])  # 404 if it was deleted
                        return {}, HTTPStatus.OK, etag  # answered with 304
                    return full_character(store, parts[1]), HTTPStatus.OK, etag
                if method == "PATCH":
                    return self._edit_character(parts[1], self._body())
                if method == "DELETE":
                    with LOCK:
                        store.character(parts[1])
                        if store.books_of(parts[1]):
                            raise ApiError(HTTPStatus.CONFLICT, "This character still has spellbooks: move them to another character or delete them first.")
                        store.delete_character(parts[1])
                    return {"ok": True}
            if len(parts) == 3 and parts[0] == "characters" and parts[2] == "prepared" and method == "PUT":
                return self._prepare(parts[1], self._body())
            if len(parts) == 3 and parts[0] == "characters" and parts[2] == "scrolls" and method == "PUT":
                return self._save_scrolls(parts[1], self._body())

            if parts == ["network"]:
                if method == "GET":
                    return network.status()
                if method == "POST":
                    # JSON only: another site open in the browser can't send it without a preflight (which fails here)
                    if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Send the request as JSON.")
                    return network.open()

            if parts == ["preview"] and method == "POST":
                return self._preview(self._body())

            if parts == ["dndtools", "filters"] and method == "GET":
                return dndtools_filters()
            if parts == ["dndtools", "search"] and method == "POST":
                filters = search.clean_filters(self._body().get("filters"))
                job = start_job("search", lambda job: run_search(job, filters), label="Searching dndtools", filters=filters)
                return job.snapshot(), HTTPStatus.ACCEPTED
            if parts == ["jobs"] and method == "GET":
                forget_old_jobs()
                with JOBS_LOCK:
                    jobs = sorted(JOBS.values(), key=lambda j: j.started)
                return [job.summary() for job in jobs]
            if parts == ["instance"] and method == "GET":
                return {"id": START_TOKEN, "data": str(store.books.parent.resolve())}
            if parts == ["shutdown"] and method == "POST":
                # only the --stop command knows the token (it is in the data folder, which a website can't read)
                body = self._body() if (self.headers.get("Content-Type") or "").startswith("application/json") else {}
                if not control.get("token") or not secrets.compare_digest(str(body.get("token", "")), control["token"]):
                    raise ApiError(HTTPStatus.FORBIDDEN, "Not allowed.")
                threading.Thread(target=control["server"].shutdown, daemon=True).start()
                return {"ok": True}
            if len(parts) in (2, 3) and parts[0] == "jobs":
                job = JOBS.get(parts[1])
                if not job:
                    raise ApiError(HTTPStatus.NOT_FOUND, "This search or import is no longer available.")
                if len(parts) == 2 and method == "GET":
                    return job.snapshot()
                if parts[2:] == ["cancel"] and method == "POST":
                    job.cancel()
                    return job.snapshot()

            if len(parts) == 2 and parts[0] == "spells" and method == "GET":
                sheet = completed_spell(store, parts[1])
                if sheet is None:
                    raise KeyError(parts[1])
                return sheet

            if len(parts) == 2 and parts[0] == "spells" and method == "PUT":
                return self._edit_handwritten(parts[1], self._body())

            if len(parts) == 3 and parts[0] == "spells" and parts[2] == "refresh" and method == "POST":
                old = store.spell(parts[1])
                if not old:
                    raise KeyError(parts[1])
                if old.get("handwritten"):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "This spell was written by hand: edit it instead.")
                fresh = download_with_linked(store, old["url"], force=True)
                return expand_spell(store, fresh)

            raise ApiError(HTTPStatus.NOT_FOUND, "Unknown path.")

        def _create_book(self, body):
            name = required_text(body, "name")
            character_id = self._valid_character(body.get("character"))
            caster_class, class_type = class_fields(body)
            book = {
                "id": f"{slugify(name)}-{secrets.token_hex(3)}",
                "name": name,
                "character": character_id,
                "owner": str(body.get("owner") or "").strip()[:80],
                "caster_class": caster_class,
                "class_type": class_type,
                "max_pages": valid_pages(body.get("max_pages")),
                "notes": str(body.get("notes") or "").strip()[:2000],
                "color": str(body.get("color") or "crimson")[:20],
                "created_at": now(),
                "spells": [],
            }
            with LOCK:
                store.save_book(book)
                self._same_class_type(book)
            return book_summary(store, book), HTTPStatus.CREATED

        def _same_class_type(self, book):
            """The type of a class is the same in all the books of that class of the character. Call it holding LOCK."""
            key, _, class_type = book_class(book)
            for other in store.books_of(book["character"]):
                if other["id"] != book["id"] and book_class(other)[0] == key and other.get("class_type") != class_type:
                    other["class_type"] = class_type
                    store.save_book(other)

        def _valid_character(self, value):
            try:
                return store.character(str(value or ""))["id"]
            except KeyError:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Choose the character this spellbook belongs to.")

        def _create_character(self, body):
            character = new_character(required_text(body, "name", 80))
            with LOCK:
                store.save_character(character)
            return character_summary(character, []), HTTPStatus.CREATED

        def _edit_book(self, book_id, body):
            """A book that is not available (lost, stolen) only accepts changes to its availability."""
            with LOCK:
                book = store.book(book_id)
                original = dict(book)
                if "unavailable" in body:
                    book["unavailable"] = valid_unavailable(body["unavailable"], book.get("unavailable"))
                    if not book["unavailable"]:
                        del book["unavailable"]
                before = book.get("character")
                if "character" in body:
                    book["character"] = self._valid_character(body["character"])
                if "name" in body:
                    book["name"] = required_text(body, "name")
                for key, maximum in (("owner", 80), ("notes", 2000), ("color", 20)):
                    if key in body:
                        book[key] = str(body[key] or "").strip()[:maximum]
                before_class = book_class(book)[0]
                book["caster_class"], book["class_type"] = class_fields(body, book)
                if "max_pages" in body:
                    book["max_pages"] = valid_pages(body["max_pages"])
                fields = ("name", "character", "owner", "notes", "color", "max_pages", "caster_class", "class_type")
                if book.get("unavailable") and any(book.get(k) != original.get(k) for k in fields):
                    ensure_available(book)
                store.save_book(book)
                self._same_class_type(book)
                if before != book["character"] or before_class != book_class(book)[0]:
                    # the previous character (or class) loses the spells of the book
                    clean_character(store, before)
            return book_summary(store, book)

        def _edit_character(self, character_id, body):
            """Name, known metamagic feats, favorite spells, and the preparation of each class:
            {"classes": {class key: {daily_slots, ability_score, ability, specialization, used}}}
            (only the classes of the character's books, only the fields sent)."""
            with LOCK:
                character = store.character(character_id)
                books = store.books_of(character_id)
                if "name" in body:
                    character["name"] = required_text(body, "name", 80)
                if "metamagic_feats" in body:
                    character["metamagic_feats"] = valid_metamagic_feats(body["metamagic_feats"])
                if "favorites" in body:
                    if not isinstance(body["favorites"], list):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Favorite spells must be a list.")
                    present = set(character_spells(books))
                    favorites = [str(i) for i in body["favorites"] if str(i) in present]
                    hidden = hidden_favorites(character.get("favorites", []), books)
                    character["favorites"] = list(dict.fromkeys(favorites + hidden))
                if "classes" in body:
                    if not isinstance(body["classes"], dict):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Classes must be an object.")
                    classes = {cls["key"]: cls for cls in character_classes(character, books)}
                    by_class = spells_by_class(books, removed=True)  # ★ marks of removed spells stay
                    stored = character.setdefault("classes", {})
                    for key, values in body["classes"].items():
                        if key not in classes or not isinstance(values, dict):
                            continue
                        cls, data = classes[key], stored.setdefault(key, {})
                        if "daily_slots" in values:
                            data["daily_slots"] = valid_slots(values["daily_slots"])
                        if "ability_score" in values:
                            data["ability_score"] = valid_ability_score(values["ability_score"])
                        if "ability" in values and not CLASS_TYPES[cls["type"]]["name"]:
                            data["ability"] = valid_ability(values["ability"])
                        if "specialization" in values:
                            data["specialization"] = valid_specialization(values["specialization"], by_class.get(key, set()), cls)
                        if "used" in values and cls["casting"] == "spontaneous":
                            data["used"] = valid_used(values["used"])
                        if "forbidden_schools" in values and "school" in CLASS_TYPES[cls["type"]]["specializations"]:
                            data["forbidden_schools"] = valid_forbidden(values["forbidden_schools"])
                        # the specialist school can't be forbidden too
                        specialization = data.get("specialization") or {}
                        if specialization.get("type") == "school" and specialization.get("name") in data.get("forbidden_schools", []):
                            data["forbidden_schools"] = [x for x in data["forbidden_schools"] if x != specialization["name"]]
                store.save_character(character)
            return character_summary(character, books)

        def _class_of(self, entry, classes, casting=None):
            """Class key of a prepared spell or scroll: the one sent, or the only class when there is one."""
            keys = [c["key"] for c in classes if casting is None or c["casting"] == casting]
            key = str(entry.get("class") or "")
            if not key and len(keys) == 1:
                return keys[0]
            return key if key in keys else None

        def _prepare(self, character_id, body):
            """Replaces the character's list of prepared spells: [{id, class, copies, cast, metamagic?}], for the
            classes that prepare their spells. A spell found in several books of a class is a single spell. The same
            spell can appear more than once with different metamagic (the entry without metamagic has no such key)."""
            entries = body.get("prepared")
            if not isinstance(entries, list):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Prepared spells must be a list.")
            with LOCK:
                character = store.character(character_id)
                books = store.books_of(character_id)
                classes = character_classes(character, books)
                by_class = spells_by_class(books)
                available = spells_by_class(books, only_available=True)
                forbidden = {c["key"]: set(c["forbidden_schools"]) for c in classes}
                sheets = {}
                before = {prepared_key(p): p for p in character.get("prepared", [])}
                prepared, seen = [], set()
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    spell_id = str(entry.get("id"))
                    class_key_ = self._class_of(entry, classes, "prepared")
                    metamagic = valid_prepared_metamagic(entry.get("metamagic"))
                    key = prepared_key({"class": class_key_, "id": spell_id, "metamagic": metamagic})
                    if spell_id not in by_class.get(class_key_, ()) or key in seen:
                        continue
                    copies = bounded_number(entry.get("copies", 1), 0, 30, "Copies must be a number.")
                    if forbidden.get(class_key_) and spell_id not in sheets:
                        sheets[spell_id] = store.spell(spell_id)
                    if spell_id not in available.get(class_key_, ()) or spell_schools(sheets.get(spell_id)) & forbidden.get(class_key_, set()):
                        # its books are lost or stolen, or its school is forbidden: the copies already prepared stay, no new ones
                        copies = min(copies, before.get(key, {}).get("copies", 0))
                    if not copies:
                        continue
                    cast = bounded_number(entry.get("cast", 0), 0, copies, "Cast must be a number.")
                    prepared.append({"id": spell_id, "class": class_key_, "copies": copies, "cast": cast,
                                     **({"metamagic": metamagic} if metamagic else {})})
                    seen.add(key)
                character["prepared"] = prepared + hidden_entries(character.get("prepared", []), books)
                store.save_character(character)
            return character_summary(character, books)

        def _save_scrolls(self, character_id, body):
            """Replaces the character's scrolls: [{id, class, count}], one entry per spell of a class, count 1-99
            (the class decides the scroll's caster level and whether it is arcane or divine)."""
            entries = body.get("scrolls")
            if not isinstance(entries, list):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Scrolls must be a list.")
            with LOCK:
                character = store.character(character_id)
                books = store.books_of(character_id)
                classes = character_classes(character, books)
                by_class = spells_by_class(books)
                scrolls = {}
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    class_key_ = self._class_of(entry, classes)
                    if str(entry.get("id")) not in by_class.get(class_key_, ()):
                        continue
                    count = bounded_number(entry.get("count", 0), 0, 99, "The number of scrolls must be a number.")
                    if count:
                        scrolls[(class_key_, str(entry["id"]))] = count
                character["scrolls"] = ([{"id": i, "class": k, "count": c} for (k, i), c in scrolls.items()]
                                        + hidden_entries(character.get("scrolls", []), books))
                store.save_character(character)
            return character_summary(character, books)

        def _preview(self, body):
            url, _ = dndtools.normalize_url(body.get("url"))
            data = download_with_linked(store, url)
            response = {"spell": expand_spell(store, data)}
            if body.get("book"):
                book = store.book(body["book"])
                class_type = book_class(book)[2]
                level, source = level_for_book(store, book, data)
                response.update({
                    "suggested_level": level,
                    "level_source": source,
                    "level_from_class": level_from_class(source, class_type),
                    "already_in_book": any(v["id"] == data["id"] for v in shown(book["spells"])),
                })
                removed = next((v for v in book["spells"] if v["id"] == data["id"] and v.get("removed_at")), None)
                if removed:
                    response["removed_from_book"] = {"level": removed["level"], "removed_at": removed["removed_at"]}
            return response

        def _import(self, book_id, body):
            urls = body.get("urls")
            if not isinstance(urls, list) or not urls:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Choose at least one spell to add.")
            book = store.book(book_id)
            ensure_available(book)
            job = start_job("import", lambda job: import_spells(store, book_id, urls, job),
                            label=f"Adding spells to “{book['name']}”", book=book_id, book_name=book["name"],
                            character=book.get("character"), caster_class=book.get("caster_class"))
            return job.snapshot(), HTTPStatus.ACCEPTED

        def _add_handwritten(self, book_id, body):
            data = handwritten_sheet(body["sheet"])
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                if any((store.spell(v["id"]) or {}).get("name", "").lower() == data["name"].lower()
                       for v in shown(book["spells"])):
                    raise ApiError(HTTPStatus.CONFLICT, f"A spell named {data['name']} is already in this book.")
                if body.get("level") not in (None, ""):
                    level = valid_level(body["level"])
                elif data["levels"] or data["domains"]:
                    level = level_for_book(store, book, data)[0]
                else:
                    raise ApiError(HTTPStatus.BAD_REQUEST,
                                   "Choose the level in this book, or write the spell levels (like “Wizard 3”).")
                store.save_spell(data)
                book["spells"].append({"id": data["id"], "level": level, "added_at": now()})
                store.save_book(book)
            return full_book(store, book), HTTPStatus.CREATED

        def _edit_handwritten(self, spell_id, body):
            with LOCK:
                previous = store.spell(spell_id)
                if not previous:
                    raise KeyError(spell_id)
                if not previous.get("handwritten"):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Only hand-written spells can be edited: use “Refresh from dndtools”.")
                holders = [b for b in store.all_books() if any(v["id"] == spell_id for v in b.get("spells", []))]
                if holders and all(b.get("unavailable") for b in holders):
                    ensure_available(holders[0])
                data = handwritten_sheet(body.get("sheet"), previous)
                store.save_spell(data)
            return expand_spell(store, data)

        def _add(self, book_id, body):
            ensure_available(store.book(book_id))
            if "sheet" in body:
                return self._add_handwritten(book_id, body)
            url, _ = dndtools.normalize_url(body.get("url"))
            data = download_with_linked(store, url)
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                if any(v["id"] == data["id"] for v in shown(book["spells"])):
                    raise ApiError(HTTPStatus.CONFLICT, f"{data['name']} is already in this book.")
                level = valid_level(body["level"]) if body.get("level") is not None else None
                if not restore_spell(book, data["id"], level):
                    level = level_for_book(store, book, data)[0] if level is None else level
                    book["spells"].append({"id": data["id"], "level": level, "added_at": now()})
                store.save_book(book)
            return full_book(store, book), HTTPStatus.CREATED

        def _change_level(self, book_id, spell_id, body):
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                entry = next((v for v in shown(book["spells"]) if v["id"] == spell_id), None)
                if not entry:
                    raise KeyError(spell_id)
                entry["level"] = valid_level(body.get("level"))
                store.save_book(book)
            return full_book(store, book)

        def _remove(self, book_id, spell_id):
            """Hides the spell: it stays in the book file (removed_at) with its prepared copies, scrolls and marks."""
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                entry = next((v for v in shown(book["spells"]) if v["id"] == spell_id), None)
                if not entry:
                    raise KeyError(spell_id)
                entry["removed_at"] = now()
                store.save_book(book)
            return full_book(store, book)

        def _delete_forever(self, book_id, spell_id):
            """Deletes the spell from the book for good (shown or removed): with it go the prepared copies, scrolls
            and marks it had through this book, and its saved sheet if nothing else uses it."""
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                if not any(v["id"] == spell_id for v in book["spells"]):
                    raise KeyError(spell_id)
                book["spells"] = [v for v in book["spells"] if v["id"] != spell_id]
                store.save_book(book)
                clean_character(store, book.get("character"))
                sheet_deleted = not spell_in_use(store, spell_id) and store.delete_spell(spell_id)
            return {**full_book(store, book), "sheet_deleted": sheet_deleted}

        @staticmethod
        def _spell_ids(body):
            ids = body.get("ids")
            if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Choose at least one spell.")
            return list(dict.fromkeys(ids))

        def _remove_many(self, book_id, body):
            """Several spells at once: hidden like _remove, or with `forever` deleted like _delete_forever
            (shown and removed ones). Spells the book doesn't have are ignored; 404 if it has none of them."""
            ids = self._spell_ids(body)
            forever = body.get("forever") is True
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                wanted = set(ids)
                if forever:
                    hit = [v["id"] for v in book["spells"] if v["id"] in wanted]
                    book["spells"] = [v for v in book["spells"] if v["id"] not in wanted]
                else:
                    hit = []
                    stamp = now()
                    for entry in shown(book["spells"]):
                        if entry["id"] in wanted:
                            entry["removed_at"] = stamp
                            hit.append(entry["id"])
                if not hit:
                    raise KeyError(book_id)
                store.save_book(book)
                answer = {"count": len(hit)}
                if forever:
                    clean_character(store, book.get("character"))
                    unused = unused_spells(store, hit)
                    answer = {"count": len(hit), "sheets_deleted": sum(1 for i in unused if store.delete_spell(i))}
            return {**full_book(store, book), **answer, "ids": hit}

        def _restore_many(self, book_id, body):
            ids = self._spell_ids(body)
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                restored = [spell_id for spell_id in ids if restore_spell(book, spell_id)]
                if not restored:
                    raise KeyError(book_id)
                store.save_book(book)
            return {**full_book(store, book), "restored": len(restored)}

        def _restore(self, book_id, spell_id):
            with LOCK:
                book = store.book(book_id)
                ensure_available(book)
                if not restore_spell(book, spell_id):
                    raise KeyError(spell_id)
                store.save_book(book)
            return full_book(store, book)

    return Handler


def local_network_ip():
    """IP of this computer on the home network (no packet is actually sent)."""
    for destination in ("192.168.1.1", "10.255.255.255", "8.8.8.8"):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            try:
                probe.connect((destination, 9))
                ip = probe.getsockname()[0]
            except OSError:
                continue
        if ip and not ip.startswith("127."):
            return ip
    return None


class NameAnnouncer:
    """Announces a .local name (my-grimoire.local) on the home network with avahi-publish, the mDNS tool of
    Avahi (the mDNS service of most Linux desktops), so iPhones and computers can open http://my-grimoire.local:<port>/.
    Names ending in .local need no setup on the phones. Without Avahi, or if another device already uses the
    name, the address falls back to the IP and `error` says why."""

    def __init__(self, name):
        self.name = name
        self.process = None
        self.ip = None
        self.error = None

    def announce(self, ip):
        """True when the name points to ip (the announcement starts, or restarts if the IP changed)."""
        if self.process and self.process.poll() is None and self.ip == ip:
            return True
        self.stop()
        tool = shutil.which("avahi-publish")
        if not tool:
            self.error = f"{self.name} can't be announced: Avahi (avahi-publish) is not installed."
            return False
        self._stop_leftovers()
        try:
            self.process = subprocess.Popen([tool, "-a", "-R", self.name, ip], stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        except OSError as error:
            self.error = f"{self.name} can't be announced: avahi-publish didn't start ({error.strerror})."
            return False
        ready, _, _ = select.select([self.process.stdout], [], [], 5)
        line = self.process.stdout.readline().strip() if ready else ""
        if line.startswith("Established"):
            self.ip, self.error = ip, None
            return True
        self.stop()
        self.error = f"{self.name} can't be announced ({line or 'Avahi did not answer'})."
        return False

    def _stop_leftovers(self):
        """An avahi-publish of this name left running by a server.py that was killed would block the name.
        Those of a server.py still running are left alone."""
        wanted = ["-a", "-R", self.name]
        for proc in Path("/proc").glob("[0-9]*"):
            try:
                args = (proc / "cmdline").read_bytes().split(b"\0")[:-1]
                if len(args) < 4 or not args[0].endswith(b"avahi-publish") or [a.decode() for a in args[1:4]] != wanted:
                    continue
                parent = (proc / "stat").read_text().rsplit(")", 1)[1].split()[1]
                parent_args = Path(f"/proc/{parent}/cmdline").read_bytes()
                if b"server.py" not in parent_args:
                    os.kill(int(proc.name), signal.SIGTERM)
            except (OSError, ValueError, IndexError):
                continue

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process, self.ip = None, None


class Network:
    """Access from devices on the same network (the phone on the same Wi-Fi), never from the internet.
    With --network the server already listens on 0.0.0.0; otherwise "Allow devices on this Wi-Fi" (POST /api/network)
    opens a second server on the same port, bound to the network IP, for as long as server.py keeps running.
    While access is open the .local name is announced, and the address uses it."""

    def __init__(self, port, all_interfaces, name=LOCAL_NAME):
        self.port = port
        self.all_interfaces = all_interfaces
        self.handler = None  # handler class, set after make_handler
        self.open_ip = None  # IP the extra server listens on
        self.lock = threading.RLock()  # open() calls status() while holding it
        self.names = NameAnnouncer(name)

    def status(self):
        ip = local_network_ip()
        active = bool(ip) and (self.all_interfaces or ip == self.open_ip)
        with self.lock:
            named = active and self.names.announce(ip)
        host = self.names.name if named else ip
        return {
            "port": self.port,
            "name": self.names.name if named else None,
            "name_error": self.names.error if active and not named else None,
            "address": f"http://{host}:{self.port}/" if ip else None,
            # the link of the QR code: every phone opens an IP, not every phone finds a .local name (many Androids)
            "ip_address": f"http://{ip}:{self.port}/" if ip else None,
            "connected": bool(ip),
            "active": active,
            "always": self.all_interfaces,
        }

    def close(self):
        self.names.stop()

    def open(self):
        with self.lock:
            status = self.status()
            if status["active"]:
                return status
            ip = local_network_ip()
            if not ip:
                raise ApiError(HTTPStatus.CONFLICT, "This computer doesn't seem to be connected to a local network.")
            try:
                server = ThreadingHTTPServer((ip, self.port), self.handler)
            except OSError as error:
                raise ApiError(HTTPStatus.CONFLICT,
                               f"Could not open port {self.port} on the home network ({error.strerror}). "
                               "Restart with: python3 server.py --network")
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.open_ip = ip
        status = self.status()
        print(f"Devices on the same Wi-Fi can now open {phone_addresses(status)}  (no password: anyone on this network can edit your books)", flush=True)
        return status


def phone_addresses(status):
    """The addresses for other devices, as printed in the terminal."""
    also = f" (or {status['address']} on iPhones and computers)" if status["name"] else ""
    return f"{status['ip_address']}{also}"


def local_address(name, port):
    """The address for this computer's browser: the name with .localhost (browsers send it to this computer with no
    setup, and it stays a secure address for "Paste"). Safari on macOS only knows it if the system resolves it:
    otherwise 127.0.0.1."""
    host = f"{name.removesuffix('.local')}.localhost"
    if sys.platform == "darwin":
        try:
            socket.getaddrinfo(host, port)
        except OSError:
            host = "127.0.0.1"
    return f"http://{host}:{port}/"


class LoopbackV6Server(ThreadingHTTPServer):
    """The same server on ::1: the system resolves "<name>.localhost" there too (browsers use 127.0.0.1)."""
    address_family = socket.AF_INET6


# ---------- one server per data folder, started and stopped by the scripts ----------
def run_file(data_folder):
    """<data>/server.json, written by the running server: id, pid, port, address, data folder, stop token."""
    return Path(data_folder) / "server.json"


def running_instance(data_folder):
    """The server already running on this data folder (its run file), or None if there isn't one."""
    try:
        info = json.loads(run_file(data_folder).read_text(encoding="utf-8"))
        with urllib.request.urlopen(f"http://127.0.0.1:{int(info['port'])}/api/instance", timeout=3) as response:
            answer = json.load(response)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    same = answer.get("id") == info.get("id") and answer.get("data") == str(Path(data_folder).resolve())
    return info if same else None


def open_browser(address):
    threading.Timer(0.5, webbrowser.open, args=(address,)).start()


def stop_instance(data_folder):
    """--stop: asks the server to stop (it cleans up), and ends the process if it doesn't answer."""
    info = running_instance(data_folder)
    if not info:
        run_file(data_folder).unlink(missing_ok=True)  # left by a server that is gone
        print("Grimoire is not running.")
        return 0
    request = urllib.request.Request(f"http://127.0.0.1:{int(info['port'])}/api/shutdown", method="POST",
                                     data=json.dumps({"token": info.get("token", "")}).encode(),
                                     headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=5).read()
    except OSError:
        pass
    for _ in range(50):
        if not running_instance(data_folder):
            print("Grimoire stopped.")
            return 0
        time.sleep(0.2)
    try:
        os.kill(int(info["pid"]), signal.SIGTERM)
    except (OSError, ValueError):
        pass
    run_file(data_folder).unlink(missing_ok=True)
    print("Grimoire stopped.")
    return 0


def start_in_background(args, argv):
    """--start: the server runs as a separate process without a window (its output goes to <data>/server.log);
    this command returns as soon as the server answers, or shows why it didn't start."""
    existing = running_instance(args.data)
    if existing:
        print(f"Grimoire is already running at {existing['address']}")
        if not args.no_browser:
            webbrowser.open(existing["address"])
        return 0
    python = Path(sys.executable)
    options = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        if python.with_name("pythonw.exe").exists():
            python = python.with_name("pythonw.exe")
        options["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True  # keeps running when the terminal is closed
    command = [str(python), "-B", str(APP_DIR / "server.py"), *[a for a in argv if a != "--start"], "--background"]
    try:
        Path(args.data).mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(f"Grimoire did not start: the data folder {args.data} can't be used ({error.strerror}).")
        return 1
    log = Path(args.data) / "server.log"
    size_before = log.stat().st_size if log.exists() else 0
    process = subprocess.Popen(command, cwd=APP_DIR, **options)
    for _ in range(600):  # up to a minute (the first start of a big library renames its files)
        info = running_instance(args.data)
        if info:
            print(f"Grimoire is running at {info['address']}\nStop it with the stop script (or: python3 server.py --stop).")
            return 0
        if process.poll() is not None:
            break
        time.sleep(0.1)
    try:
        with open(log, encoding="utf-8", errors="replace") as file:
            if log.stat().st_size >= size_before:  # otherwise the server started a new log
                file.seek(size_before)
            output = file.read().strip()
    except OSError:
        output = ""
    print("Grimoire did not start." + (f"\n{output}" if output else ""))
    return 1


def main():
    parser = argparse.ArgumentParser(description="Grimoire: local spellbooks.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data", default=str(APP_DIR / "data"), help="data folder (default: ./data)")
    parser.add_argument("--network", action="store_true",
                        help="listen on the home network too, so phones and tablets on the same Wi-Fi can open it")
    parser.add_argument("--name", default=LOCAL_NAME,
                        help=f"name announced on the home network, ending in .local (default: {LOCAL_NAME})")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    parser.add_argument("--quiet", action="store_true", help="do not log requests")
    parser.add_argument("--start", action="store_true",
                        help="run in the background without a window, and return when it answers")
    parser.add_argument("--stop", action="store_true", help="stop the server running on this data folder")
    parser.add_argument("--background", action="store_true", help=argparse.SUPPRESS)  # output to <data>/server.log
    args = parser.parse_args()
    if args.stop:
        sys.exit(stop_instance(args.data))
    if MISSING_MODULE:
        sys.exit(f"Missing Python module: {MISSING_MODULE}. Install it with: python3 -m pip install -r requirements.txt "
                 "(or use the start script for your system).")
    if args.start:
        sys.exit(start_in_background(args, sys.argv[1:]))
    try:
        Path(args.data).mkdir(parents=True, exist_ok=True)
    except OSError as error:
        sys.exit(f"The data folder {args.data} can't be used ({error.strerror}).")
    if args.background or sys.stdout is None:  # no window (pythonw): everything goes to the log
        log = Path(args.data) / "server.log"
        if log.exists() and log.stat().st_size > 2_000_000:
            os.replace(log, log.with_suffix(".log.old"))
        sys.stdout = sys.stderr = open(log, "a", encoding="utf-8", buffering=1)
        print(f"--- {now()}")
    existing = running_instance(args.data)
    if existing:
        print(f"Grimoire is already running at {existing['address']}")
        if not args.no_browser:
            webbrowser.open(existing["address"])
        sys.exit(0)
    if not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.local", args.name):
        sys.exit("--name must be one word of letters, digits and hyphens followed by .local, like my-grimoire.local")

    store = Store(args.data)
    store.assign_characters()
    store.upgrade_classes()
    converted = store.convert_units()
    if converted:
        print(f"Converted {converted} saved spell{'s' if converted != 1 else ''} to metric units.")
    # conditions missing (first start, deleted file): downloaded in the background, the page waits for them
    def fetch_conditions():
        error = ensure_conditions()
        if error:
            print(error, flush=True)

    threading.Thread(target=fetch_conditions, daemon=True).start()
    ensure_metamagic()
    renamed = store.name_spell_files()
    if renamed:
        print(f"Renamed {renamed} spell file{'s' if renamed != 1 else ''} to <level>-<name>--<id>.json.")
    host = "0.0.0.0" if args.network else "127.0.0.1"
    server = None
    network = Network(None, args.network, args.name)
    control = {"quiet": args.quiet or args.background, "token": secrets.token_urlsafe(24)}
    handler = make_handler(store, network, control)
    network.handler = handler
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer((host, port), handler)
            break
        except OSError:
            continue
    if server is None:
        sys.exit(f"No free port between {args.port} and {args.port + 19}.")

    port = server.server_address[1]
    network.port = port
    control["server"] = server
    try:
        loopback6 = LoopbackV6Server(("::1", port), handler)
        threading.Thread(target=loopback6.serve_forever, daemon=True).start()
    except OSError:
        pass  # no IPv6 on this computer: browsers use 127.0.0.1 anyway
    address = local_address(args.name, port)
    print(f"Grimoire running at {address}  ({'stop it with the stop script' if args.background else 'Ctrl+C to stop'})")
    if args.network:
        status = network.status()
        if status["address"]:
            print(f"From a phone on the same Wi-Fi: {phone_addresses(status)}")
            if status["name_error"]:
                print(status["name_error"])
        else:
            print("This computer doesn't seem to be connected to a local network.")
        print("Warning: there is no password, anyone on this network can edit your books.")
    print(f"Data in {Path(args.data).resolve()}", flush=True)
    info = {"id": START_TOKEN, "pid": os.getpid(), "port": port, "address": address,
            "data": str(Path(args.data).resolve()), "token": control["token"], "started_at": now()}
    tmp = run_file(args.data).with_suffix(".tmp")
    tmp.write_text(json.dumps(info, indent=2), encoding="utf-8")
    os.replace(tmp, run_file(args.data))
    if not args.no_browser:
        open_browser(address)
    # stopped by the system (kill, logout): same clean exit as Ctrl+C, so the name announcement stops too
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        server.serve_forever()  # returns after /api/shutdown (--stop)
        print("Grimoire stopped.")
    except KeyboardInterrupt:
        print("\nGrimoire stopped.")
    finally:
        cancel_all_jobs()
        network.close()
        server.server_close()
        try:
            if json.loads(run_file(args.data).read_text(encoding="utf-8")).get("id") == START_TOKEN:
                run_file(args.data).unlink()
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    main()
