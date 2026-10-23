#!/usr/bin/env python3
"""Checks the guide files under guides/ and writes guides.json from them.

guides.json maps a song id to the slugs of the guides kept at
guides/<song id>/<slug>.txt, which is how the player finds them. The file
is derived, so a contribution is a single new .txt file: the deploy
workflows run this before publishing. Run it by hand after adding a guide
locally.

Every guide is parsed the way the player parses it (see parseGuideText in
app.js), strictly: a line that is neither a header, a tip, a comment nor
blank is an error, as is an unknown tip key or player, a song id not in
songs.json, a guide without a title or without tips. Any error fails the
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

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SLUG = re.compile(r'^[\w-]+$')
CLOCK = r'\d+:\d{2}(?:\.\d+)?'
TIP = re.compile(r'^(' + CLOCK + r')\s*([^|]*)(?:\|\s*(.*))?$')
HEADER = re.compile(r'^(title|lang|by|url):\s*(.*)$', re.I)
LANG = re.compile(r'^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$')
STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals']
GAIN_MAX = 1.5


def clock(s):
    m, sec = s.split(':')
    return int(m) * 60 + float(sec)


def stem_list(val, where, errors):
    ids = [v for v in val.split(',') if v]
    for v in ids:
        if v not in STEMS:
            errors.append(f'{where}: unknown player "{v}" (one of {", ".join(STEMS)})')
    return ids


def check_tip(keys, where, errors):
    at = None
    to = None
    solo = mute = []
    for tok in keys.split():
        key, eq, val = tok.partition('=')
        if key in ('solo', 'mute'):
            ids = stem_list(val, where, errors)
            if key == 'solo':
                solo = ids
            else:
                mute = ids
        elif key == 'g':
            for item in val.split(','):
                sid, _, v = item.partition(':')
                try:
                    n = float(v)
                except ValueError:
                    n = None
                if sid not in STEMS or n is None or not 0 <= n <= GAIN_MAX:
                    errors.append(f'{where}: bad gain "{item}" (player:value, 0 to {GAIN_MAX})')
        elif key == 'to':
            if not re.fullmatch(CLOCK, val):
                errors.append(f'{where}: bad end "{val}" (m:ss)')
            else:
                to = clock(val)
        elif key == 'pause' and not eq:
            pass
        else:
            errors.append(f'{where}: unknown key "{tok}" (solo=, mute=, g=, to=, pause)')
    if set(solo) & set(mute):
        errors.append(f'{where}: a player is both soloed and muted')
    return to


def check_guide(path, errors):
    where = os.path.relpath(path, ROOT)
    headers = {}
    tips = 0
    for n, raw in enumerate(open(path, encoding='utf-8'), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        here = f'{where}:{n}'
        m = TIP.match(line)
        if not m:
            h = HEADER.match(line)
            if h:
                headers[h.group(1).lower()] = h.group(2).strip()
            else:
                errors.append(f'{here}: not a header (title:, lang:, by:, url:) nor a tip (m:ss ... | note)')
            continue
        tips += 1
        at = clock(m.group(1))
        to = check_tip(m.group(2), here, errors)
        if to is not None and to <= at:
            errors.append(f'{here}: the end is not after the start')
        if m.group(3) is None:
            errors.append(f'{here}: a tip needs a | before its note')
    if not headers.get('title'):
        errors.append(f'{where}: no title: header')
    if headers.get('lang') and not LANG.match(headers['lang']):
        errors.append(f'{where}: lang "{headers["lang"]}" is not a language code like en or fr')
    if headers.get('url') and not re.match(r'^https?://\S+$', headers['url']):
        errors.append(f'{where}: url "{headers["url"]}" is not a full link')
    if not tips:
        errors.append(f'{where}: no tips')


def index(errors):
    guides = {}
    base = os.path.join(ROOT, 'guides')
    with open(os.path.join(ROOT, 'songs.json'), encoding='utf-8') as f:
        song_ids = {s['id'] for s in json.load(f)}
    for song_id in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        song_dir = os.path.join(base, song_id)
        if not os.path.isdir(song_dir):
            continue
        if song_id not in song_ids:
            errors.append(f'guides/{song_id}: no such song in songs.json')
            continue
        slugs = []
        for f in sorted(os.listdir(song_dir)):
            if not f.endswith('.txt'):
                continue
            slug = f[:-4]
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
