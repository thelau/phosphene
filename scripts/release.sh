#!/usr/bin/env bash
# Phosphene: a new version of the Mac app, built and published (npm run release 0.1.1).
# The installed apps find it on their next launch (latest.json) and offer "Restart to update".
# Needs: the update signing key in ~/.tauri/phosphene.key (keep a copy somewhere safe: without it no update can be published),
# and gh signed in to GitHub. The releases go to a PUBLIC repository that holds only the app, never the code.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: npm run release <version>, e.g. 0.1.1}"
REPO="${PHOSPHENE_RELEASES:-thelau/phosphene-releases}"
NOTES="${2:-Phosphene $VERSION}"
KEY="$HOME/.tauri/phosphene.key"
[ -f "$KEY" ] || { echo "The update signing key is missing: $KEY"; exit 1; }

echo "== Version $VERSION"
.venv/bin/python - "$VERSION" <<'PY'
import json, re, sys
v = sys.argv[1]
for p in ("app/src-tauri/tauri.conf.json", "package.json"):
    d = json.load(open(p)); d["version"] = v; open(p, "w").write(json.dumps(d, indent=2) + "\n")
p = "app/src-tauri/Cargo.toml"; s = open(p).read()
open(p, "w").write(re.sub(r'(?m)^version = "[^"]+"', f'version = "{v}"', s, count=1))
PY

echo "== Build"
.venv/bin/python app/build.py
(cd app && TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri build)

B=app/src-tauri/target/release/bundle
DMG=$(ls "$B"/dmg/Phosphene_"$VERSION"_*.dmg)
TAR="$B/macos/Phosphene.app.tar.gz"
SIG=$(cat "$TAR.sig")
URL="https://github.com/$REPO/releases/download/v$VERSION"
.venv/bin/python - "$VERSION" "$NOTES" "$SIG" "$URL/Phosphene.app.tar.gz" > "$B/latest.json" <<'PY'
import json, sys, datetime
v, notes, sig, url = sys.argv[1:5]
print(json.dumps({"version": v, "notes": notes, "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "platforms": {"darwin-aarch64": {"signature": sig, "url": url}}}, indent=2))
PY

echo "== Publish to $REPO"
gh release create "v$VERSION" --repo "$REPO" --title "Phosphene $VERSION" --notes "$NOTES" "$DMG#Phosphene $VERSION (Mac, Apple silicon)" "$TAR" "$B/latest.json"
echo "Done: $URL"
