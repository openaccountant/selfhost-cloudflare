#!/usr/bin/env bash
# Make a consistent tarball of the wilson data dir (~/.openaccountant) at $1.
# SQLite files are copied with VACUUM INTO (safe while wilson is running);
# everything else is copied as-is. Model caches and logs are left out.
set -euo pipefail
OUT="${1:?usage: snapshot.sh <out.tgz>}"
SRC="$HOME/.openaccountant"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[ -d "$SRC" ] || { echo "no data dir yet"; exit 3; }

mkdir -p "$STAGE/.openaccountant"
# Copy the tree without databases, caches, models and logs.
(cd "$SRC" && find . -type f \
  ! -path './models/*' ! -path './logs/*' ! -path '*/cache/*' \
  ! -name '*.db' ! -name '*.db-wal' ! -name '*.db-shm' -print0) \
  | (cd "$SRC" && xargs -0 -r cp --parents -t "$STAGE/.openaccountant")

# Consistent copies of every SQLite database.
while IFS= read -r -d '' db; do
  rel="${db#"$SRC"/}"
  mkdir -p "$STAGE/.openaccountant/$(dirname "$rel")"
  bun -e "const { Database } = require('bun:sqlite'); const d = new Database(process.argv[1]); d.run(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\"); d.close();" \
    "$db" "$STAGE/.openaccountant/$rel"
done < <(find "$SRC" -name '*.db' -type f ! -path '*/models/*' -print0)

tar czf "$OUT" -C "$STAGE" .openaccountant
echo "snapshot $(stat -c %s "$OUT") bytes"
