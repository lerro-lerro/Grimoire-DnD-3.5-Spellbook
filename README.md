# Grimoire

A spellbook manager for **Dungeons & Dragons 3.5** that runs on your own computer.
Keep your characters' spellbooks, prepare the day's spells, count your scrolls, and open it all from your phone.

Spells come from [dndtools.net](https://dndtools.net/spells/): paste a link or search with its filters, and the
full spell is saved on your computer (with measurements in metric units).

## Features

- **Characters and classes:** several characters, each with any number of spellbooks. Wizard, sorcerer, cleric,
  druid, or any class that casts arcane or divine spells (prepared or spontaneous), and multiclass characters.
- **Adding spells:** paste dndtools links, search dndtools with its filters, or write homebrew spells by hand.
- **Preparing spells:** spells per day with ability bonuses, specialist schools, domains, forbidden schools and
  metamagic feats. Sorcerers and similar classes spend slots instead.
- **Scrolls:** market price and scribing cost for each spell, and a planner that fits a batch of scrolls to your gold.
- **Everyday tools:** favorites, filters, folding levels, removed spells you can restore, and books marked as lost or stolen.
- **Rules at hand:** the full text of every spell, with clickable conditions from the d20 SRD.
- **Phone:** the layout works on phones, and a QR code opens the grimoire from any device on your Wi-Fi.

## Requirements

- Python 3.9 or newer
- [lxml](https://lxml.de/) (the start scripts install it if needed)
- An internet connection when you add spells. Everything you download stays on your computer.

## Start

| System  | How |
|---------|-----|
| Linux   | run `./start-linux.sh` |
| macOS   | double-click `start-mac.command` (the first time: right-click → Open) |
| Windows | double-click `start-windows.bat` |

The browser opens at `http://my-grimoire.localhost:8765`. To stop, press Ctrl+C in the terminal window
(or close it).

Without the scripts:

```bash
python3 -m pip install -r requirements.txt
python3 server.py
```

The server also accepts these options:

- `--port 9000` uses another port.
- `--data /some/folder` keeps the data in another folder.
- `--network` lets phones connect right away.
- `--no-browser` doesn't open the browser.

`python3 server.py --help` lists them all.

## From your phone

Click **Connect device**, allow devices on your Wi-Fi, and scan the QR code with the phone.
The phone must be on the same network. The grimoire is never reachable from the internet, but it has
**no password**: anyone on your Wi-Fi can open and change your books, so only allow it on networks you trust.

## Your data

Books, characters and downloaded spells are JSON files in the `data/` folder, created on the first start.
To back them up, copy that folder. It is not part of the repository.

## Project layout

```
server.py      the web server and its API (start here)
grimoire/      dndtools download and search, metric units, SRD conditions, metamagic feats
web/           the interface: HTML, CSS and JavaScript, no build step
start-*        start scripts for Linux, macOS and Windows
```

## Credits

- Spell and feat data: [dndtools.net](https://dndtools.net). It is downloaded on your computer when you use the
  app and is not included in this repository.
- Conditions: the d20 System Reference Document ([d20srd.org](https://www.d20srd.org)), Open Game License.
- Dungeons & Dragons is a trademark of Wizards of the Coast. This is an unofficial fan project, not affiliated
  with or endorsed by Wizards of the Coast.
