#!/usr/bin/env python3
"""Checks songs.yaml and bands.yaml against what the player expects.

The player (see loadSong in app.js) reads a song's band from bands.yaml,
its stems from `dir` (meta.json and, per stem, a directory of Opus
segments, as scripts/segment-stems.py writes them), and optional per-stem
overrides from `channels`. `dir` is normally the song's URL in the stems
bucket, and every file it promises is checked with a HEAD request; a local
path is checked on disk. This script is strict: a missing or mistyped
field, an unknown field, a band the song names that is not in bands.yaml, a
segment that is not there, or a date that is not a date all fail the run
with the song named, so a pull request with a broken entry fails its check
and a bad merge fails the deploy. The shape of the files (fields, kinds,
required ones) is schemas/songs.schema.json and schemas/bands.schema.json,
applied through scripts/schema.py; this script adds what a schema cannot
say.

    python3 scripts/check-songs.py
"""
import datetime
import json
import math
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import yaml
import yaml12
import schema

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
STEMS = schema.STEMS
META_FIELDS = ['duration', 'segment', 'lead', 'segments']
URL = re.compile(r'^https?://\S+$')

# Cloudflare answers 403 to Python's default User-Agent; any other name is fine.
HEADERS = {'User-Agent': 'splitopen-check-songs'}


def load(name, errors):
    path = os.path.join(ROOT, name)
    try:
        with open(path, encoding='utf-8') as f:
            return yaml12.load(f.read())
    except OSError as e:
        errors.append(f'{name}: {e.strerror}')
    except yaml.YAMLError as e:
        errors.append(f'{name}: not valid YAML ({" ".join(str(e).split())})')
    return None


def read_meta(d):
    if URL.match(d):
        with urllib.request.urlopen(urllib.request.Request(d + 'meta.json', headers=HEADERS), timeout=30) as r:
            return json.load(r)
    with open(os.path.join(ROOT, d, 'meta.json'), encoding='utf-8') as f:
        return json.load(f)


def present(d, name):
    """Whether a file under `dir` exists and is not empty. The public bucket
    host rate-limits bursts with 429s, so those (and server errors) are
    retried with a growing pause; only a clear answer counts."""
    if not URL.match(d):
        p = os.path.join(ROOT, d, name)
        return os.path.isfile(p) and os.path.getsize(p) > 0
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(d + name, method='HEAD', headers=HEADERS), timeout=30) as r:
                return r.status == 200 and r.headers.get('Content-Length') != '0'
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            if e.code != 429 and e.code < 500:
                raise
        except OSError:
            pass
        time.sleep(0.5 * 2 ** attempt)
    return False


def check_stems(d, where, errors, stems):
    """meta.json and every segment it promises, for each of the song's stems."""
    try:
        meta = read_meta(d)
    except OSError as e:
        errors.append(f'{where}: cannot read {d}meta.json ({e}); run scripts/segment-stems.py and upload-stems.sh')
        return
    except ValueError as e:
        errors.append(f'{where}: {d}meta.json is not valid JSON ({e})')
        return
    if not isinstance(meta, dict):
        errors.append(f'{where}: {d}meta.json must be an object')
        return
    for key in meta:
        if key not in META_FIELDS:
            errors.append(f'{where}: {d}meta.json: unknown field "{key}"')
    for key in META_FIELDS:
        v = meta.get(key)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0 or (v == 0 and key != 'lead'):
            errors.append(f'{where}: {d}meta.json: "{key}" must be a positive number')
            return
    if not isinstance(meta['segments'], int) or meta['segments'] != math.ceil(meta['duration'] / meta['segment']):
        errors.append(f'{where}: {d}meta.json: "segments" should be {math.ceil(meta["duration"] / meta["segment"])} '
                      f'for {meta["duration"]} s in {meta["segment"]} s segments')
    names = [f'{stem}/{k:03d}.opus' for stem in stems for k in range(meta['segments'])]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for name, ok in zip(names, pool.map(lambda n: present(d, n), names)):
            if not ok:
                errors.append(f'{where}: missing or empty segment {d}{name}')


def check_bands(bands, errors):
    """Checks bands.yaml against its schema. Returns each band's channels map
    by slug, for the songs' checks."""
    errors += schema.check('bands.schema.json', bands, 'bands.yaml',
                           label=lambda path: schema.place(path[1:], str(path[0])) if path else '')
    if not isinstance(bands, dict):
        return {}
    return {slug: band.get('channels', {}) if isinstance(band, dict) else {} for slug, band in bands.items()}


def check_songs(songs, band_ids, errors):
    """Checks songs.yaml against its schema, then what the schema cannot say:
    ids are unique, the band is in bands.yaml, the date is a real date, dir
    is the song's own and holds its stems, and a stem a song adds that its
    band lacks has both who and inst."""
    def label(path):
        if not path or not isinstance(path[0], int):
            return schema.place(path)
        song = songs[path[0]]
        sid = song.get('id') if isinstance(song, dict) else None
        return schema.place(path[1:], sid if isinstance(sid, str) else f'[{path[0]}]')
    errors += schema.check('songs.schema.json', songs, 'songs.yaml', label=label)
    if not isinstance(songs, list):
        return
    seen = set()
    for i, song in enumerate(songs):
        if not isinstance(song, dict):
            continue
        sid = song.get('id')
        where = f'songs.yaml {sid}' if isinstance(sid, str) else f'songs.yaml [{i}]'
        if sid in seen:
            errors.append(f'{where}: duplicate id')
        seen.add(sid)
        band = song.get('band')
        if isinstance(band, str) and band not in band_ids:
            errors.append(f'{where}: band "{band}" is not in bands.yaml')
        band_channels = band_ids.get(band) or {}
        if not isinstance(band_channels, dict):
            band_channels = {}
        own = song.get('channels') if isinstance(song.get('channels'), dict) else {}
        stems = [s for s in STEMS if s in band_channels or s in own]  # the stems the player will fetch
        date = song.get('date')
        if isinstance(date, str) and re.match(r'^\d{4}-\d{2}-\d{2}$', date):
            try:
                datetime.date.fromisoformat(date)
            except ValueError:
                errors.append(f'{where}: there is no date {date}')
        d = song.get('dir')
        if isinstance(d, str) and (URL.match(d) or d.startswith('audio/songs/')) and d.endswith('/'):
            if isinstance(sid, str) and not d.endswith(f'/{sid}/'):
                errors.append(f'{where}: dir should end with "/{sid}/", not "{d}"')
            else:
                check_stems(d, where, errors, stems)
        for stem, ch in own.items():
            if stem in STEMS and stem not in band_channels and isinstance(ch, dict):
                for key in ('who', 'inst'):
                    if key not in ch:
                        errors.append(f'{where} channels.{stem}: a stem the band lacks needs "{key}" too')
    if not any(isinstance(s, dict) and not s.get('hidden') for s in songs):
        errors.append('songs.yaml: every song is hidden; the picker would be empty')


if __name__ == '__main__':
    errors = []
    bands = load('bands.yaml', errors)
    songs = load('songs.yaml', errors)
    band_ids = check_bands(bands, errors) if bands is not None else {}
    if songs is not None:
        check_songs(songs, band_ids, errors)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        sys.exit(1)
    print(f'{len(songs)} song(s) and {len(band_ids)} band(s) check out')
