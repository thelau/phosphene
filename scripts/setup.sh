#!/usr/bin/env bash
# Phosphene: everything the app needs on this computer, checked and installed (npm run setup). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
note() { printf '\n\033[1m%s\033[0m\n' "$1"; }

note "Checking the tools"
missing=()
have() { command -v "$1" >/dev/null 2>&1; }
if have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then ok "Python $(python3 -c 'import platform; print(platform.python_version())')"; else bad "Python 3.10 or newer"; missing+=(python); fi
if have node && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then ok "Node $(node -v)"; else bad "Node 20 or newer"; missing+=(node); fi
if have ffmpeg; then ok "ffmpeg"; else bad "ffmpeg (makes the video files)"; missing+=(ffmpeg); fi

if [ ${#missing[@]} -gt 0 ]; then
  if have brew; then
    printf '\nInstall %s with Homebrew now? [y/N] ' "${missing[*]}"
    read -r answer
    if [[ "$answer" =~ ^[Yy] ]]; then brew install "${missing[@]}"; else echo "Install them, then run npm run setup again."; exit 1; fi
  else
    echo
    echo "Install these first, then run npm run setup again: ${missing[*]}"
    echo "On a Mac the easiest way is Homebrew (https://brew.sh): brew install ${missing[*]}"
    exit 1
  fi
fi

note "Python packages (in .venv, only for this app)"
# A .venv made in another folder (the repo was moved) has scripts pointing there: make it again.
if [ -d .venv ] && ! grep -qF "$PWD/.venv" .venv/pyvenv.cfg 2>/dev/null; then rm -rf .venv; fi
[ -d .venv ] || python3 -m venv --system-site-packages .venv
.venv/bin/pip install -q --disable-pip-version-check -r requirements-dev.txt
ok "Pillow and pytest"

note "The page's packages"
npm install --silent
ok "Vite and the test browser driver"

note "Ready"
cat <<'MSG'
  Start it:   npm run dev     then open http://localhost:5173
  First time: Settings (top right) › Connect Krea, and paste your Kimi key.
  Projects:   the name next to Phosphene, top left: New project… for a mark.
  Update:     git pull, then npm run setup again if it says something changed.
MSG
