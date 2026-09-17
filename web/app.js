// ===== Grimoire — interface =====
import { qrSvg } from "/qrcode.js";

const SCHOOLS = {
  Abjuration: "Abjuration",
  Conjuration: "Conjuration",
  Divination: "Divination",
  Enchantment: "Enchantment",
  Evocation: "Evocation",
  Illusion: "Illusion",
  Necromancy: "Necromancy",
  Transmutation: "Transmutation",
  Universal: "Universal",
};

const COVERS = {
  crimson: "#6b1d1d",
  midnight: "#1d2a4a",
  emerald: "#1d4a36",
  obsidian: "#2a2426",
  amber: "#6b4a1d",
  amethyst: "#3d2350",
};

const COVER_NAMES = {
  crimson: "Crimson", midnight: "Midnight", emerald: "Emerald",
  obsidian: "Obsidian", amber: "Amber", amethyst: "Amethyst",
};

const COMPONENTS = {
  V: "Verbal", S: "Somatic", M: "Material", F: "Focus",
  DF: "Divine focus", AF: "Arcane focus", XP: "Experience point cost",
};

const STATS = [
  ["casting_time", "Casting Time"],
  ["range", "Range"],
  ["target", "Target"],
  ["area", "Area"],
  ["effect", "Effect"],
  ["duration", "Duration"],
  ["saving_throw", "Saving Throw"],
  ["spell_resistance", "Spell Resistance"],
];

const $ = (selector, root = document) => root.querySelector(selector);
const app = $("#app");
const TOUCH = matchMedia("(pointer: coarse)").matches;  // phone or tablet
const CAN_PASTE = Boolean(window.isSecureContext && navigator.clipboard?.readText);

// levels folded in each tab ("book", "prepared", "scrolls"), remembered in this browser
const FOLD_KEY = "grimoire-folded-v1";

function loadFolded() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; } catch { /* private window or blocked storage */ }
  return Object.fromEntries(["book", "prepared", "scrolls"].map((view) => [
    view, new Set((Array.isArray(saved[view]) ? saved[view] : []).map(Number).filter((n) => n >= 0 && n <= 9)),
  ]));
}

function saveFolded() {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(Object.fromEntries(
      Object.entries(state.folded).map(([view, levels]) => [view, [...levels]]))));
  } catch { /* the folds just aren't remembered */ }
}

const state = {
  book: null,       // open book, or the collection of all the books (book.all)
  character: null,  // character of the open book: preparation + spells of all their books, merged
  textFilter: "",
  schoolFilters: new Set(),
  bookFilters: new Set(), // spellbook ids, in "All spellbooks"
  folded: loadFolded(),
  preview: null,    // preview response in the "add" dialog
  editingBookId: null, // id of the book being edited (null = new)
  view: "book",     // "book" = every spell, "prepared" = spells ready for the day, "scrolls" = scrolls owned
  onlyPrepared: false,
  onlyOwned: false,
  onlyFavorites: false,
  saveQueue: Promise.resolve(), // prepared-spell saves run one at a time
  selecting: false,  // Spellbook tab: cards are picked (to remove several at once) instead of opened
  selected: new Set(), // ids of the picked spells
  lastPicked: null,  // for shift-click ranges
  selectionLevels: new Map(), // level -> ids of the spells shown in it
  selectionOrder: [], // ids of the spells shown, in page order
};

// ---------- utilities ----------
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const ORDINALS = ["Cantrips", "First Level", "Second Level", "Third Level", "Fourth Level",
  "Fifth Level", "Sixth Level", "Seventh Level", "Eighth Level", "Ninth Level"];

function levelName(level) {
  return ORDINALS[Number(level)] ?? `Level ${level}`;
}

function pages(level) {
  return Math.max(1, Number(level));
}

function school(spell) {
  return SCHOOLS[spell.school] || spell.school || "—";
}

function schoolColor(spell) {
  const key = (spell.school || "universal").toLowerCase();
  return `var(--${key in { abjuration: 1, conjuration: 1, divination: 1, enchantment: 1, evocation: 1, illusion: 1, necromancy: 1, transmutation: 1 } ? key : "universal"})`;
}

function schoolLine(spell) {
  const subline = spell.subschools?.length ? ` (${spell.subschools.join(", ")})` : "";
  const descr = spell.descriptors?.length ? ` [${spell.descriptors.join(", ")}]` : "";
  return `${esc(school(spell))}<span class="subline">${esc(subline + descr)}</span>`;
}

function shortSource(spell) {
  const page = spell.page ? `, p. ${spell.page}` : "";
  return `${spell.rulebook || (spell.handwritten ? "Hand-written" : "dndtools")}${page}`;
}

function components(spell) {
  return `<span class="components">${(spell.components || [])
    .map((c) => `<abbr title="${esc(COMPONENTS[c] || c)}">${esc(c)}</abbr>`)
    .join("")}</span>`;
}

function pageBar(used, maximum) {
  const percent = Math.min(100, Math.round((used / Math.max(1, maximum)) * 100));
  return `<div class="page-bar ${used > maximum ? "full" : ""}"><span style="width:${percent}%"></span></div>`;
}

// action: {label, run} adds a button to the message (e.g. "Undo")
function notify(text, error = false, action = null) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = text;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => { node.remove(); action.run(); });
    node.append(button);
  }
  $("#toasts").append(node);
  setTimeout(() => node.remove(), error || action ? 6000 : 3200);
}

function shortDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const OUTDATED_SERVER = "The server is out of date: stop server.py (Ctrl+C), start it again and reload the page.";

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { /* empty response */ }
  // 501/405 without JSON = server started before an app update
  if ((response.status === 501 || response.status === 405) && !data) throw new Error(OUTDATED_SERVER);
  // a path the running server doesn't know yet = server started before an app update
  if (response.status === 404 && data?.error === "Unknown path.") throw new Error(OUTDATED_SERVER);
  if (!response.ok) throw new Error(data?.error || `Error ${response.status}`);
  return data;
}

// option = {text, label, warning}: a checkbox under the text; while it is ticked the button reads `label` and the
// text becomes `warning`. With an option the answer is false, "confirm" or "option" instead of true/false.
function askConfirm(title, text, label = "Confirm", option = null) {
  const dialog = $("#confirm-dialog");
  const box = $("#confirm-option");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-yes").textContent = label;
  $("#confirm-option-field").hidden = !option;
  box.checked = false;
  box.onchange = () => {
    $("#confirm-yes").textContent = box.checked ? option.label : label;
    $("#confirm-text").textContent = box.checked ? option.warning : text;
  };
  if (option) $("#confirm-option-text").textContent = option.text;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const yes = dialog.returnValue === "yes";
      resolve(option ? yes && (box.checked ? "option" : "confirm") : yes);
    }, { once: true });
  });
}

// ---------- long lists: only what changed is redrawn ----------
// With thousands of spells, rebuilding every card or row after each click takes seconds (on a phone even more).
// patchList keeps the elements whose HTML didn't change; patchSections does it for the level sections, whose
// "head" (title, pips) and rows are compared separately.
const patchMemory = new WeakMap(); // element -> {key, html}

// A row whose HTML is only built when it is needed (a big list shows its first rows before building the others)
function lazyRow(key, make) {
  let html;
  return {
    key,
    get html() {
      if (html === undefined) html = make().trim();
      return html;
    },
  };
}

