#!/usr/bin/env bash
# Assemble the deployable site in _site/: the player from web/ at the root,
# the stems alongside it, and a redirect for links to the old /web/ path.
# Used by the deploy and PR-preview workflows; local dev serves the repo
# root directly and does not need this.
set -euo pipefail
cd "$(dirname "$0")/.."

out=_site
rm -rf "$out"
mkdir -p "$out"

cp -R web/. "$out"/
cp -R audio "$out"/audio
# songs.json points at ../audio/ relative to web/; at the site root it is audio/.
sed -i.bak 's#"\.\./audio/#"audio/#' "$out"/songs.json && rm "$out"/songs.json.bak
[ -f CNAME ] && cp CNAME "$out"/CNAME
touch "$out"/.nojekyll

# The player used to live at /web/. Send old links, hash included, to the root.
mkdir -p "$out"/web
cat > "$out"/web/index.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Split Open</title>
<script>location.replace('../' + location.search + location.hash);</script>
<meta http-equiv="refresh" content="0; url=../">
</head>
<body><a href="../">Split Open has moved</a></body>
</html>
HTML

echo "built $out ($(du -sh "$out" | cut -f1))"
