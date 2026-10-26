#!/usr/bin/env python3
"""Checks the guide files under guides/ and writes guides.json from them.

guides.json maps a song id to the slugs of the guides kept at
guides/<song id>/<slug>.yaml, which is how the player finds them. The file
is derived, so a contribution is a single new .yaml file: the deploy
workflows run this before publishing. Run it by hand after adding a guide
locally.

Every guide is parsed the way the player parses it (see parseGuideText in
app.js), strictly: a file that is not valid YAML is an error, as is an
unknown key or player, a field of the wrong kind, a song id not in
songs.yaml, a guide without a title or without tips. The shape of a guide
is schemas/guide.schema.json, applied through scripts/schema.py; this
script adds what a schema cannot say. Any error fails the run, so a pull
request with a broken guide shows as a failed check and a bad merge fails
the deploy.

    python3 scripts/guides-index.py          # check, then rewrite guides.json
    python3 scripts/guides-index.py --lint   # check only
    python3 scripts/guides-index.py --check  # check, and exit 1 if guides.json is stale
"""
import json
import os
import re
import sys

import yaml
import yaml12
import schema

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SLUG = re.compile(r'^[\w-]+$')
CLOCK = re.compile(r'^\d+:\d{2}(?:\.\d+)?$')


def clock(s):
    """Seconds from m:ss, or None when it is not that."""
    if not isinstance(s, str) or not CLOCK.match(s):
        return None
    m, sec = s.split(':')
    return int(m) * 60 + float(sec)


def players(val):
    """The set of players named by solo: or mute:, a name or a list of them."""
    names = val if isinstance(val, list) else [val]
    return set(v for v in names if isinstance(v, str))


def check_tip(tip, where, errors):
    """What the schema cannot say about a tip: its end is after its start, and
    no player is both soloed and muted."""
    at, to = clock(tip.get('at')), clock(tip.get('to'))
    if at is not None and to is not None and to <= at:
        errors.append(f'{where}: the end is not after the start')
    if players(tip.get('solo', [])) & players(tip.get('mute', [])):
        errors.append(f'{where}: a player is both soloed and muted')


def check_guide(path, errors):
    where = os.path.relpath(path, ROOT)
    try:
        with open(path, encoding='utf-8') as f:
            g = yaml12.load(f.read())
    except yaml.YAMLError as e:
        errors.append(f'{where}: not valid YAML ({" ".join(str(e).split())})')
        return

    def label(p):
        if len(p) >= 2 and p[0] == 'tips' and isinstance(p[1], int):
            return schema.place(p[2:], f'tip {p[1] + 1}')
        return schema.place(p)
    errors += schema.check('guide.schema.json', g, where, label=label)
    if isinstance(g, dict) and isinstance(g.get('tips'), list):
        for n, tip in enumerate(g['tips'], 1):
            if isinstance(tip, dict):
                check_tip(tip, f'{where} tip {n}', errors)


def index(errors):
    guides = {}
    base = os.path.join(ROOT, 'guides')
    with open(os.path.join(ROOT, 'songs.yaml'), encoding='utf-8') as f:
        song_ids = {s['id'] for s in yaml12.load(f.read())}
    for song_id in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        song_dir = os.path.join(base, song_id)
        if not os.path.isdir(song_dir):
            continue
        if song_id not in song_ids:
            errors.append(f'guides/{song_id}: no such song in songs.yaml')
            continue
        slugs = []
        for f in sorted(os.listdir(song_dir)):
            if not f.endswith('.yaml'):
                continue
            slug = f[:-5]
            if not SLUG.match(slug):
                errors.append(f'guides/{song_id}/{f}: the file name may only have letters, digits, - and _')
                continue
            check_guide(os.path.join(song_dir, f), errors)
            slugs.append(slug)
        if slugs:
            guides[song_id] = slugs
    return guides


def render(guides):
    if not guides:
        return '{}\n'
    lines = [f'  {json.dumps(song)}: {json.dumps(slugs)}' for song, slugs in guides.items()]
    return '{\n' + ',\n'.join(lines) + '\n}\n'


if __name__ == '__main__':
    errors = []
    guides = index(errors)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        sys.exit(1)
    count = sum(len(v) for v in guides.values())
    path = os.path.join(ROOT, 'guides.json')
    text = render(guides)
    current = open(path).read() if os.path.exists(path) else ''
    if '--lint' in sys.argv:
        print(f'{count} guide(s) parse')
    elif '--check' in sys.argv:
        if current != text:
            print('guides.json is stale; run scripts/guides-index.py', file=sys.stderr)
            sys.exit(1)
        print(f'{count} guide(s) parse; guides.json is current')
    else:
        with open(path, 'w') as f:
            f.write(text)
        print(text, end='')