// items: [{key, html}], each html a single element; decorate(element) runs on the elements it creates
function patchList(parent, items, decorate = null) {
  const old = new Map();
  for (const child of [...parent.children]) {
    const memo = patchMemory.get(child);
    if (memo && !old.has(memo.key)) old.set(memo.key, { el: child, html: memo.html });
    else child.remove();
  }
  const elements = new Array(items.length);
  const fresh = [];
  items.forEach((item, i) => {
    const kept = old.get(item.key);
    if (kept && kept.html === item.html) {
      elements[i] = kept.el;
      old.delete(item.key);
    } else {
      fresh.push(i);
    }
  });
  if (fresh.length) {
    const template = document.createElement("template");
    template.innerHTML = fresh.map((i) => items[i].html).join("");
    const created = [...template.content.children];
    fresh.forEach((i, n) => {
      elements[i] = created[n];
      patchMemory.set(created[n], { key: items[i].key, html: items[i].html });
      decorate?.(created[n]);
    });
  }
  for (const { el } of old.values()) el.remove();
  let cursor = parent.firstElementChild;
  for (const el of elements) {
    if (el === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(el, cursor);
  }
}

// sections: [{key, level, className, id?, head, listTag, listClass, rows: [{key, html}], empty}]
// Inside a section: the head nodes, then the list (or the `empty` element when there are no rows).
// When most rows are new (a big book just opened), CHUNK rows are drawn now and the others right after,
// so the page shows up at once instead of after every card has been built.
const sectionParts = new WeakMap();
const CHUNK = 150;
const pendingSections = new WeakMap(); // container -> timer of the next piece
const drawingInPieces = new WeakSet();   // containers whose rows are being drawn piece by piece

function patchSections(container, sections, decorate = null) {
  if (pendingSections.has(container)) {
    clearTimeout(pendingSections.get(container));
    pendingSections.delete(container);
  }
  let total = 0;
  let drawnBefore = 0;
  for (const section of sections) total += section.rows.length;
  for (const child of container.children) drawnBefore += sectionParts.get(child)?.list.childElementCount || 0;
  if (total - drawnBefore > CHUNK && total > 2 * drawnBefore) drawingInPieces.add(container);
  // a small first piece shows the page at once; bigger pieces then mean fewer layouts of the growing grid
  let budget = drawingInPieces.has(container) ? (drawnBefore ? 4 * CHUNK : CHUNK) : Infinity;
  let unfinished = false;
  const existing = new Map();
  for (const child of [...container.children]) {
    const key = child.dataset.sectionKey;
    if (key !== undefined && !existing.has(key)) existing.set(key, child);
    else child.remove();
  }
  const wanted = new Set(sections.map((s) => s.key));
  for (const [key, el] of existing) if (!wanted.has(key)) el.remove();
  let cursor = container.firstElementChild;
  for (const section of sections) {
    let el = existing.get(section.key);
    if (!el) {
      el = document.createElement("section");
      el.dataset.sectionKey = section.key;
    }
    if (el.className !== section.className) el.className = section.className;
    if (el.dataset.levelSection !== String(section.level)) el.dataset.levelSection = section.level;
    if (el.dataset.count !== String(section.rows.length)) el.dataset.count = section.rows.length;
    if (section.id && el.id !== section.id) el.id = section.id;
    let parts = sectionParts.get(el);
    const listKind = section.rows.length ? "list" : "empty";
    if (!parts || parts.kind !== listKind || (listKind === "empty" && parts.empty !== section.empty)) {
      parts?.list.remove();
      const list = listKind === "list" ? document.createElement(section.listTag) : document.createElement("template");
      if (listKind === "list") {
        list.className = section.listClass;
      }
      let node = list;
      if (listKind === "empty") {
        list.innerHTML = section.empty;
        node = list.content.firstElementChild;
      }
      el.append(node);
      parts = { ...(parts || { head: null, headNodes: [] }), kind: listKind, empty: section.empty, list: node };
      sectionParts.set(el, parts);
    }
    if (parts.head !== section.head) {
      for (const node of parts.headNodes) node.remove();
      const template = document.createElement("template");
      template.innerHTML = section.head;
      parts.headNodes = [...template.content.children];
      el.insertBefore(template.content, parts.list);
      parts.head = section.head;
    }
    if (listKind === "list") {
      const had = parts.list.childElementCount;
      const allowed = Math.min(section.rows.length, had + budget);
      if (allowed < section.rows.length) unfinished = true;
      patchList(parts.list, allowed < section.rows.length ? section.rows.slice(0, allowed) : section.rows, decorate);
      if (budget !== Infinity) budget = Math.max(0, budget - Math.max(0, allowed - had));
    }
    if (el === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(el, cursor);
  }
  if (unfinished) {
    // a timer, not an animation frame: rows added off screen don't make the browser draw a new frame
    pendingSections.set(container, setTimeout(() => {
      pendingSections.delete(container);
      patchSections(container, sections, decorate);
    }, 0));
  } else {
    drawingInPieces.delete(container);
  }
}

// Spells of the character by ID, and of the open book by ID (rebuilt when the lists are loaded again)
const indexCache = new WeakMap();

function indexBy(list, key) {
  let index = indexCache.get(list);
  if (!index) {
    index = new Map(list.map((entry) => [key(entry), entry]));
    indexCache.set(list, index);
  }
  return index;
}

function characterSpell(id, pc = state.character) {
  return pc ? indexBy(pc.spells, (e) => e.spell.id).get(id) : undefined;
}

function bookSpell(id, book = state.book) {
  return book ? indexBy(book.spells, (e) => e.spell.id).get(id) : undefined;
}

function breadcrumbs(entries) {
  $("#breadcrumbs").innerHTML = entries
    .map((entry, i) => (entry.href && i < entries.length - 1
      ? `<a href="${entry.href}">${esc(entry.text)}</a>`
      : `<span>${esc(entry.text)}</span>`))
    .join(" &nbsp;›&nbsp; ");
}

// ---------- library ----------
async function showLibrary() {
  state.book = null;
  breadcrumbs([{ text: "Library" }]);
  document.title = "my-grimoire";
  app.innerHTML = `<p class="loading">Opening the library…</p>`;
  const [books, characters] = await Promise.all([api("books"), api("characters")]);
  if (!Array.isArray(characters)) throw new Error(OUTDATED_SERVER);

  const tome = (book) => `
    <a class="tome ${book.unavailable ? "unavailable" : ""}" href="#/book/${esc(book.id)}" style="--cover:${COVERS[book.color] || COVERS.crimson}">
      ${book.unavailable ? `<div class="tome-status">${esc(unavailableLabel(book))}</div>` : ""}
      <div class="ornament">❦</div>
      <h2>${esc(book.name)}</h2>
      <div class="owner">${esc(book.caster_class)}</div>
      <div class="footer">
        <div class="tally">
          <span>${book.spell_count} spell${book.spell_count === 1 ? "" : "s"}</span>
          <span>${book.pages_used}/${book.max_pages} pages</span>
        </div>
        ${pageBar(book.pages_used, book.max_pages)}
      </div>
    </a>`;

  const sections = characters.map((pc) => {
    const ownBooks = books.filter((l) => l.character === pc.id);
    return `
      <section class="character-section">
        <div class="character-title">
          <div>
            <h2>${esc(pc.name)}</h2>
            <p>${ownBooks.length ? `${pc.classes.map((c) => esc(c.name)).join(" / ")} · ${ownBooks.length} spellbook${ownBooks.length === 1 ? "" : "s"} · ${pc.spell_count} spell${pc.spell_count === 1 ? "" : "s"} · ${pc.prepared_total} prepared${pc.scroll_total ? ` · ${pc.scroll_total} scroll${pc.scroll_total === 1 ? "" : "s"}` : ""}` : "No spellbooks yet"}</p>
          </div>
          <button class="button compact" type="button" data-edit-character="${esc(pc.id)}">Rename</button>
        </div>
        <div class="shelf">
          ${ownBooks.length ? `
          <a class="tome all" href="#/character/${esc(pc.id)}">
            <div class="ornament">✦</div>
            <h2>All spellbooks</h2>
            <div class="owner">every spell of ${esc(pc.name)}, and what is prepared today</div>
            <div class="footer">
              <div class="tally">
                <span>${pc.spell_count} spell${pc.spell_count === 1 ? "" : "s"}</span>
                <span>${pc.prepared_total} prepared</span>
              </div>
            </div>
          </a>` : ""}
          ${ownBooks.map(tome).join("")}
          <button class="tome new" type="button" data-new-book="${esc(pc.id)}">
            <span class="plus">+</span>
            <span>New book</span>
          </button>
        </div>
      </section>`;
  }).join("");

  app.innerHTML = `
    <div class="header">
      <div>
        <h1>The Library</h1>
        <p>${characters.length ? "Each character has their own spellbooks, one or more classes, spells per day and prepared spells." : "Every spellcaster starts with a name and a blank book."}</p>
      </div>
      <button class="button gold" id="new-character" type="button">✚ New character</button>
    </div>
    ${sections || `<div class="empty dark"><div class="big">No characters yet</div><p>Create a character, then give them a spellbook.</p></div>`}`;
  $("#new-character").addEventListener("click", () => openCharacterDialog(null));
  app.querySelectorAll("[data-new-book]").forEach((button) => button.addEventListener("click", () => openBookDialog(null, button.dataset.newBook)));
  app.querySelectorAll("[data-edit-character]").forEach((button) => button.addEventListener("click", () => {
    openCharacterDialog(characters.find((pc) => pc.id === button.dataset.editCharacter));
  }));
}

// ---------- book ----------
// id = book to open; null = all the books of character characterId
async function showBook(id, view = state.view, characterId = null) {
  state.view = view;
  if (!state.book || state.book.id !== id || (!id && state.character?.id !== characterId)) {
    app.innerHTML = `<p class="loading">Opening the book…</p>`;
    state.textFilter = "";
    state.schoolFilters.clear();
    state.bookFilters.clear();
  }
  try {
    await state.saveQueue; // don't read in the middle of a save
    const book = id ? await api(`books/${encodeURIComponent(id)}`) : null;
    const pid = book ? book.character : characterId;
    if (!pid) throw new Error("This spellbook doesn't belong to any character: restart server.py to assign it.");
    const character = await api(`characters/${encodeURIComponent(pid)}`);
    if (!character.spells) throw new Error(OUTDATED_SERVER);
    state.character = character;
    forgetFullSheets();
    if (book) {
      // the book lists its spells, the sheets come with the character (once for both)
      book.spells = book.spells
        .map((entry) => ({ ...entry, spell: entry.spell || characterSpell(entry.id, character)?.spell }))
        .filter((entry) => entry.spell)
        .sort((a, b) => a.level - b.level || compareNames(a.spell.name, b.spell.name));
    }
    await recoverUnsaved();
    state.book = book || allBooksCollection();
  } catch (error) {
    app.innerHTML = `<div class="empty dark"><div class="big">Book not found</div><p>${esc(error.message)}</p><a class="button" href="#/">Back to the library</a></div>`;
    return;
  }
  renderBook();
}

function compareNames(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// Reloads the open page (a book or all the character's books), for example after adding a spell
function reloadView() {
  return showBook(state.book.id, state.view, state.character.id);
}

// Fake "book" with the spells of all the character's books (each once, at the lowest level)
function allBooksCollection(pc = state.character) {
  return {
    id: null,
    all: true,
    name: `${pc.name}: all spellbooks`,
    color: "obsidian",
    spells: pc.spells,
    books: pc.books,
    spell_count: pc.spells.length,
    pages_used: pc.books.reduce((total, l) => total + l.pages_used, 0),
    max_pages: pc.books.reduce((total, l) => total + l.max_pages, 0),
  };
}

// ---------- books that are not available (lost, stolen…) ----------
const UNAVAILABLE = { lost: "Lost", stolen: "Stolen", other: "Not available" };

function unavailableLabel(book) {
  return book?.unavailable ? UNAVAILABLE[book.unavailable.reason] || "Not available" : "";
}

// The character's book summary (with its availability)
function bookSummary(id) {
  return (state.character?.books || []).find((b) => b.id === id) || null;
}

// False when every book of the character with this spell is lost or stolen
function spellAvailable(id) {
  const entry = characterSpell(id);
  return entry ? entry.available !== false : true;
}

// Books that contain the spell: colored cover + name, and the level if it differs from the one used
function spellBookList(entry, className = "card-books") {
  return `<span class="${className}">${(entry.books || []).map((l) => `<span class="${l.available === false ? "unavailable" : ""}" style="--cover:${COVERS[l.color] || COVERS.crimson}"><i aria-hidden="true"></i>${esc(l.name)}${l.level !== entry.level ? ` (level ${l.level})` : ""}${l.available === false ? ` · ${esc(unavailableLabel(bookSummary(l.id)) || "not available").toLowerCase()}` : ""}</span>`).join("")}</span>`;
}

function collectionPath(book = state.book) {
  return book.all ? `#/character/${encodeURIComponent(state.character.id)}` : `#/book/${encodeURIComponent(book.id)}`;
}

// The filter bar above the tabs (text, favorites, spellbooks, schools) works the same in all three tabs.
// books = the spellbooks that contain the spell (entry.books), for the spellbook chips of "All spellbooks".
function matchesFilters(spell, books = []) {
  if (state.schoolFilters.size && !state.schoolFilters.has(spell.school)) return false;
  if (state.bookFilters.size && state.book.all && !books.some((b) => state.bookFilters.has(b.id))) return false;
  if (state.onlyFavorites && !isFavorite(spell.id)) return false;
  const text = state.textFilter.trim().toLowerCase();
  if (!text) return true;
  return searchText(spell).includes(text);
}

const searchTexts = new WeakMap();

function searchText(spell) {
  let text = searchTexts.get(spell);
  if (text === undefined) {
    text = [spell.name, school(spell), spell.school, spell.summary, ...(spell.descriptors || []), ...(spell.subschools || [])]
      .join(" ").toLowerCase();
    searchTexts.set(spell, text);
  }
  return text;
}

function filtersActive() {
  return Boolean(state.textFilter.trim() || state.schoolFilters.size || state.onlyFavorites
    || (state.book?.all && state.bookFilters.size));
}

function filteredSpells() {
  return state.book.spells.filter((entry) => matchesFilters(entry.spell, entry.books));
}

function filterBar() {
  const book = state.book;
  const schools = [...new Set(book.spells.map((v) => v.spell.school))].filter(Boolean).sort();
  const books = book.all && book.books.length > 1 ? book.books : [];
  // filters of one tab: prepared copies (classes that prepare) and scrolls owned
  const onlyPrepared = state.view === "prepared" && viewClasses().some((c) => c.casting === "prepared");
  const placeholder = state.view === "prepared" ? "Search these spells…" : state.view === "scrolls" ? "Search these scrolls…"
    : book.all ? "Search all books…" : "Search this book…";
  return `
    <div class="toolbar" id="filter-bar">
      <div class="toolbar-row">
        <input class="search" id="search" type="search" placeholder="${placeholder}${TOUCH ? "" : "  (/)"}" value="${esc(state.textFilter)}" aria-label="Search">
        <details class="level-menu" id="level-menu">
          <summary>Levels</summary>
          <div class="level-menu-panel" id="level-menu-panel"></div>
        </details>
        ${canSelect() ? `<button type="button" class="select-toggle" id="select-toggle" aria-pressed="${state.selecting}"
          title="Pick several spells, to remove them together">${state.selecting ? "✓ Selecting" : "Select"}</button>` : ""}
      </div>
      <nav class="level-nav" id="level-nav" aria-label="Jump to level"></nav>
      ${books.length ? `<div class="book-filters" role="group" aria-label="Spellbooks">
        ${books.map((b) => `<button type="button" class="chip book-chip" data-book="${esc(b.id)}" aria-pressed="${state.bookFilters.has(b.id)}" style="--c:${COVERS[b.color] || COVERS.crimson}"><i></i>${esc(b.name)}</button>`).join("")}
      </div>` : ""}
      <div class="school-filters" role="group" aria-label="Quick filters and schools">
        ${onlyPrepared ? `<button type="button" class="chip only-chip" data-only="prepared" aria-pressed="${state.onlyPrepared}"><i></i>✦ Only prepared</button>` : ""}
        ${state.view === "scrolls" ? `<button type="button" class="chip only-chip" data-only="owned" aria-pressed="${state.onlyOwned}"><i></i>📜 Only owned</button>` : ""}
        <button type="button" class="chip favorite-chip" data-favorites aria-pressed="${state.onlyFavorites}"><i></i>♥ Favorites</button>
        ${schools.map((s) => `<button type="button" class="chip" data-school="${esc(s)}" aria-pressed="${state.schoolFilters.has(s)}" style="--c:${schoolColor({ school: s })}"><i></i>${esc(SCHOOLS[s] || s)}</button>`).join("")}
      </div>
    </div>`;
}

// Draws the open tab again (after a filter or a fold changes)
function renderView() {
  if (state.view === "prepared") return renderPreparation();
  if (state.view === "scrolls") return renderScrolls();
  return renderPages();
}

function bindFilterBar() {
  const bar = $("#filter-bar");
  let typing = null;
  $("#search").addEventListener("input", (event) => {
    state.textFilter = event.target.value;
    clearTimeout(typing);
    // with a big book, the lists are drawn again when the typing pauses
    if (state.book.spells.length > 300) typing = setTimeout(renderView, 150);
    else renderView();
  });
  bar.addEventListener("click", (event) => {
    if (event.target.closest("#select-toggle")) return setSelecting(!state.selecting);
    const chip = event.target.closest(".chip");
    if (chip) {
      const d = chip.dataset;
      let pressed;
      if ("favorites" in d) pressed = state.onlyFavorites = !state.onlyFavorites;
      else if (d.only === "prepared") pressed = state.onlyPrepared = !state.onlyPrepared;
      else if (d.only === "owned") pressed = state.onlyOwned = !state.onlyOwned;
      else {
        const set = d.school ? state.schoolFilters : state.bookFilters;
        const value = d.school || d.book;
        set.has(value) ? set.delete(value) : set.add(value);
        pressed = set.has(value);
      }
      chip.setAttribute("aria-pressed", pressed);
      return renderView();
    }
    if (event.target.closest("[data-fold-all]")) return setFolded(Array.from({ length: 10 }, (_, n) => n), true);
    if (event.target.closest("[data-unfold-all]")) return setFolded(Array.from({ length: 10 }, (_, n) => n), false);
    const jump = event.target.closest("#level-nav a");
    if (jump) {
      event.preventDefault();
      jumpToLevel(Number(jump.dataset.level));
    }
  });
  bar.addEventListener("change", (event) => {
    const box = event.target.closest("[data-fold-level]");
    if (box) setFolded([Number(box.dataset.foldLevel)], !box.checked);
  });
}

// ---------- levels: jump and fold (the same in the three tabs) ----------
function viewContainer() {
  return $(state.view === "prepared" ? "#preparation" : state.view === "scrolls" ? "#scrolls" : "#book-pages");
}

function isFolded(level) {
  return state.folded[state.view]?.has(Number(level)) || false;
}

// Button at the start of a level header; the whole header folds and unfolds the level too
function foldButton(level, title) {
  const open = !isFolded(level);
  return `<button type="button" class="fold-toggle" data-fold="${level}" aria-expanded="${open}" aria-label="${open ? "Fold" : "Unfold"} ${esc(title)}" title="${open ? "Fold" : "Unfold"} this level"></button>`;
}

function setFolded(levels, fold) {
  const folded = state.folded[state.view];
  for (const level of levels) fold ? folded.add(level) : folded.delete(level);
  saveFolded();
  const container = viewContainer();
  for (const section of container?.querySelectorAll("[data-level-section]") || []) {
    const closed = isFolded(section.dataset.levelSection);
    section.classList.toggle("folded", closed);
    const button = section.querySelector(".fold-toggle");
    const title = section.querySelector("h2")?.textContent.trim() || "";
    button.setAttribute("aria-expanded", !closed);
    button.setAttribute("aria-label", `${closed ? "Unfold" : "Fold"} ${title}`);
    button.title = `${closed ? "Unfold" : "Fold"} this level`;
  }
  updateLevelTools();
}

function jumpToLevel(level) {
  const section = viewContainer()?.querySelector(`[data-level-section="${level}"]`);
  if (!section) return;
  if (isFolded(level)) setFolded([level], false);
  // below the top bar, and below the filter bar when it stays at the top of the screen
  const bar = $("#filter-bar");
  const style = bar && getComputedStyle(bar);
  const covered = style?.position === "sticky" ? parseFloat(style.top) + bar.offsetHeight : ($(".topbar")?.offsetHeight || 0);
  window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - covered - 8, behavior: "smooth" });
}

// Jump links and the "Levels" menu, from the level sections on the page
function updateLevelTools() {
  const container = viewContainer();
  const nav = $("#level-nav");
  const panel = $("#level-menu-panel");
  if (!nav || !panel) return;
  const levels = new Map();
  for (const section of container?.querySelectorAll("[data-level-section]") || []) {
    const n = Number(section.dataset.levelSection);
    const info = levels.get(n) || { titles: new Set(), count: 0 };
    info.titles.add(section.querySelector("h2")?.textContent.trim());
    info.count += Number(section.dataset.count ?? section.querySelectorAll(".card, .prep-row").length);
    levels.set(n, info);
  }
  const numbers = [...levels.keys()].sort((a, b) => a - b);
  const title = (n) => [...levels.get(n).titles].join(" / ");
  nav.innerHTML = Array.from({ length: 10 }, (_, n) => (levels.has(n)
    ? `<a href="#level-${n}" data-level="${n}" title="${esc(title(n))}">${n}</a>`
    : `<span aria-hidden="true">${n}</span>`)).join("");
  const menu = $("#level-menu");
  menu.hidden = !numbers.length;
  const foldedHere = numbers.filter(isFolded).length;
  menu.querySelector("summary").textContent = foldedHere ? `Levels · ${foldedHere} folded` : "Levels";
  // the list is rebuilt only when the levels change, so a ticked box keeps the focus
  const signature = numbers.map((n) => `${n}:${title(n)}:${levels.get(n).count}`).join("|");
  if (panel.dataset.signature !== signature) {
    panel.dataset.signature = signature;
    panel.innerHTML = `
      <div class="level-menu-actions">
        <button type="button" class="button compact" data-fold-all>Fold all</button>
        <button type="button" class="button compact" data-unfold-all>Unfold all</button>
      </div>
      <p class="level-menu-help">Ticked levels are open.</p>
      <ul>${numbers.map((n) => `
        <li><label><input type="checkbox" data-fold-level="${n}"> <span class="level-menu-number">${n}</span>
          <span class="level-menu-name">${esc(title(n))}</span> <small>${levels.get(n).count}</small></label></li>`).join("")}
      </ul>`;
  }
  for (const box of panel.querySelectorAll("[data-fold-level]")) box.checked = !isFolded(box.dataset.foldLevel);
}

function renderBook() {
  const book = state.book;
  const pc = state.character;
  breadcrumbs(book.all
    ? [{ text: "Library", href: "#/" }, { text: pc.name }]
    : [{ text: "Library", href: "#/" }, { text: pc.name, href: `#/character/${encodeURIComponent(pc.id)}` }, { text: book.name }]);
  const cover = COVERS[book.color] || COVERS.crimson;

  const frontispiece = book.all ? `
    <section class="frontispiece" style="--cover:${cover}">
      <div>
        <h1>All spellbooks</h1>
        <div class="subtitle">${esc(pc.name)} · ${book.books.length} spellbook${book.books.length === 1 ? "" : "s"} · ${pc.classes.map((c) => esc(c.name)).join(", ")} · a spell in more than one book counts once</div>
        <div class="stats">
          <div class="stat"><div class="value">${book.spell_count}</div><div class="label">Different spells</div></div>
          <div class="stat"><div class="value">${book.pages_used} <small>/ ${book.max_pages}</small></div><div class="label">Pages used</div>${pageBar(book.pages_used, book.max_pages)}</div>
        </div>
      </div>
      <div class="collection-books">${book.books.map((l) => `
        <a class="collection-book ${l.unavailable ? "unavailable" : ""}" href="#/book/${esc(l.id)}" style="--cover:${COVERS[l.color] || COVERS.crimson}">
          <i aria-hidden="true"></i>${esc(l.name)} <small>${l.unavailable ? `${esc(unavailableLabel(l).toLowerCase())} · ` : ""}${l.spell_count}</small></a>`).join("")}
      </div>
    </section>` : `
    <section class="frontispiece ${book.unavailable ? "unavailable" : ""}" style="--cover:${cover}">
      <div>
        <h1>${esc(book.name)}</h1>
        <div class="subtitle">belonging to ${esc(pc.name)} · ${esc(book.caster_class)}${classByKey(book.class_key) ? ` (${esc(classKind(classByKey(book.class_key)))})` : ""}</div>
        ${book.notes ? `<p class="book-notes">${esc(book.notes)}</p>` : ""}
        ${book.unavailable ? `<p class="book-status" role="note"><b>${esc(unavailableLabel(book))}</b> since ${esc(shortDate(book.unavailable.since))}${
          book.unavailable.note ? ` · ${esc(book.unavailable.note)}` : ""}. Its spells can't be prepared, and the book can't be changed until you mark it as available in Settings.</p>` : ""}
        <div class="stats">
          <div class="stat"><div class="value">${book.spell_count}</div><div class="label">Spells</div></div>
          <div class="stat"><div class="value">${book.pages_used} <small>/ ${book.max_pages}</small></div><div class="label">Pages used</div>${pageBar(book.pages_used, book.max_pages)}</div>
          <div class="stat"><div class="value">${(book.pages_used * 100).toLocaleString("en-US")} gp</div><div class="label">Scribing value</div></div>
        </div>
      </div>
      <div class="book-actions">
        ${book.unavailable ? "" : `<button class="button gold" id="open-add" type="button">✚ Add spell</button>
        <button class="button" id="open-finder" type="button">🔍 Search dndtools</button>`}
        <button class="button" id="book-settings" type="button">Settings</button>
      </div>
    </section>`;

  // the same page drawn again (after a change, or when a download ends): its lists are kept, so only the rows
  // that changed are redrawn and the page doesn't jump
  const pageKey = `${book.all ? `all:${pc.id}` : book.id}|${state.view}`;
  const kept = app.dataset.page === pageKey ? app.querySelector("[data-view-body]") : null;
  const search = kept && document.activeElement?.id === "search" ? document.activeElement : null;
  const scrolled = window.scrollY;
  app.dataset.page = pageKey;
  app.innerHTML = `
    ${frontispiece}

    <nav class="book-tabs" aria-label="Book sections">
      <a href="${collectionPath()}" class="${state.view === "book" ? "active" : ""}" ${state.view === "book" ? 'aria-current="page"' : ""}>
        <span class="tab-icon" aria-hidden="true">📖</span> Spellbook <span class="count">${book.spell_count}</span>
      </a>
      <a href="${collectionPath()}/prepared" class="${state.view === "prepared" ? "active" : ""}" ${state.view === "prepared" ? 'aria-current="page"' : ""}>
        <span class="tab-icon" aria-hidden="true">✦</span> <span id="prepared-label">${preparedTabLabel()}</span> <span class="count" id="prepared-count">${preparedCountText()}</span>
      </a>
      <a href="${collectionPath()}/scrolls" class="${state.view === "scrolls" ? "active" : ""}" ${state.view === "scrolls" ? 'aria-current="page"' : ""}>
        <span class="tab-icon" aria-hidden="true">📜</span> Scrolls <span class="count" id="scroll-count">${scrollTotals(viewClasses()).count}</span>
      </a>
      ${book.all ? "" : `<a class="all-link" href="#/character/${esc(pc.id)}${state.view === "book" ? "" : `/${state.view}`}" title="All spellbooks"><span class="wide-only-bar">All spellbooks </span><span class="narrow-only-bar">All </span>→</a>`}
    </nav>

    ${filterBar()}
    <div class="parchment" data-view-body id="${state.view === "prepared" ? "preparation" : state.view === "scrolls" ? "scrolls" : "book-pages"}"></div>`;
  if (kept) app.querySelector("[data-view-body]").replaceWith(kept);

  $("#open-add")?.addEventListener("click", openAddDialog);
  $("#open-finder")?.addEventListener("click", openFinder);
  $("#book-settings")?.addEventListener("click", () => openBookDialog(book));
  bindFilterBar();
  renderView();
  if (search) {
    const field = $("#search");
    field.focus({ preventScroll: true });
    field.setSelectionRange(search.selectionStart, search.selectionEnd);
  }
  if (kept && window.scrollY !== scrolled) window.scrollTo(0, scrolled);
}

function renderPages() {
  const container = $("#book-pages");
  const book = state.book;
  const entries = filteredSpells();
  const byLevel = new Map();
  entries.forEach((entry) => {
    if (!byLevel.has(entry.level)) byLevel.set(entry.level, []);
    byLevel.get(entry.level).push(entry);
  });
  state.selectionOrder = entries.map((entry) => entry.spell.id);
  state.selectionLevels = new Map([...byLevel].map(([level, group]) => [level, group.map((entry) => entry.spell.id)]));
  for (const id of state.selected) if (!bookSpell(id)) state.selected.delete(id);  // removed meanwhile
  const finish = () => {
    updateLevelTools();
    syncSelection();
  };

  if (!book.spells.length && book.all) {
    container.innerHTML = `<div class="empty"><div class="big">No spells yet</div><p>Open one of ${esc(state.character.name)}'s spellbooks from the library and add spells to it.</p></div>`;
    return finish();
  }
  if (!book.spells.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="big">The pages are still blank</div>
        <p>${book.unavailable ? "This book has no spells." : "Add your first spell by pasting the link to its page on dndtools."}</p>
        ${book.unavailable ? "" : `<button class="button gold" type="button" data-action="add">✚ Add spell</button>`}
      </div>`;
    container.querySelector("[data-action]")?.addEventListener("click", openAddDialog);
    return finish();
  }
  if (!entries.length) {
    container.innerHTML = `<div class="empty"><div class="big">No spells found</div><p>Try a different search, or turn off some of the filters above.</p></div>`;
    return finish();
  }

  patchSections(container, [...byLevel.keys()].sort((a, b) => a - b).map((level) => {
    const group = byLevel.get(level);
    const pageCount = group.reduce((total, v) => total + pages(v.level), 0);
    const title = levelTitle(level, book.all ? null : classByKey(book.class_key));
    return {
      key: `level-${level}`, level, id: `level-${level}`,
      className: `level-section${isFolded(level) ? " folded" : ""}`,
      head: `
        <div class="level-title">
          ${foldButton(level, title)}
          <span class="number">${level}</span>
          <div>
            <h2>${esc(title)}</h2>
            <div class="level-info">${group.length} spell${group.length === 1 ? "" : "s"} · ${pageCount} page${pageCount === 1 ? "" : "s"}</div>
          </div>
          ${state.selecting ? `<label class="level-select" title="Select every spell of this level shown">
            <input type="checkbox" data-select-level="${level}"> <span><span class="wide-only-select">Select </span>all</span></label>` : ""}
        </div>`,
      listTag: "div", listClass: "spell-grid",
      rows: group.map((entry) => lazyRow(entry.spell.id, () => spellCard(entry))),
    };
  }), decorateCard);
  finish();
}

// ---------- picking several spells (Spellbook tab of a book) ----------
// "Select" in the filter bar: a click on a card picks it (shift-click: a range), the level headers get
// "Select all", and the bar at the bottom removes the picked spells together. The picks are not part of the
// cards' HTML (redrawing thousands of cards would be slow): decorateCard marks them on the elements.
function canSelect() {
  const book = state.book;
  return state.view === "book" && Boolean(book) && !book.all && !book.unavailable && book.spells.length > 0;
}

function setSelecting(on) {
  state.selecting = on && canSelect();
  state.lastPicked = null;
  if (!state.selecting) state.selected.clear();
  const toggle = $("#select-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(state.selecting));
    toggle.textContent = state.selecting ? "✓ Selecting" : "Select";
  }
  renderPages();  // the level headers get (or lose) their boxes
}

// leaving the page: no picks left behind
function endSelection() {
  state.selecting = false;
  state.selected.clear();
  state.lastPicked = null;
  renderSelectBar(false);
}

function decorateCard(card) {
  const picked = state.selecting && state.selected.has(card.dataset.id);
  if (card.classList.contains("selected") !== picked) card.classList.toggle("selected", picked);
  const pressed = state.selecting ? String(picked) : null;
  if (card.getAttribute("aria-pressed") === pressed) return;
  if (pressed === null) card.removeAttribute("aria-pressed");
  else card.setAttribute("aria-pressed", pressed);
}

function syncSelection() {
  const container = $("#book-pages");
  if (state.selecting && !canSelect()) {  // e.g. the book was just marked as lost
    state.selecting = false;
    state.selected.clear();
  }
  const on = state.selecting;
  if (container) {
    container.classList.toggle("selecting", on);
    if (on || container.dataset.marked) {
      for (const card of container.querySelectorAll(".card")) decorateCard(card);
      container.dataset.marked = on ? "1" : "";
    }
    for (const box of container.querySelectorAll("[data-select-level]")) {
      const ids = state.selectionLevels.get(Number(box.dataset.selectLevel)) || [];
      const picked = ids.filter((id) => state.selected.has(id)).length;
      box.checked = ids.length > 0 && picked === ids.length;
      box.indeterminate = picked > 0 && picked < ids.length;
    }
  }
  renderSelectBar(on);
}

function pickCard(card, range) {
  const id = card.dataset.id;
  const on = !state.selected.has(id);
  let ids = [id];
  const order = state.selectionOrder;
  if (range && state.lastPicked && state.lastPicked !== id) {
    const from = order.indexOf(state.lastPicked);
    const to = order.indexOf(id);
    if (from >= 0 && to >= 0) ids = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  }
  for (const picked of ids) on ? state.selected.add(picked) : state.selected.delete(picked);
  state.lastPicked = id;
  syncSelection();
}

const selectBar = $("#select-bar");

function renderSelectBar(on) {
  selectBar.hidden = !on;
  if (on) {
    if (!selectBar.firstElementChild) {
      selectBar.innerHTML = `
        <p class="select-info"><b id="select-count"></b> <span id="select-hidden"></span></p>
        <div class="select-actions">
          <button type="button" class="button compact" data-select="shown"></button>
          <button type="button" class="button compact" data-select="none">Clear</button>
          <button type="button" class="button compact danger" data-select="remove"></button>
          <button type="button" class="button compact gold" data-select="done">Done</button>
        </div>`;
    }
    const count = state.selected.size;
    const shown = state.selectionOrder;
    const shownSet = new Set(shown);
    const hidden = [...state.selected].filter((id) => !shownSet.has(id)).length;
    $("#select-count").textContent = count ? `${plural(count, "spell")} selected` : `${TOUCH ? "Tap" : "Click"} the spells to select`;
    $("#select-hidden").textContent = hidden ? `(${hidden} hidden by the filters)` : "";
    const all = selectBar.querySelector('[data-select="shown"]');
    all.textContent = shown.length === state.book.spells.length ? "Select all" : `Select the ${shown.length} shown`;
    all.disabled = !shown.length || shown.every((id) => state.selected.has(id));
    selectBar.querySelector('[data-select="none"]').disabled = !count;
    const remove = selectBar.querySelector('[data-select="remove"]');
    remove.textContent = count ? `Remove ${count}` : "Remove";
    remove.disabled = !count;
  }
  selectSpace();
}

// room kept free at the bottom for the bar: the downloads panel, messages and the top button go above it
function selectSpace() {
  const space = selectBar.hidden ? 0 : Math.ceil(selectBar.offsetHeight + parseFloat(getComputedStyle(selectBar).bottom) + 8);
  document.documentElement.style.setProperty("--select-space", `${space}px`);
  dockSpace();
}
new ResizeObserver(selectSpace).observe(selectBar);

selectBar.addEventListener("click", (event) => {
  const action = event.target.closest("[data-select]")?.dataset.select;
  if (action === "shown") state.selectionOrder.forEach((id) => state.selected.add(id));
  else if (action === "none") state.selected.clear();
  else if (action === "remove") return removeSelected();
  else if (action === "done") return setSelecting(false);
  else return;
  syncSelection();
});

app.addEventListener("change", (event) => {
  const box = event.target.closest("[data-select-level]");
  if (!box || !state.selecting) return;
  for (const id of state.selectionLevels.get(Number(box.dataset.selectLevel)) || []) {
    if (box.checked) state.selected.add(id);
    else state.selected.delete(id);
  }
  syncSelection();
});

async function removeSelected() {
  const book = state.book;
  const ids = [...state.selected];
  if (!ids.length) return;
  const names = ids.map((id) => bookSpell(id)?.spell.name).filter(Boolean).sort(compareNames);
  const list = names.length <= 6 ? names.join(", ") : `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`;
  const count = plural(ids.length, "spell");
  const answer = await askConfirm(`Remove ${count}?`,
    `${list} will be hidden from “${book.name}”. Their levels, prepared copies, scrolls and favorite marks are kept: restore them from the book's Settings (or add them again) to bring them back.`,
    `Remove ${count}`, {
      text: `Delete ${ids.length === 1 ? "it" : "them"} for good`,
      label: `Delete ${count} for good`,
      warning: `${list} will be deleted from “${book.name}” for good: their levels, and the prepared copies, scrolls, favorite and ★ marks they have through this book, are lost (their downloaded pages too, if no other book or spell uses them). This can't be undone.`,
    });
  if (!answer) return;
  const forever = answer === "option";
  let done;
  try {
    done = await api(`books/${encodeURIComponent(book.id)}/spells/remove`, { method: "POST", body: { ids, forever } });
  } catch (error) {
    notify(error.message === "Unknown path." ? OUTDATED_SERVER : error.message, true);
    return;
  }
  endSelection();
  await route().catch((error) => notify(error.message, true));
  if (forever) {
    const kept = done.count - done.sheets_deleted;
    notify(`${plural(done.count, "spell")} deleted for good.${kept ? ` ${kept === 1 ? "One downloaded page stays" : `${kept} downloaded pages stay`}: other books or spells use ${kept === 1 ? "it" : "them"}.` : ""}`);
  } else {
    notify(`${plural(done.count, "spell")} removed from the book.`, false, {
      label: "Undo",
      run: () => restoreMany(book.id, done.ids),
    });
  }
}

async function restoreMany(bookId, ids) {
  try {
    const book = await api(`books/${encodeURIComponent(bookId)}/spells/restore`, { method: "POST", body: { ids } });
    await route();
    notify(`${plural(book.restored, "spell")} ${book.restored === 1 ? "is" : "are"} back in the book.`);
  } catch (error) {
    notify(error.message, true);
  }
}

function spellCard(entry) {
  const inc = entry.spell;
  const st = inc.stats || {};
  const target = st.target ? ["Target", st.target] : st.area ? ["Area", st.area] : st.effect ? ["Effect", st.effect] : null;
  const rows = [
    ["Casting", st.casting_time],
    ["Range", st.range],
    target,
    ["Duration", st.duration],
    ["Save / SR", [st.saving_throw && dcText(st.saving_throw, entry), st.spell_resistance].filter(Boolean).join(" · ")],
  ].filter((row) => row && row[1]);

  const available = state.book?.all ? entry.available !== false : spellAvailable(inc.id);
  // forbidden for every class that has the spell (the book's class, in a book)
  const cardClasses = state.book?.all ? entryClasses(entry) : [classByKey(state.book?.class_key)].filter(Boolean);
  const forbidden = cardClasses.length && cardClasses.every((c) => forbiddenSchool(inc, c)) ? forbiddenSchool(inc, cardClasses[0]) : null;
  const title = forbidden ? `${forbidden} is a forbidden school: it can't be prepared`
    : available ? "" : "Only in spellbooks that are not available: it can't be prepared";
  return `
    <button type="button" class="card ${available && !forbidden ? "" : "unavailable"}" data-id="${esc(inc.id)}" style="--c:${schoolColor(inc)}"
            ${title ? `title="${esc(title)}"` : ""}>
      <h3>${isFavorite(inc.id) ? `<span class="favorite-mark" title="Favorite">♥</span> ` : ""}${esc(inc.name)}</h3>
      <div class="school-line">${schoolLine(inc)}</div>
      <p class="summary">${esc(inc.summary)}</p>
      ${state.book?.all ? spellBookList(entry) : ""}
      ${inc.inherited_from ? `<span class="card-base">Based on <span class="ref" data-ref-card="${esc(inc.inherited_from.chain[0].id)}" data-from="${esc(inc.id)}">${esc(inc.inherited_from.chain[0].name)}</span></span>` : ""}
      <dl class="quick-stats">${rows.map(([e, v]) => `<dt>${esc(e)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join("")}</dl>
      <div class="card-footer">
        ${components(inc)}
        ${preparedCopies(inc.id) ? `<span class="prepared-badge" title="Prepared copies">✦ ${preparedCopies(inc.id)}</span>` : ""}
        ${scrollCount(inc.id) ? `<span class="scroll-badge" title="Scrolls">📜 ${scrollCount(inc.id)}</span>` : ""}
        ${forbidden ? `<span class="forbidden-badge">Forbidden</span>` : ""}
        <span class="spacer"></span>
        <span>${esc(shortSource(inc))}</span>
        <span>· ${pages(entry.level)} pg.</span>
      </div>
    </button>`;
}

// ---------- classes ----------
// Same table as CLASS_TYPES in server.py. Named types have a fixed name; the general types take the name
// the user writes (Bard, Favored Soul…). Books of the same class share spells per day and preparation.
const CLASS_TYPES = {
  wizard: { name: "Wizard", tradition: "arcane", casting: "prepared", specializations: ["school", "domain"] },
  sorcerer: { name: "Sorcerer", tradition: "arcane", casting: "spontaneous", specializations: [] },
  cleric: { name: "Cleric", tradition: "divine", casting: "prepared", specializations: ["domain"] },
  druid: { name: "Druid", tradition: "divine", casting: "prepared", specializations: [] },
  "arcane-prepared": { name: "", tradition: "arcane", casting: "prepared", specializations: ["school", "domain"] },
  "arcane-spontaneous": { name: "", tradition: "arcane", casting: "spontaneous", specializations: [] },
  "divine-prepared": { name: "", tradition: "divine", casting: "prepared", specializations: ["domain"] },
  "divine-spontaneous": { name: "", tradition: "divine", casting: "spontaneous", specializations: [] },
};
const ABILITIES = ["Intelligence", "Wisdom", "Charisma"];

function classKind(cls) {
  return `${cls.tradition}, ${cls.casting === "prepared" ? "prepares spells" : "casts spontaneously"}`;
}

function classByKey(key, pc = state.character) {
  return (pc?.classes || []).find((c) => c.key === key) || null;
}

// The classes of the open page: the book's class, or all the character's classes
function viewClasses() {
  if (!state.character) return [];
  if (state.book && !state.book.all) return [classByKey(state.book.class_key)].filter(Boolean);
  return state.character.classes || [];
}

// The spells of a class, each at its level in that class's books (the lowest if the books differ)
const classEntryCache = new WeakMap();

function classEntries(cls, pc = state.character) {
  const list = pc?.spells || [];
  let byClass = classEntryCache.get(list);
  if (!byClass) classEntryCache.set(list, byClass = new Map());
  if (!byClass.has(cls.key)) {
    byClass.set(cls.key, list.filter((e) => e.classes?.[cls.key] !== undefined)
      .map((e) => ({
        ...e, level: e.classes[cls.key], books: e.books.filter((b) => b.class === cls.key),
        available: e.available_classes ? e.available_classes.includes(cls.key) : true,
      })));
  }
  return byClass.get(cls.key);
}

function levelIn(cls, spellId) {
  return characterSpell(spellId)?.classes?.[cls.key];
}

// Classes that matter for a spell on a card or sheet: the book's class, or every class that has the spell
function entryClasses(entry) {
  if (!entry) return [];
  if (state.book && !state.book.all) return [classByKey(state.book.class_key)].filter(Boolean);
  return Object.keys(entry.classes || {}).map((key) => classByKey(key)).filter(Boolean);
}

// Level 0 is "Cantrips" for arcane classes and "Orisons" for divine ones
function levelTitle(level, cls) {
  return Number(level) === 0 && cls?.tradition === "divine" ? "Orisons" : levelName(level);
}

// "0 — orison" in the level choices of a divine book, "0 — cantrip" otherwise
function levelZeroOption(book = state.book) {
  return CLASS_TYPES[book?.class_type]?.tradition === "divine" ? "0 — orison" : "0 — cantrip";
}

// ---------- ability score, save DC and bonus spells ----------
function modifier(score) {
  return Math.floor((score - 10) / 2);
}

function signed(number) {
  return number >= 0 ? `+${number}` : `−${Math.abs(number)}`;
}

// Bonus spells from the Player's Handbook table: none for cantrips.
function bonusSpells(score, level) {
  const mod = modifier(score);
  return level > 0 && mod >= level ? Math.floor((mod - level) / 4) + 1 : 0;
}

function spellDc(level, cls) {
  return cls?.ability_score ? 10 + Number(level) + modifier(cls.ability_score) : null;
}

// "Will negates" -> "Will negates (DC 16)"; no DC without a saving throw.
// A spell of several classes (all books): "Will negates (DC 16 Wizard, DC 14 Cleric)"
function dcText(savingThrow, entry) {
  if (!savingThrow || /^\s*(none|no)\b/i.test(savingThrow)) return savingThrow;
  const inBook = state.book && !state.book.all;
  const dcs = entryClasses(entry)
    .map((cls) => [cls, spellDc(inBook ? entry.level : entry.classes[cls.key], cls)])
    .filter(([, dc]) => dc);
  if (!dcs.length) return savingThrow;
  if (dcs.length === 1) return `${savingThrow} (DC ${dcs[0][1]})`;
  return `${savingThrow} (${dcs.map(([cls, dc]) => `DC ${dc} ${cls.name}`).join(", ")})`;
}

// Same rule as total_slots in server.py: written base + bonus up to the highest level with base slots;
// with a score below 10 + level that level can't be cast.
function computeSlots(cls) {
  const score = cls.ability_score;
  const base = Array.from({ length: 10 }, (_, n) => Number(cls.daily_slots?.[n] || 0));
  const maximum = base.reduce((m, v, n) => (v ? n : m), -1);
  return base.map((b, n) => {
    const reachable = n <= maximum;
    const tooLow = Boolean(score) && score < 10 + n;
    const bonus = score && reachable && !tooLow ? bonusSpells(score, n) : 0;
    const special = reachable && !tooLow ? specialSlot(n, cls) : 0;
    return {
      base: b, bonus, special, tooLow, reachable,
      total: tooLow ? 0 : b + bonus + special, dc: spellDc(n, cls),
    };
  });
}

// ---------- specialist school or domains ----------
const SPECIALIST_SCHOOLS = ["Abjuration", "Conjuration", "Divination", "Enchantment", "Evocation", "Illusion", "Necromancy", "Transmutation"];

// Same rule as special_slot in server.py: a school or a domain gives one extra slot at every level,
// cantrips included, except that divine domains start at level 1.
function specialSlot(level, cls) {
  if (!["school", "domain"].includes(cls.specialization?.type)) return 0;
  return cls.tradition === "divine" && Number(level) === 0 ? 0 : 1;
}

// Forbidden (prohibited) schools: classes that can specialize in a school, as many as wanted
function canForbid(cls) {
  return Boolean(cls && CLASS_TYPES[cls.type]?.specializations.includes("school"));
}

function spellSchools(spell) {
  return (spell?.school || "").split(/[\s,/]+/).filter(Boolean);
}

// The forbidden school of the spell for this class, or null
function forbiddenSchool(spell, cls) {
  const forbidden = cls?.forbidden_schools || [];
  return forbidden.length ? spellSchools(spell).find((name) => forbidden.includes(name)) || null : null;
}

function forbiddenNote(school) {
  return `${school} is one of your forbidden schools: it can't be prepared.`;
}

function toggleForbidden(cls, school) {
  const chosen = new Set(cls.forbidden_schools || []);
  chosen.has(school) ? chosen.delete(school) : chosen.add(school);
  cls.forbidden_schools = SPECIALIST_SCHOOLS.filter((name) => chosen.has(name));
  renderPreparation();
  savePreparation();
}

function specializationName(cls) {
  const spec = cls.specialization;
  if (!spec) return "";
  return spec.name || (spec.type === "school" ? "School" : "Domain");
}

// "auto" if the dndtools sheet says so (school, or listed domain), "manual" if marked with ★, otherwise false
function fitsSpecialization(inc, cls) {
  const spec = cls.specialization;
  if (!spec?.name) return spec?.type === "domain" && spec.extra?.includes(inc.id) ? "manual" : false;
  const name = spec.name.trim().toLowerCase();
  if (spec.type === "school") return (inc.school || "").toLowerCase() === name ? "auto" : false;
  const names = name.split(/[/,]/).map((n) => n.trim()).filter(Boolean);
  if ((inc.domains || []).some((d) => names.includes(d.domain.toLowerCase()))) return "auto";
  return spec.extra?.includes(inc.id) ? "manual" : false;
}

// ---------- favorite spells ----------
const favoriteSets = new WeakMap();

function isFavorite(id) {
  const list = state.character?.favorites || [];
  let set = favoriteSets.get(list);
  if (!set) favoriteSets.set(list, set = new Set(list));
  return set.has(id);
}

function toggleFavorite(id) {
  const pc = state.character;
  pc.favorites = isFavorite(id) ? pc.favorites.filter((i) => i !== id) : [...(pc.favorites || []), id];
  savePreparation();
}

function favoriteButton(inc) {
  const on = isFavorite(inc.id);
  return `<button type="button" class="favorite-button" data-favorite="${esc(inc.id)}" aria-pressed="${on}"
            title="${on ? "Favorite: click to remove it" : "Mark as favorite"}" aria-label="${esc(inc.name)}: favorite">${on ? "♥" : "♡"}</button>`;
}

// Favorites first, then by name
function favoritesFirst(a, b) {
  return (isFavorite(b.id) - isFavorite(a.id)) || a.name.localeCompare(b.name);
}

// ---------- metamagic (web/metamagic.json, made by metamagic.py) ----------
// kept offline by the server; while it downloads them (first start) the Prepared tab asks again now and then
const metamagic = { list: [], byId: new Map(), source: "", error: "", triedAt: 0, loading: false };

async function loadMetamagic() {
  if (metamagic.loading) return;
  metamagic.loading = true;
  metamagic.triedAt = Date.now();
  try {
    const response = await fetch("/metamagic.json");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
    metamagic.list = data.feats;
    metamagic.byId = new Map(data.feats.map((t) => [t.id, t]));
    metamagic.source = data.source || "";
    metamagic.error = "";
  } catch (error) {
    metamagic.error = error.message; // without the file metamagic is not available
    setTimeout(() => { if (state.view === "prepared") loadMetamagic(); }, 20000);
    if (state.view === "prepared" && state.book && state.character) renderPreparation();
    return;
  } finally {
    metamagic.loading = false;
  }
  if (state.view === "prepared" && state.book && state.character) renderPreparation();
}

// Identity of a prepared entry: the class, the ID, plus the feats with their increase (same order as the server)
function preparedKey(p) {
  const meta = [...(p.metamagic || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const base = `${p.class}|${p.id}`;
  return meta.length ? `${base}|${meta.map((m) => `${m.id}+${m.increase}`).join(",")}` : base;
}

// Level of the slot used: level in the book + the increases of all the feats
function slotLevel(level, meta = []) {
  return Number(level) + meta.reduce((total, m) => total + m.increase, 0);
}

// Level for save DCs and effects: changes only with feats that really raise the level (Heighten Spell)
function effectiveLevel(level, meta = []) {
  return Number(level) + meta.filter((m) => metamagic.byId.get(m.id)?.raises_level).reduce((total, m) => total + m.increase, 0);
}

function featName(id) {
  return metamagic.byId.get(id)?.name || `Feat #${id}`;
}

// The row shows the increase only when it isn't fixed (Heighten, or not stated by dndtools)
function showsIncrease(m) {
  const feat = metamagic.byId.get(m.id);
  return !feat || feat.variable || feat.increase === null;
}

function increaseText(feat) {
  if (feat.variable) return "+X";
  return feat.increase === null ? "+?" : `+${feat.increase}`;
}

// Rough checks on the Player's Handbook feat rules (Sudden versions too):
// they are warnings, they don't prevent preparing.
function featWarnings(feat, inc) {
  const st = inc.stats || {};
  const base = feat.name.replace(/^Sudden /, "").replace(/ Spell$/, "");
  const warnings = [];
  if (base === "Extend" && !/\d|level/i.test(st.duration || "")) {
    warnings.push(`Extend Spell needs a duration that is not instantaneous, permanent or concentration (this one: ${st.duration || "none"}).`);
  }
  if (base === "Enlarge" && !/\b(close|medium|long)\b/i.test(st.range || "")) {
    warnings.push(`Enlarge Spell only works on close, medium or long range (this one: ${st.range || "none"}).`);
  }
  if (base === "Widen" && !st.area) warnings.push("Widen Spell needs an area (burst, emanation, line or spread).");
  if (base === "Silent" && !(inc.components || []).includes("V")) warnings.push("This spell has no verbal component: Silent Spell does nothing.");
  if (base === "Still" && !(inc.components || []).includes("S")) warnings.push("This spell has no somatic component: Still Spell does nothing.");
  if (base === "Quicken" && /minute|hour|day|\b([2-9]|\d{2,})\s+rounds?/i.test(st.casting_time || "")) {
    warnings.push(`Quicken Spell can't be used on spells that take longer than 1 full round to cast (this one: ${st.casting_time}).`);
  }
  if ((base === "Empower" || base === "Maximize") && !(inc.has_dice ?? new RegExp(DICE_RE.source).test(inc.description_html || ""))) {
    warnings.push(`No dice found in the description: ${base} Spell only changes variable numeric effects.`);
  }
  if (feat.sudden) warnings.push(`${feat.name} is used once per day when you cast, without preparing it in a higher slot.`);
  if (feat.increase === null && !feat.variable) warnings.push(`dndtools doesn't say how many levels ${feat.name} adds: check the feat.`);
  return warnings;
}

// Checks on a spell with metamagic: errors = it can't be cast, warnings = worth checking
function metamagicProblems(entry, meta, calc, cls, pc = state.character) {
  const slot = slotLevel(entry.level, meta);
  const errors = [];
  const warnings = [];
  if (slot > 9) errors.push(`Needs a level ${slot} slot: the highest spell level is 9.`);
  else if (!calc[slot].reachable) errors.push(`Needs a level ${slot} slot: you have no level ${slot} spells per day.`);
  else if (calc[slot].tooLow) errors.push(`Needs a level ${slot} slot: your ${cls.ability} is too low (${10 + slot} required).`);
  else if (!calc[slot].total) errors.push(`Needs a level ${slot} slot: you have no level ${slot} spells per day.`);
  const seen = new Set();
  for (const m of meta) {
    const feat = metamagic.byId.get(m.id);
    if (seen.has(m.id)) errors.push(`${featName(m.id)} can't be applied twice to the same spell.`);
    seen.add(m.id);
    if (!feat) continue;
    if (!(pc.metamagic_feats || []).includes(m.id)) warnings.push(`${feat.name} is not among your metamagic feats.`);
    warnings.push(...featWarnings(feat, entry.spell));
  }
  return { slot, errors, warnings };
}

// ---------- prepared spells and spell slots ----------
const preparedTotals = new WeakMap();

function preparedCopies(id) {
  const list = state.character?.prepared || [];
  let totals = preparedTotals.get(list);
  if (!totals) {
    totals = new Map();
    for (const p of list) totals.set(p.id, (totals.get(p.id) || 0) + p.copies);
    preparedTotals.set(list, totals);
  }
  return totals.get(id) || 0;
}

// Prepared classes: copies prepared and cast; spontaneous classes: slots used ("cast")
function classTotals(cls, pc = state.character) {
  const calc = computeSlots(cls);
  const slot = calc.reduce((a, l) => a + l.total, 0);
  if (cls.casting === "spontaneous") {
    const used = calc.reduce((a, l, n) => a + Math.min(Number(cls.used?.[n] || 0), l.total), 0);
    return { slot, prepared: 0, cast: used };
  }
  const own = (pc.prepared || []).filter((p) => p.class === cls.key);
  return { slot, prepared: own.reduce((a, p) => a + p.copies, 0), cast: own.reduce((a, p) => a + p.cast, 0) };
}

function viewTotals(classes = viewClasses()) {
  const t = { slotPrepared: 0, prepared: 0, castPrepared: 0, slotSpontaneous: 0, used: 0, anyPrepared: false, anySpontaneous: false };
  for (const cls of classes) {
    const c = classTotals(cls);
    if (cls.casting === "spontaneous") {
      t.anySpontaneous = true;
      t.slotSpontaneous += c.slot;
      t.used += c.cast;
    } else {
      t.anyPrepared = true;
      t.slotPrepared += c.slot;
      t.prepared += c.prepared;
      t.castPrepared += c.cast;
    }
  }
  t.cast = t.castPrepared + t.used;
  t.left = t.slotSpontaneous - t.used;
  return t;
}

// Tab counter: prepared / slots, or (only spontaneous classes) slots left / slots
function preparedCountText() {
  const t = viewTotals();
  if (t.anyPrepared) return t.slotPrepared ? `${t.prepared}/${t.slotPrepared}` : `${t.prepared}`;
  return `${t.left}/${t.slotSpontaneous}`;
}

function preparedTabLabel() {
  const classes = viewClasses();
  return !classes.length || classes.some((c) => c.casting === "prepared") ? "Prepared" : "Casting";
}

function visibleSpellIds() {
  return state.book && !state.book.all ? indexBy(state.book.spells, (v) => v.spell.id) : null;
}

// One row per spell at its level, plus one row for each metamagic combination
// at the level of the slot it uses (above 9 it goes to 9, marked as an error).
// Counts cover all the books of the class; the view of a single book only shows the rows of its spells.
function preparationLevels(cls) {
  const pc = state.character;
  const calc = computeSlots(cls);
  const levels = calc.map((c, n) => ({ n, ...c, slot: c.total, prepared: 0, cast: 0, fitting: 0, rows: [] }));
  const visible = visibleSpellIds();
  const add = (level, row) => {
    if (!visible || visible.has(row.entry.spell.id)) level.rows.push(row);
    level.prepared += row.copies;
    level.cast += row.cast;
    if (row.fits) level.fitting += row.copies;
  };
  const entries = classEntries(cls, pc);
  const own = (pc.prepared || []).filter((p) => p.class === cls.key);
  const simple = new Map(own.filter((p) => !p.metamagic?.length).map((p) => [p.id, p]));
  const byId = new Map(entries.map((v) => [v.spell.id, v]));
  for (const entry of entries) {
    const prep = simple.get(entry.spell.id);
    const differentLevels = new Set(entry.books.map((l) => l.level)).size > 1;
    add(levels[entry.level], {
      entry, key: preparedKey({ class: cls.key, id: entry.spell.id }), metamagic: [], errors: [],
      warnings: differentLevels ? [`Different levels in your books (${entry.books.map((l) => `${l.name}: ${l.level}`).join(", ")}): the lowest is used.`] : [],
      fits: fitsSpecialization(entry.spell, cls), forbidden: forbiddenSchool(entry.spell, cls),
      copies: prep?.copies || 0, cast: prep?.cast || 0,
    });
  }
  for (const prep of own) {
    const entry = byId.get(prep.id);
    if (!prep.metamagic?.length || !entry) continue;
    const problems = metamagicProblems(entry, prep.metamagic, calc, cls, pc);
    add(levels[Math.min(9, problems.slot)], {
      entry, key: preparedKey(prep), metamagic: prep.metamagic, ...problems,
      fits: fitsSpecialization(entry.spell, cls), forbidden: forbiddenSchool(entry.spell, cls),
      copies: prep.copies, cast: prep.cast,
    });
  }
  for (const level of levels) {
    level.rows.sort((a, b) => favoritesFirst(a.entry.spell, b.entry.spell) || a.metamagic.length - b.metamagic.length);
    level.uncastable = level.rows.filter((r) => r.errors.length).length;
  }
  return levels;
}

// Spontaneous casters: the spells known of each level, and the slots used today
function castingLevels(cls) {
  const calc = computeSlots(cls);
  const visible = visibleSpellIds();
  const levels = calc.map((c, n) => ({ n, ...c, slot: c.total, used: Math.min(Number(cls.used?.[n] || 0), c.total), rows: [] }));
  for (const entry of classEntries(cls)) {
    if (!visible || visible.has(entry.spell.id)) levels[entry.level].rows.push({ entry });
  }
  for (const level of levels) level.rows.sort((a, b) => favoritesFirst(a.entry.spell, b.entry.spell));
  return levels;
}

function countState(prepared, slot) {
  if (prepared > slot) return "over";
  if (slot && prepared === slot) return "full";
  return "";
}

// Like countState, but the specialization slot only accepts fitting spells:
// the others can't exceed the normal slots.
function tooManyOutsideSpecialization(l) {
  return l.prepared - l.fitting > l.slot - l.special;
}

function levelState(l) {
  return tooManyOutsideSpecialization(l) ? "over" : countState(l.prepared, l.slot);
}

function classJump(classes, prefix) {
  return classes.length > 1 ? `<nav class="class-jump" aria-label="Classes">${classes.map((c) =>
    `<button type="button" class="chip" data-jump="${prefix}-${esc(c.key)}">${esc(c.name)}</button>`).join("")}</nav>` : "";
}

function classHead(cls, extra = "") {
  return `<div class="class-head"><h2>${esc(cls.name)}</h2><span class="class-kind">${esc(extra || classKind(cls))}</span></div>`;
}

function classBlockSkeleton(cls) {
  const type = CLASS_TYPES[cls.type] || CLASS_TYPES.wizard;
  const spontaneous = cls.casting === "spontaneous";
  const specs = type.specializations;
  const domains = [...new Set(classEntries(cls).flatMap((v) => (v.spell.domains || []).map((d) => d.domain)))].sort();
  const scoreInput = `<input type="number" inputmode="numeric" min="1" max="60" placeholder="—" data-score
    value="${cls.ability_score || ""}" aria-label="${esc(cls.name)} ${esc(cls.ability)} score">`;
  return `
    <section class="class-prep" id="prep-${esc(cls.key)}" data-class-block="${esc(cls.key)}">
      ${classHead(cls)}
      <section class="day-slots">
        <div class="slot-header">
          <div>
            <h3>Spells per day</h3>
            <p class="parchment-help">${spontaneous
              ? "Write your base spells per day from the class table: bonus spells and save DCs are added automatically. Use “Cast” on a spell you know, or tap a slot, to spend it."
              : "Write your base spells per day from the class table. Bonus spells, save DCs and the specialization slot are added automatically."}
              ${state.book.all ? "" : `The rows are the spells of this book; the counts include your other ${esc(cls.name)} books.`}</p>
          </div>
          ${specs.length ? `
          <div class="specialization">
            <span class="ability-name">${specs.includes("school") ? "Specialization" : "Domains"}</span>
            <select data-spec-type aria-label="${esc(cls.name)} specialization">
              <option value="">None</option>
              ${specs.includes("school") ? `<option value="school">School</option>` : ""}
              <option value="domain">${specs.includes("school") ? "Domain" : "Domains"}</option>
            </select>
            ${specs.includes("school") ? `<select data-spec-school aria-label="Specialist school" hidden>
              ${SPECIALIST_SCHOOLS.map((name) => `<option>${name}</option>`).join("")}</select>` : ""}
            <input data-spec-domain type="text" list="domains-${esc(cls.key)}" hidden
                   placeholder="${cls.tradition === "divine" ? "Fire, Sun" : "Domain name"}" aria-label="${esc(cls.name)} domain names">
            <datalist id="domains-${esc(cls.key)}">${domains.map((name) => `<option value="${esc(name)}">`).join("")}</datalist>
            <span class="ability-mod" data-spec-note></span>
          </div>` : ""}
          ${type.name ? `
          <label class="ability">
            <span class="ability-name">${esc(cls.ability)}</span>
            ${scoreInput}
            <span class="ability-mod" data-ability-mod></span>
          </label>` : `
          <div class="ability">
            <select class="ability-name ability-choice" data-ability aria-label="${esc(cls.name)} casting ability">
              ${ABILITIES.map((a) => `<option ${a === cls.ability ? "selected" : ""}>${a}</option>`).join("")}</select>
            ${scoreInput}
            <span class="ability-mod" data-ability-mod></span>
          </div>`}
        </div>
        <div class="slot-grid">${Array.from({ length: 10 }, (_, n) => `
          <label class="slot" title="${esc(levelTitle(n, cls))}">
            <span class="lvl">${n === 0 ? levelTitle(0, cls) : `Level ${n}`}</span>
            <input type="number" inputmode="numeric" min="0" max="99" placeholder="0" value="${cls.daily_slots?.[n] || ""}"
                   data-slot-level="${n}" aria-label="${esc(cls.name)}, ${esc(levelTitle(n, cls))}: base spells per day">
            <span class="calc"></span>
            <span class="dc"></span>
            <span class="usage"></span>
          </label>`).join("")}
        </div>
        ${canForbid(cls) ? `
        <div class="forbidden-schools" role="group" aria-label="${esc(cls.name)} forbidden schools">
          <span class="ability-name">Forbidden schools</span>
          <div class="forbidden-chips">${SPECIALIST_SCHOOLS.map((name) => `
            <button type="button" class="chip" data-forbid="${name}" aria-pressed="false" style="--c:${schoolColor({ school: name })}"><i></i>${name}</button>`).join("")}
          </div>
          <p class="parchment-help" data-forbidden-note></p>
        </div>` : ""}
      </section>
      <div data-class-sections></div>
    </section>`;
}

function renderPreparation() {
  const container = $("#preparation");
  if (!container) return;
  const pc = state.character;
  const classes = viewClasses();
  $("#prepared-count").textContent = preparedCountText();
  $("#prepared-label").textContent = preparedTabLabel();

  // the class blocks are created only once, so the fields don't lose focus while typing
  const layout = classes.map((c) => `${c.key}:${c.type}:${c.ability}`).join(",") + (state.book.all ? ":all" : "");
  if (container.dataset.layout !== layout) {
    container.dataset.layout = layout;
    container.innerHTML = `
      <div class="day" id="day"></div>
      <section class="book-metamagic" id="book-metamagic"></section>
      ${classJump(classes, "prep")}
      ${classes.map(classBlockSkeleton).join("")}
      ${classes.length ? "" : `<div class="empty"><div class="big">No classes yet</div><p>Create a spellbook for this character: its class decides how spells are prepared.</p></div>`}`;
  }
  const known = (pc.metamagic_feats || []).map((id) => metamagic.byId.get(id)).filter(Boolean);
  if (!metamagic.list.length && Date.now() - metamagic.triedAt > 20000) loadMetamagic();
  $("#book-metamagic").innerHTML = !classes.length ? "" : !metamagic.list.length ? (metamagic.error
    ? `<div><h2>Metamagic feats</h2><p class="parchment-help">${esc(metamagic.error)}</p></div>` : "") : `
    <div>
      <h2>Metamagic feats</h2>
      <p class="parchment-help">${known.length
        ? "Use “Metamagic” on a spell below to prepare or cast it with these feats in a higher slot."
        : "Choose the metamagic feats this character knows, then use “Metamagic” on a spell below."}</p>
    </div>
    <div class="known-feats">
      ${known.map((t) => `<button type="button" class="feat-chip" data-feat="${esc(t.id)}" title="${esc(t.summary)}">${esc(t.name)} <b>${increaseText(t)}</b></button>`).join("")}
      <button type="button" class="button compact" data-pick-feats>${known.length ? "Change feats" : "Choose feats"}</button>
    </div>`;
  for (const cls of classes) renderClassBlock(container.querySelector(`[data-class-block="${CSS.escape(cls.key)}"]`), cls);
  renderDay(classes);
  updateLevelTools();
}

function renderClassBlock(block, cls) {
  const spontaneous = cls.casting === "spontaneous";
  const levels = spontaneous ? castingLevels(cls) : preparationLevels(cls);
  const score = cls.ability_score;
  block.querySelector("[data-ability-mod]").textContent = score ? `mod ${signed(modifier(score))}` : "not set";
  const specType = block.querySelector("[data-spec-type]");
  if (specType) {
    const spec = cls.specialization;
    const specSchool = block.querySelector("[data-spec-school]");
    const specDomain = block.querySelector("[data-spec-domain]");
    specType.value = spec?.type || "";
    if (specSchool) {
      specSchool.hidden = spec?.type !== "school";
      if (spec?.type === "school") specSchool.value = SPECIALIST_SCHOOLS.includes(spec.name) ? spec.name : SPECIALIST_SCHOOLS[0];
    }
    specDomain.hidden = spec?.type !== "domain";
    if (spec?.type === "domain" && document.activeElement !== specDomain) specDomain.value = spec.name || "";
    block.querySelector("[data-spec-note]").textContent = !spec ? "no extra slot"
      : spec.type === "school" ? "+1 spell per level, 0–9"
      : cls.tradition === "divine" ? "+1 domain spell per level, 1–9 · ★ marks domain spells"
      : "+1 spell per level, 0–9 · ★ marks domain spells";
  }
  const forbidden = cls.forbidden_schools || [];
  for (const chip of block.querySelectorAll("[data-forbid]")) {
    const specialist = cls.specialization?.type === "school" && cls.specialization.name === chip.dataset.forbid;
    chip.setAttribute("aria-pressed", forbidden.includes(chip.dataset.forbid));
    chip.disabled = specialist;
    chip.title = specialist ? "Your specialist school can't be forbidden" : forbidden.includes(chip.dataset.forbid) ? "Forbidden: tap to allow it again" : "Tap to forbid this school";
  }
  const note = block.querySelector("[data-forbidden-note]");
  if (note) {
    note.textContent = forbidden.length
      ? `${forbidden.join(", ")}: ${forbidden.length === 1 ? "its" : "their"} spells can't be prepared, and ${forbidden.length === 1 ? "its" : "their"} scrolls can't be used or scribed.`
      : "None. Tap a school to forbid it (as many as you like).";
  }
  levels.forEach((l) => {
    const box = block.querySelector(`[data-slot-level="${l.n}"]`).closest(".slot");
    box.className = `slot ${spontaneous ? "" : levelState(l)} ${l.tooLow && l.base ? "blocked" : ""} ${l.reachable ? "" : "off"}`;
    const pieces = [
      l.bonus ? `+${l.bonus}<span class="wide-only"> bonus</span>` : "",
      l.special ? `<span class="star" title="${esc(specializationName(cls))} slot">+1★</span>` : "",
    ].filter(Boolean);
    box.querySelector(".calc").innerHTML = !l.reachable ? ""
      : l.tooLow ? `needs ${10 + l.n}`
      : pieces.length ? `${pieces.join(" ")} = <b>${l.total}</b>`
      : score ? "no bonus" : "";
    box.querySelector(".dc").textContent = l.dc && l.reachable && !l.tooLow ? `DC ${l.dc}` : "";
    box.querySelector(".usage").innerHTML = spontaneous
      ? `${l.used} / ${l.slot}<span class="wide-only"> used</span>`
      : `${l.prepared} / ${l.slot}<span class="wide-only"> prepared</span>`;
  });
  const sections = levels
    .filter((l) => l.rows.length || l.slot)
    .map((l) => (spontaneous ? castingSection(l, cls) : preparationSection(l, cls)))
    .filter(Boolean);
  const filtered = filtersActive() || (!spontaneous && state.onlyPrepared);
  const container = block.querySelector("[data-class-sections]");
  if (sections.length) patchSections(container, sections);
  else container.innerHTML = `<p class="empty-level">${filtered ? "Nothing matches the filters above." : `No ${esc(cls.name)} spells ${state.book.all ? "in your books" : "in this book"} yet, and no spells per day written above.`}</p>`;
}

// A level of a class that prepares its spells: {head, rows} for patchSections, or null when filtered away
function preparationSection(l, cls) {
  const rows = l.rows.filter((r) => (!state.onlyPrepared || r.copies) && matchesFilters(r.entry.spell, r.entry.books));
  if ((state.onlyPrepared || filtersActive()) && !rows.length) return null;
  const title = levelTitle(l.n, cls);
  return {
    key: `level-${l.n}`, level: l.n, className: `prep-level${isFolded(l.n) ? " folded" : ""}`,
    listTag: "ul", listClass: "prep-list",
    rows: rows.map((r) => lazyRow(r.key, () => preparationRow(r, cls))),
    empty: `<p class="empty-level">No spells of this level in ${state.book.all ? "your books" : "this book"} yet.</p>`,
    head: `
      <div class="level-title">
        ${foldButton(l.n, title)}
        <span class="number">${l.n}</span>
        <div>
          <h2>${esc(title)}</h2>
          <div class="level-info">${l.cast} cast · ${Math.max(0, l.prepared - l.cast)} ready${l.dc ? ` · DC ${l.dc}` : ""}${l.bonus ? ` · ${l.base} + ${l.bonus} bonus` : ""}</div>
          ${l.special ? `<div class="level-note ${tooManyOutsideSpecialization(l) ? "error" : l.fitting ? "ok" : ""}">★ ${esc(specializationName(cls))} slot: ${
            tooManyOutsideSpecialization(l) ? `only ${l.slot - l.special} other spells allowed`
            : l.fitting ? "filled" : "empty"}</div>` : ""}
          ${l.uncastable ? `<div class="level-note error">${l.uncastable} metamagic spell${l.uncastable === 1 ? "" : "s"} can't be cast</div>` : ""}
        </div>
        <span class="counter ${levelState(l)}" title="Prepared / spells per day">${l.prepared} / ${l.slot}</span>
      </div>`,
  };
}

function castingSection(l, cls) {
  const rows = l.rows.filter((r) => matchesFilters(r.entry.spell, r.entry.books));
  if (filtersActive() && !rows.length) return null;
  const left = Math.max(0, l.slot - l.used);
  const title = levelTitle(l.n, cls);
  const pips = Array.from({ length: l.slot }, (_, i) => `
    <button type="button" class="pip" data-used-pip="${i}" data-level="${l.n}" aria-pressed="${i < l.used}"
            aria-label="${esc(title)}, slot ${i + 1}: ${i < l.used ? "used" : "available"}"></button>`).join("");
  return {
    key: `level-${l.n}`, level: l.n, className: `prep-level${isFolded(l.n) ? " folded" : ""}`,
    listTag: "ul", listClass: "prep-list",
    rows: rows.map((r) => lazyRow(r.entry.spell.id, () => castingRow(r, l, cls))),
    empty: `<p class="empty-level">No spells of this level known ${state.book.all ? "in your books" : "in this book"}.</p>`,
    head: `
      <div class="level-title">
        ${foldButton(l.n, title)}
        <span class="number">${l.n}</span>
        <div>
          <h2>${esc(title)}</h2>
          <div class="level-info">${l.rows.length} known · ${l.used} used · ${left} left${l.dc ? ` · DC ${l.dc}` : ""}${l.bonus ? ` · ${l.base} + ${l.bonus} bonus` : ""}</div>
        </div>
        <span class="counter" title="Slots left / spells per day">${left} / ${l.slot}</span>
      </div>
      ${l.slot ? `<div class="pips slot-pips" role="group" aria-label="${esc(title)} slots">${pips}</div>` : ""}`,
  };
}

function renderDay(classes) {
  const t = viewTotals(classes);
  const everything = viewTotals(state.character.classes || []);
  $("#day").innerHTML = `
    <div class="day-counters">
      ${t.anyPrepared ? `<div class="day-counter ${countState(t.prepared, t.slotPrepared)}"><span class="value">${t.prepared}<small> / ${t.slotPrepared}</small></span><span class="label">Prepared</span></div>` : ""}
      ${t.anySpontaneous ? `<div class="day-counter"><span class="value">${t.left}<small> / ${t.slotSpontaneous}</small></span><span class="label">Slots left</span></div>` : ""}
      <div class="day-counter"><span class="value">${t.cast}</span><span class="label">Cast</span></div>
      ${t.anyPrepared ? `<div class="day-counter"><span class="value">${Math.max(0, t.prepared - t.castPrepared)}</span><span class="label">Ready</span></div>` : ""}
    </div>
    <div class="day-actions">
      <button class="button" type="button" id="new-day" ${everything.cast ? "" : "disabled"}>☾ New day</button>
      ${t.anyPrepared ? `<button class="button danger" type="button" id="clear-prepared" ${t.prepared ? "" : "disabled"}>Clear all</button>` : ""}
    </div>`;
}

function hasSavingThrow(inc) {
  const ts = inc.stats?.saving_throw;
  return Boolean(ts) && !/^\s*(none|no)\b/i.test(ts);
}

function specializationStar(inc, fits, level, cls) {
  const spec = cls.specialization;
  if (!spec || !specialSlot(level, cls)) return ""; // no special slot at this level
  const name = esc(specializationName(cls));
  if (fits === "auto") return `<span class="row-star fixed" title="${name} spell: fits the ${name} slot">★</span>`;
  if (spec.type !== "domain") return "";
  return `<button type="button" class="row-star" data-special="${esc(inc.id)}" aria-pressed="${fits === "manual"}"
            title="${fits ? `Marked as a ${name} domain spell` : `Mark as a ${name} domain spell`}"
            aria-label="${esc(inc.name)}: ${name} domain spell">${fits ? "★" : "☆"}</button>`;
}

const UNAVAILABLE_NOTE = "Its spellbook is not available: no new copies can be prepared.";

function preparationRow({ entry, fits, forbidden, copies, cast, key, metamagic: meta, slot, errors, warnings }, cls) {
  const unavailable = entry.available === false || Boolean(forbidden);
  const blockedNote = forbidden ? forbiddenNote(forbidden) : UNAVAILABLE_NOTE;
  const inc = entry.spell;
  const name = meta.length ? `${inc.name} (${meta.map((m) => featName(m.id)).join(", ")})` : inc.name;
  const dc = spellDc(effectiveLevel(entry.level, meta), cls);
  const pips = Array.from({ length: copies }, (_, i) => `
    <button type="button" class="pip" data-pip="${i}" data-key="${esc(key)}" aria-pressed="${i < cast}"
            aria-label="${esc(name)}, copy ${i + 1}: ${i < cast ? "cast" : "ready"}"></button>`).join("");
  return `
    <li class="prep-row ${copies ? "active" : ""} ${meta.length ? "with-metamagic" : ""} ${errors.length ? "uncastable" : ""} ${unavailable ? "unavailable" : ""}" style="--c:${schoolColor(inc)}">
      <button type="button" class="prep-name" data-open="${esc(inc.id)}">
        <span class="name">${esc(inc.name)}</span>
        ${meta.length ? `<span class="row-feats">${meta.map((m) => `<span class="row-feat">${esc(featName(m.id).replace(/ Spell$/, ""))}${showsIncrease(m) ? ` +${m.increase}` : ""}</span>`).join("")}
          <span class="level-shift" title="Level in the book → level of the slot used">${entry.level} → ${slot}</span></span>` : ""}
        <span class="subline">${esc(school(inc))}${inc.stats?.casting_time ? ` · ${esc(inc.stats.casting_time)}` : ""}${hasSavingThrow(inc) && dc ? ` · DC ${dc}` : ""}</span>
        ${spellBookList(entry, "card-books row-books")}
      </button>
      <div class="pips" role="group" aria-label="Cast copies">${pips}</div>
      <div class="controls">
        ${meta.length ? "" : favoriteButton(inc)}
        ${meta.length ? "" : specializationStar(inc, fits, entry.level, cls)}
        ${!meta.length && metamagic.list.length ? `<button type="button" class="metamagic-button" data-metamagic="${esc(inc.id)}"
            title="Prepare with metamagic" aria-label="Prepare ${esc(inc.name)} with metamagic" ${unavailable ? "disabled" : ""}>Meta<span class="wide-only-row">magic</span></button>` : ""}
        <div class="stepper">
          <button type="button" data-change="-1" data-key="${esc(key)}" data-spell="${esc(inc.id)}" aria-label="Prepare one less ${esc(name)}" ${copies ? "" : "disabled"}>−</button>
          <span class="copies" aria-live="polite">${copies}</span>
          <button type="button" data-change="1" data-key="${esc(key)}" data-spell="${esc(inc.id)}" aria-label="Prepare one more ${esc(name)}" ${errors.length || unavailable ? "disabled" : ""}>+</button>
        </div>
      </div>
      ${errors.length || warnings.length || unavailable ? `<ul class="row-problems">
        ${unavailable ? `<li class="unavailable-note">${esc(blockedNote)}</li>` : ""}
        ${errors.map((e) => `<li class="error">${esc(e)}</li>`).join("")}
        ${warnings.map((a) => `<li>${esc(a)}</li>`).join("")}
      </ul>` : ""}
    </li>`;
}

function castingRow({ entry }, l, cls) {
  const inc = entry.spell;
  const dc = spellDc(entry.level, cls);
  const left = l.slot - l.used;
  const unavailable = entry.available === false;
  return `
    <li class="prep-row casting-row ${unavailable ? "unavailable" : "active"}" style="--c:${schoolColor(inc)}">
      <button type="button" class="prep-name" data-open="${esc(inc.id)}">
        <span class="name">${esc(inc.name)}</span>
        <span class="subline">${esc(school(inc))}${inc.stats?.casting_time ? ` · ${esc(inc.stats.casting_time)}` : ""}${hasSavingThrow(inc) && dc ? ` · DC ${dc}` : ""}</span>
        ${spellBookList(entry, "card-books row-books")}
      </button>
      <div class="controls">
        ${favoriteButton(inc)}
        ${metamagic.list.length ? `<button type="button" class="metamagic-button" data-metamagic="${esc(inc.id)}"
            title="Cast with metamagic" aria-label="Cast ${esc(inc.name)} with metamagic" ${unavailable ? "disabled" : ""}>Meta<span class="wide-only-row">magic</span></button>` : ""}
        <button type="button" class="button compact cast-button" data-cast="${l.n}" data-spell="${esc(inc.id)}"
                aria-label="Cast ${esc(inc.name)} using a ${esc(levelTitle(l.n, cls).toLowerCase())} slot" ${left > 0 && !unavailable ? "" : "disabled"}>Cast</button>
      </div>
      ${unavailable ? `<ul class="row-problems"><li class="unavailable-note">Its spellbook is not available: it can't be cast from here.</li></ul>` : ""}
    </li>`;
}

// Every change sends the whole state (every class's slots, prepared spells, scrolls and favorites), so the last
// successful save covers all the earlier ones. Until the server confirms, a copy stays in the browser
// (localStorage) and is sent again the next time a book is opened. The preparation belongs to the character,
// not to the book: one key per character.
const unsavedKey = (id) => `grimoire-unsaved-v2-character-${id}`;

function readUnsaved(id) {
  try { return JSON.parse(localStorage.getItem(unsavedKey(id))); } catch { return null; }
}

function writeUnsaved(id, data) {
  try {
    if (data) localStorage.setItem(unsavedKey(id), JSON.stringify(data));
    else localStorage.removeItem(unsavedKey(id));
  } catch { /* browser without localStorage: only the server save is left */ }
}

function preparationData(pc) {
  return {
    classes: Object.fromEntries((pc.classes || []).map((c) => [c.key, {
      daily_slots: { ...(c.daily_slots || {}) },
      ability_score: c.ability_score ?? null,
      ability: c.ability,
      specialization: structuredClone(c.specialization ?? null),
      used: { ...(c.used || {}) },
      forbidden_schools: [...(c.forbidden_schools || [])],
    }])),
    metamagic_feats: [...(pc.metamagic_feats || [])],
    favorites: [...(pc.favorites || [])],
    prepared: structuredClone(pc.prepared || []),
    scrolls: structuredClone(pc.scrolls || []),
    modified_at: new Date().toISOString(),
  };
}

// PATCH first: an old server ignores the new fields (and would lose data), so we notice before sending the lists.
async function sendPreparation(id, data) {
  const response = await api(`characters/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { classes: data.classes, metamagic_feats: data.metamagic_feats, favorites: data.favorites },
  });
  if (!("classes" in response) || !("favorites" in response)
      || response.classes.some((c) => !("forbidden_schools" in c))) throw new Error(OUTDATED_SERVER);
  await api(`characters/${encodeURIComponent(id)}/prepared`, { method: "PUT", body: { prepared: data.prepared } });
  await api(`characters/${encodeURIComponent(id)}/scrolls`, { method: "PUT", body: { scrolls: data.scrolls } });
}

function savePreparation() {
  const pc = state.character;
  const id = pc.id;
  const data = preparationData(pc);
  writeUnsaved(id, data);
  state.saveQueue = state.saveQueue
    .then(async () => {
      await sendPreparation(id, data);
      if (readUnsaved(id)?.modified_at === data.modified_at) writeUnsaved(id, null);
      state.saveFailed = false;
    })
    .catch((error) => {
      if (!state.saveFailed) {
        notify(`Not saved on the server: ${error.message} Your changes are kept in this browser and will be sent again when you reopen the book.`, true);
      }
      state.saveFailed = true;
    });
}

// When a book is reopened: sends again the changes left in the browser, if they are newer than the file on the server.
async function recoverUnsaved() {
  const pc = state.character;
  const data = readUnsaved(pc.id);
  if (!data) return;
  if (Date.parse(pc.updated_at) > Date.parse(data.modified_at)) {
    writeUnsaved(pc.id, null); // changed afterwards (e.g. from another device): the server wins
    return;
  }
  try {
    await sendPreparation(pc.id, data);
    state.character = await api(`characters/${encodeURIComponent(pc.id)}`);
    writeUnsaved(pc.id, null);
    state.saveFailed = false;
    notify("Unsaved preparation, scrolls and favorites from this browser are now saved.");
  } catch (error) {
    for (const cls of pc.classes || []) Object.assign(cls, data.classes?.[cls.key] || {});
    for (const key of ["prepared", "scrolls", "favorites", "metamagic_feats"]) if (key in data) pc[key] = data[key];
    state.saveFailed = true;
    notify(`Still not saved on the server: ${error.message} Your changes stay in this browser.`, true);
  }
}

function editPrepared(edit) {
  const list = (state.character.prepared || []).map((p) => ({ ...p }));
  edit(list);
  state.character.prepared = list
    .filter((p) => p.copies > 0)
    .map((p) => ({ ...p, cast: Math.max(0, Math.min(p.cast, p.copies)) }));
  renderPreparation();
  savePreparation();
}

// key = preparedKey; newEntry = entry to create if missing ({class, id} and, if any, its metamagic)
function changeCopies(key, delta, newEntry) {
  editPrepared((list) => {
    let entry = list.find((p) => preparedKey(p) === key);
    if (!entry) list.push(entry = { ...newEntry, copies: 0, cast: 0 });
    entry.copies = Math.max(0, Math.min(30, entry.copies + delta));
  });
}

function markCast(key, index) {
  editPrepared((list) => {
    const entry = list.find((p) => preparedKey(p) === key);
    if (entry) entry.cast = index < entry.cast ? index : index + 1;
  });
}

// Spontaneous casters: tapping slot n marks n+1 slots as used (or frees it, like the prepared pips)
function markUsed(cls, level, index) {
  const used = Number(cls.used?.[level] || 0);
  cls.used = { ...(cls.used || {}), [level]: index < used ? index : index + 1 };
  renderPreparation();
  savePreparation();
}

function useSlot(cls, level, spellId, feats = "") {
  if (classEntries(cls).find((e) => e.spell.id === spellId)?.available === false) {
    return notify("Its spellbook is not available: it can't be cast from here.", true);
  }
  const total = computeSlots(cls)[level]?.total || 0;
  const used = Number(cls.used?.[level] || 0);
  if (used >= total) return notify(`No ${levelTitle(level, cls).toLowerCase()} slots left today.`, true);
  cls.used = { ...(cls.used || {}), [level]: used + 1 };
  const name = characterSpell(spellId)?.spell.name || "Spell";
  notify(`${name}${feats} cast: ${total - used - 1} level ${level} slot${total - used - 1 === 1 ? "" : "s"} left.`);
  renderPreparation();
  savePreparation();
}

function newDay() {
  for (const cls of state.character.classes || []) cls.used = {};
  editPrepared((list) => list.forEach((p) => { p.cast = 0; }));
  notify("A new day: all prepared spells and spell slots are ready again.");
}

function updateSpecialization(block, cls) {
  const type = block.querySelector("[data-spec-type]").value;
  const before = cls.specialization;
  const school = block.querySelector("[data-spec-school]");
  cls.specialization = !type ? null : {
    type,
    name: type === "school" ? school.value : block.querySelector("[data-spec-domain]").value.trim(),
    extra: before?.extra || [],
  };
  if (type === "school" && before?.type !== "school" && !SPECIALIST_SCHOOLS.includes(cls.specialization.name)) {
    cls.specialization.name = SPECIALIST_SCHOOLS[0];
  }
  if (type === "school") cls.forbidden_schools = (cls.forbidden_schools || []).filter((name) => name !== cls.specialization.name);
  renderPreparation();
  if (type === "domain" && before?.type !== "domain") block.querySelector("[data-spec-domain]").focus();
  savePreparation();
}

function toggleSpecial(id, cls) {
  const spec = cls.specialization;
  if (!spec) return;
  spec.extra = spec.extra?.includes(id) ? spec.extra.filter((i) => i !== id) : [...(spec.extra || []), id];
  renderPreparation();
  savePreparation();
}

function saveSlots(block, cls) {
  const slot = {};
  block.querySelectorAll("[data-slot-level]").forEach((field) => {
    const number = Math.max(0, Math.min(99, parseInt(field.value, 10) || 0));
    if (number) slot[field.dataset.slotLevel] = number;
  });
  cls.daily_slots = slot;
  renderPreparation();
  savePreparation();
}

function jumpTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

app.addEventListener("click", async (event) => {
  if (state.view !== "prepared" || !event.target.closest("#preparation")) return;
  const target = event.target.closest("button, input");
  if (!target) return;
  const d = target.dataset;
  const cls = classByKey(target.closest("[data-class-block]")?.dataset.classBlock);
  if (d.change === "1") {
    const target = classEntries(cls).find((e) => e.spell.id === d.spell);
    if (target && forbiddenSchool(target.spell, cls)) return notify(forbiddenNote(forbiddenSchool(target.spell, cls)), true);
    if (target?.available === false) return notify(UNAVAILABLE_NOTE, true);
  }
  if (d.change) return changeCopies(d.key, Number(d.change), { class: cls.key, id: d.spell });
  if (d.pip) return markCast(d.key, Number(d.pip));
  if (d.usedPip) return markUsed(cls, Number(d.level), Number(d.usedPip));
  if (d.cast) return useSlot(cls, Number(d.cast), d.spell);
  if (d.open) return openSheet(d.open);
  if (d.favorite) {
    toggleFavorite(d.favorite);
    return renderPreparation();
  }
  if (d.special) return toggleSpecial(d.special, cls);
  if (d.forbid) return toggleForbidden(cls, d.forbid);
  if (d.metamagic) return openMetamagic({ mode: "spell", id: d.metamagic, class: cls.key });
  if (d.feat) return openMetamagic({ mode: "feat", feat: d.feat });
  if ("pickFeats" in d) return openMetamagic({ mode: "choice" });
  if (d.jump) return jumpTo(d.jump);
  if (target.id === "new-day") return newDay();
  if (target.id === "clear-prepared") {
    const keys = new Set(viewClasses().filter((c) => c.casting === "prepared").map((c) => c.key));
    const names = viewClasses().filter((c) => keys.has(c.key)).map((c) => c.name).join(" and ");
    if (await askConfirm("Clear all prepared spells?", `Every ${names} spell goes back to 0 prepared copies. Your spells per day stay as they are.`, "Clear all")) {
      editPrepared((list) => list.splice(0, list.length, ...list.filter((p) => !keys.has(p.class))));
    }
  }
});

app.addEventListener("change", (event) => {
  const block = event.target.closest("[data-class-block]");
  if (state.view !== "prepared" || !block) return;
  const cls = classByKey(block.dataset.classBlock);
  const d = event.target.dataset;
  if (d.slotLevel !== undefined) saveSlots(block, cls);
  if ("specType" in d || "specSchool" in d || "specDomain" in d) updateSpecialization(block, cls);
  if ("score" in d) {
    const number = parseInt(event.target.value, 10);
    cls.ability_score = number > 0 ? Math.min(60, number) : null;
    event.target.value = cls.ability_score || "";
    renderPreparation();
    savePreparation();
  }
  if ("ability" in d) {
    cls.ability = event.target.value;
    renderPreparation();
    savePreparation();
  }
});

// ---------- scrolls ----------
// Scroll prices (SRD, Creating Magic Items): spell level × caster level × 25 gp, with a cantrip counting as ½ level.
// The caster level is the lowest that can cast the spell in the scriber's class; costly material components are
// added at their value and XP costs at 5 gp per XP (a focus isn't used up, so it isn't added). Scribing a scroll
// yourself costs half the base price in gp and 1/25 of it in XP, plus the full component costs.
const SCROLL_CASTER_LEVELS = {
  wizard: [1, 1, 3, 5, 7, 9, 11, 13, 15, 17],  // cleric, druid and wizard
  sorcerer: [1, 1, 4, 6, 8, 10, 12, 14, 16, 18],
  bard: [1, 2, 4, 7, 10, 13, 16],
  paladin: [null, 2, 4, 5, 7],                 // paladin and ranger: caster level is half the class level
};

// The table of a class: by name for the classes the SRD lists, otherwise by casting style
function scrollTable(cls) {
  const name = cls?.name || "";
  if (/\bbard\b/i.test(name)) return "bard";
  if (/paladin|ranger/i.test(name)) return "paladin";
  if (/beguiler|wu jen/i.test(name)) return "wizard";
  if (/sorcerer|favored soul|warmage|spirit shaman/i.test(name) || cls?.casting === "spontaneous") return "sorcerer";
  return "wizard";
}

function scrollCasterLevel(level, cls) {
  return SCROLL_CASTER_LEVELS[scrollTable(cls)][level] ?? SCROLL_CASTER_LEVELS.wizard[level];
}

// "Material Component: a pearl of at least 100 gp value", "XP Cost: 300 XP": the costs written in the description,
// or in the base spell's when the components come from it. "per"/"each" means the cost depends on the casting.
function componentCosts(spell, cls) {
  const material = cls?.tradition === "divine"
    ? /^(?:divine\s+)?material\s+components?$/i : /^(?:arcane\s+)?material\s+components?$/i;
  const read = (html) => {
    const costs = { gp: 0, xp: 0, variable: false, found: false };
    for (const [, paragraph] of (html || "").matchAll(/<p>([^]*?)<\/p>/g)) {
      const text = paragraph.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
      const label = text.match(/^([A-Z][^.:]{0,45}):\s*([^]*)$/);
      const isMaterial = label && material.test(label[1].trim());
      const isXp = label && /^xp cost$/i.test(label[1].trim());
      if (!isMaterial && !isXp) continue;
      costs.found = true;
      // "costs more than 10,000 gp" is a threshold, not a cost; with several amounts the largest one counts
      // ("100 XP per HD (minimum 1,000 XP)")
      const amounts = [...label[2].matchAll(isMaterial ? /(\d[\d,]*)\s*gp\b/gi : /(\d[\d,]*)\s*XP\b/g)]
        .filter((m) => !/(more than|in excess of)\s*$/i.test(label[2].slice(0, m.index)))
        .map((m) => Number(m[1].replace(/,/g, "")));
      const largest = Math.max(0, ...amounts);
      if (isMaterial) costs.gp = Math.max(costs.gp, largest);
      else costs.xp = Math.max(costs.xp, largest);
      if ((amounts.length && /\b(per|each|for every)\b/i.test(label[2])) || (isXp && !amounts.length)) costs.variable = true;
    }
    return costs;
  };
  // lists have light sheets: only the cost paragraphs (costs_html, base_costs_html); full sheets have the whole text
  const key = cls?.tradition === "divine" ? "divine" : "arcane";
  let cached = costCache.get(spell);
  if (!cached) costCache.set(spell, cached = {});
  if (!cached[key]) {
    const own = read(spell.costs_html ?? spell.description_html);
    const baseName = spell.inherited_from?.keys?.components;
    const base = baseName && spell.inherited_from.chain.find((b) => b.name === baseName);
    cached[key] = !own.found && base
      ? read(spell.base_costs_html ?? (spell.linked?.find((c) => c.id === base.id) || findSpell(base.id)?.inc)?.description_html)
      : own;
  }
  return cached[key];
}

const costCache = new WeakMap();

// 12.5 -> "12 gp 5 sp", 1650 -> "1,650 gp"
function coins(gp) {
  const cp = Math.round(gp * 100);
  return [[Math.floor(cp / 100), "gp"], [Math.floor(cp / 10) % 10, "sp"], [cp % 10, "cp"]]
    .filter(([n]) => n).map(([n, unit]) => `${n.toLocaleString("en-US")} ${unit}`).join(" ") || "0 gp";
}

function scrollPrice(level, spell, cls) {
  const casterLevel = scrollCasterLevel(Number(level), cls);
  const base = (Number(level) || 0.5) * casterLevel * 25;
  const costs = componentCosts(spell, cls);
  return {
    casterLevel, base, costs,
    market: base + costs.gp + costs.xp * 5,
    scribeGp: base / 2 + costs.gp,
    scribeXp: Math.ceil(base / 25) + costs.xp,
  };
}

function costNote(costs) {
  const parts = [];
  if (costs.gp) parts.push(`${coins(costs.gp)} material component`);
  if (costs.xp) parts.push(`${costs.xp.toLocaleString("en-US")} XP cost (${coins(costs.xp * 5)})`);
  const text = parts.length ? `includes ${parts.join(" and ")}` : "";
  return costs.variable ? `${text ? `${text}; ` : ""}the component cost varies: check the spell` : text;
}

// Scrolls of a spell: of one class, or of every class (card badge)
const scrollCountCache = new WeakMap();

function scrollCount(id, cls = null) {
  const list = state.character?.scrolls || [];
  let counts = scrollCountCache.get(list);
  if (!counts) {
    counts = new Map();
    for (const scroll of list) {
      counts.set(`${scroll.class}|${scroll.id}`, (counts.get(`${scroll.class}|${scroll.id}`) || 0) + scroll.count);
      counts.set(scroll.id, (counts.get(scroll.id) || 0) + scroll.count);
    }
    scrollCountCache.set(list, counts);
  }
  return counts.get(cls ? `${cls.key}|${id}` : id) || 0;
}

// Scrolls of the given classes, and what they are worth
function scrollTotals(classes = viewClasses()) {
  const keys = new Map(classes.map((c) => [c.key, c]));
  let count = 0;
  let value = 0;
  for (const scroll of state.character?.scrolls || []) {
    const cls = keys.get(scroll.class);
    const level = cls && levelIn(cls, scroll.id);
    if (level === undefined || !cls) continue;
    const spell = characterSpell(scroll.id).spell;
    count += scroll.count;
    value += scroll.count * scrollPrice(level, spell, cls).market;
  }
  return { count, value };
}

// "Scroll" line on the spell sheet: one line per class of the spell
function scrollSummary(entry) {
  const classes = entryClasses(entry);
  return classes.map((cls) => {
    const level = levelIn(cls, entry.spell.id) ?? entry.level;
    const price = scrollPrice(level, entry.spell, cls);
    const owned = scrollCount(entry.spell.id, cls);
    return `${classes.length > 1 ? `${esc(cls.name)}: ` : ""}caster level ${price.casterLevel} · ${esc(coins(price.market))}${price.costs.variable ? " or more" : ""}`
      + `${owned ? ` · <b>${owned} owned, ${esc(coins(price.market * owned))}${price.costs.variable ? "+" : ""} in total</b>` : ""}`;
  }).join("<br>");
}

function scrollRow({ entry, count, price }, cls) {
  const inc = entry.spell;
  const note = costNote(price.costs);
  const plus = price.costs.variable ? "+" : "";
  return `
    <li class="prep-row scroll-row ${count ? "active" : ""} ${entry.available === false || forbiddenSchool(inc, cls) ? "unavailable" : ""}" style="--c:${schoolColor(inc)}">
      <button type="button" class="prep-name" data-open="${esc(inc.id)}">
        <span class="name">${esc(inc.name)}</span>
        <span class="subline">${esc(school(inc))} · caster level ${price.casterLevel}${forbiddenSchool(inc, cls) ? " · forbidden school: you can't use it" : ""}${entry.available === false ? " · spellbook not available" : ""}</span>
        ${spellBookList(entry, "card-books row-books")}
      </button>
      <div class="scroll-price">
        <span><b>${esc(coins(price.market))}${plus}</b> each</span>
        ${count ? `<span class="scroll-total">total for ${count}: <b>${esc(coins(price.market * count))}${plus}</b></span>` : ""}
        <span>scribe one: ${esc(coins(price.scribeGp))} + ${price.scribeXp.toLocaleString("en-US")} XP</span>
        ${note ? `<span class="cost-note">${esc(note)}</span>` : ""}
      </div>
      <div class="controls">
        ${favoriteButton(inc)}
        <div class="stepper">
          <button type="button" data-scroll-change="-1" data-scroll="${esc(inc.id)}" aria-label="One ${esc(cls.name)} scroll of ${esc(inc.name)} less" ${count ? "" : "disabled"}>−</button>
          <span class="copies" aria-live="polite">${count}</span>
          <button type="button" data-scroll-change="1" data-scroll="${esc(inc.id)}" aria-label="One more ${esc(cls.name)} scroll of ${esc(inc.name)}" ${count >= 99 ? "disabled" : ""}>+</button>
        </div>
      </div>
    </li>`;
}

// The level sections of a class in the Scrolls tab, for patchSections
function scrollSections(cls) {
  const visible = visibleSpellIds();
  const byLevel = new Map();
  for (const entry of classEntries(cls)) {
    if (visible && !visible.has(entry.spell.id)) continue;
    const count = scrollCount(entry.spell.id, cls);
    if ((state.onlyOwned && !count) || !matchesFilters(entry.spell, entry.books)) continue;
    if (!byLevel.has(entry.level)) byLevel.set(entry.level, []);
    byLevel.get(entry.level).push({ entry, count, price: scrollPrice(entry.level, entry.spell, cls) });
  }
  return [...byLevel.keys()].sort((a, b) => a - b).map((level) => {
    const rows = byLevel.get(level).sort((a, b) => favoritesFirst(a.entry.spell, b.entry.spell));
    const owned = rows.reduce((total, row) => total + row.count, 0);
    const casterLevel = scrollCasterLevel(level, cls);
    const title = levelTitle(level, cls);
    return {
      key: `level-${level}`, level, className: `prep-level${isFolded(level) ? " folded" : ""}`,
      listTag: "ul", listClass: "prep-list",
      rows: rows.map((row) => lazyRow(row.entry.spell.id, () => scrollRow(row, cls))),
      empty: "",
      head: `
        <div class="level-title">
          ${foldButton(level, title)}
          <span class="number">${level}</span>
          <div>
            <h2>${esc(title)}</h2>
            <div class="level-info">caster level ${casterLevel} · ${esc(coins((level || 0.5) * casterLevel * 25))} a scroll, plus costly components</div>
          </div>
          <span class="counter ${owned ? "full" : ""}" title="Scrolls owned">${owned}</span>
        </div>`,
    };
  });
}

// Like the prepared spells: one block per class, one section per level, the rows of the open book (or of all the books)
function renderScrolls() {
  const container = $("#scrolls");
  if (!container) return;
  const classes = viewClasses();
  const totals = scrollTotals(classes);
  $("#scroll-count").textContent = totals.count;
  // the page is built once for these classes; then only the counters and the rows that changed are drawn again
  const layout = classes.map((c) => `${c.key}:${c.type}`).join(",") + (state.book.all ? ":all" : "");
  if (container.dataset.layout !== layout) {
    container.dataset.layout = layout;
    container.innerHTML = `
      <div class="day" id="scroll-day"></div>
      <p class="parchment-help scroll-help">Prices at the minimum caster level of each class: spell level × caster level × 25 gp
        (a cantrip or orison counts as ½ level), plus costly material components and 5 gp for each XP the spell costs.
        Scribing one yourself takes half the price in gold and 1/25 of it in XP, plus the full component costs.
        ${state.book.all ? "" : "The rows are the spells of this book; the totals include the scrolls of your other books of the same class."}</p>
      ${classJump(classes, "scrolls")}
      ${classes.map((cls) => `
        <section class="class-prep" id="scrolls-${esc(cls.key)}" data-class-block="${esc(cls.key)}">
          ${classHead(cls, `${cls.tradition} scrolls`)}
          <div data-class-sections></div>
        </section>`).join("")
        || `<div class="empty"><div class="big">No classes yet</div><p>Create a spellbook for this character to keep count of their scrolls.</p></div>`}`;
  }
  const day = `
      <div class="day-counters">
        <div class="day-counter"><span class="value">${totals.count}</span><span class="label">Scrolls</span></div>
        <div class="day-counter"><span class="value">${esc(coins(totals.value))}</span><span class="label">Market value</span></div>
      </div>
      ${classes.length ? `<div class="day-actions">
        <button class="button" type="button" id="open-cart">✚ Add scrolls</button>
      </div>` : ""}`;
  const dayBox = $("#scroll-day");
  if (patchMemory.get(dayBox)?.html !== day) {
    dayBox.innerHTML = day;
    patchMemory.set(dayBox, { key: "day", html: day });
  }
  const filtered = state.onlyOwned || filtersActive();
  for (const cls of classes) {
    const box = container.querySelector(`[data-class-block="${CSS.escape(cls.key)}"] [data-class-sections]`);
    const sections = scrollSections(cls);
    if (sections.length) patchSections(box, sections);
    else box.innerHTML = `<p class="empty-level">${filtered ? "Nothing matches the filters above." : `No ${esc(cls.name)} spells ${state.book.all ? "in your books" : "in this book"} yet.`}</p>`;
  }
  updateLevelTools();
}

function changeScrolls(cls, id, delta) {
  const list = (state.character.scrolls || []).map((s) => ({ ...s }));
  let scroll = list.find((s) => s.id === id && s.class === cls.key);
  if (!scroll) list.push(scroll = { id, class: cls.key, count: 0 });
  scroll.count = Math.max(0, Math.min(99, scroll.count + delta));
  state.character.scrolls = list.filter((s) => s.count > 0);
  renderScrolls();
  savePreparation();
}

app.addEventListener("click", (event) => {
  if (state.view !== "scrolls" || !event.target.closest("#scrolls")) return;
  const target = event.target.closest("button, input");
  if (!target) return;
  const cls = classByKey(target.closest("[data-class-block]")?.dataset.classBlock);
  if (target.id === "open-cart") return openCart();
  if (target.dataset.scrollChange) return changeScrolls(cls, target.dataset.scroll, Number(target.dataset.scrollChange));
  if (target.dataset.open) return openSheet(target.dataset.open);
  if (target.dataset.jump) return jumpTo(target.dataset.jump);
  if (target.dataset.favorite) {
    toggleFavorite(target.dataset.favorite);
    return renderScrolls();
  }
});

// ---------- dialog: add scrolls ----------
// A list of scrolls to add, with what they cost to buy (market price) and to scribe (gp + XP), checked against the
// gold (and XP) the character can spend. "Add" puts them in the scroll counts. The list is kept while the page is open.
const cart = { mode: "buy", budget: "", xp: "", counts: new Map(), text: "", level: "", cls: "", onlyChosen: false };

function cartKey(cls, id) {
  return `${cls.key}|${id}`;
}

// Every spell that can get a scroll on this page (all classes shown, whatever the filters of the dialog)
function cartItems() {
  const visible = visibleSpellIds();
  const items = new Map();
  for (const cls of viewClasses()) {
    for (const entry of classEntries(cls)) {
      if (visible && !visible.has(entry.spell.id)) continue;
      items.set(cartKey(cls, entry.spell.id), {
        key: cartKey(cls, entry.spell.id), cls, entry,
        price: scrollPrice(entry.level, entry.spell, cls),
        owned: scrollCount(entry.spell.id, cls),
      });
    }
  }
  return items;
}

function amount(value) {
  const number = parseFloat(String(value).replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// A spell of a forbidden school, or whose spellbooks are all lost or stolen, can be bought, not scribed
function cartBlocked(item) {
  return cart.mode === "scribe" && (item.entry.available === false || Boolean(forbiddenSchool(item.entry.spell, item.cls)));
}

function cartTotals(items) {
  const totals = { count: 0, market: 0, scribeGp: 0, scribeXp: 0, variable: false, blocked: 0 };
  for (const [key, n] of cart.counts) {
    const item = items.get(key);
    if (!item || !n) continue;
    totals.count += n;
    totals.market += n * item.price.market;
    totals.scribeGp += n * item.price.scribeGp;
    totals.scribeXp += n * item.price.scribeXp;
    totals.variable ||= item.price.costs.variable;
    if (cartBlocked(item)) totals.blocked += n;
  }
  totals.gp = cart.mode === "buy" ? totals.market : totals.scribeGp;
  const budget = amount(cart.budget);
  const xp = amount(cart.xp);
  totals.goldLeft = budget === null ? null : budget - totals.gp;
  totals.xpLeft = cart.mode === "scribe" && xp !== null ? xp - totals.scribeXp : null;
  return totals;
}

function openCart() {
  // chosen spells that are no longer on the page are dropped
  const items = cartItems();
  for (const key of cart.counts.keys()) if (!items.has(key)) cart.counts.delete(key);
  const classes = viewClasses();
  if (!classes.some((c) => c.key === cart.cls)) cart.cls = "";
  const levels = [...new Set([...items.values()].map((i) => i.entry.level))].sort((a, b) => a - b);
  if (!levels.includes(Number(cart.level))) cart.level = "";
  $("#cart").innerHTML = `
    <h2>Add scrolls</h2>
    <p class="help">Choose how many scrolls of each spell you are adding: the costs add up at the bottom.
      Write the gold you can spend to see what is left, and use “Max” to fill it with one spell.</p>
    <div class="field-row">
      <label>Gold you can spend (gp)
        <input type="number" inputmode="decimal" min="0" step="any" id="cart-budget" placeholder="e.g. 500" value="${esc(cart.budget)}">
      </label>
      <fieldset class="cart-mode">
        <legend>How you get them</legend>
        <label><input type="radio" name="cart-mode" value="buy" ${cart.mode === "buy" ? "checked" : ""}> Buy them (market price)</label>
        <label><input type="radio" name="cart-mode" value="scribe" ${cart.mode === "scribe" ? "checked" : ""}> Scribe them (Scribe Scroll)</label>
      </fieldset>
    </div>
    <label id="cart-xp-field" ${cart.mode === "scribe" ? "" : "hidden"}>XP you can spend
      <input type="number" inputmode="numeric" min="0" step="1" id="cart-xp" placeholder="optional" value="${esc(cart.xp)}">
    </label>
    <div class="cart-filters">
      <input type="search" id="cart-search" placeholder="Search spells…" aria-label="Search spells" value="${esc(cart.text)}">
      <select id="cart-level" aria-label="Level">
        <option value="">All levels</option>
        ${levels.map((n) => `<option value="${n}" ${String(n) === String(cart.level) ? "selected" : ""}>${n === 0 ? "Level 0" : `Level ${n}`}</option>`).join("")}
      </select>
      ${classes.length > 1 ? `<select id="cart-class" aria-label="Class">
        <option value="">All classes</option>
        ${classes.map((c) => `<option value="${esc(c.key)}" ${c.key === cart.cls ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>` : ""}
      <label class="cart-only"><input type="checkbox" id="cart-only" ${cart.onlyChosen ? "checked" : ""}> Only the chosen ones</label>
    </div>
    <ul class="cart-list" id="cart-list"></ul>
    <div class="cart-footer">
      <div class="cart-summary" id="cart-summary" aria-live="polite"></div>
      <div class="form-actions">
        <button type="button" class="button ghost" id="cart-clear">Clear the list</button>
        <span class="spacer"></span>
        <button type="button" class="button ghost" data-close>Cancel</button>
        <button type="button" class="button gold" id="cart-add" disabled>Add scrolls</button>
      </div>
    </div>`;
  renderCart();
  const dialog = $("#cart-dialog");
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  if (!TOUCH) $("#cart-budget").focus();
}

function renderCart() {
  const items = cartItems();
  const text = cart.text.trim().toLowerCase();
  const multi = viewClasses().length > 1;
  const totals = cartTotals(items);
  const shown = [...items.values()]
    .filter((i) => (!cart.cls || i.cls.key === cart.cls) && (cart.level === "" || i.entry.level === Number(cart.level)))
    .filter((i) => !cart.onlyChosen || cart.counts.get(i.key))
    .filter((i) => !text || [i.entry.spell.name, school(i.entry.spell), i.cls.name].join(" ").toLowerCase().includes(text))
    .sort((a, b) => a.entry.level - b.entry.level || favoritesFirst(a.entry.spell, b.entry.spell) || a.cls.name.localeCompare(b.cls.name));
  $("#cart-list").innerHTML = shown.map((i) => {
    const n = cart.counts.get(i.key) || 0;
    const p = i.price;
    const plus = p.costs.variable ? "+" : "";
    const blocked = cartBlocked(i);
    const room = 99 - i.owned - n;  // a spell can have at most 99 scrolls
    const unit = cart.mode === "buy" ? p.market : p.scribeGp;
    const canMax = !blocked && room > 0 && totals.goldLeft !== null && unit > 0 && maxMore(i, totals) > 0;
    return `
      <li class="cart-row ${n ? "chosen" : ""} ${blocked ? "blocked" : ""}" style="--c:${schoolColor(i.entry.spell)}">
        <div class="cart-info">
          <span class="cart-name"><button type="button" class="ref" data-cart-open="${esc(i.entry.spell.id)}">${esc(i.entry.spell.name)}</button>
            ${multi ? `<span class="finder-tag">${esc(i.cls.name)}</span>` : ""}${isFavorite(i.entry.spell.id) ? ` <span class="favorite-mark" title="Favorite">♥</span>` : ""}</span>
          <span class="cart-meta">${esc(levelTitle(i.entry.level, i.cls))} · caster level ${p.casterLevel}${i.owned ? ` · you have ${i.owned}` : ""}</span>
          <span class="cart-prices"><span class="${cart.mode === "buy" ? "current" : ""}">buy ${esc(coins(p.market))}${plus}</span>
            <span class="${cart.mode === "scribe" ? "current" : ""}">scribe ${esc(coins(p.scribeGp))}${plus} + ${p.scribeXp.toLocaleString("en-US")} XP</span></span>
          ${forbiddenSchool(i.entry.spell, i.cls) ? `<span class="cart-note">${esc(forbiddenSchool(i.entry.spell, i.cls))} is a forbidden school: you can buy the scroll but not use or scribe it.</span>`
            : blocked ? `<span class="cart-note">Its spellbook is not available: it can be bought, not scribed.</span>` : ""}
        </div>
        <div class="cart-controls">
          ${n ? `<span class="cart-line">${n} × = <b>${esc(coins(n * unit))}${plus}</b>${cart.mode === "scribe" ? ` + ${(n * p.scribeXp).toLocaleString("en-US")} XP` : ""}</span>` : ""}
          ${canMax ? `<button type="button" class="button compact" data-cart-max="${esc(i.key)}" title="As many as the gold left allows">Max</button>` : ""}
          <div class="stepper">
            <button type="button" data-cart-change="-1" data-key="${esc(i.key)}" aria-label="One scroll of ${esc(i.entry.spell.name)} less" ${n ? "" : "disabled"}>−</button>
            <span class="copies" aria-live="polite">${n}</span>
            <button type="button" data-cart-change="1" data-key="${esc(i.key)}" aria-label="One more scroll of ${esc(i.entry.spell.name)}" ${blocked || room <= 0 ? "disabled" : ""}>+</button>
          </div>
        </div>
      </li>`;
  }).join("") || `<li class="finder-none">${items.size ? "No spells match." : "No spells in this book yet."}</li>`;
  renderCartSummary(totals);
}

// How many more scrolls of this spell the gold (and XP, when scribing) left can pay for
function maxMore(item, totals) {
  const unit = cart.mode === "buy" ? item.price.market : item.price.scribeGp;
  let most = Math.floor((totals.goldLeft + 1e-9) / unit);
  if (totals.xpLeft !== null && item.price.scribeXp) most = Math.min(most, Math.floor(totals.xpLeft / item.price.scribeXp));
  return Math.max(0, Math.min(most, 99 - item.owned - (cart.counts.get(item.key) || 0)));
}

function renderCartSummary(totals) {
  const plus = totals.variable ? "+" : "";
  const buying = cart.mode === "buy";
  const lines = [];
  if (totals.goldLeft !== null) {
    lines.push(totals.goldLeft >= 0
      ? `<p class="cart-left">Gold left: <b>${esc(coins(totals.goldLeft))}</b>${plus ? " or less" : ""} (of ${esc(coins(amount(cart.budget)))})</p>`
      : `<p class="cart-left over">Not enough gold: <b>${esc(coins(-totals.goldLeft))}</b> short (you have ${esc(coins(amount(cart.budget)))})</p>`);
  }
  if (totals.xpLeft !== null) {
    lines.push(totals.xpLeft >= 0
      ? `<p class="cart-left">XP left: <b>${totals.xpLeft.toLocaleString("en-US")}</b> (of ${amount(cart.xp).toLocaleString("en-US")})</p>`
      : `<p class="cart-left over">Not enough XP: <b>${(-totals.xpLeft).toLocaleString("en-US")}</b> short</p>`);
  }
  if (totals.blocked) lines.push(`<p class="cart-left over">${totals.blocked} of them can't be scribed: their school is forbidden or their spellbook is not available.</p>`);
  if (totals.variable) lines.push(`<p class="cart-vary">Some component costs vary with the casting: the totals are the least they cost.</p>`);
  $("#cart-summary").innerHTML = `
    <div class="cart-totals">
      <span class="cart-count"><b>${totals.count}</b> scroll${totals.count === 1 ? "" : "s"}</span>
      <span class="${buying ? "current" : ""}">Buy: <b>${esc(coins(totals.market))}${plus}</b></span>
      <span class="${buying ? "" : "current"}">Scribe: <b>${esc(coins(totals.scribeGp))}${plus}</b> + <b>${totals.scribeXp.toLocaleString("en-US")} XP</b></span>
    </div>
    ${lines.join("")}`;
  const add = $("#cart-add");
  add.disabled = !totals.count || totals.blocked > 0;
  add.textContent = totals.count ? `${buying ? "Buy" : "Scribe"} ${totals.count} scroll${totals.count === 1 ? "" : "s"}` : "Add scrolls";
  $("#cart-clear").disabled = !totals.count;
}

function addCartScrolls() {
  const items = cartItems();
  const totals = cartTotals(items);
  if (!totals.count || totals.blocked) return;
  const list = (state.character.scrolls || []).map((s) => ({ ...s }));
  for (const [key, n] of cart.counts) {
    const item = items.get(key);
    if (!item || !n) continue;
    let scroll = list.find((s) => s.id === item.entry.spell.id && s.class === item.cls.key);
    if (!scroll) list.push(scroll = { id: item.entry.spell.id, class: item.cls.key, count: 0 });
    scroll.count = Math.min(99, scroll.count + n);
  }
  state.character.scrolls = list;
  const plus = totals.variable ? "+" : "";
  const cost = cart.mode === "buy" ? `${coins(totals.market)}${plus}` : `${coins(totals.scribeGp)}${plus} and ${totals.scribeXp.toLocaleString("en-US")} XP`;
  const left = totals.goldLeft !== null && totals.goldLeft >= 0 ? ` ${coins(totals.goldLeft)} left.` : "";
  // what is left becomes the gold (and XP) to spend next time
  if (totals.goldLeft !== null) cart.budget = String(Math.max(0, Math.round(totals.goldLeft * 100) / 100));
  if (totals.xpLeft !== null) cart.xp = String(Math.max(0, totals.xpLeft));
  cart.counts.clear();
  $("#cart-dialog").close();
  renderScrolls();
  savePreparation();
  notify(`${cart.mode === "buy" ? "Bought" : "Scribed"} ${totals.count} scroll${totals.count === 1 ? "" : "s"} for ${cost}.${left}`);
}

$("#cart").addEventListener("input", (event) => {
  const id = event.target.id;
  if (id === "cart-budget") cart.budget = event.target.value;
  else if (id === "cart-xp") cart.xp = event.target.value;
  else if (id === "cart-search") cart.text = event.target.value;
  else return;
  renderCart();
});

$("#cart").addEventListener("change", (event) => {
  const target = event.target;
  if (target.name === "cart-mode") {
    cart.mode = target.value;
    $("#cart-xp-field").hidden = cart.mode !== "scribe";
  } else if (target.id === "cart-level") cart.level = target.value;
  else if (target.id === "cart-class") cart.cls = target.value;
  else if (target.id === "cart-only") cart.onlyChosen = target.checked;
  else return;
  renderCart();
});

$("#cart").addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const d = target.dataset;
  if (d.cartChange) {
    const n = Math.max(0, (cart.counts.get(d.key) || 0) + Number(d.cartChange));
    n ? cart.counts.set(d.key, n) : cart.counts.delete(d.key);
    renderCart();
    $(`#cart-list [data-cart-change="${d.cartChange}"][data-key="${CSS.escape(d.key)}"]`)?.focus();
  } else if (d.cartMax) {
    const items = cartItems();
    const item = items.get(d.cartMax);
    if (!item) return;
    cart.counts.set(d.cartMax, (cart.counts.get(d.cartMax) || 0) + maxMore(item, cartTotals(items)));
    renderCart();
  } else if (d.cartOpen) {
    openSheet(d.cartOpen);
  } else if (target.id === "cart-clear") {
    cart.counts.clear();
    renderCart();
  } else if (target.id === "cart-add") {
    addCartScrolls();
  }
});

// ---------- dialog: metamagic ----------
// mode "spell": picks the feats to apply to a spell of a class and prepares it (or casts it, for a spontaneous
// class) in the higher slot; mode "choice": known metamagic feats (state.character.metamagic_feats);
// mode "feat": rules of one feat. returnTo = dialog state that "← Back" / "Done" goes back to.
function openMetamagic(options) {
  state.metamagic = { chosen: new Map(), returnTo: null, ...options };
  renderMetamagic();
  const dialog = $("#metamagic-dialog");
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

function increaseNote(feat) {
  if (feat.variable) return "You choose the new level when preparing (up to 9th). Save DCs use the new level.";
  if (feat.sudden) return "Once per day, when you cast: no higher slot and no special preparation.";
  if (feat.increase === null) return "dndtools doesn't state the slot increase: you write it when preparing.";
  if (!feat.increase) return "Uses a slot of the spell's normal level.";
  return `Uses a slot ${feat.increase} level${feat.increase === 1 ? "" : "s"} higher. Save DCs don't change.`;
}

function featRules(feat) {
  return `${feat.prerequisites ? `<p class="prerequisites"><b>Prerequisites:</b> ${esc(feat.prerequisites)}</p>` : ""}
    <div class="feat-text" lang="en">${feat.text_html}</div>
    <p class="increase-note">${esc(increaseNote(feat))} <a href="${esc(feat.url)}" target="_blank" rel="noopener">dndtools ↗</a></p>`;
}

function metamagicTarget(m) {
  const cls = classByKey(m.class);
  const entry = cls && classEntries(cls).find((v) => v.spell.id === m.id);
  return entry ? { cls, entry } : null;
}

function chosenMeta(m) {
  return [...m.chosen].map(([id, increase]) => ({ id, increase }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function renderMetamagic() {
  const m = state.metamagic;
  const container = $("#metamagic");
  if (m.mode === "feat") {
    const t = metamagic.byId.get(m.feat);
    container.innerHTML = !t ? "" : `
      <h2>${esc(t.name)} <span class="feat-increase">${increaseText(t)}</span></h2>
      <p class="help">${esc(shortSource(t))}${t.edition_35 ? "" : " · D&amp;D 3.0"} · ${esc(t.summary)}</p>
      ${featRules(t)}
      <div class="form-actions">
        ${m.returnTo ? `<button type="button" class="button" data-back-meta>← Back</button>` : ""}
        <span class="spacer"></span>
        <button type="button" class="button gold" data-close>Close</button>
      </div>`;
    return;
  }

  if (m.mode === "choice") {
    const known = new Set(state.character.metamagic_feats || []);
    container.innerHTML = `
      <h2>Metamagic feats</h2>
      <p class="help">Tick the feats this character knows: <b id="feat-count">${known.size}</b> chosen, from ${metamagic.list.length} metamagic feats on dndtools.</p>
      <input type="search" class="feat-search" data-search-feats placeholder="Search by feat or rulebook…" aria-label="Search metamagic feats">
      <ul class="feat-list">${metamagic.list.map((t) => `
        <li class="feat" data-text="${esc(`${t.name} ${t.rulebook}`.toLowerCase())}">
          <label class="feat-choice">
            <input type="checkbox" data-know="${esc(t.id)}" ${known.has(t.id) ? "checked" : ""}>
            <span class="name">${esc(t.name)}</span>
            <span class="feat-increase" title="${esc(increaseNote(t))}">${increaseText(t)}</span>
          </label>
          <div class="feat-info">${esc(shortSource(t))}${t.edition_35 ? "" : " · D&amp;D 3.0"} — ${esc(t.summary)}</div>
          <details><summary>Rules</summary>${featRules(t)}</details>
        </li>`).join("")}
      </ul>
      <p class="empty-feats" id="no-feats" hidden>No feats match this search.</p>
      <div class="form-actions">
        <span class="spacer"></span>
        <button type="button" class="button gold" ${m.returnTo ? "data-back-meta" : "data-close"}>Done</button>
      </div>`;
    return;
  }

  const target = metamagicTarget(m);
  if (!target) {
    $("#metamagic-dialog").close();
    return;
  }
  const { cls, entry } = target;
  const spontaneous = cls.casting === "spontaneous";
  const inc = entry.spell;
  const known = (state.character.metamagic_feats || []).map((id) => metamagic.byId.get(id)).filter(Boolean);
  const meta = chosenMeta(m).map((x) => ({ ...x, increase: x.increase ?? 0 }));
  const problems = metamagicProblems(entry, meta, computeSlots(cls), cls);
  const errors = [...(forbiddenSchool(inc, cls) ? [forbiddenNote(forbiddenSchool(inc, cls))] : []),
    ...(entry.available === false ? [spontaneous ? "Its spellbook is not available: it can't be cast from here." : UNAVAILABLE_NOTE] : []),
    ...problems.errors,
    ...[...m.chosen].filter(([, increase]) => increase === null).map(([id]) => `Write how many levels higher ${featName(id)} makes the slot.`)];
  const warnings = [...problems.warnings];
  const level = problems.slot <= 9 ? (spontaneous ? castingLevels(cls) : preparationLevels(cls))[problems.slot] : null;
  if (!spontaneous && level?.slot && level.prepared >= level.slot) {
    warnings.unshift(`All ${level.slot} level ${problems.slot} spells per day are already prepared.`);
  }
  if (spontaneous && level?.slot && level.used >= level.slot && !problems.errors.length) {
    errors.push(`No level ${problems.slot} slots left today.`);
  }
  const dc = hasSavingThrow(inc) ? spellDc(effectiveLevel(entry.level, meta), cls) : null;
  const existing = (state.character.prepared || []).find((p) => preparedKey(p) === preparedKey({ class: cls.key, id: inc.id, metamagic: meta }));

  const rows = known.map((t) => {
    const isChosen = m.chosen.has(t.id);
    const increase = m.chosen.get(t.id);
    const impossible = t.variable && entry.level >= 9;
    let field = "";
    if (isChosen && t.variable) {
      field = `<label class="increase-field">Heighten to
        <select data-heighten="${esc(t.id)}">${Array.from({ length: 9 - entry.level }, (_, i) => entry.level + i + 1)
          .map((n) => `<option value="${n}" ${n === entry.level + increase ? "selected" : ""}>level ${n}</option>`).join("")}</select></label>`;
    } else if (isChosen && t.increase === null) {
      field = `<label class="increase-field">Slot levels higher
        <input type="number" inputmode="numeric" min="0" max="9" data-increase="${esc(t.id)}" value="${increase ?? ""}" placeholder="?"></label>`;
    }
    return `
      <li class="feat ${isChosen ? "chosen" : ""}">
        <label class="feat-choice">
          <input type="checkbox" data-apply="${esc(t.id)}" ${isChosen ? "checked" : ""} ${impossible ? "disabled" : ""}>
          <span class="name">${esc(t.name)}</span>
          <span class="feat-increase" title="${esc(increaseNote(t))}">${increaseText(t)}</span>
        </label>
        ${field}
        <div class="feat-info">${esc(t.summary)}</div>
        <details><summary>Rules</summary>${featRules(t)}</details>
      </li>`;
  }).join("");

  const slotName = problems.slot > 9 ? `level ${problems.slot}` : problems.slot === 0 ? levelTitle(0, cls).toLowerCase().replace(/s$/, "") : `level ${problems.slot}`;
  container.innerHTML = `
    <h2>Metamagic: ${esc(inc.name)}</h2>
    <p class="help">Level ${entry.level} in your ${esc(cls.name)} book${entry.books.length === 1 ? "" : "s"}. Tick the feats to apply: ${spontaneous
      ? "the spell uses a higher slot, and casting it takes a full-round action (a standard action or less only with Quicken Spell)."
      : "the spell is prepared in a higher slot."}</p>
    ${known.length ? `<ul class="feat-list">${rows}</ul>`
      : `<p class="empty-feats">No metamagic feats chosen for this character yet.</p>`}
    <div><button type="button" class="button compact" data-pick-feats>${known.length ? "Change feats" : "Choose feats"}</button></div>
    <div class="metamagic-summary ${errors.length ? "error" : meta.length ? "ok" : ""}" aria-live="polite">
      <div class="meta-levels">
        <span>Level ${entry.level}</span> <span aria-hidden="true">→</span>
        <b>${esc(slotName)} slot</b>
        ${dc && !errors.length ? `<span>· DC ${dc}</span>` : ""}
        ${level?.slot ? `<span>· ${spontaneous ? `${Math.max(0, level.slot - level.used)}/${level.slot} slots left` : `${level.prepared}/${level.slot} prepared`} at that level</span>` : ""}
      </div>
      ${errors.length || warnings.length ? `<ul>
        ${errors.map((e) => `<li class="error">${esc(e)}</li>`).join("")}
        ${warnings.map((a) => `<li>${esc(a)}</li>`).join("")}
      </ul>` : ""}
    </div>
    <div class="form-actions">
      <span class="spacer"></span>
      <button type="button" class="button ghost" data-close>Cancel</button>
      <button type="button" class="button gold" data-prepare-meta ${!meta.length || errors.length ? "disabled" : ""}>
        ${spontaneous ? `Cast using a ${esc(slotName)} slot` : existing ? `Prepare another (${existing.copies} already)` : "Prepare 1 copy"}</button>
    </div>`;
}

// Redraws the dialog without losing the focused field or the scroll position
function rerenderMetamagic() {
  const active = document.activeElement;
  const key = ["apply", "heighten", "increase"].find((k) => active?.dataset?.[k] !== undefined);
  const selector = key && $("#metamagic").contains(active) ? `[data-${key}="${active.dataset[key]}"]` : null;
  const dialog = $("#metamagic-dialog");
  const scroll = dialog.scrollTop;
  renderMetamagic();
  dialog.scrollTop = scroll;
  if (selector) $("#metamagic").querySelector(selector)?.focus();
}

function prepareWithMetamagic() {
  const m = state.metamagic;
  const target = metamagicTarget(m);
  const meta = chosenMeta(m);
  if (!target || !meta.length || meta.some((x) => x.increase === null)) return;
  const { cls, entry } = target;
  const problems = metamagicProblems(entry, meta, computeSlots(cls), cls);
  if (problems.errors.length || entry.available === false || forbiddenSchool(entry.spell, cls)) return;
  const feats = meta.map((x) => featName(x.id)).join(", ");
  $("#metamagic-dialog").close();
  if (cls.casting === "spontaneous") return useSlot(cls, problems.slot, entry.spell.id, ` (${feats})`);
  const newEntry = { class: cls.key, id: entry.spell.id, metamagic: meta };
  changeCopies(preparedKey(newEntry), 1, newEntry);
  notify(`${entry.spell.name} prepared with ${feats} in a level ${problems.slot} slot.`);
}

// ---------- full spell sheet ----------

// "Label: text" lines that describe the components: they go next to the stats
const COMPONENT_NOTES = [
  [/^(arcane\s+)?material components?$/i, "Material component"],
  [/^arcane focus$/i, "Arcane focus"],
  [/^divine focus$/i, "Divine focus"],
  [/^focus$/i, "Focus"],
  [/^xp cost$/i, "XP cost"],
];
const LABEL_HTML_RE = /^\s*(?:<(strong|b|em|i)>)?\s*([A-Z0-9][^.:<>]{0,45}):\s*(?:<\/\1>)?\s*/;
const DICE_RE = /\b\d+d\d+(?:\s*[+×x]\s*\d+)?\b/g;
const LONG_PARAGRAPH = 650;       // characters beyond which a paragraph is split
const MIN_PARAGRAPH_PIECE = 320;  // minimum length of the pieces

function splitParagraph(paragraph) {
  if (paragraph.textContent.length <= LONG_PARAGRAPH) return;
  const sentences = paragraph.innerHTML.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  const pieces = [];
  let current = "";
  for (const sentence of sentences) {
    current = current ? `${current} ${sentence}` : sentence;
    if (current.replace(/<[^>]+>/g, "").length >= MIN_PARAGRAPH_PIECE) {
      pieces.push(current);
      current = "";
    }
  }
  if (current) {
    if (pieces.length && current.replace(/<[^>]+>/g, "").length < 120) pieces[pieces.length - 1] += ` ${current}`;
    else pieces.push(current);
  }
  if (pieces.length < 2) return;
  paragraph.replaceWith(...pieces.map((html) => {
    const fresh = document.createElement("p");
    fresh.innerHTML = html;
    return fresh;
  }));
}

function highlightDice(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  const hasDice = new RegExp(DICE_RE.source);  // without /g: test() without state
  while (walker.nextNode()) if (hasDice.test(walker.currentNode.data)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    DICE_RE.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const found of node.data.matchAll(DICE_RE)) {
      fragment.append(node.data.slice(last, found.index));
      const dice = document.createElement("span");
      dice.className = "dice";
      dice.textContent = found[0];
      fragment.append(dice);
      last = found.index + found[0].length;
    }
    fragment.append(node.data.slice(last));
    node.replaceWith(fragment);
  }
}

// ---------- conditions (SRD, web/conditions.json: kept offline, downloaded by the server when missing) ----------
const conditions = { list: [], byId: new Map(), forms: new Map(), pattern: null, note: "", source: "", error: "" };
const conditionHistory = []; // "list" or ids of the opened conditions, for "← Back"

async function loadConditions() {
  try {
    const response = await fetch("/conditions.json");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
    conditions.error = "";
    conditions.list = data.conditions;
    conditions.byId = new Map(data.conditions.map((c) => [c.id, c]));
    conditions.note = data.note || "";
    conditions.source = data.source || "";
    // excluded phrases ("raise dead") are matched but stay plain text
    for (const c of data.conditions) for (const form of c.forms) conditions.forms.set(form.toLowerCase(), c.id);
    for (const sentence of data.excluded || []) conditions.forms.set(sentence.toLowerCase(), null);
    const alternative = [...conditions.forms.keys()]
      .sort((a, b) => b.length - a.length)
      .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
    conditions.pattern = new RegExp(`(?<![\\w-])(?:${alternative.join("|")})(?![\\w-])`, "gi");
  } catch (error) {
    // without the file descriptions have no links to conditions; the dialog says why and can try again
    conditions.error = error.message;
  }
}

// Words that name a condition become buttons that open its description.
function highlightConditions(root) {
  if (!conditions.pattern) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest("button, .dice, .label, h3, h4, th")) nodes.push(node);
  }
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const found of node.data.matchAll(conditions.pattern)) {
      const id = conditions.forms.get(found[0].toLowerCase().replace(/\s+/g, " "));
      if (!id) continue;
      fragment.append(node.data.slice(last, found.index));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "condition";
      button.dataset.condition = id;
      button.title = `Condition: ${conditions.byId.get(id).name}`;
      button.textContent = found[0];
      fragment.append(button);
      last = found.index + found[0].length;
    }
    if (!last) continue;
    fragment.append(node.data.slice(last));
    node.replaceWith(fragment);
  }
}

function openCondition(view) {
  conditionHistory.splice(0, conditionHistory.length, view);
  renderCondition();
  const dialog = $("#condition-dialog");
  if (!dialog.open) dialog.showModal();
}

function renderCondition() {
  const view = conditionHistory.at(-1);
  const condition = conditions.byId.get(view);
  let body;
  if (!conditions.list.length) {
    body = `<h2>Conditions</h2>
      <p class="conditions-note">${esc(conditions.error || "The conditions are not loaded yet.")}</p>
      <p><button type="button" class="button" data-retry-conditions>Try again</button></p>`;
  } else if (condition) {
    const template = document.createElement("template");
    template.innerHTML = condition.description_html;
    for (const link of template.content.querySelectorAll("a[data-condition]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "condition";
      button.dataset.condition = link.dataset.condition;
      button.textContent = link.textContent;
      link.replaceWith(button);
    }
    highlightDice(template.content);
    const output = document.createElement("div");
    output.append(template.content);
    body = `
      <p class="overline">Condition</p>
      <h2>${esc(condition.name)}</h2>
      <div class="description" lang="en">${output.innerHTML}</div>`;
  } else {
    body = `
      <p class="overline">SRD 3.5</p>
      <h2>Conditions</h2>
      <p class="conditions-note">${esc(conditions.note)}</p>`;
  }
  $("#condition").innerHTML = `
    <article class="parchment condition-sheet">
      <button class="sheet-close" type="button" data-close aria-label="Close">×</button>
      ${body}
      <nav class="condition-index" aria-label="All conditions">
        ${condition ? `<h3>Other conditions</h3>` : ""}
        ${conditions.list.map((c) => `<button type="button" class="condition-item" data-condition="${esc(c.id)}"
            ${c.id === view ? 'aria-current="true"' : ""}>${esc(c.name)}</button>`).join("")}
      </nav>
      <div class="sheet-actions">
        ${conditionHistory.length > 1 ? `<button class="button" type="button" data-back>← Back</button>` : ""}
        <span class="spacer"></span>
        ${conditions.source ? `<a class="button" href="${esc(conditions.source)}${condition ? `#${esc(condition.id)}` : ""}" target="_blank" rel="noopener">d20srd.org ↗</a>` : ""}
      </div>
    </article>`;
  $("#condition .parchment").scrollTop = 0;
}

/** Makes the dndtools description easier to read. Returns the HTML and the component notes. */
function formatDescription(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  const root = template.content;
  const notes = [];

  const first = root.firstElementChild;
  const onlyItalic = first?.tagName === "P" && first.children.length === 1
    && /^(EM|I)$/.test(first.firstElementChild.tagName)
    && first.textContent.trim() === first.firstElementChild.textContent.trim();
  if (onlyItalic) first.classList.add("flavor");

  for (const paragraph of [...root.querySelectorAll("p:not(.flavor)")]) {
    const label = paragraph.innerHTML.match(LABEL_HTML_RE);
    if (label && paragraph.textContent.trim().length > label[2].length + 1) {
      const rest = paragraph.innerHTML.slice(label[0].length);
      const component = COMPONENT_NOTES.find(([pattern]) => pattern.test(label[2].trim()));
      if (component) {
        notes.push({ label: component[1], html: rest });
        paragraph.remove();
        continue;
      }
      paragraph.classList.add("labeled");
      paragraph.innerHTML = `<strong class="label">${esc(label[2].trim())}</strong> ${rest}`;
      continue;
    }
    splitParagraph(paragraph);
  }

  root.querySelector("p:not(.flavor):not(.labeled)")?.classList.add("first");
  for (const link of root.querySelectorAll("a[data-ref]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ref";
    button.dataset.ref = link.dataset.ref;
    button.textContent = link.textContent;
    link.replaceWith(button);
  }
  for (const link of root.querySelectorAll("a")) link.replaceWith(...link.childNodes); // any other link
  for (const table of root.querySelectorAll("table")) {
    const container = document.createElement("div");
    container.className = "scroll-table";
    table.replaceWith(container);
    container.append(table);
  }
  highlightDice(root);
  highlightConditions(root);

  const output = document.createElement("div");
  output.append(root);
  return { html: output.innerHTML, notes };
}

// A spell of the page (light sheet), or a spell referenced by an opened sheet (in "linked", already completed)
function findSpell(id) {
  const entry = bookSpell(id);
  if (entry) return { entry, inc: entry.spell };
  const sheets = [...fullSheetData.values(), state.preview?.spell].filter(Boolean);
  for (const sheet of sheets) {
    const linked = sheet.linked?.find((c) => c.id === id);
    if (linked) return { entry: null, inc: linked };
  }
  return null;
}

// Full sheets (description, levels, referenced spells), fetched when a sheet is opened; emptied when the page reloads
const fullSheets = new Map();     // id -> promise
const fullSheetData = new Map();  // id -> sheet

function forgetFullSheets() {
  fullSheets.clear();
  fullSheetData.clear();
}

function fullSheet(id) {
  if (!fullSheets.has(id)) {
    fullSheets.set(id, api(`spells/${encodeURIComponent(id)}`).then((sheet) => {
      fullSheetData.set(id, sheet);
      return sheet;
    }, (error) => {
      fullSheets.delete(id);
      throw error;
    }));
  }
  return fullSheets.get(id);
}

let sheetRequest = null;

async function openSheet(id, options = {}) {
  const found = findSpell(id);
  if (!found) return;
  if (!found.entry || fullSheetData.has(id)) return showSheet(id, options);
  sheetRequest = id;
  const dialog = $("#sheet-dialog");
  if (!dialog.open) {
    $("#sheet").innerHTML = `<article class="parchment sheet"><p class="loading">Opening ${esc(found.inc.name)}…</p></article>`;
    dialog.showModal();
  }
  try {
    await fullSheet(id);
  } catch (error) {
    notify(error.message, true);
    return;
  }
  if (sheetRequest === id) showSheet(id, options);
}

// "Forbidden school for your Wizard" on the sheet, for the classes of the page that forbid the spell's school
function sheetForbidden(inc, entry) {
  const classes = state.book?.all ? (entry ? entryClasses(entry) : state.character?.classes || []) : [classByKey(state.book?.class_key)].filter(Boolean);
  const forbidding = classes.filter((c) => forbiddenSchool(inc, c));
  if (!forbidding.length) return "";
  return `<p class="forbidden-note">${esc(forbiddenSchool(inc, forbidding[0]))} is a forbidden school for your ${esc(forbidding.map((c) => c.name).join(" and "))}: its spells can't be learned or prepared.</p>`;
}

function inheritedNote(inc, key) {
  const name = inc.inherited_from?.keys?.[key];
  return name ? ` <small class="inherited">from ${esc(name)}</small>` : "";
}

function showSheet(id, { from = null } = {}) {
  const found = findSpell(id);
  if (!found) return;
  const { entry } = found;
  const inc = (entry && fullSheetData.get(id)) || found.inc;
  const st = inc.stats || {};
  const bookClass = (state.book.all ? (state.character?.classes || []).map((c) => c.name).join(",") : state.book.caster_class || "").toLowerCase();
  const all = Boolean(state.book.all);
  const locked = !all && Boolean(state.book.unavailable);  // the open book is lost or stolen: read only
  const editable = inc.handwritten && (all ? entry?.available !== false : !locked);

  const levels = [
    ...(inc.levels || []).map((l) => {
      const current = bookClass.split(/[/,]/).map((c) => c.trim()).includes(l.caster_class.toLowerCase());
      return `<span class="${current ? "current" : ""}">${esc(l.caster_class)} ${l.level}</span>`;
    }),
    ...(inc.domains || []).map((d) => `<span>${esc(d.domain)} domain ${d.level}</span>`),
  ].join(", ");

  const description = formatDescription(inc.description_html || `<p>${esc(inc.summary)}</p>`);
  // "functions like X": the text of X (and of its own base, if any) below the description
  const bases = (inc.inherited_from?.chain || []).map(({ id: idBase, name }) => {
    const base = inc.linked?.find((c) => c.id === idBase) || findSpell(idBase)?.inc;
    return { id: idBase, name, text: base ? formatDescription(base.description_html || `<p>${esc(base.summary)}</p>`) : null };
  });
  const baseNotes = inc.inherited_from?.keys?.components
    ? bases.find((b) => b.name === inc.inherited_from.keys.components)?.text?.notes || [] : [];
  const componentsHtml = [
    (inc.components || []).map((c) => `<abbr title="${esc(COMPONENTS[c] || c)}">${esc(c)}</abbr>`).join(" ") + inheritedNote(inc, "components"),
    ...[...description.notes, ...baseNotes].map((n) => `<div class="component-note"><b>${esc(n.label)}:</b> ${n.html}</div>`),
  ].filter((part) => part.replace(/<small[^]*<\/small>/, "").trim()).join("");
  const data = [
    ...STATS.map(([key, label]) => [label, !st[key] ? ""
      : (key === "saving_throw" && entry ? esc(dcText(st[key], entry)) : esc(st[key])) + inheritedNote(inc, key)]),
    ["Components", componentsHtml],
    ["Scroll", entry ? scrollSummary(entry) : ""],
  ].filter(([, value]) => value);

  $("#sheet").innerHTML = `
    <article class="parchment sheet" style="--c:${schoolColor(inc)}">
      <button class="sheet-close" type="button" data-close aria-label="Close">×</button>
      <h2>${esc(inc.name)}</h2>
      <div class="school-line">${schoolLine(inc)}</div>
      ${sheetForbidden(inc, entry)}
      <div class="source">${esc(shortSource(inc))}${inc.edition_35 ? "" : " · not 3.5"}</div>
      ${levels ? `<p class="class-levels"><b>Level:</b> ${levels}</p>` : ""}
      <div class="sheet-body">
        <aside class="sheet-side">
          <dl class="stats-table">${data.map(([e, v]) => `<dt>${esc(e)}</dt><dd>${v}</dd>`).join("")}</dl>
        </aside>
        <div class="sheet-text">
          <div class="description" lang="en">${description.html}</div>
          ${bases.map((b) => `
            <section class="base-spell">
              <h3>Based on <button type="button" class="ref" data-ref="${esc(b.id)}">${esc(b.name)}</button></h3>
              ${b.text ? `<div class="description" lang="en">${b.text.html}</div>`
                : `<p class="appears">This spell was not downloaded: use “Refresh from dndtools”.</p>`}
            </section>`).join("")}
          ${inc.also_appears_in?.length ? `<p class="appears">Also appears in: ${esc(inc.also_appears_in.join(", "))}</p>` : ""}
        </div>
      </div>
      ${entry && all ? `
      <div class="sheet-actions">
        <span class="in-books">In ${entry.books.map((l) => `<a href="#/book/${esc(l.id)}" data-close>${esc(l.name)}</a> (${esc(classByKey(l.class)?.name || "")} level ${l.level}${
          l.available === false ? `, ${esc(unavailableLabel(bookSummary(l.id)) || "not available").toLowerCase()}` : ""})`).join(", ")}</span>
        <span class="spacer"></span>
        ${favoriteButton(inc)}
        ${from ? `<button class="button" type="button" data-ref="${esc(from)}">← Back</button>` : ""}
        ${inc.handwritten ? (editable ? `<button class="button" type="button" id="sheet-edit">Edit spell</button>` : "") : `
        <a class="button" href="${esc(inc.url)}" target="_blank" rel="noopener">dndtools ↗</a>
        <button class="button" type="button" id="sheet-refresh">Refresh from dndtools</button>`}
      </div>` : entry && locked ? `
      <div class="sheet-actions">
        <span class="not-in-book">“${esc(state.book.name)}” is ${esc(unavailableLabel(state.book).toLowerCase())}: it can't be changed.</span>
        <span class="spacer"></span>
        ${favoriteButton(inc)}
        ${from ? `<button class="button" type="button" data-ref="${esc(from)}">← Back</button>` : ""}
        ${inc.handwritten ? "" : `<a class="button" href="${esc(inc.url)}" target="_blank" rel="noopener">dndtools ↗</a>`}
      </div>` : entry ? `
      <div class="sheet-actions">
        <label>Level in this book
          <select id="sheet-level">${Array.from({ length: 10 }, (_, n) => `<option value="${n}" ${n === entry.level ? "selected" : ""}>${n}</option>`).join("")}</select>
        </label>
        <span class="spacer"></span>
        ${favoriteButton(inc)}
        ${from ? `<button class="button" type="button" data-ref="${esc(from)}">← Back</button>` : ""}
        ${inc.handwritten ? `<button class="button" type="button" id="sheet-edit">Edit spell</button>` : `
        <a class="button" href="${esc(inc.url)}" target="_blank" rel="noopener">dndtools ↗</a>
        <button class="button" type="button" id="sheet-refresh">Refresh from dndtools</button>`}
        <button class="button danger" type="button" id="sheet-remove">Remove</button>
      </div>` : `
      <div class="sheet-actions">
        <span class="not-in-book">Not in ${all ? "your spellbooks" : "this book"}</span>
        <span class="spacer"></span>
        ${from ? `<button class="button" type="button" data-ref="${esc(from)}">← Back</button>` : ""}
        <a class="button" href="${esc(inc.url)}" target="_blank" rel="noopener">dndtools ↗</a>
        ${$("#add-dialog").open || all || locked ? "" : `<button class="button gold" type="button" id="sheet-add">✚ Add to this book</button>`}
      </div>`}
    </article>`;

  const dialog = $("#sheet-dialog");
  $("#sheet").dataset.open = inc.id;
  if (!entry) {
    $("#sheet-add")?.addEventListener("click", () => {
      dialog.close();
      openAddDialog();
      $("#add-form").url.value = inc.url;
      loadPreview();
    });
    if (!dialog.open) dialog.showModal();
    dialog.querySelector(".parchment").scrollTop = 0;
    return;
  }
  $("#sheet-level")?.addEventListener("change", async (event) => {
    try {
      await api(`books/${state.book.id}/spells/${inc.id}`, { method: "PATCH", body: { level: Number(event.target.value) } });
      await reloadView();
      notify(`${inc.name} moved to level ${event.target.value}.`);
    } catch (error) { notify(error.message, true); }
  });
  $("#sheet-edit")?.addEventListener("click", () => {
    dialog.close();
    openHandwrittenDialog(inc);
  });
  $("#sheet-refresh")?.addEventListener("click", async (event) => {
    event.target.disabled = true;
    event.target.textContent = "Checking dndtools…";
    try {
      await api(`spells/${inc.id}/refresh`, { method: "POST" });
      await reloadView();
      openSheet(inc.id);
      notify(`${inc.name} refreshed from dndtools.`);
    } catch (error) {
      notify(error.message, true);
      event.target.disabled = false;
      event.target.textContent = "Refresh from dndtools";
    }
  });
  $("#sheet-remove")?.addEventListener("click", async () => {
    dialog.close();
    const book = state.book;
    // a server started before removed spells were kept would delete it for good
    if (!("removed" in book)) return notify(OUTDATED_SERVER, true);
    const answer = await askConfirm("Remove this spell?", `${inc.name} will be hidden from “${book.name}”. Its level, prepared copies, scrolls and favorite mark are kept: restore it from the book's Settings (or add it again) to bring them back.`, "Remove", {
      text: "Delete it for good",
      label: "Delete for good",
      warning: forgetWarning(inc.name, book.name),
    });
    if (answer === "option") return deleteForever(book.id, inc.id, inc.name).catch((error) => notify(error.message, true));
    if (!answer) return;
    try {
      await api(`books/${book.id}/spells/${inc.id}`, { method: "DELETE" });
      await reloadView();
      notify(`${inc.name} removed from the book.`, false, {
        label: "Undo",
        run: () => restoreSpell(book.id, inc.id).then(() => notify(`${inc.name} is back in the book.`), () => {}),
      });
    } catch (error) { notify(error.message, true); }
  });

  if (!dialog.open) dialog.showModal();
  dialog.querySelector(".parchment").scrollTop = 0;
}

// ---------- dialog: add a spell ----------
function openAddDialog() {
  const form = $("#add-form");
  form.reset();
  state.preview = null;
  $("#preview").hidden = true;
  $("#add-error").hidden = true;
  $("#confirm-add").disabled = true;
  $("#paste-link").hidden = !CAN_PASTE;
  $("#confirm-add").textContent = "Add to book";
  $("#add-dialog").showModal();
  if (!TOUCH) form.url.focus();  // on a phone the keyboard would cover half the dialog
}

async function pasteLink() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return notify("The clipboard is empty.", true);
    $("#add-form").url.value = text;
    loadPreview();
  } catch {
    notify("Couldn't read the clipboard: paste the link into the field instead.", true);
  }
}

// Links in the field: the field drops line breaks, so several pasted links are split where "http" starts
function linksIn(text) {
  return [...new Set(text.match(/https?:\/\/.*?(?=https?:\/\/|\s|$)/g) || [])];
}

async function loadPreview() {
  const form = $("#add-form");
  const url = form.url.value.trim();
  const error = $("#add-error");
  const preview = $("#preview");
  const links = linksIn(url);
  error.hidden = true;
  $("#confirm-add").disabled = true;
  $("#confirm-add").textContent = "Add to book";
  preview.hidden = false;
  if (links.length > 1) {
    state.preview = { urls: links };
    preview.innerHTML = `
      <div class="parchment">
        <h3>${links.length} links</h3>
        <p>Each spell is added at the level suggested for this book's class; spells removed from the book earlier come back at their old level. Spells already in the book and links that are not dndtools spells are skipped.</p>
      </div>`;
    $("#confirm-add").textContent = `Add ${links.length} spells`;
    $("#confirm-add").disabled = false;
    return;
  }
  preview.innerHTML = `<p class="loading">Checking dndtools…</p>`;
  $("#load-preview").disabled = true;
  try {
    const response = await api("preview", { method: "POST", body: { url, book: state.book.id } });
    state.preview = { ...response, url };
    renderPreview();
    if (TOUCH) form.url.blur();  // closes the keyboard to show the preview
  } catch (e) {
    preview.hidden = true;
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    $("#load-preview").disabled = false;
  }
}

function renderPreview() {
  const { spell: inc, suggested_level, level_from_class, level_source, already_in_book, removed_from_book } = state.preview;
  const level = removed_from_book ? removed_from_book.level : suggested_level;
  const levels = [
    ...(inc.levels || []).map((l) => `${esc(l.caster_class)} ${l.level}`),
    ...(inc.domains || []).map((d) => `${esc(d.domain)} domain ${d.level}`),
  ].join(", ");

  $("#preview").innerHTML = `
    <div class="parchment" style="--c:${schoolColor(inc)}">
      <h3>${esc(inc.name)}</h3>
      <div class="school-line">${schoolLine(inc)}</div>
      <div class="class-levels">${levels ? `Level: ${levels}` : "No level listed on dndtools"} · ${esc(shortSource(inc))}</div>
      <p class="summary" style="-webkit-line-clamp:5">${esc(inc.summary)}</p>
      ${inc.inherited_from ? `<p class="base-note">Works like <button type="button" class="ref" data-ref-preview="${esc(inc.inherited_from.chain[0].id)}">${esc(inc.inherited_from.chain[0].name)}</button>, downloaded too: its casting time, range, duration, save and components are shown for this spell.</p>` : ""}
      <div class="level-choice">
        <label for="add-level">Level in this book</label>
        <select id="add-level">${Array.from({ length: 10 }, (_, n) => `<option value="${n}" ${n === level ? "selected" : ""}>${n === 0 ? levelZeroOption() : `Level ${n}`}</option>`).join("")}</select>
      </div>
      ${removed_from_book ? `<p class="base-note">You removed this spell from the book on ${esc(shortDate(removed_from_book.removed_at))}: adding it again brings back its prepared copies, scrolls and favorite mark. Its old level is selected.</p>` : ""}
      ${level_from_class || removed_from_book ? "" : `<p class="parchment-warning">This spell has no ${esc(state.book.caster_class || "Wizard")} level, so ${
        level_source && level_source !== "lowest" ? `the ${esc(level_source)} level` : "the lowest listed level"} is suggested: check it before adding.</p>`}
      ${already_in_book ? `<p class="parchment-warning">Already in this book.</p>` : ""}
      ${forbiddenSchool(inc, classByKey(state.book.class_key)) ? `<p class="parchment-warning">${esc(forbiddenSchool(inc, classByKey(state.book.class_key)))} is a forbidden school for your ${esc(state.book.caster_class)}: you can add it, but it can't be prepared.</p>` : ""}
      ${inc.edition_35 ? "" : `<p class="parchment-warning">Warning: this page comes from a rulebook that is not 3.5.</p>`}
    </div>`;
  $("#confirm-add").disabled = Boolean(already_in_book);
  $("#confirm-add").textContent = removed_from_book ? "Add again" : "Add to book";
}

async function confirmAdd() {
  if (!state.preview) return;
  const button = $("#confirm-add");
  button.disabled = true;
  if (state.preview.urls) {
    try {
      const done = await importSpells(state.preview.urls, $("#preview"));
      if (done.shown) notify(`${plural((done.added || []).length, "spell")} added to “${done.book_name}”.`);
      state.preview = null;
    } catch (error) {
      $("#add-error").textContent = error.message;
      $("#add-error").hidden = false;
      button.disabled = false;
    }
    return;
  }
  try {
    const level = Number($("#add-level").value);
    await api(`books/${state.book.id}/spells`, { method: "POST", body: { url: state.preview.url, level } });
    $("#add-dialog").close();
    await reloadView();
    notify(`${state.preview.spell.name} ${state.preview.removed_from_book ? "is back in" : "added to"} the book.`);
    document.getElementById(`level-${level}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    $("#add-error").textContent = error.message;
    $("#add-error").hidden = false;
    button.disabled = false;
  }
}

// ---------- background work: dndtools searches and imports ----------
// Searches and imports run on the server. The job panel (#job-dock) lists them (GET /api/jobs) with their progress
// whatever page or dialog is open, and after a reload too; a finished one stays, with its result, until it is closed.
const DISMISSED_KEY = "grimoire-dismissed-jobs";
const jobs = {
  list: new Map(),      // id -> summary from GET /api/jobs
  watchers: new Map(),  // id -> {resolve, reject, onProgress, box}: a dialog waiting for the result
  timer: null, polling: false, again: false, failures: 0,
  round: 0,  // job lists asked so far
  listed: false,  // a first list arrived: jobs missing from it and finished in a later one have just ended
  seenRunning: new Set(),  // jobs this page saw running: listed when they end, however long ago they started
  minimized: (() => { try { return localStorage.getItem("grimoire-jobs-minimized") === "1"; } catch { return false; } })(),
  dismissed: (() => { try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY)) || []); } catch { return new Set(); } })(),
};

