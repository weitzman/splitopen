#!/usr/bin/env python3
"""Writes a page per song under s/<id>/ that carries the song's link preview.

The player keeps the song in the URL hash, which link unfurlers (Slack,
iMessage, Twitter, Facebook) never send to the server, so a link straight to
the player can only ever preview as "Split Open". Share hands out
s/<id>/ instead (see songLink in app.js): a page whose Open Graph and
Twitter tags name the song, band, date and venue (its image, card.png
beside it, comes from scripts/song-cards.py), and whose script forwards
the browser to the player at the site root, carrying the mix and moment from
its hash. Nothing is lost on the way: s/<id>/#solo=keys&t=312 opens the
player at #<id>&solo=keys&t=312.

The pages are derived from songs.yaml and bands.yaml, so s/ is gitignored:
the deploy workflows run this before publishing, and scripts/serve.py
renders the same page on the fly for local testing.

    python3 scripts/song-pages.py        # write s/<id>/index.html for every song
"""
import html
import os
import re
import shutil
import sys

import yaml12

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals', 'horns', 'flute']
OUT = 's'

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{url}">
<meta name="theme-color" content="#0b1026">
<link rel="icon" href="../../favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Split Open">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{url}card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{alt}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{url}card.png">
<meta name="twitter:image:alt" content="{alt}">
<script>
// Forward to the player, keeping the query and carrying this page's hash
// (the mix and the moment) after the song id. replace() keeps this page out
// of history, so Back leaves the player for wherever the link was.
location.replace('../../' + location.search + '#{id}' + (location.hash.length > 1 ? '&' + location.hash.slice(1) : ''));
</script>
<style>
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1026; color: #f4efe6; font: 400 18px/1.4 Inter, system-ui, sans-serif; text-align: center; }}
h1 {{ font-size: 28px; margin: 0 0 8px; }}
p {{ margin: 0 0 16px; color: #9aa0b8; }}
a {{ color: #f2b134; }}
</style>
</head>
<body>
<main>
<h1>{heading}</h1>
<p>{line}</p>
<p><a href="../../#{id}">Open in Split Open</a></p>
</main>
</body>
</html>
"""


def site_url():
    """The site's address, from the canonical link in index.html."""
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        m = re.search(r'<link rel="canonical" href="([^"]+/)">', f.read())
    if not m:
        raise SystemExit('song-pages: index.html has no canonical link to read the site address from')
    return m.group(1)


def load_yaml(name):
    with open(os.path.join(ROOT, name), encoding='utf-8') as f:
        return yaml12.load(f.read())


def lineup(song, band):
    """Who plays, in stem order: the band's lineup with the song's overrides."""
    channels = dict(band['channels'])
    for stem, ch in (song.get('channels') or {}).items():
        channels[stem] = {**channels.get(stem, {}), **ch}
    return [channels[stem]['who'] for stem in STEMS if stem in channels]


def join(items):
    if len(items) <= 2:
        return ' and '.join(items)
    return ', '.join(items[:-1]) + ', and ' + items[-1]


def render(song, band, site):
    title = f"{song['title']} — {band['name']}, {song['date']}"
    place = f"{song['venue']}, {song['city']}"
    when = f"{song['date']}" + (f", {song['set']}" if song.get('set') else '')
    description = (f"{band['name']} at {place}, {when}, split open: "
                   f"mute, solo, and fade {join(lineup(song, band))}.")
    fields = {
        'id': song['id'],
        'title': title,
        'heading': song['title'],
        'line': f"{band['name']} · {place} · {when}",
        'description': description,
        'url': f"{site}{OUT}/{song['id']}/",
        'alt': f"Split Open playing {song['title']}: a strip each for {join(lineup(song, band))}",
    }
    return PAGE.format(**{k: html.escape(v, quote=True) for k, v in fields.items()})


def page(song_id):
    """The page for one song, or None if there is no such song."""
    songs = load_yaml('songs.yaml')
    bands = load_yaml('bands.yaml')
    song = next((s for s in songs if s['id'] == song_id), None)
    if song is None:
        return None
    return render(song, bands[song['band']], site_url())


def main():
    songs = load_yaml('songs.yaml')
    bands = load_yaml('bands.yaml')
    site = site_url()
    out = os.path.join(ROOT, OUT)
    shutil.rmtree(out, ignore_errors=True)
    for song in songs:
        d = os.path.join(out, song['id'])
        os.makedirs(d)
        with open(os.path.join(d, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(render(song, bands[song['band']], site))
    print(f'{OUT}/: {len(songs)} song pages')


if __name__ == '__main__':
    main()
