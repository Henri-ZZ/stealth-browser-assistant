#!/bin/bash
# package.sh — Build store upload ZIPs for Stealth Browser Assistant.
#
# Usage:
#   ./package.sh                 # Chrome/Edge ZIP (default): dist/stealth-browser-assistant-<version>.zip
#   ./package.sh --firefox       # Firefox ZIP: dist/...-<version>-firefox.zip (uses manifest.firefox.json)
#   ./package.sh --all           # both, in one run
#   ./package.sh --list          # only print which files would be included
#   ./package.sh --check         # validate manifest + verify the built zip
#
# Design notes:
#   - Whitelist-based: only files the extension actually references at runtime
#     are packaged. Source-only artifacts (plan.md, 推广策略.md, *.png backups,
#     .git, .workbuddy, .claude, .DS_Store) never leak into the store upload.
#   - manifest.json must sit at the ZIP root (Chrome Web Store requirement).
#   - Version is read from manifest.json so the artifact name always matches.
#   - Firefox differs from Chrome/Edge only in manifest (background.scripts +
#     gecko settings); the code is identical, so --firefox swaps in
#     manifest.firefox.json before staging. Chrome/Edge share one package.

set -euo pipefail
cd "$(dirname "$0")"   # script lives at project root

DIST_DIR="dist"
ARCHIVE_BASE="sba"  # 简称，文件名 sba-<version>.zip，方便一眼看版本号

# Runtime files (whitelist). Keep in sync with manifest.json references.
FILES=(
  manifest.json
  background.js
  shared.js
  config.js
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

MODE="chrome"   # chrome (default) | firefox
for arg in "$@"; do
  case "$arg" in
    --firefox) MODE="firefox" ;;
    --all) MODE="all" ;;
    --list|--check) ;;  # handled below
    *) die "unknown option: $arg (use --list | --check | --firefox | --all)" ;;
  esac
done

# Validate the base manifest parses before building.
python3 -c "import json;json.load(open('manifest.json'))" \
  || die "manifest.json is not valid JSON"

list_files() {
  printf 'Would package (%s files):\n' "${#FILES[@]}"
  for f in "${FILES[@]}"; do printf '  %s\n' "$f"; done
  printf 'Version: %s\n' "$VERSION"
}

check_archive() {
  local archive="$1"
  [ -f "$archive" ] || die "archive not found: $archive (run ./package.sh first)"
  # Manifest at root?
  python3 - "$archive" <<'PY' || die "manifest.json not at ZIP root — see unzip -l"
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
    if ! python3 -c "import sys,zipfile;names=zipfile.ZipFile(sys.argv[1]).namelist();sys.exit(0 if any(n==sys.argv[2] or n.startswith(sys.argv[2]+'/') for n in names) else 1)" "$archive" "$f"; then
      die "whitelisted path missing from zip: $f"
    fi
  done
  ok "check passed: $archive"
}

build_one() {
  local variant="$1"   # "" = chrome/edge, "-firefox" = firefox
  local suffix="$2"
  local manifest_src="$3"
  local archive="$DIST_DIR/${ARCHIVE_BASE}-${VERSION}${suffix}.zip"

  # Fresh staging dir — build the zip from exactly the whitelisted files.
  local stage
  stage="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" EXIT

  for f in "${FILES[@]}"; do
    check_file_exists "$f"
    mkdir -p "$stage/$(dirname "$f")"
    cp -R "$f" "$stage/$f"
  done

  # Swap in the variant manifest (Firefox differs from Chrome/Edge).
  cp "$manifest_src" "$stage/manifest.json"

  # Strip macOS metadata that `cp -R` may have carried over from source dirs.
  find "$stage" -name ".DS_Store" -delete

  mkdir -p "$DIST_DIR"
  rm -f "$archive"
  (
    cd "$stage"
    zip -qr "$OLDPWD/$archive" .
  )

  check_archive "$archive"
  ok "built ($variant): $archive"
  printf '  size: %s KB\n' "$(( $(stat -f%z "$archive") / 1024 ))"
}

# ── dispatch ─────────────────────────────────────────────────────────

if [ "${1:-}" = "--list" ]; then
  list_files
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  check_archive "$DIST_DIR/${ARCHIVE_BASE}-${VERSION}.zip"
  exit 0
fi

if [ "${MODE}" = "chrome" ]; then
  build_one "chrome/edge" "" "manifest.json"
elif [ "${MODE}" = "firefox" ]; then
  [ -f manifest.firefox.json ] || die "manifest.firefox.json not found"
  python3 -c "import json;json.load(open('manifest.firefox.json'))" \
    || die "manifest.firefox.json is not valid JSON"
  build_one "firefox" "-firefox" "manifest.firefox.json"
else
  [ -f manifest.firefox.json ] || die "manifest.firefox.json not found"
  python3 -c "import json;json.load(open('manifest.firefox.json'))" \
    || die "manifest.firefox.json is not valid JSON"
  build_one "chrome/edge" "" "manifest.json"
  build_one "firefox" "-firefox" "manifest.firefox.json"
fi