function dismissJob(id) {
  if (id) jobs.dismissed.add(id);
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...jobs.dismissed].slice(-60))); } catch { /* storage blocked */ }
  renderDock();
}

// true when the element is on screen (not in a closed dialog)
function onScreen(element) {
  return Boolean(element?.isConnected && element.getClientRects().length);
}

// Follows a job started by this page: onProgress(summary) while it runs; resolves with the whole job when it ends
// (`shown`: its result was on screen in `box`, so the panel doesn't list it), rejects if it failed.
function watchJob(job, { box = null, onProgress = () => {} } = {}) {
  jobs.list.set(job.id, { ...job, counts: {} });
  jobs.seenRunning.add(job.id);
  // round: a list asked before this job existed doesn't have it yet, so only a later one can say it is gone
  const done = new Promise((resolve, reject) => jobs.watchers.set(job.id, { resolve, reject, onProgress, box, round: jobs.round }));
  pollJobs();
  return done;
}

function pollJobs(delay = 0) {
  clearTimeout(jobs.timer);
  jobs.timer = setTimeout(checkJobs, delay);
}

async function checkJobs() {
  if (jobs.polling) {
    jobs.again = true;
    return;
  }
  jobs.polling = true;
  const round = ++jobs.round;
  let list = null;
  try {
    list = await api("jobs");
    jobs.failures = 0;
  } catch {
    jobs.failures += 1;
  }
  if (list) {
    const now = new Map(list.map((job) => [job.id, job]));
    for (const [id, watcher] of jobs.watchers) {
      if (now.has(id)) continue;
      if (watcher.round < round) {  // the server was restarted: the job is gone
        jobs.watchers.delete(id);
        watcher.reject(new Error("This search or import stopped: the server was restarted."));
      } else if (jobs.list.has(id)) {
        now.set(id, jobs.list.get(id));
      }
    }
    const endings = [];
    for (const job of list) {
      const before = jobs.list.get(job.id);
      const watcher = jobs.watchers.get(job.id);
      if (!job.finished) watcher?.onProgress(job);
      // (a quick job started on another device can start and end between two lists)
      else if (watcher || (before ? !before.finished : jobs.listed)) endings.push(job);
    }
    jobs.list = now;
    for (const job of list) if (!job.finished) jobs.seenRunning.add(job.id);
    jobs.listed = true;
    await Promise.all(endings.map(jobEnded));
  }
  renderDock();
  jobs.polling = false;
  const running = [...jobs.list.values()].some((job) => !job.finished) || jobs.watchers.size;
  // quick while something runs; otherwise now and then, for jobs started on another device
  const delay = running ? (jobs.failures ? 2000 : 700) : 8000;
  if (jobs.again) {
    jobs.again = false;
    pollJobs();
  } else if (running || !document.hidden) {
    pollJobs(delay);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollJobs();
});

