#!/usr/bin/env bash
# Sync the encoded stems in audio/songs/ to the R2 bucket the player reads.
#
#   scripts/upload-stems.sh [song id]
#
# With no argument every song is synced; with an id just that song. Needs an
# rclone remote named "r2" for the bucket (see README, Hosting). R2_REMOTE
# overrides the bucket path, default r2:splitopen/songs.
#
# Segments never change once encoded (a re-encode replaces the whole song
# directory, and sync removes what is gone), so they get a year-long
# immutable cache header. meta.json gets an hour, so a re-encoded song's new
# grid is picked up without a cache-busting path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${R2_REMOTE:-r2:splitopen/songs}"
command -v rclone >/dev/null || { echo "missing: rclone (brew install rclone)" >&2; exit 1; }

src="$ROOT/audio/songs"; dest="$REMOTE"
if [[ -n "${1:-}" ]]; then
  [[ -s "$src/$1/meta.json" ]] || { echo "no encoded song at audio/songs/$1" >&2; exit 1; }
  src="$src/$1"; dest="$dest/$1"
fi

rclone sync "$src" "$dest" --exclude meta.json --exclude .DS_Store \
  --header-upload 'Cache-Control: public, max-age=31536000, immutable' \
  --header-upload 'Content-Type: audio/ogg' \
  --transfers 16 --checkers 16 --stats-one-line -P
rclone copy "$src" "$dest" --include meta.json \
  --header-upload 'Cache-Control: public, max-age=3600' \
  --header-upload 'Content-Type: application/json' \
  --stats-one-line -P
echo "synced to $dest"
