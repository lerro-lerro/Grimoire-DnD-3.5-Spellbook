"""Updates Grimoire from GitHub with git: the latest commit of main, fast-forward only.

Public functions:
    find_git() -> path of a git that works, or None
    status(app_dir) -> what is installed, what GitHub has, and whether it can be updated
    apply(app_dir, data_dir, progress) -> installs the latest version, returns what rollback() needs
    rollback(app_dir, undo) -> puts the previous version back (the new one didn't start)
    forget_previous(app_dir) -> removes the copy kept for rollback, once the new version runs
    install_method(), install_git_hint(), install_git(progress) -> getting git when it is missing

Every git call goes to the public HTTPS address of the repository (never the `origin` remote, which may be SSH: a
server in the background can't type a key's passphrase), can't ask for a password or open a login window, and has a
timeout. A copy is updated only when it is safe: on main, without changes of its own, strictly behind GitHub. A copy
downloaded as a ZIP (no .git) is turned into a clone the first time it is updated.

Without git (the user asked for Windows and macOS only; Linux shows how to install it):
- Windows: MinGit (the small, official Git for Windows made for programs that carry their own git) is downloaded
  into .git-tools/ next to server.py: no administrator rights, no window, checked against GitHub's sha256;
- macOS: git comes with Apple's command line tools, and only Apple's installer can install them: it is opened
  (`xcode-select --install`) and the user clicks Install there.
"""

import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO_URL = "https://github.com/lerro-lerro/grimoire.git"
BRANCH = "main"
GIT_TIMEOUT = 120   # seconds for one git command (a slow connection)
BACKUPS_KEPT = 10
PREVIOUS = ".update-previous"  # the files a ZIP copy had before it was connected (for rollback)
LOCK = threading.Lock()        # one git operation at a time (the check in the background and an update)
TOOLS = Path(__file__).resolve().parent.parent / ".git-tools"  # Windows: Grimoire's own git (MinGit)
MINGIT = TOOLS / "mingit"
MINGIT_RELEASE = "https://api.github.com/repos/git-for-windows/git/releases/latest"


class UpdateError(Exception):
    """Error with a message to show to the user."""


def _hidden():
    # Windows: the server runs under pythonw.exe, a console window would flash at every git call
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def _works(command):
    try:
        return subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=15, **_hidden()).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def find_git():
    """The git to use, or None. On macOS /usr/bin/git is only a stub until Apple's command line tools are
    installed (running it opens their installer), so it is used only when `xcode-select -p` finds them."""
    candidates = []
    found = shutil.which("git")
    if sys.platform == "darwin":
        if found and found != "/usr/bin/git":
            candidates.append(found)
        candidates += [path for path in ("/opt/homebrew/bin/git", "/usr/local/bin/git") if Path(path).exists()]
        if Path("/usr/bin/git").exists() and _works(["xcode-select", "-p"]):
            candidates.append("/usr/bin/git")
    else:
        if found:
            candidates.append(found)
        if os.name == "nt":  # Git for Windows when its folder isn't in PATH, then Grimoire's own MinGit
            for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                         os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")):
                if base:
                    candidates.append(os.path.join(base, "Git", "cmd", "git.exe"))
            candidates.append(str(MINGIT / "cmd" / "git.exe"))
    for path in dict.fromkeys(candidates):
        if Path(path).exists() and _works([path, "--version"]):
            return path
    return None


def install_method():
    """How install_git() gets git here: "mingit" (Windows), "xcode" (macOS) or "manual" (the user installs it)."""
    if os.name == "nt":
        return "mingit"
    if sys.platform == "darwin":
        return "xcode"
    return "manual"


def install_git_hint():
    """What getting git means here, for the page and the terminal."""
    method = install_method()
    if method == "mingit":
        return ("Grimoire gets its own copy of git (MinGit, from Git for Windows) by itself. If that doesn't work, "
                "install Git for Windows from https://git-scm.com/download/win.")
    if method == "xcode":
        return "git comes with Apple's command line tools: their installer opens, click Install there."
    return "Install git with your package manager (for example sudo apt install git, or sudo dnf install git)."