async function jobEnded(summary) {
  const watcher = jobs.watchers.get(summary.id);
  jobs.watchers.delete(summary.id);
  let job = summary;
  if (watcher) {
    try {
      job = await api(`jobs/${encodeURIComponent(summary.id)}`);
    } catch (error) {
      watcher.reject(error);
      return;
    }
  }
  const shown = onScreen(watcher?.box);
  if (shown) {
    jobs.dismissed.add(job.id);  // its result is in the open dialog
  } else {
    const action = jobAction(summary);
    notify(`${jobTitle(summary)}: ${jobResult(summary)}`, Boolean(summary.error), action && { label: action.label, run: action.run });
    if (!watcher) await refreshAfterJob(summary);
  }
  if (!watcher) return;
  if (job.error) watcher.reject(new Error(job.error));
  else watcher.resolve({ ...job, shown });
}

// After an import, the page is reloaded if it shows that book, its character or the library
async function refreshAfterJob(job) {
  if (job.kind !== "import" || !job.added && !job.counts?.added) return;
  const [, page, id] = location.hash.split("/");
  const shown = page === "book" ? decodeURIComponent(id || "") === job.book
    : page === "character" ? decodeURIComponent(id || "") === job.character : true;
  if (shown) await route().catch((error) => notify(error.message, true));
}

