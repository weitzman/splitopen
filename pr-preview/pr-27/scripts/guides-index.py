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
songs.yaml, a guide without a title or without tips. Any error fails the
run, so a pull request with a broken guide shows as a failed check and a
bad merge fails the deploy.

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

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SLUG = re.compile(r'^[\w-]+$')
CLOCK = re.compile(r'^\d+:\d{2}(?:\.\d+)?$')
LANG = re.compile(r'^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$')
STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals']
GUIDE_KEYS = ['title', 'lang', 'by', 'url', 'tips']
TIP_KEYS = ['at', 'to', 'solo', 'mute', 'gain', 'pause', 'note']
GAIN_MAX = 1.5


def clock(s):
    m, sec = s.split(':')
    return int(m) * 60 + float(sec)


def check_clock(val, key, where, errors):
    """A time as m:ss (or m:ss.s), or an error."""
    if not isinstance(val, str) or not CLOCK.match(val):
        errors.append(f'{where}: {key} must be a time like 0:30 or 1:05.5, not {val!r}')
        return None
    return clock(val)


def check_text(obj, key, where, errors):
    """A string field, or an error. Returns the string, '' when absent."""
    if key not in obj:
        return ''
    if not isinstance(obj[key], str):
        errors.append(f'{where}: {key} must be text, not {obj[key]!r}')
        return ''
    return obj[key].strip()


def check_stems(val, key, where, errors):
    """A player name or a list of them, as solo: drums or solo: [drums, bass]."""
    names = val if isinstance(val, list) else [val]
    for v in names:
        if not isinstance(v, str) or v not in STEMS:
            errors.append(f'{where}: {key} names an unknown player {v!r} (one of {", ".join(STEMS)})')
    return set(v for v in names if isinstance(v, str))


def check_tip(tip, where, errors):
    if not isinstance(tip, dict):
        errors.append(f'{where}: a tip is a map with at:, a mix and note:')
        return
    for key in tip:
        if key not in TIP_KEYS:
            errors.append(f'{where}: unknown key "{key}" (one of {", ".join(TIP_KEYS)})')
    if 'at' not in tip:
        errors.append(f'{where}: no at:')
    at = check_clock(tip.get('at'), 'at', where, errors) if 'at' in tip else None
    to = check_clock(tip['to'], 'to', where, errors) if 'to' in tip else None
    if at is not None and to is not None and to <= at:
        errors.append(f'{where}: the end is not after the start')
    solo = check_stems(tip['solo'], 'solo', where, errors) if 'solo' in tip else set()
    mute = check_stems(tip['mute'], 'mute', where, errors) if 'mute' in tip else set()
    if solo & mute:
        errors.append(f'{where}: a player is both soloed and muted')
    if 'gain' in tip:
        gains = tip['gain']
        if not isinstance(gains, dict):
            errors.append(f'{where}: gain must be a map of player to level, like {{guitar: 0.8}}')
        else:
            for sid, v in gains.items():
                if sid not in STEMS or isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= GAIN_MAX:
                    errors.append(f'{where}: bad gain {sid}: {v!r} (a player and a level from 0 to {GAIN_MAX})')
    if 'pause' in tip and not isinstance(tip['pause'], bool):
        errors.append(f'{where}: pause must be true or false')
    check_text(tip, 'note', where, errors)


def check_guide(path, errors):
    where = os.path.relpath(path, ROOT)
    try:
        with open(path, encoding='utf-8') as f:
            g = yaml12.load(f.read())
    except yaml.YAMLError as e:
        errors.append(f'{where}: not valid YAML ({" ".join(str(e).split())})')
        return
    if not isinstance(g, dict):
        errors.append(f'{where}: a guide is a map with title: and tips:')
        return
    for key in g:
        if key not in GUIDE_KEYS:
            errors.append(f'{where}: unknown key "{key}" (one of {", ".join(GUIDE_KEYS)})')
    if not check_text(g, 'title', where, errors):
        errors.append(f'{where}: no title:')
    lang = check_text(g, 'lang', where, errors)
    if lang and not LANG.match(lang):
        errors.append(f'{where}: lang "{lang}" is not a language code like en or fr')
    check_text(g, 'by', where, errors)
    url = check_text(g, 'url', where, errors)
    if url and not re.match(r'^https?://\S+$', url):
        errors.append(f'{where}: url "{url}" is not a full link')
    tips = g.get('tips')
    if not isinstance(tips, list) or not tips:
        errors.append(f'{where}: no tips: list')
        return
    for n, tip in enumerate(tips, 1):
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