def install_git(progress=lambda text: None):
    """Tries to get git. Windows: downloads MinGit, returns its path. macOS: opens Apple's installer and returns
    None (the user finishes there). Elsewhere: UpdateError with how to install it."""
    method = install_method()
    if method == "mingit":
        return _install_mingit(progress)
    if method == "xcode":
        try:
            subprocess.Popen(["xcode-select", "--install"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        except OSError as error:
            raise UpdateError(f"Could not open Apple's installer ({error}).")
        progress("Apple's installer is open: click Install there")
        return None
    raise UpdateError(install_git_hint())


def _install_mingit(progress):
    """Windows: the latest MinGit from Git for Windows' releases, into .git-tools/mingit (no administrator rights)."""
    headers = {"User-Agent": "Grimoire", "Accept": "application/vnd.github+json"}
    download = TOOLS / "mingit.zip.tmp"
    try:
        progress("Looking for the latest git for Windows")
        with urllib.request.urlopen(urllib.request.Request(MINGIT_RELEASE, headers=headers), timeout=30) as response:
            release = json.load(response)
        wanted = {"ARM64": "arm64", "X86": "32-bit"}.get(platform.machine().upper(), "64-bit")
        assets = [a for a in release.get("assets", []) if re.fullmatch(r"MinGit-[\w.()-]+\.zip", a.get("name", ""))
                  and "busybox" not in a["name"]]
        asset = next((a for suffix in (wanted, "64-bit") for a in assets if a["name"].endswith(f"-{suffix}.zip")), None)
        if not asset:
            raise UpdateError("MinGit wasn't found in the latest Git for Windows release: install Git for Windows.")
        progress(f"Downloading git ({round(asset.get('size', 0) / 1_000_000)} MB, once)")
        TOOLS.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        request = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "Grimoire"})
        with urllib.request.urlopen(request, timeout=60) as response, open(download, "wb") as file:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                file.write(chunk)
                digest.update(chunk)
    except (urllib.error.URLError, OSError, ValueError) as error:
        download.unlink(missing_ok=True)
        raise UpdateError(f"git couldn't be downloaded ({error}): check the internet connection.")
    expected = (asset.get("digest") or "").removeprefix("sha256:")
    if expected and digest.hexdigest() != expected:
        download.unlink(missing_ok=True)
        raise UpdateError("The download of git was damaged: try again.")
    progress("Installing git")
    staging = TOOLS / "mingit.new"
    _remove_tree(staging)
    try:
        with zipfile.ZipFile(download) as archive:
            if any(name.startswith(("/", "\\")) or ".." in Path(name).parts for name in archive.namelist()):
                raise UpdateError("The download of git looks wrong: install Git for Windows instead.")
            archive.extractall(staging)
    except zipfile.BadZipFile:
        raise UpdateError("The download of git was damaged: try again.")
    finally:
        download.unlink(missing_ok=True)
    if not (staging / "cmd" / "git.exe").exists():
        _remove_tree(staging)
        raise UpdateError("The download of git looks wrong: install Git for Windows instead.")
    _remove_tree(MINGIT)
    os.replace(staging, MINGIT)
    return str(MINGIT / "cmd" / "git.exe")