function searchDescription(filters = {}) {
  const pretty = (slug) => String(slug).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const parts = [];
  if (filters.class_levels__slug) parts.push(`${pretty(filters.class_levels__slug)} ${(filters.spellclasslevel__level || []).join(", ")}`.trim());
  if (filters.domain_levels__slug) parts.push(`${pretty(filters.domain_levels__slug)} domain ${(filters.spelldomainlevel__level || []).join(", ")}`.trim());
  if (filters.school__slug) parts.push(pretty(filters.school__slug));
  if (filters.name) parts.push(`“${filters.name}”`);
  return parts.join(" · ");
}

function jobTitle(job) {
  const book = `“${job.book_name || "the book"}”`;
  if (job.kind === "import") {
    if (!job.finished) return job.cancelled ? `Stopping: adding to ${book}` : `Adding spells to ${book}`;
    return job.error ? `Adding to ${book} failed` : job.cancelled ? `Stopped adding to ${book}` : `Finished adding to ${book}`;
  }
  if (!job.finished) return job.cancelled ? "Stopping the dndtools search" : "Searching dndtools";
  return job.error ? "dndtools search failed" : job.stopped || job.cancelled ? "dndtools search stopped" : "dndtools search finished";
}


// "about 2 min left", from the pace so far (the server's estimate)
function timeLeft(job) {
  if (job.finished || job.cancelled || !job.total) return "";
  const s = job.remaining;
  if (s === null || s === undefined) return "working out the time left…";
  if (s < 10) return "a few seconds left";
  if (s < 60) return `about ${Math.max(10, Math.round(s / 5) * 5)} s left`;
  if (s < 600) {
    let minutes = Math.floor(s / 60);
    let seconds = Math.round((s % 60) / 10) * 10;
    if (seconds === 60) [minutes, seconds] = [minutes + 1, 0];
    return `about ${minutes} min${seconds ? ` ${seconds} s` : ""} left`;
  }
  if (s < 3600) return `about ${Math.round(s / 60)} min left`;
  const minutes = Math.round((s % 3600) / 60);
  return `about ${Math.floor(s / 3600)} h${minutes ? ` ${minutes} min` : ""} left`;
}

