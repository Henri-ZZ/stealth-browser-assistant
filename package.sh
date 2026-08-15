#!/bin/bash
# package.sh — Build a Chrome Web Store upload ZIP for Stealth Browser Assistant.
#
# Usage:
#   ./package.sh                 # builds dist/stealth-browser-assistant-<version>.zip
#   ./package.sh --list          # only print which files would be included
#   ./package.sh --check         # validate manifest + verify the built zip
#
# Design notes:
#   - Whitelist-based: only files the extension actually references at runtime
#     are packaged. Source-only artifacts (plan.md, 推广策略.md, *.png backups,
#     .git, .workbuddy, .claude, .DS_Store) never leak into the store upload.
#   - manifest.json must sit at the ZIP root (Chrome Web Store requirement).
#   - Version is read from manifest.json so the artifact name always matches.

set -euo pipefail
cd "$(dirname "$0")"   # script lives at project root

DIST_DIR="dist"
ARCHIVE_BASE="stealth-browser-assistant"

# Runtime files (whitelist). Keep in sync with manifest.json references.
FILES=(
  manifest.json
  background.js
  shared.js
  license.js
  popup.html
  popup.js
  options.html
  options.js
  styles.css
  _locales
  icons
  assets/premium.png
)

# ── helpers ──────────────────────────────────────────────────────────

warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

version_from_manifest() {
  # No jq dependency — read "version" with python3 or node.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys;print(json.load(open('manifest.json'))['version'])"
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('./manifest.json').version)"
  else
    die "need python3 or node to read manifest.json version"
  fi
}

check_file_exists() {
  local f="$1"
  [ -e "$f" ] || die "whitelisted path missing: $f"
}

# ── main ─────────────────────────────────────────────────────────────

VERSION="$(version_from_manifest)"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "manifest version looks wrong: '$VERSION' (want x.y.z)"
fi

ARCHIVE="$DIST_DIR/${ARCHIVE_BASE}-${VERSION}.zip"

if [ "${1:-}" = "--list" ]; then
  printf 'Would package (%s files):\n' "${#FILES[@]}"
  for f in "${FILES[@]}"; do printf '  %s\n' "$f"; done
  printf 'Version: %s\n' "$VERSION"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  [ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE (run ./package.sh first)"
  # Manifest at root?
  python3 - "$ARCHIVE" <<'PY' || die "manifest.json not at ZIP root — see unzip -l"
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
assert "manifest.json" in names, "manifest.json missing from zip"
assert not any(n.startswith("__MACOSX/") for n in names), "macOS metadata leaked in zip"
total = sum(i.file_size for i in z.infolist())
print(f"  OK: manifest.json at root, {len(names)} entries, {total//1024}KB")
PY
  # Every whitelisted path present?
  for f in "${FILES[@]}"; do
    if ! python3 -c "import sys,zipfile;names=zipfile.ZipFile(sys.argv[1]).namelist();sys.exit(0 if any(n==sys.argv[2] or n.startswith(sys.argv[2]+'/') for n in names) else 1)" "$ARCHIVE" "$f"; then
      die "whitelisted path missing from zip: $f"
    fi
  done
  ok "check passed: $ARCHIVE"
  exit 0
fi

if [ "${1:-}" != "" ]; then
  die "unknown option: $1 (use --list | --check | no arg)"
fi

# Validate manifest parses before building.
python3 -c "import json;json.load(open('manifest.json'))" \
  || die "manifest.json is not valid JSON"

# Fresh staging dir — build the zip from exactly the whitelisted files.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for f in "${FILES[@]}"; do
  check_file_exists "$f"
  mkdir -p "$STAGE/$(dirname "$f")"
  cp -R "$f" "$STAGE/$f"
done

# Strip macOS metadata that `cp -R` may have carried over from source dirs.
find "$STAGE" -name ".DS_Store" -delete

mkdir -p "$DIST_DIR"
rm -f "$ARCHIVE"
(
  cd "$STAGE"
  zip -qr "$OLDPWD/$ARCHIVE" .
)

# Sanity: verify the archive right after building.
"$0" --check

ok "built: $ARCHIVE"
printf '  size: %s KB\n' "$(( $(stat -f%z "$ARCHIVE") / 1024 ))"