def _git(git, app_dir, *args, timeout=GIT_TIMEOUT):
    """Runs git in app_dir: no prompts, no credential helper (no login window), English messages."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "GIT_ASKPASS": "", "SSH_ASKPASS": "",
           "LC_ALL": "C", "LANGUAGE": "C"}
    command = [git, "-c", "credential.helper=", "-c", "core.quotepath=off", *args]
    try:
        result = subprocess.run(command, cwd=app_dir, env=env, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=timeout, **_hidden())
    except subprocess.TimeoutExpired:
        raise UpdateError("git took too long: check the internet connection and try again.")
    except OSError as error:
        raise UpdateError(f"git could not run ({error}).")
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip().splitlines()
        message = next((line for line in message if line.strip()), "git failed")
        if "Could not resolve host" in message or "unable to access" in message:
            message = "GitHub can't be reached: check the internet connection."
        raise UpdateError(message.removeprefix("fatal: ").removeprefix("error: "))
    return result.stdout.decode("utf-8", "replace").strip()


def status(app_dir):
    """{method: "clone" | "zip" | "missing", current, latest, behind, ahead, commits [{sha, message, date}],
    available, blocked (why this copy isn't updated automatically), error (the check failed)}."""
    app_dir = Path(app_dir)
    info = {"method": "missing", "current": None, "latest": None, "behind": 0, "ahead": 0, "commits": [],
            "available": False, "blocked": None, "error": None,
            "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    git = find_git()
    if not git:
        return info
    with LOCK:
        try:
            if not (app_dir / ".git").exists():
                info["method"] = "zip"
                heads = _git(git, app_dir, "ls-remote", REPO_URL, f"refs/heads/{BRANCH}").split()
                info["latest"] = heads[0] if heads else None
                info["available"] = bool(info["latest"])
                return info
            info["method"] = "clone"
            info["current"] = _git(git, app_dir, "rev-parse", "HEAD")
            try:
                branch = _git(git, app_dir, "symbolic-ref", "--quiet", "--short", "HEAD")
            except UpdateError:
                branch = None
            if branch != BRANCH:
                info["blocked"] = (f"This copy is on the branch {branch}, not {BRANCH}" if branch
                                   else "This copy isn't on a branch") + ": update it with git yourself."
                return info
            if _git(git, app_dir, "status", "--porcelain", "--untracked-files=no"):
                info["blocked"] = "This copy has changes of its own (files edited here): update it with git yourself."
                return info
            # the new commits are downloaded now: installing them later needs no network
            _git(git, app_dir, "fetch", "--quiet", "--no-tags", REPO_URL, BRANCH)
            info["latest"] = _git(git, app_dir, "rev-parse", "FETCH_HEAD")
            info["behind"] = int(_git(git, app_dir, "rev-list", "--count", "HEAD..FETCH_HEAD"))
            info["ahead"] = int(_git(git, app_dir, "rev-list", "--count", "FETCH_HEAD..HEAD"))
            if info["ahead"]:
                info["blocked"] = "This copy has commits that aren't on GitHub: update it with git yourself."
                return info
            for line in _git(git, app_dir, "log", "-20", "--format=%H%x1f%s%x1f%cI", "HEAD..FETCH_HEAD").splitlines():
                sha, message, date = (line.split("\x1f") + ["", ""])[:3]
                info["commits"].append({"sha": sha, "message": message, "date": date})
            info["available"] = info["behind"] > 0
        except UpdateError as error:
            info["error"] = str(error)
    return info


def backup(data_dir):
    """data/backups/data-<date>.zip with the books and characters (the spell cache can be downloaded again)."""
    data_dir = Path(data_dir)
    folder = data_dir / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"data-{datetime.now():%Y-%m-%d-%H%M%S}.zip"
    tmp = target.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as archive:
        for part in ("books", "characters"):
            for file in sorted((data_dir / part).glob("*.json")):
                archive.write(file, f"{part}/{file.name}")
    os.replace(tmp, target)
    for old in sorted(folder.glob("data-*.zip"))[:-BACKUPS_KEPT]:
        old.unlink(missing_ok=True)
    return target


def _remove_tree(path):
    """shutil.rmtree that also removes read-only files (git's objects on Windows)."""
    def retry(function, name, _):
        os.chmod(name, stat.S_IWRITE)
        function(name)
    if Path(path).exists():
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=retry)
        else:
            shutil.rmtree(path, onerror=retry)


def _connect(git, app_dir, progress):
    """A copy downloaded as a ZIP becomes a clone of GitHub at the latest commit. The files git overwrites are
    copied to .update-previous first."""
    previous = app_dir / PREVIOUS
    undo = {"method": "zip", "kept": [], "added": []}
    try:
        _git(git, app_dir, "init", "--quiet")
        _git(git, app_dir, "symbolic-ref", "HEAD", f"refs/heads/{BRANCH}")
        _git(git, app_dir, "remote", "add", "origin", REPO_URL)
        progress("Downloading the new version")
        _git(git, app_dir, "fetch", "--quiet", "--no-tags", "origin", BRANCH)
        tracked = _git(git, app_dir, "ls-tree", "-r", "-z", "--name-only", f"origin/{BRANCH}").split("\0")
        _remove_tree(previous)
        for name in filter(None, tracked):
            source = app_dir / name
            if source.is_file():
                (previous / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, previous / name)
                undo["kept"].append(name)
            else:
                undo["added"].append(name)
        progress("Installing")
        _git(git, app_dir, "reset", "--quiet", "--hard", f"origin/{BRANCH}")
        _git(git, app_dir, "branch", "--quiet", f"--set-upstream-to=origin/{BRANCH}", BRANCH)
    except (UpdateError, OSError) as error:
        _restore(app_dir, undo)
        if isinstance(error, UpdateError):
            raise
        raise UpdateError(f"Could not install the new version ({error}).")
    return undo


def _restore(app_dir, undo):
    """Puts back the files of a ZIP copy (and removes what the connection added)."""
    previous = app_dir / PREVIOUS
    for name in undo["kept"]:
        target = app_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(previous / name, target)
    for name in undo["added"]:
        (app_dir / name).unlink(missing_ok=True)
    _remove_tree(app_dir / ".git")
    _remove_tree(previous)


def apply(app_dir, data_dir, progress=lambda text: None):
    """Installs the latest commit of main. Returns what rollback() needs to put the current version back."""
    app_dir = Path(app_dir)
    progress("Checking GitHub")
    info = status(app_dir)
    if info["method"] == "missing":
        raise UpdateError("Updates need git. " + install_git_hint())
    if info["error"]:
        raise UpdateError(info["error"])
    if info["blocked"]:
        raise UpdateError(info["blocked"])
    if not info["available"]:
        raise UpdateError("Grimoire is already up to date.")
    progress("Backing up your data")
    backup(data_dir)
    git = find_git()
    requirements = (app_dir / "requirements.txt").read_bytes() if (app_dir / "requirements.txt").exists() else b""
    with LOCK:
        if info["method"] == "clone":
            progress("Installing")
            _git(git, app_dir, "merge", "--ff-only", "--quiet", info["latest"])  # fetched by status()
            undo = {"method": "clone", "head": info["current"]}
        else:
            undo = _connect(git, app_dir, progress)
    undo["sha"] = info["latest"]  # the version installed: not offered again if it doesn't start
    now = (app_dir / "requirements.txt").read_bytes() if (app_dir / "requirements.txt").exists() else b""
    if now != requirements:  # the new version needs other Python modules
        progress("Installing the Python modules it needs")
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                            "-r", "requirements.txt"], cwd=app_dir, stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=600, check=True, **_hidden())
        except (OSError, subprocess.SubprocessError):
            rollback(app_dir, undo)
            raise UpdateError("The new version needs Python modules that couldn't be installed (requirements.txt): "
                              "the previous version is still installed.")
    return undo


def rollback(app_dir, undo):
    """Back to the version installed before apply() (the new one didn't start)."""
    app_dir = Path(app_dir)
    with LOCK:
        if undo["method"] == "clone":
            _git(find_git(), app_dir, "reset", "--quiet", "--hard", undo["head"])
        else:
            _restore(app_dir, undo)


def forget_previous(app_dir):
    _remove_tree(Path(app_dir) / PREVIOUS)