function jobResult(job) {
  const counts = job.counts || {};
  if (!job.finished) {
    if (!job.total) return "Starting…";
    const left = timeLeft(job);
    return `${job.done} of ${job.total} ${job.kind === "import" ? "spells" : "pages"}${left ? ` · ${left}` : ""}`;
  }
  if (job.error) return job.error;
  if (job.kind === "import") {
    return [`${plural(counts.added || 0, "spell")} added`, counts.skipped && `${counts.skipped} already there`,
      counts.failed && `${counts.failed} not added`].filter(Boolean).join(", ") + ".";
  }
  return `${plural(counts.results || 0, "spell")} found${job.incomplete ? " (some pages could not be loaded)" : ""}.`;
}

// "Open book" for an import, "Show results" for a search: null when there is nothing to open from here
function jobAction(job) {
  if (!job.finished || job.error) return null;
  if (job.kind === "import") {
    if (!job.book || location.hash === `#/book/${encodeURIComponent(job.book)}`) return null;
    return { label: "Open book", run: () => { location.hash = `#/book/${encodeURIComponent(job.book)}`; } };
  }
  // the results are added to the open book, so they are shown on a book page
  if (!/^#\/book\//.test(location.hash) || !state.book?.id || state.book.unavailable) return null;
  return { label: "Show results", run: () => showSearchResults(job.id) };
}

async function showSearchResults(id) {
  if (finder.jobId === id) return openFinder();
  let job;
  try {
    job = await api(`jobs/${encodeURIComponent(id)}`);
  } catch (error) {
    notify(error.message, true);
    return;
  }
  await openFinder();
  if (!finder.options || finder.busy) return;
  applySearch(job, job.filters || {});
  finder.summary = "";
  renderFinderResults();
}

// ---- the panel ----
const dock = $("#job-dock");

// jobs that ended long before the page was opened are old news: only the recent ones are listed
const PAGE_OPENED = Date.now();
const RECENT = 10 * 60 * 1000;

function dockJobs() {
  return [...jobs.list.values()]
    .filter((job) => !jobs.dismissed.has(job.id) && !onScreen(jobs.watchers.get(job.id)?.box))
    .filter((job) => !job.finished || jobs.seenRunning.has(job.id) || PAGE_OPENED - Date.parse(job.finished_at) < RECENT)
    .sort((a, b) => (a.finished - b.finished) || String(b.started_at).localeCompare(String(a.started_at)))
    .slice(0, 3);
}

function renderDock() {
  const shown = dockJobs();
  dock.hidden = !shown.length;
  if (!shown.length) {
    dockSpace();
    return;
  }
  const running = shown.filter((job) => !job.finished);
  if (!dock.firstElementChild) {
    dock.innerHTML = `<div class="dock-head"><button type="button" class="dock-toggle"></button>
      <button type="button" class="dock-clear" data-clear-jobs>Clear</button></div><div class="dock-list"></div>`;
  }
  const toggle = dock.querySelector(".dock-toggle");
  const done = running.reduce((sum, job) => sum + job.done, 0);
  const total = running.reduce((sum, job) => sum + job.total, 0);
  toggle.textContent = running.length
    ? `${jobs.minimized ? "⟳ " : ""}${running.length} running${total ? ` · ${Math.floor((done / total) * 100)}%` : ""}`
    : `${plural(shown.length, "download")} finished`;
  toggle.setAttribute("aria-expanded", String(!jobs.minimized));
  toggle.title = jobs.minimized ? "Show the downloads" : "Hide the downloads";
  dock.classList.toggle("minimized", jobs.minimized);
  const clear = dock.querySelector("[data-clear-jobs]");
  clear.hidden = jobs.minimized || shown.length - running.length < 2;
  clear.title = "Close the finished downloads";
  const list = dock.querySelector(".dock-list");
  const cards = new Map([...list.children].map((card) => [card.dataset.job, card]));
  shown.forEach((job, index) => {
    const card = cards.get(job.id) || jobCard(job);
    cards.delete(job.id);
    updateJobCard(card, job);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  });
  for (const card of cards.values()) card.remove();
  dockSpace();
}

function jobCard(job) {
  const card = document.createElement("div");
  card.className = "job-card";
  card.dataset.job = job.id;
  card.innerHTML = `
    <div class="job-card-head"><b class="job-title"></b>
      <button type="button" class="button compact" data-stop-job="${esc(job.id)}">Stop</button>
      <button type="button" class="button compact" data-job-action="${esc(job.id)}"></button>
      <button type="button" class="job-dismiss" data-dismiss-job="${esc(job.id)}" aria-label="Close" title="Close">×</button></div>
    <p class="job-detail"></p>
    <div class="page-bar"><span></span></div>
    <p class="job-text" role="status"></p>`;
  return card;
}

function updateJobCard(card, job) {
  const failed = Boolean(job.error) || (job.finished && job.counts?.failed > 0);
  card.classList.toggle("done", job.finished && !failed);
  card.classList.toggle("failed", failed);
  card.querySelector(".job-title").textContent = jobTitle(job);
  const detail = job.kind === "search" ? searchDescription(job.filters) : "";
  card.querySelector(".job-detail").textContent = detail;
  card.querySelector(".job-detail").hidden = !detail;
  const bar = card.querySelector(".page-bar");
  bar.hidden = job.finished;
  bar.firstElementChild.style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 0}%`;
  card.querySelector(".job-text").textContent = jobResult(job);
  const stop = card.querySelector("[data-stop-job]");
  stop.hidden = job.finished;
  if (job.cancelled && !stop.disabled) {
    stop.disabled = true;
    stop.textContent = "Stopping…";
  }
  card.querySelector("[data-dismiss-job]").hidden = !job.finished;
  const action = jobAction(job);
  const button = card.querySelector("[data-job-action]");
  button.hidden = !action;
  if (action) button.textContent = action.label;
}

// Room kept free for the panel: messages and the "top" button go above it, dialogs end above it
function dockSpace() {
  // height + distance from the bottom edge (not the position on screen: it moves while the panel slides in)
  const space = dock.hidden ? 0 : Math.ceil(dock.offsetHeight + parseFloat(getComputedStyle(dock).bottom) + 6);
  document.documentElement.style.setProperty("--dock-space", `${Math.max(0, space)}px`);
}
window.addEventListener("resize", dockSpace);
new ResizeObserver(dockSpace).observe(dock);

dock.addEventListener("click", (event) => {
  if (event.target.closest(".dock-toggle")) {
    jobs.minimized = !jobs.minimized;
    try { localStorage.setItem("grimoire-jobs-minimized", jobs.minimized ? "1" : "0"); } catch { /* storage blocked */ }
    renderDock();
    return;
  }
  const dismiss = event.target.closest("[data-dismiss-job]");
  if (dismiss) return dismissJob(dismiss.dataset.dismissJob);
  if (event.target.closest("[data-clear-jobs]")) {
    for (const job of dockJobs()) if (job.finished) jobs.dismissed.add(job.id);
    return dismissJob(null);
  }
  const button = event.target.closest("[data-job-action]");
  const job = button && jobs.list.get(button.dataset.jobAction);
  const action = job && jobAction(job);
  if (!action) return;
  dismissJob(job.id);  // it has been looked at
  action.run();
});
window.addEventListener("hashchange", () => renderDock());

// A modal dialog makes the rest of the page unreachable: the panel and the messages move into the open dialog
// (the last one opened), and back to the page when it closes.
const openDialogs = [];
function placeOverlays() {
  const host = openDialogs.at(-1) || document.body;
  if (dock.parentElement !== host) {
    host.append(dock);
    dock.classList.add("moved");  // no slide-in again: it was already on screen
  }
  if ($("#toasts").parentElement !== host) host.append($("#toasts"));
  renderDock();  // a closed dialog may have been showing a job's progress
}
new MutationObserver((records) => {
  for (const { target } of records) {
    if (target.tagName !== "DIALOG") continue;
    const index = openDialogs.indexOf(target);
    if (index >= 0) openDialogs.splice(index, 1);
    if (target.open && target.matches(":modal")) openDialogs.push(target);
  }
  // while a dialog is still sliding in, fixed children would move with it: wait until it stands still
  // (its style is computed first: the opening animation doesn't exist before that)
  const host = openDialogs.at(-1);
  if (host) getComputedStyle(host).animationName;
  const moving = host?.getAnimations?.() || [];
  if (moving.length) Promise.all(moving.map((a) => a.finished.catch(() => {}))).then(placeOverlays);
  else placeOverlays();
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });

// Progress of a search or an import in `box`, with "Stop"; the box is built once, then only text and bar change
// (so a click on "Stop" is never lost to a redraw)
function showProgress(box, text, done = 0, total = 0, jobId = null) {
  let progress = box.querySelector(".job-progress");
  if (!progress) {
    box.innerHTML = `<div class="job-progress" role="status">
      <div class="job-line"><p class="loading"></p><button type="button" class="button compact" data-stop-job hidden>Stop</button></div>
      <div class="page-bar"><span></span></div></div>`;
    progress = box.querySelector(".job-progress");
  }
  progress.querySelector(".loading").textContent = text;
  progress.querySelector(".page-bar span").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  const stop = progress.querySelector("[data-stop-job]");
  if (jobId) {
    stop.dataset.stopJob = jobId;
    stop.hidden = false;
  }
}

document.addEventListener("click", async (event) => {
  const stop = event.target.closest("[data-stop-job]");
  if (!stop?.dataset.stopJob) return;
  stop.disabled = true;
  stop.textContent = "Stopping…";
  try {
    await api(`jobs/${encodeURIComponent(stop.dataset.stopJob)}/cancel`, { method: "POST", body: {} });
  } catch (error) {
    notify(error.message, true);
  }
});

function importSummary(job, names = new Map()) {
  const added = job.added || [];
  const skipped = job.skipped || [];
  const failed = job.failed || [];
  const guessed = added.filter((a) => !a.from_class);
  const restored = added.filter((a) => a.restored).length;
  return `
    <div class="import-summary" role="status">
      <p><b>${added.length} spell${added.length === 1 ? "" : "s"} added</b>${restored ? ` (${restored} removed earlier and now back)` : ""} to “${esc(job.book_name || state.book.name)}”${
        skipped.length ? `, ${skipped.length} already there` : ""}${failed.length ? `, ${failed.length} not added` : ""}.</p>
      ${guessed.length ? `<p>No ${esc(job.caster_class || state.book.caster_class || "Wizard")} level for ${guessed.map((a) => `${esc(a.name)} (${
        a.source && a.source !== "lowest" ? `${esc(a.source)} level` : "lowest level"} ${a.level})`).join(", ")}: check them on the spell sheet.</p>` : ""}
      ${job.cancelled ? `<p>Stopped: the spells that were still to download were not added.</p>` : ""}
      ${failed.length ? `<ul class="import-failed">${failed.map((f) => `<li>${esc(names.get(f.id) || f.url)}: ${esc(f.error)}</li>`).join("")}</ul>` : ""}
    </div>`;
}

// Adds the spells to the open book in the background: the progress, then the summary, go in `box`
async function importSpells(urls, box, names = new Map()) {
  box.innerHTML = "";
  showProgress(box, "Adding spells…", 0, urls.length);
  const job = await api(`books/${encodeURIComponent(state.book.id)}/import`, { method: "POST", body: { urls } });
  showProgress(box, "Adding spells…", 0, urls.length, job.id);
  const done = await watchJob(job, { box, onProgress: (j) => {
    const left = timeLeft(j);
    showProgress(box, j.cancelled ? `Stopping… ${j.done} of ${j.total}` : `Adding spells… ${j.done} of ${j.total}${left ? ` · ${left}` : ""}`, j.done, j.total);
  } });
  await refreshAfterJob(done);
  box.innerHTML = importSummary(done, names);
  return done;
}

// ---------- dialog: search dndtools ----------
// The filters of the dndtools search form (loaded once), results picked with checkboxes and added to the open book.
const FINDER_COMPONENTS = [["verbal_component", "Verbal (V)"], ["somatic_component", "Somatic (S)"],
  ["material_component", "Material (M)"], ["arcane_focus_component", "Arcane focus (F)"],
  ["divine_focus_component", "Divine focus (DF)"], ["xp_component", "XP cost"]];
const FINDER_TEXTS = [["casting_time", "Casting time"], ["range", "Range"], ["area", "Area"], ["duration", "Duration"],
  ["saving_throw", "Saving throw"], ["spell_resistance", "Spell resistance"], ["description", "Description contains"]];
const FINDER_MULTI = ["spellclasslevel__level", "spelldomainlevel__level", "rulebook__dnd_edition__slug"];
const finder = {
  options: null, results: [], selected: new Set(), searched: false, stopped: false, incomplete: false, busy: false, summary: "",
  jobId: null,
};

async function openFinder() {
  $("#finder-dialog").showModal();
  if (finder.options) {
    finder.summary = "";
    renderFinderResults();  // the open book may be a different one
    return;
  }
  $("#finder").innerHTML = `<h2>Search dndtools</h2><p class="loading">Loading the dndtools filters…</p>`;
  try {
    finder.options = await api("dndtools/filters");
  } catch (error) {
    $("#finder").innerHTML = `<h2>Search dndtools</h2>
      <p class="form-error">${esc(error.message === "Unknown path." ? OUTDATED_SERVER : error.message)}</p>
      <div class="form-actions"><span class="spacer"></span><button type="button" class="button ghost" data-close>Close</button></div>`;
    return;
  }
  renderFinderForm();
}

function finderSelect(name, label) {
  const groups = new Map();
  for (const option of finder.options[name] || []) {
    if (!groups.has(option.group || "")) groups.set(option.group || "", []);
    groups.get(option.group || "").push(option);
  }
  const options = [...groups].map(([group, list]) => {
    const html = list.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
    return group ? `<optgroup label="${esc(group)}">${html}</optgroup>` : html;
  }).join("");
  return `<label>${label}<select name="${name}"><option value="">Any</option>${options}</select></label>`;
}

function finderChips(name, legend, choices) {
  return `<fieldset class="component-choices"><legend>${legend}</legend><div>${choices.map((c) =>
    `<label><input type="checkbox" name="${name}" value="${esc(c.value)}"> ${esc(c.label)}</label>`).join("")}</div></fieldset>`;
}

function renderFinderForm() {
  const levels = Array.from({ length: 10 }, (_, n) => ({ value: String(n), label: String(n) }));
  $("#finder").innerHTML = `
    <h2>Search dndtools</h2>
    <p class="help">The filters of <a href="https://dndtools.net/spells/" target="_blank" rel="noopener">dndtools.net/spells</a>.
      Tick the spells you want, or all of them, and add them to the book.</p>
    <form id="finder-form" class="finder-form">
      <div class="field-row three">
        <label>Name contains <input name="name" type="search" autocomplete="off"></label>
        ${finderSelect("class_levels__slug", "Class")}
        ${finderSelect("school__slug", "School")}
      </div>
      ${finderChips("spellclasslevel__level", "Spell level (for the class above)", levels)}
      ${finderChips("rulebook__dnd_edition__slug", "Editions", finder.options.rulebook__dnd_edition__slug || [])}
      ${finderSelect("rulebook__slug", "Rulebook")}
      <details class="finder-more">
        <summary>More filters</summary>
        <div class="field-row three">
          ${finderSelect("sub_school__slug", "Subschool")}
          ${finderSelect("descriptors__slug", "Descriptor")}
          ${finderSelect("domain_levels__slug", "Domain")}
        </div>
        ${finderChips("spelldomainlevel__level", "Spell level (for the domain above)", levels)}
        <div class="field-row three">${FINDER_COMPONENTS.map(([name, label]) => `<label>${label}<select name="${name}">
          <option value="">Any</option><option value="2">Yes</option><option value="3">No</option></select></label>`).join("")}</div>
        <div class="field-row three">${FINDER_TEXTS.map(([name, label]) =>
          `<label>${label}<input name="${name}" autocomplete="off"></label>`).join("")}</div>
      </details>
      <div class="form-actions">
        <button type="button" class="button ghost" id="finder-reset">Reset filters</button>
        <span class="spacer"></span>
        <button type="button" class="button ghost" data-close>Close</button>
        <button type="submit" class="button gold" id="finder-go">🔍 Search</button>
      </div>
    </form>
    <div id="finder-results" class="finder-results"></div>`;
  resetFinderForm();
}

// Defaults: the book's class and the 3.5 editions
function resetFinderForm() {
  const form = $("#finder-form");
  form.reset();
  const bookClass = (state.book?.caster_class || "").split(/[/,]/)[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if ((finder.options.class_levels__slug || []).some((o) => o.value === bookClass)) {
    form.elements.class_levels__slug.value = bookClass;
  }
  const editions = new Map((finder.options.rulebook__dnd_edition__slug || []).map((o) => [o.value, o.label]));
  for (const box of form.querySelectorAll('[name="rulebook__dnd_edition__slug"]')) {
    box.checked = /\(3\.5\)/.test(editions.get(box.value) || "");
  }
}

function finderFilters() {
  const filters = {};
  for (const [key, value] of new FormData($("#finder-form"))) {
    if (!value) continue;
    if (FINDER_MULTI.includes(key)) (filters[key] ||= []).push(value);
    else filters[key] = value;
  }
  return filters;
}

function optionLabel(name, value) {
  return (finder.options[name] || []).find((o) => o.value === value)?.label || "";
}

async function runFinder(event) {
  event.preventDefault();
  if (finder.busy) return;
  const filters = finderFilters();
  const out = $("#finder-results");
  finder.busy = true;
  finder.summary = "";
  $("#finder-go").disabled = true;
  out.innerHTML = "";
  showProgress(out, "Searching dndtools…");
  try {
    const job = await api("dndtools/search", { method: "POST", body: { filters } });
    showProgress(out, "Searching dndtools…", 0, 0, job.id);
    const done = await watchJob(job, { box: out, onProgress: (j) => {
      const left = timeLeft(j);
      showProgress(out, `${j.cancelled ? "Stopping" : "Searching dndtools"}… ${j.done} of ${j.total} pages${left ? ` · ${left}` : ""}`, j.done, j.total);
    } });
    applySearch(done, filters);
  } catch (error) {
    out.innerHTML = `<p class="form-error">${esc(error.message === "Unknown path." ? OUTDATED_SERVER : error.message)}</p>`;
    return;
  } finally {
    finder.busy = false;
    $("#finder-go").disabled = false;
  }
  renderFinderResults();
  out.scrollIntoView({ block: "start", behavior: "smooth" });
}

function applySearch(job, filters) {
  Object.assign(finder, {
    jobId: job.id, results: job.results || [], searched: true, stopped: job.stopped, incomplete: job.incomplete,
    className: optionLabel("class_levels__slug", filters.class_levels__slug),
    domainName: optionLabel("domain_levels__slug", filters.domain_levels__slug),
  });
  finder.selected.clear();
}

function finderInBook() {
  return new Set((state.book?.spells || []).map((v) => v.spell.id));
}

function renderFinderResults() {
  const out = $("#finder-results");
  if (!out) return;
  const inBook = finderInBook();
  for (const id of [...finder.selected]) if (inBook.has(id)) finder.selected.delete(id);
  const editions = new Map((finder.options.rulebook__dnd_edition__slug || []).map((o) => [o.value, o.label]));
  const rows = finder.results.map((r) => {
    const owned = inBook.has(r.id);
    const level = r.level !== undefined ? `${finder.className} ${r.level}`
      : r.domain_level !== undefined ? `${finder.domainName} domain ${r.domain_level}` : "";
    const source = `${r.rulebook}${editions.has(r.edition) ? ` (${editions.get(r.edition)})` : ""}`;
    const meta = [level, r.school, source, r.components.join(" "), r.casting_time, r.range, r.duration].filter(Boolean);
    const bookClass = classByKey(state.book?.class_key);
    const banned = (bookClass?.forbidden_schools || []).find((name) => (r.schools || []).includes(name.toLowerCase()));
    return `
      <li><label class="finder-row ${owned ? "in-book" : ""}">
        <input type="checkbox" data-pick="${esc(r.id)}" ${owned ? "disabled" : finder.selected.has(r.id) ? "checked" : ""}>
        <span class="finder-info">
          <span class="finder-name"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>${owned ? ` <span class="finder-tag">in this book</span>` : ""}${
            banned ? ` <span class="finder-tag forbidden-tag" title="${esc(banned)} is a forbidden school for your ${esc(bookClass.name)}">forbidden school</span>` : ""}</span>
          <span class="finder-meta">${meta.map(esc).join(" · ")}</span>
        </span>
      </label></li>`;
  }).join("");
  out.innerHTML = `
    ${finder.summary}
    ${!finder.results.length ? (finder.searched ? `<p class="finder-none">No spells match these filters.</p>` : "") : `
    <div class="finder-bar">
      <label class="finder-all"><input type="checkbox" id="finder-all"> Select all</label>
      <span class="finder-count" id="finder-count"></span>
      <span class="spacer"></span>
      <button type="button" class="button gold" id="finder-add" disabled>✚ Add to the book</button>
    </div>
    ${finder.stopped ? `<p class="parchment-warning">Search stopped: only the spells found until then are listed.</p>` : ""}
    ${finder.incomplete ? `<p class="parchment-warning">Some result pages could not be loaded from dndtools: search again to complete the list.</p>` : ""}
    <ul class="finder-list">${rows}</ul>`}`;
  updateFinderSelection();
}

function updateFinderSelection() {
  const all = $("#finder-all");
  if (!all) return;
  const inBook = finderInBook();
  const owned = finder.results.filter((r) => inBook.has(r.id)).length;
  const free = finder.results.length - owned;
  const count = finder.selected.size;
  all.disabled = !free;
  all.checked = free > 0 && count === free;
  all.indeterminate = count > 0 && count < free;
  $("#finder-count").textContent = `${finder.results.length} found${owned ? ` · ${owned} already in the book` : ""} · ${count} selected`;
  const add = $("#finder-add");
  add.disabled = !count || finder.busy;
  add.textContent = count ? `✚ Add ${count} spell${count === 1 ? "" : "s"} to the book` : "✚ Add to the book";
}

async function importFinderSelection() {
  const urls = finder.results.filter((r) => finder.selected.has(r.id)).map((r) => r.url);
  if (!urls.length || finder.busy) return;
  finder.busy = true;
  updateFinderSelection();
  const box = document.createElement("div");
  $("#finder-results").prepend(box);
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  try {
    const done = await importSpells(urls, box, new Map(finder.results.map((r) => [r.id, r.name])));
    finder.summary = box.innerHTML;
    finder.selected.clear();
    if (done.shown) notify(`${plural((done.added || []).length, "spell")} added to “${done.book_name}”.`);
  } catch (error) {
    finder.summary = `<p class="form-error">${esc(error.message)}</p>`;
  } finally {
    finder.busy = false;
    renderFinderResults();
  }
}

// ---------- dialog: connect a device ----------
// QR code with the server address on the home network: the phone must be on the same Wi-Fi.
async function openConnect() {
  $("#connect").innerHTML = `<h2>Connect a device</h2><p class="loading">Checking the network…</p>`;
  $("#connect-dialog").showModal();
  try {
    renderConnect(await api("network"));
  } catch (error) {
    renderConnect(null, error.message === "Unknown path." ? OUTDATED_SERVER : error.message);
  }
}

function renderConnect(network, error = "") {
  let body;
  if (error) {
    body = `<p class="form-error">${esc(error)}</p>
      <div class="form-actions"><span class="spacer"></span><button type="button" class="button ghost" data-close>Close</button></div>`;
  } else if (!network.connected) {
    body = `<p>This computer doesn't seem to be connected to a local network. Connect it to your Wi-Fi and try again.</p>
      <div class="form-actions"><span class="spacer"></span><button type="button" class="button ghost" data-close>Close</button></div>`;
  } else if (!network.active) {
    body = `
      <p>Right now the grimoire only answers this computer. You can let phones and tablets on the same Wi-Fi open it, until <code>server.py</code> is stopped.</p>
      <p class="network-warning">There is no password: anyone on this network will be able to open and edit your books.</p>
      <div class="form-actions">
        <span class="spacer"></span>
        <button type="button" class="button ghost" data-close>Cancel</button>
        <button type="button" class="button gold" id="open-network">Allow devices on this Wi-Fi</button>
      </div>`;
  } else {
    // same book and same tab on the phone ("#/book/…"), but not the level jumps ("#level-3")
    const hash = location.hash.startsWith("#/") ? location.hash : "";
    // the QR code opens the computer's IP (every phone can); the page title is "my-grimoire"
    const link = (network.ip_address || network.address) + hash;
    const byName = network.name ? `http://${network.name}:${network.port}/${hash}` : "";
    body = `
      <p class="help">Scan it with the phone's camera: the phone must be on the same Wi-Fi as this computer.</p>
      <div class="qr">${qrSvg(link)}</div>
      <details class="network-type">
        <summary>Typing the address by hand?</summary>
        <p><code>${esc(link)}</code></p>
        ${byName ? `<p>On an iPhone, a Mac or a computer this works too: <code>${esc(byName)}</code></p>` : ""}
      </details>
      <p class="network-note">It opens this same page, and works only on your home network, never from the internet. If it doesn't load, check that the phone
        isn't on mobile data or on a guest Wi-Fi, and that the router doesn't keep Wi-Fi devices apart (“AP isolation”).
        ${network.always ? "" : "Network access stays open until server.py is stopped."} There is no password: anyone on this network can edit your books.</p>
      <div class="form-actions"><span class="spacer"></span><button type="button" class="button gold" data-close>Done</button></div>`;
  }
  $("#connect").innerHTML = `<h2>Connect a device</h2>${body}`;
}

