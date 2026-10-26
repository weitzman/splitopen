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
and a bad merge fails the deploy.

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

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SLUG = re.compile(r'^[\w-]+$')
STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals', 'horns', 'flute']
META_FIELDS = ['duration', 'segment', 'lead', 'segments']
URL = re.compile(r'^https?://\S+$')

SONG_REQUIRED = ['id', 'band', 'title', 'date', 'venue', 'city', 'source', 'dir']
# r2.dev answers 403 to Python's default User-Agent; any other name is fine.
HEADERS = {'User-Agent': 'splitopen-check-songs'}
SONG_OPTIONAL = ['set', 'hidden', 'channels']


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


def text(obj, key, where, errors, required=True):
    """A non-empty string field, or an error."""
    if key not in obj:
        if required:
            errors.append(f'{where}: no "{key}"')
        return None
    v = obj[key]
    if not isinstance(v, str) or not v.strip():
        errors.append(f'{where}: "{key}" must be a non-empty string')
        return None
    return v


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


def check_channels(channels, where, errors, complete, band_channels=()):
    """A map of stem id to {who, inst}. A band's lists the stems it has, each
    with both; a song's lists only what it overrides, or adds for the night
    (a stem its band lacks, which then needs both)."""
    if not isinstance(channels, dict):
        errors.append(f'{where}: "channels" must be a map keyed by stem')
        return
    if complete and not channels:
        errors.append(f'{where}: "channels" lists no stems')
    for stem, ch in channels.items():
        here = f'{where} channels.{stem}'
        if stem not in STEMS:
            errors.append(f'{here}: unknown stem (one of {", ".join(STEMS)})')
            continue
        if not isinstance(ch, dict):
            errors.append(f'{here}: must be a map with "who" and/or "inst"')
            continue
        for key in ch:
            if key not in ('who', 'inst'):
                errors.append(f'{here}: unknown field "{key}"')
        for key in ('who', 'inst'):
            text(ch, key, here, errors, required=complete or stem not in band_channels)


def check_bands(bands, errors):
    """Returns each band's channels map by slug."""
    if not isinstance(bands, dict):
        errors.append('bands.yaml: must be a map keyed by band slug')
        return {}
    for slug, band in bands.items():
        where = f'bands.yaml {slug}'
        if not SLUG.match(slug):
            errors.append(f'{where}: the slug may only have letters, digits, - and _')
        if not isinstance(band, dict):
            errors.append(f'{where}: must be a map with "name" and "channels"')
            continue
        for key in band:
            if key not in ('name', 'short_name', 'channels'):
                errors.append(f'{where}: unknown field "{key}"')
        text(band, 'name', where, errors)
        text(band, 'short_name', where, errors, required=False)
        if 'channels' in band:
            check_channels(band['channels'], where, errors, complete=True)
        else:
            errors.append(f'{where}: no "channels"')
    return {slug: band.get('channels', {}) if isinstance(band, dict) else {} for slug, band in bands.items()}


def check_songs(songs, band_ids, errors):
    if not isinstance(songs, list):
        errors.append('songs.yaml: must be a list of songs')
        return
    seen = set()
    for i, song in enumerate(songs):
        where = f'songs.yaml [{i}]'
        if not isinstance(song, dict):
            errors.append(f'{where}: must be a map')
            continue
        sid = text(song, 'id', where, errors)
        if sid:
            where = f'songs.yaml {sid}'
            if not SLUG.match(sid):
                errors.append(f'{where}: the id may only have letters, digits, - and _')
            if sid in seen:
                errors.append(f'{where}: duplicate id')
            seen.add(sid)
        for key in song:
            if key not in SONG_REQUIRED and key not in SONG_OPTIONAL:
                errors.append(f'{where}: unknown field "{key}"')
        for key in SONG_REQUIRED:
            if key not in ('id', 'band', 'date', 'source', 'dir'):
                text(song, key, where, errors)
        text(song, 'set', where, errors, required=False)
        band = text(song, 'band', where, errors)
        if band and band not in band_ids:
            errors.append(f'{where}: band "{band}" is not in bands.yaml')
        band_channels = band_ids.get(band) or {}
        if not isinstance(band_channels, dict):
            band_channels = {}
        own = song.get('channels') if isinstance(song.get('channels'), dict) else {}
        stems = [s for s in STEMS if s in band_channels or s in own]  # the stems the player will fetch
        date = text(song, 'date', where, errors)
        if date:
            try:
                datetime.date.fromisoformat(date)
                if not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
                    raise ValueError
            except ValueError:
                errors.append(f'{where}: date "{date}" is not YYYY-MM-DD')
        source = text(song, 'source', where, errors)
        if source and not URL.match(source):
            errors.append(f'{where}: source "{source}" is not a full link')
        d = text(song, 'dir', where, errors)
        if d:
            if sid and not d.endswith(f'/{sid}/'):
                errors.append(f'{where}: dir should end with "/{sid}/", not "{d}"')
            elif not (URL.match(d) or d.startswith('audio/songs/')):
                errors.append(f'{where}: dir "{d}" is neither a bucket URL nor audio/songs/{sid}/')
            else:
                check_stems(d, where, errors, stems)
        if 'hidden' in song and not isinstance(song['hidden'], bool):
            errors.append(f'{where}: "hidden" must be true or false')
        if 'channels' in song:
            check_channels(song['channels'], where, errors, complete=False, band_channels=band_channels)
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
