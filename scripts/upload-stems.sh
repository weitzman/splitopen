#!/usr/bin/env bash
# Sync the encoded stems in audio/songs/ to the R2 bucket the player reads.
#
#   scripts/upload-stems.sh [song id]
#   scripts/upload-stems.sh --levels [song id]
#
# With no argument every song is synced; with an id just that song.
# --levels copies only levels.json (see stem-levels.py), for songs whose
# stems are already up; it deletes nothing, so it is safe for songs whose
# segments are not in audio/songs/. Needs an rclone remote named "r2" for
# the bucket (see README, Hosting). R2_REMOTE overrides the bucket path,
# default r2:splitopen/songs.
#
# Segments never change once encoded (a re-encode replaces the whole song
# directory, and sync removes what is gone), so they get a year-long
# immutable cache header. meta.json and levels.json get an hour, so a
# re-encoded song's new grid is picked up without a cache-busting path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${R2_REMOTE:-r2:splitopen/songs}"
command -v rclone >/dev/null || { echo "missing: rclone (brew install rclone)" >&2; exit 1; }

src="$ROOT/audio/songs"; dest="$REMOTE"

json_up() {  # copy only the JSON files named, with a short cache
  local args=()
  for f in "$@"; do args+=(--include "$f"); done
  rclone copy "$src" "$dest" "${args[@]}" \
    --header-upload 'Cache-Control: public, max-age=3600' \
    --header-upload 'Content-Type: application/json' \
    --stats-one-line -P
}

if [[ "${1:-}" == --levels ]]; then
  if [[ -n "${2:-}" ]]; then
    [[ -s "$src/$2/levels.json" ]] || { echo "no levels at audio/songs/$2; run scripts/stem-levels.py $2" >&2; exit 1; }
    src="$src/$2"; dest="$dest/$2"
  fi
  json_up levels.json
  echo "copied levels to $dest"
  exit 0
fi
if [[ -n "${1:-}" ]]; then
  [[ -s "$src/$1/meta.json" ]] || { echo "no encoded song at audio/songs/$1" >&2; exit 1; }
  src="$src/$1"; dest="$dest/$1"
fi

rclone sync "$src" "$dest" --exclude meta.json --exclude levels.json --exclude .DS_Store \
  --header-upload 'Cache-Control: public, max-age=31536000, immutable' \
  --header-upload 'Content-Type: audio/ogg' \
  --transfers 16 --checkers 16 --stats-one-line -P
json_up meta.json levels.json
echo "synced to $dest"
