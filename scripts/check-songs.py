#!/usr/bin/env python3
"""Checks songs.yaml and bands.yaml against what the player expects.

The player (see loadSong in app.js) reads a song's band from bands.yaml,
its five stems from `dir`, and optional per-stem overrides from `channels`.
This script is strict: a missing or mistyped field, an unknown field, a
band the song names that is not in bands.yaml, a stem file that is not
there, or a date that is not a date all fail the run with the song named,
so a pull request with a broken entry fails its check and a bad merge
fails the deploy.

    python3 scripts/check-songs.py
"""
import datetime
import os
import re
import sys

import yaml
import yaml12

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SLUG = re.compile(r'^[\w-]+$')
STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals']
STEM_FILES = [s + '.opus' for s in STEMS]
URL = re.compile(r'^https?://\S+$')

SONG_REQUIRED = ['id', 'band', 'title', 'date', 'venue', 'city', 'source', 'dir']
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


def check_channels(channels, where, errors, complete):
    """A map of stem id to {who, inst}. A band's lists every stem with
    both; a song's lists only what it overrides."""
    if not isinstance(channels, dict):
        errors.append(f'{where}: "channels" must be a map keyed by stem')
        return
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
            text(ch, key, here, errors, required=complete)
    if complete:
        for stem in STEMS:
            if stem not in channels:
                errors.append(f'{where}: no channel for "{stem}"')


def check_bands(bands, errors):
    if not isinstance(bands, dict):
        errors.append('bands.yaml: must be a map keyed by band slug')
        return set()
    for slug, band in bands.items():
        where = f'bands.yaml {slug}'
        if not SLUG.match(slug):
            errors.append(f'{where}: the slug may only have letters, digits, - and _')
        if not isinstance(band, dict):
            errors.append(f'{where}: must be a map with "name" and "channels"')
            continue
        for key in band:
            if key not in ('name', 'channels'):
                errors.append(f'{where}: unknown field "{key}"')
        text(band, 'name', where, errors)
        if 'channels' in band:
            check_channels(band['channels'], where, errors, complete=True)
        else:
            errors.append(f'{where}: no "channels"')
    return set(bands)


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
            if sid and d != f'audio/songs/{sid}/':
                errors.append(f'{where}: dir should be "audio/songs/{sid}/", not "{d}"')
            for f in STEM_FILES:
                p = os.path.join(ROOT, d, f)
                if not os.path.isfile(p):
                    errors.append(f'{where}: missing stem {d}{f}')
                elif os.path.getsize(p) == 0:
                    errors.append(f'{where}: empty stem {d}{f}')
        if 'hidden' in song and not isinstance(song['hidden'], bool):
            errors.append(f'{where}: "hidden" must be true or false')
        if 'channels' in song:
            check_channels(song['channels'], where, errors, complete=False)
    if not any(isinstance(s, dict) and not s.get('hidden') for s in songs):
        errors.append('songs.yaml: every song is hidden; the picker would be empty')


if __name__ == '__main__':
    errors = []
    bands = load('bands.yaml', errors)
    songs = load('songs.yaml', errors)
    band_ids = check_bands(bands, errors) if bands is not None else set()
    if songs is not None:
        check_songs(songs, band_ids, errors)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        sys.exit(1)
    print(f'{len(songs)} song(s) and {len(band_ids)} band(s) check out')
