#!/bin/bash
# Validate and export localized Store listing copy. This does not publish.
set -euo pipefail
cd "$(dirname "$0")"
if [ "$#" -eq 0 ]; then
  set -- check
fi
exec node store-listing.mjs "$@"
