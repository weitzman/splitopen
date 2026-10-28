#!/usr/bin/env python3
"""Writes the player at s/<id>/ for every song, with the song's own link
preview, and a 404 page that boots the player.

A song's address is s/<id>/ (see the URL state section of app.js): the page
there is index.html with the song's title, band, date, venue and lineup in
its Open Graph and Twitter tags and its card (scripts/song-cards.py) as the
image, so a copied address unfurls as the song. A <base> after the charset
points the page's relative URLs at the site root. The mix and the moment
stay in the hash, which unfurlers never see.

404.html is index.html with an absolute <base>, so a path GitHub Pages has
no file for (a song id that is not in songs.yaml) still shows the player,
which falls back to the first song.

The pages are derived from index.html, songs.yaml and bands.yaml, so s/ and
404.html are gitignored: the deploy workflows run this before publishing,
and scripts/serve.py renders the same pages on the fly.

    python3 scripts/song-pages.py        # write s/<id>/index.html and 404.html
"""
import html
import os
import re
import shutil

import yaml12

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals', 'horns', 'flute']
OUT = 's'
BLOCK = re.compile(r'<!-- link preview:.*?-->\n(.*?)<!-- /link preview -->\n', re.S)
CHARSET = '<meta charset="utf-8">\n'

PREVIEW = """<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{url}">
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
"""


def index():
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        text = f.read()
    if not BLOCK.search(text) or CHARSET not in text:
        raise SystemExit('song-pages: index.html has no link preview block to replace')
    return text


def based(text, base):
    """index.html with a <base> so its relative URLs resolve at the site root."""
    return text.replace(CHARSET, CHARSET + f'<base href="{html.escape(base, quote=True)}">\n', 1)


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
    # The venue line as the player shows it under the title, then the slogan.
    where = ' · '.join([song['date'], band.get('short_name') or band['name'],
                        song['venue'], song['city']])
    who = join(lineup(song, band))
    fields = {
        'title': title,
        'description': f"{where}. Split Open, to learn & appreciate.",
        'url': f"{site}{OUT}/{song['id']}/",
        'alt': f"Split Open playing {song['title']}: a strip each for {who}",
    }
    preview = PREVIEW.format(**{k: html.escape(v, quote=True) for k, v in fields.items()})
    return BLOCK.sub(lambda m: preview, based(index(), '../../'), count=1)


def not_found(site):
    """404.html: the player at any path, with the site's own preview."""
    return based(index(), site)


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
    with open(os.path.join(ROOT, '404.html'), 'w', encoding='utf-8') as f:
        f.write(not_found(site))
    print(f'{OUT}/: {len(songs)} song pages, and 404.html')


if __name__ == '__main__':
    main()
