# Grimoire

A spellbook manager for **Dungeons & Dragons 3.5**. It runs on your own computer and opens in your browser, and
your phone can use it too.

Keep your characters' spellbooks, prepare the day's spells, and count your scrolls. Spells come from
[dndtools.net](https://dndtools.net/spells/): Grimoire downloads the full text of each spell, with measurements
converted to metric, and keeps it on your computer.

## What you can do

- **Characters and spellbooks:** as many characters as you like, each with any number of books. Wizard, sorcerer,
  cleric, druid, or any other class that casts arcane or divine spells, multiclass characters included.
- **Add spells** in three ways: paste a dndtools link, search dndtools with its filters, or write a homebrew spell
  by hand.
- **Prepare spells:** Grimoire counts your spells per day, including ability bonuses, specialist schools, domains,
  forbidden schools and metamagic feats. Tap **Cast** when you use a spell and **New day** after a rest. Sorcerers and
  other spontaneous casters spend slots instead.
- **Scrolls:** the market price and the scribing cost (gold and XP) of each spell. **Add scrolls** plans a batch that
  fits your gold.
- **Find spells fast:** search by name (words in any order), school, level, or any field of the spell: description,
  range, duration, components and more. Filters stay fast even with thousands of spells.
- **Stay tidy:** favorites, folding levels, **Select** to remove many spells at once (with Undo), a list of removed
  spells you can restore, and books you can mark as lost or stolen.
- **Rules at hand:** the full text of every spell. Conditions like *stunned* are clickable and open the d20 SRD
  rules.
- **Phone:** the page is made for phones too, and a QR code opens it from any device on your Wi-Fi.

## What you need

- **Python 3.9 or newer.** On Windows and macOS, get it from [python.org](https://www.python.org/downloads/).
- **An internet connection** when you add spells or update Grimoire. Everything else works offline.
- **git** for automatic updates (optional). Grimoire can get it by itself on Windows and macOS: see
  [Updates](#updates).

## Get Grimoire

The best way is with git, because that copy updates itself:

```bash
git clone https://github.com/lerro-lerro/grimoire.git
```

You can also use **Code → Download ZIP** on GitHub and unzip it. That copy connects to GitHub the first time you
update it.

## Start and stop

| System  | Start | Stop |
|---------|-------|------|
| Windows | double-click `start-windows.bat` | double-click `stop-windows.bat` |
| macOS   | double-click `start-mac.command` (the first time: right-click → Open) | double-click `stop-mac.command` |
| Linux   | `./start-linux.sh` | `./stop-linux.sh` |

The browser opens at **http://my-grimoire.localhost:8765**. Grimoire keeps running in the background, with no
window, until you use the stop script or turn off the computer. Starting it again while it runs just opens the
browser. The first start installs the Python module it needs (lxml).

On Linux, `./start-linux.sh --add-to-menu` adds **Grimoire** and **Stop Grimoire** to the applications menu.

## First steps

1. **Create a character:** click **New character** and give it a name.
2. **Create a book:** click **New book** and choose its class (wizard, cleric, sorcerer…). A multiclass character
   has a book for each class.
3. **Add spells:** open the book, click **Add spell**, then paste dndtools links or use **Search dndtools**.
   Downloads keep going while you use the app: a panel in the corner shows their progress and tells you when they
   are done, even after you close the dialog or reload the page.
4. **Prepare:** in the **Prepared** tab, write your spells per day from the class table and your ability score.
   Grimoire adds the bonus spells and the save DCs. Then pick the day's spells.
5. **Play:** tap **Cast** when you use a spell, and **New day** after a rest.
6. **Scrolls:** the **Scrolls** tab counts the scrolls you own and what they cost.

**All spellbooks** shows every spell of a character together, with the book each one comes from.

## Use it on your phone

1. On the computer, click **Connect device**, then **Allow devices on this Wi-Fi**.
2. Scan the QR code with the phone. The phone must be on the same Wi-Fi.

Grimoire is never reachable from the internet, but it has **no password**: anyone on your Wi-Fi can open and change
your books. Only allow it on networks you trust.

## Updates

Grimoire checks GitHub by itself. When a new version is out, an **Update** button appears at the top of the page,
with the list of changes. One click:

1. backs up your books and characters (in `data/backups`);
2. installs the new version and restarts Grimoire;
3. reloads the page. Phones on your Wi-Fi reconnect.

If the new version doesn't start, the previous one comes back by itself.

Updates need **git**:

- **Windows:** nothing to do. Grimoire downloads its own copy of git the first time (about 40 MB, into the
  `.git-tools` folder). If that fails, the Library page shows **Try again**, or you can install
  [Git for Windows](https://git-scm.com/download/win).
- **macOS:** Grimoire opens Apple's installer once: click **Install** there. If you closed it, use **Install git**
  on the Library page.
- **Linux:** install it with your package manager, for example `sudo apt install git` or `sudo dnf install git`.

You can also update from a terminal with `python3 server.py --update`. A copy with changes of its own (edited
files, your own commits, another branch) is never updated automatically: update it with git.

## Your data

Books, characters and downloaded spells are JSON files in the `data/` folder, created on the first start. It is
not part of the repository, and updates never touch it. To back everything up, copy that folder.

## Problems?

- **Grimoire doesn't start:** the reason is at the end of `data/server.log`.
- **The port is busy:** Grimoire tries the next ones by itself. You can also pick one with `--port`.
- **The phone can't connect:** check that it is on the same Wi-Fi as the computer, and that **Connect device**
  allows devices.
- **An update failed:** Grimoire went back to the previous version by itself and doesn't offer that version again.
  The reason is in `data/server.log`.

## Options

The start scripts pass these on, and so does `python3 server.py`:

| Option | What it does |
|--------|--------------|
| `--port 9000` | uses another port |
| `--data /some/folder` | keeps the data in another folder (use it to stop that server too) |
| `--network` | lets phones connect right away |
| `--no-browser` | doesn't open the browser |
| `--no-update-check` | doesn't check GitHub for new versions |

Without the scripts: `python3 -m pip install -r requirements.txt`, then `python3 server.py` (stop it with Ctrl+C), or
`python3 server.py --start` and `--stop` for the background. `python3 server.py --help` lists every option.

## For developers

```
server.py      the web server and its API (start here)
grimoire/      dndtools download and search, metric units, SRD conditions, metamagic feats, updates
web/           the interface: HTML, CSS and JavaScript, no build step
start-*        start scripts for Windows, macOS and Linux (stop-* stop the server)
```

Python standard library plus lxml, and plain JavaScript: nothing to build.

## Credits

- Spell and feat data: [dndtools.net](https://dndtools.net). It is downloaded to your computer when you use the
  app and is not included in this repository.
- Conditions: the d20 System Reference Document ([d20srd.org](https://www.d20srd.org)), Open Game License.
- Dungeons & Dragons is a trademark of Wizards of the Coast. This is an unofficial fan project, not affiliated
  with or endorsed by Wizards of the Coast.