async function openNetwork(button) {
  button.disabled = true;
  button.textContent = "Opening…";
  try {
    renderConnect(await api("network", { method: "POST", body: {} }));
  } catch (error) {
    renderConnect(null, error.message);
  }
}

// ---------- dialog: hand-written spell ----------
const HANDWRITTEN_FIELDS = ["name", "school", "casting_time", "range", "target", "area", "effect",
  "duration", "saving_throw", "spell_resistance", "rulebook", "page"];
// elements.namedItem: "target" is also a form property, form.target would not return the field
const handwrittenField = (name) => $("#handwritten-form").elements.namedItem(name);

// inc = sheet to edit (null = new spell to add to the open book)
function openHandwrittenDialog(inc = null) {
  const form = $("#handwritten-form");
  form.reset();
  form.dataset.edit = inc?.id || "";
  $("#handwritten-error").hidden = true;
  $("#handwritten-title").textContent = inc ? `Edit ${inc.name}` : "Write a spell by hand";
  $("#handwritten-help").textContent = inc
    ? "Changes apply to every book that has this spell. Change its level in this book from the spell sheet."
    : "For homebrew spells or spells that are not on dndtools. Only the name is required.";
  $("#handwritten-level-field").hidden = Boolean(inc);
  form.querySelector('select[name="level"] option[value="0"]').textContent = levelZeroOption();
  $("#save-handwritten").textContent = inc ? "Save changes" : "Add to book";
  if (inc) {
    for (const field of HANDWRITTEN_FIELDS) handwrittenField(field).value = inc[field] ?? inc.stats?.[field] ?? "";
    handwrittenField("subschools").value = (inc.subschools || []).join(", ");
    handwrittenField("descriptors").value = (inc.descriptors || []).join(", ");
    handwrittenField("levels").value = [
      ...(inc.levels || []).map((l) => `${l.caster_class} ${l.level}`),
      ...(inc.domains || []).map((d) => `${d.domain} domain ${d.level}`),
    ].join(", ");
    handwrittenField("description").value = inc.description_text || "";
    for (const box of form.querySelectorAll('[name="components"]')) box.checked = (inc.components || []).includes(box.value);
  }
  $("#handwritten-dialog").showModal();
  $("#handwritten-dialog").scrollTop = 0;
  if (!TOUCH) handwrittenField("name").focus();
}

async function saveHandwritten(event) {
  event.preventDefault();
  const form = $("#handwritten-form");
  const error = $("#handwritten-error");
  error.hidden = true;
  const sheet = Object.fromEntries(HANDWRITTEN_FIELDS.map((field) => [field, handwrittenField(field).value]));
  Object.assign(sheet, {
    subschools: handwrittenField("subschools").value,
    descriptors: handwrittenField("descriptors").value,
    levels: handwrittenField("levels").value,
    description: handwrittenField("description").value,
    components: [...form.querySelectorAll('[name="components"]:checked')].map((c) => c.value),
  });
  if (!sheet.name.trim()) {
    error.textContent = "The spell name is required.";
    error.hidden = false;
    handwrittenField("name").focus();
    return;
  }
  const button = $("#save-handwritten");
  button.disabled = true;
  try {
    const id = form.dataset.edit;
    if (id) {
      await api(`spells/${encodeURIComponent(id)}`, { method: "PUT", body: { sheet } });
      $("#handwritten-dialog").close();
      await reloadView();
      openSheet(id);
      notify(`${sheet.name.trim()} saved.`);
    } else {
      const before = new Set(state.book.spells.map((v) => v.spell.id));
      await api(`books/${state.book.id}/spells`, { method: "POST", body: { sheet, level: handwrittenField("level").value } });
      $("#handwritten-dialog").close();
      await reloadView();
      const fresh = state.book.spells.find((v) => !before.has(v.spell.id));
      notify(`${sheet.name.trim()} added to the book.`);
      if (fresh) document.getElementById(`level-${fresh.level}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
    error.scrollIntoView({ block: "nearest" });
  } finally {
    button.disabled = false;
  }
}

// ---------- dialog: character ----------
function openCharacterDialog(character) {
  const form = $("#character-form");
  form.reset();
  form.dataset.edit = character?.id || "";
  $("#character-dialog-title").textContent = character ? "Character" : "New character";
  $("#save-character").textContent = character ? "Save" : "Create character";
  $("#character-error").hidden = true;
  const deleteButton = $("#delete-character");
  deleteButton.hidden = !character;
  deleteButton.disabled = Boolean(character?.book_count);
  deleteButton.title = character?.book_count ? "Move or delete this character's spellbooks first" : "";
  form.name.value = character?.name || "";
  $("#character-dialog").showModal();
  if (!TOUCH) form.name.focus();
}

async function saveCharacter(event) {
  event.preventDefault();
  const form = $("#character-form");
  const id = form.dataset.edit;
  try {
    if (id) await api(`characters/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: form.name.value } });
    else await api("characters", { method: "POST", body: { name: form.name.value } });
    $("#character-dialog").close();
    notify(id ? "Character saved." : `${form.name.value.trim()} joins the library.`);
    await route();
  } catch (error) {
    $("#character-error").textContent = error.message;
    $("#character-error").hidden = false;
  }
}

async function deleteCharacter() {
  const form = $("#character-form");
  const id = form.dataset.edit;
  const name = form.name.value;
  $("#character-dialog").close();
  if (!await askConfirm("Delete this character?", `${name} will be removed, with their spells per day and prepared spells.`, "Delete")) return;
  try {
    await api(`characters/${encodeURIComponent(id)}`, { method: "DELETE" });
    notify(`${name} deleted.`);
    await route();
  } catch (error) { notify(error.message, true); }
}

// ---------- dialog: new book / settings ----------
// book = book to edit (null = new); characterId = character suggested for a new book
async function openBookDialog(book, characterId = null) {
  const form = $("#book-form");
  form.reset();
  let characters = [];
  try { characters = await api("characters"); } catch (error) { return notify(error.message, true); }
  if (!characters.length) return notify("Create a character first.", true);
  state.dialogCharacters = characters;
  form.character.innerHTML = characters.map((pc) => `<option value="${esc(pc.id)}">${esc(pc.name)}</option>`).join("");
  form.character.value = book?.character || characterId || state.character?.id || characters[0].id;
  state.editingBookId = book?.id || null;
  $("#book-dialog-title").textContent = book ? "Book settings" : "New book";
  $("#save-book").textContent = book ? "Save" : "Create book";
  $("#delete-book").hidden = !book;
  $("#book-error").hidden = true;
  state.editingBook = book || null;
  $("#availability-field").hidden = !book;
  form.availability.value = book?.unavailable?.reason || "";
  form.unavailable_note.value = book?.unavailable?.note || "";
  if (book) {
    for (const field of ["name", "max_pages", "notes"]) form[field].value = book[field] ?? "";
    form.class_type.value = book.class_type || "wizard";
    form.caster_class.value = CLASS_TYPES[form.class_type.value]?.name ? "" : book.caster_class || "";
  } else {
    // a new book gets the class of the character's first book
    const first = characters.find((pc) => pc.id === form.character.value)?.classes?.[0];
    form.class_type.value = first?.type || "wizard";
    form.caster_class.value = first && !CLASS_TYPES[first.type]?.name ? first.name : "";
  }
  syncClassFields();
  renderRemovedSpells(book);
  $("#removed-status").textContent = "";
  $("#removed-spells").open = false;
  pickCover(book?.color || "crimson");
  syncAvailability();
  $("#book-dialog").showModal();
  if (!TOUCH) form.name.focus();
}

// The class name is written only for the general types; the note says which classes the character already has
function syncClassFields() {
  const form = $("#book-form");
  const type = CLASS_TYPES[form.class_type.value] || CLASS_TYPES.wizard;
  const general = !type.name;
  $("#class-name-field").hidden = !general;
  form.caster_class.required = general;
  const pc = (state.dialogCharacters || []).find((c) => c.id === form.character.value);
  const name = general ? form.caster_class.value.trim() : type.name;
  const key = classSlug(name);
  const same = pc?.classes?.find((c) => c.key === key);
  const others = (pc?.classes || []).filter((c) => c.key !== key).map((c) => c.name);
  $("#class-note").textContent = [
    same ? `Shares spells per day and preparation with ${pc.name}'s other ${same.name} books.`
      : name ? `A new class for ${pc?.name || "this character"}, with its own spells per day and preparation.` : "",
    others.length ? `Other classes: ${others.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

// Same as slugify in server.py: the key that groups the books of a class
function classSlug(name) {
  return name.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "book";
}

// Typing the name of a general class the character already has picks that class's type
function matchClassName() {
  const form = $("#book-form");
  const pc = (state.dialogCharacters || []).find((c) => c.id === form.character.value);
  const key = classSlug(form.caster_class.value);
  const same = pc?.classes?.find((c) => c.key === key && !CLASS_TYPES[c.type]?.name);
  if (same && form.class_type.value !== same.type) form.class_type.value = same.type;
  syncClassFields();
}

function pickCover(color) {
  $("#swatches").innerHTML = Object.entries(COVERS).map(([name, value]) =>
    `<button type="button" class="swatch" data-color="${name}" title="${COVER_NAMES[name]}" aria-label="${COVER_NAMES[name]} cover" aria-pressed="${name === color}" style="--cover:${value}"></button>`).join("");
  $("#swatches").dataset.chosen = color;
}

// A book marked as lost or stolen can only change its availability: the other fields go back to the saved
// values and are locked (the server refuses other changes too)
function syncAvailability() {
  const form = $("#book-form");
  const book = state.editingBook;
  const locked = Boolean(book && form.availability.value);
  $("#unavailable-note-field").hidden = !form.availability.value;
  if (locked && book) {
    for (const field of ["name", "max_pages", "notes"]) form[field].value = book[field] ?? "";
    form.character.value = book.character;
    form.class_type.value = book.class_type || "wizard";
    form.caster_class.value = CLASS_TYPES[form.class_type.value]?.name ? "" : book.caster_class || "";
    pickCover(book.color || "crimson");
    syncClassFields();
  }
  for (const field of ["name", "character", "class_type", "caster_class", "max_pages", "notes"]) form[field].disabled = locked;
  for (const swatch of $("#swatches").querySelectorAll("button")) swatch.disabled = locked;
  $("#delete-book").disabled = locked;
  $("#delete-book").title = locked ? "Mark the book as available before deleting it" : "";
  for (const button of $("#removed-list").querySelectorAll("button")) button.disabled = locked;
  $("#locked-note").hidden = !locked;
}

async function saveBook(event) {
  event.preventDefault();
  const form = $("#book-form");
  const body = {
    name: form.name.value,
    character: form.character.value,
    class_type: form.class_type.value,
    caster_class: CLASS_TYPES[form.class_type.value]?.name || form.caster_class.value,
    max_pages: Number(form.max_pages.value) || 100,
    notes: form.notes.value,
    color: $("#swatches").dataset.chosen,
  };
  if (state.editingBookId) {
    body.unavailable = form.availability.value ? { reason: form.availability.value, note: form.unavailable_note.value } : null;
  }
  try {
    if (state.editingBookId) {
      const before = state.editingBook?.unavailable?.reason || "";
      const saved = await api(`books/${state.editingBookId}`, { method: "PATCH", body });
      // a server from before lost and stolen books ignores "unavailable"
      if (!("unavailable" in saved)) throw new Error(OUTDATED_SERVER);
      $("#book-dialog").close();
      await showBook(state.editingBookId);
      const now = saved.unavailable?.reason || "";
      notify(now === before ? "Book updated."
        : now ? `“${saved.name}” marked as ${unavailableLabel(saved).toLowerCase()}: its spells can't be prepared until it is available again.`
        : `“${saved.name}” is available again.`);
    } else {
      const book = await api("books", { method: "POST", body });
      $("#book-dialog").close();
      location.hash = `#/book/${book.id}`;
      notify(`“${book.name}” is ready.`);
    }
  } catch (error) {
    $("#book-error").textContent = error.message;
    $("#book-error").hidden = false;
  }
}

// Spells removed from the book stay in its file, hidden: the book settings list them with "Restore"
function renderRemovedSpells(book) {
  const removed = book?.removed || [];
  $("#removed-spells").hidden = !removed.length;
  $("#removed-count").textContent = removed.length;
  $("#removed-list").innerHTML = removed.map((r) => `
    <li style="--c:${schoolColor(r)}">
      <span class="removed-name"><b>${esc(r.name)}</b><small>${esc(levelTitle(r.level, { tradition: CLASS_TYPES[book.class_type]?.tradition }))} · removed ${esc(shortDate(r.removed_at))}</small></span>
      <span class="removed-actions">
        <button type="button" class="button compact" data-restore="${esc(r.id)}" aria-label="Restore ${esc(r.name)}">Restore</button>
        <button type="button" class="button compact danger" data-forget="${esc(r.id)}" data-name="${esc(r.name)}" aria-label="Delete ${esc(r.name)} for good">Delete</button>
      </span>
    </li>`).join("");
}

// Shows a removed spell again (with its level, prepared copies, scrolls and marks) and reloads the open page
async function restoreSpell(bookId, spellId) {
  try {
    const book = await api(`books/${encodeURIComponent(bookId)}/spells/${encodeURIComponent(spellId)}/restore`, { method: "POST" });
    await route();
    return book;
  } catch (error) {
    notify(error.message, true);
    throw error;
  }
}

function forgetWarning(name, bookName) {
  return `${name} will be deleted from “${bookName}” for good: its level, and the prepared copies, scrolls, favorite and ★ marks it has through this book, are lost (its downloaded page too, if no other book or spell uses it). This can't be undone.`;
}

// Deletes a spell from a book for good (shown or removed) and reloads the open page; returns the book
async function deleteForever(bookId, spellId, name) {
  const book = await api(`books/${encodeURIComponent(bookId)}/spells/${encodeURIComponent(spellId)}/forever`, { method: "DELETE" });
  await route();
  notify(`${name} deleted for good.${book.sheet_deleted ? "" : " Its downloaded page stays: another book or spell uses it."}`);
  return book;
}

$("#removed-list").addEventListener("click", async (event) => {
  const forget = event.target.closest("[data-forget]");
  if (forget) {
    const { name } = forget.dataset;
    const bookName = $("#book-form").name.value;
    if (!await askConfirm("Delete this spell for good?", forgetWarning(name, bookName), "Delete for good")) return;
    forget.disabled = true;
    try {
      renderRemovedSpells(await deleteForever(state.editingBookId, forget.dataset.forget, name));
      $("#removed-status").textContent = `${name} deleted for good.`;
    } catch (error) {
      $("#removed-status").textContent = error.message;
      forget.disabled = false;
    }
    return;
  }
  const button = event.target.closest("[data-restore]");
  if (!button) return;
  button.disabled = true;
  try {
    renderRemovedSpells(await restoreSpell(state.editingBookId, button.dataset.restore));
    $("#removed-status").textContent = `${button.getAttribute("aria-label").replace(/^Restore /, "")} is back in the book.`;
  } catch (error) {
    $("#removed-status").textContent = error.message;
    button.disabled = false;
  }
});

async function deleteBook() {
  const book = state.book;
  $("#book-dialog").close();
  if (!await askConfirm("Delete this book?", `“${book.name}” and its list of ${book.spell_count} spells will be deleted. Downloaded spell pages stay available to your other books.`, "Delete")) return;
  try {
    await api(`books/${book.id}`, { method: "DELETE" });
    location.hash = "#/";
    notify(`“${book.name}” deleted.`);
  } catch (error) { notify(error.message, true); }
}

// ---------- global events ----------
function route() {
  const [, page, id, section] = location.hash.split("/");
  const view = ["prepared", "scrolls"].includes(section) ? section : "book";
  const samePage = page === "book" && view === "book" && state.view === "book" && state.book?.id === decodeURIComponent(id || "");
  if (state.selecting && !samePage) endSelection();
  if (page === "book" && id) return showBook(decodeURIComponent(id), view);
  if (page === "character" && id) return showBook(null, view, decodeURIComponent(id));
  return showLibrary();
}

window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#level-")) return; // jump to a section, not a new page
  route().catch((error) => notify(error.message, true));
});

app.addEventListener("click", (event) => {
  const picked = state.selecting && event.target.closest("#book-pages .card");
  if (picked) {
    event.preventDefault();
    return pickCard(picked, event.shiftKey);
  }
  const base = event.target.closest("[data-ref-card]");
  if (base) return openSheet(base.dataset.refCard, { from: base.dataset.from });
  const card = event.target.closest(".card");
  if (card) openSheet(card.dataset.id);
  // a click on a level header (or its ▾ button) folds or unfolds that level
  const header = event.target.closest("[data-level-section] > .level-title");
  const control = event.target.closest("button, a, input, select, label");
  if (header && (!control || control.classList.contains("fold-toggle"))) {
    const level = Number(header.parentElement.dataset.levelSection);
    setFolded([level], !isFolded(level));
  }
});

document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll(".level-menu[open]")) if (!menu.contains(event.target)) menu.open = false;
  if (event.target.closest("[data-close]")) event.target.closest("dialog")?.close();
  // click on the dialog backdrop = close
  if (event.target.tagName === "DIALOG") event.target.close();
});

// "Back to the top" button: shows up once the page has scrolled past the first screen
const toTop = $("#to-top");
let toTopQueued = false;
window.addEventListener("scroll", () => {
  if (toTopQueued) return;
  toTopQueued = true;
  requestAnimationFrame(() => {
    toTopQueued = false;
    toTop.hidden = window.scrollY < Math.max(400, window.innerHeight * 0.8);
  });
}, { passive: true });
toTop.addEventListener("click", () => {
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  toTop.blur();
});

document.addEventListener("keydown", (event) => {
  const menu = $(".level-menu[open]");
  if (event.key === "Escape" && menu) {
    menu.open = false;
    menu.querySelector("summary").focus();
    return;
  }
  if (event.key === "Escape" && state.selecting && !document.querySelector("dialog[open]")) {
    setSelecting(false);
    return;
  }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (event.key === "/" && !typing && state.book && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    $("#search")?.focus();
  }
});

$("#sheet").addEventListener("click", (event) => {
  const favorite = event.target.closest("[data-favorite]");
  if (favorite) {
    toggleFavorite(favorite.dataset.favorite);
    const on = isFavorite(favorite.dataset.favorite);
    favorite.setAttribute("aria-pressed", on);
    favorite.textContent = on ? "♥" : "♡";
    favorite.title = on ? "Favorite: click to remove it" : "Mark as favorite";
    if (state.view === "prepared") renderPreparation();
    else if (state.view === "scrolls") renderScrolls();
    else renderPages();
    return;
  }
  const condition = event.target.closest("[data-condition]");
  if (condition) return openCondition(condition.dataset.condition);
  const ref = event.target.closest("[data-ref]");
  if (!ref) return;
  if (!findSpell(ref.dataset.ref)) {
    notify("This spell was not downloaded yet: use “Refresh from dndtools” on the spell that mentions it.", true);
    return;
  }
  const current = $("#sheet").dataset.open;
  openSheet(ref.dataset.ref, { from: ref.textContent.startsWith("←") ? null : current });
});

$("#condition").addEventListener("click", (event) => {
  const entry = event.target.closest("[data-condition]");
  if (entry && entry.dataset.condition !== conditionHistory.at(-1)) {
    conditionHistory.push(entry.dataset.condition);
    renderCondition();
  }
  if (event.target.closest("[data-back]")) {
    conditionHistory.pop();
    renderCondition();
  }
  const retry = event.target.closest("[data-retry-conditions]");
  if (retry) {
    retry.disabled = true;
    retry.textContent = "Downloading…";
    loadConditions().then(renderCondition);
  }
});
$("#open-conditions").addEventListener("click", () => openCondition("list"));
$("#open-connect").addEventListener("click", openConnect);
$("#connect").addEventListener("click", (event) => {
  const button = event.target.closest("#open-network");
  if (button) openNetwork(button);
});

$("#preview").addEventListener("click", (event) => {
  const ref = event.target.closest("[data-ref-preview]");
  if (ref) openSheet(ref.dataset.refPreview);
});

$("#swatches").addEventListener("click", (event) => {
  const swatch = event.target.closest(".swatch");
  if (swatch) pickCover(swatch.dataset.color);
});
$("#book-form").addEventListener("submit", saveBook);
$("#book-form").class_type.addEventListener("change", syncClassFields);
$("#book-form").character.addEventListener("change", syncClassFields);
$("#book-form").caster_class.addEventListener("input", matchClassName);
$("#book-form").availability.addEventListener("change", syncAvailability);
$("#character-form").addEventListener("submit", saveCharacter);
$("#delete-character").addEventListener("click", deleteCharacter);
$("#delete-book").addEventListener("click", deleteBook);
$("#add-form").addEventListener("submit", (event) => { event.preventDefault(); loadPreview(); });
$("#add-form").url.addEventListener("paste", () => setTimeout(loadPreview, 0));
$("#confirm-add").addEventListener("click", confirmAdd);
$("#paste-link").addEventListener("click", pasteLink);
$("#open-finder-from-add").addEventListener("click", () => {
  $("#add-dialog").close();
  openFinder();
});
$("#finder").addEventListener("submit", (event) => {
  if (event.target.id === "finder-form") runFinder(event);
});
$("#finder").addEventListener("click", (event) => {
  if (event.target.closest("#finder-reset")) resetFinderForm();
  if (event.target.closest("#finder-add")) importFinderSelection();
});
$("#finder").addEventListener("change", (event) => {
  const pick = event.target.dataset.pick;
  if (pick) {
    if (event.target.checked) finder.selected.add(pick);
    else finder.selected.delete(pick);
    updateFinderSelection();
  }
  if (event.target.id === "finder-all") {
    const inBook = finderInBook();
    finder.selected = new Set(event.target.checked ? finder.results.filter((r) => !inBook.has(r.id)).map((r) => r.id) : []);
    for (const box of $("#finder").querySelectorAll("[data-pick]")) box.checked = finder.selected.has(box.dataset.pick);
    updateFinderSelection();
  }
});
$("#open-handwritten").addEventListener("click", () => {
  $("#add-dialog").close();
  openHandwrittenDialog();
});
$("#handwritten-form").addEventListener("submit", saveHandwritten);

$("#metamagic").addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if ("pickFeats" in target.dataset) openMetamagic({ mode: "choice", returnTo: state.metamagic });
  if ("backMeta" in target.dataset) {
    state.metamagic = state.metamagic.returnTo;
    renderMetamagic();
  }
  if ("prepareMeta" in target.dataset) prepareWithMetamagic();
});
$("#metamagic").addEventListener("change", (event) => {
  const { apply, heighten, increase, know } = event.target.dataset;
  const chosen = state.metamagic.chosen;
  if (apply) {
    const feat = metamagic.byId.get(apply);
    if (event.target.checked) chosen.set(apply, feat.variable ? 1 : feat.increase);
    else chosen.delete(apply);
  }
  if (heighten) {
    const entry = characterSpell(state.metamagic.id);
    chosen.set(heighten, Number(event.target.value) - entry.level);
  }
  if (increase) {
    const number = parseInt(event.target.value, 10);
    chosen.set(increase, Number.isNaN(number) ? null : Math.max(0, Math.min(9, number)));
  }
  if (apply || heighten || increase) rerenderMetamagic();
  if (know) {
    const known = new Set(state.character.metamagic_feats || []);
    if (event.target.checked) known.add(know);
    else known.delete(know);
    state.character.metamagic_feats = [...known];
    $("#feat-count").textContent = known.size;
    renderPreparation();
    savePreparation();
  }
});
$("#metamagic").addEventListener("input", (event) => {
  if (!("searchFeats" in event.target.dataset)) return;
  const text = event.target.value.trim().toLowerCase();
  let visible = 0;
  for (const entry of $("#metamagic").querySelectorAll(".feat")) {
    entry.hidden = Boolean(text) && !entry.dataset.text.includes(text);
    if (!entry.hidden) visible += 1;
  }
  $("#no-feats").hidden = visible > 0;
});

loadConditions();
loadMetamagic();
pollJobs();

route().catch((error) => {
  app.innerHTML = `<div class="empty dark"><div class="big">The grimoire isn't responding</div><p>${esc(error.message)}</p><p>Is the server running? Start it with the start script in the grimoire folder.</p></div>`;
});
