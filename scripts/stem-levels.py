#!/usr/bin/env python3
"""Measure a song's stem levels for the player's seek bar and meters.

    scripts/stem-levels.py audio/songs/<id>     a local song directory
    scripts/stem-levels.py <song id> ...        songs in songs.yaml, read from their dir URL
    scripts/stem-levels.py --all                every song in songs.yaml

Each stem's segments are decoded and lined up the way the player plays them
(scripts/seam-test.py does the same), and the RMS level of each 100 ms is
written to levels.json beside the song's meta.json:

    {"hz": 10, "floor": -60, "stems": {"guitar": "<base64>", ...}}

Each stem is one byte per 100 ms of the song, base64-encoded: 0 is silence
(below the floor), and 1..255 run from the floor up to 0 dBFS. A five-stem,
seven-minute song comes to about 20 KB. The player draws the seek bar from it
and runs the meters from it while paused, so neither needs decoded audio.

A song given by id is read from its `dir` in songs.yaml and its levels.json is
written to audio/songs/<id>/ (only that file; nothing else is downloaded to
disk). Upload it with `scripts/upload-stems.sh --levels <id>`.
segment-stems.py runs this on the song it has just encoded.
"""
import argparse
import base64
import http.client
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals', 'horns', 'flute']
RATE = 48000
HZ = 10
FLOOR = -60


def read(src, name):
    """A file from a song directory, local or http(s)."""
    if src.startswith(('http://', 'https://')):
        req = urllib.request.Request(src + name, headers={'User-Agent': 'splitopen-stem-levels'})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.read()
            except urllib.error.HTTPError:
                raise  # a real answer, such as 404 for a stem the song lacks
            except (urllib.error.URLError, OSError, http.client.HTTPException):
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
    with open(os.path.join(src, name), 'rb') as f:
        return f.read()


def decode(data):
    """Opus bytes to mono float32 at 48 kHz."""
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', str(RATE), 'pipe:1'],
        input=data, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def stem_levels(src, stem, meta, pool):
    seg = round(meta['segment'] * RATE)
    lead = round(meta['lead'] * RATE)
    n = round(meta['duration'] * RATE)
    count = meta['segments']
    pcm = list(pool.map(lambda k: decode(read(src, f'{stem}/{k:03d}.opus')), range(count)))
    parts = []
    for k, a in enumerate(pcm):
        skip = lead if k else 0
        want = min(seg, n - k * seg)
        a = a[skip:skip + want]
        if len(a) < want:
            a = np.concatenate([a, np.zeros(want - len(a), np.float32)])
        parts.append(a)
    x = np.concatenate(parts).astype(np.float64)
    hop = RATE // HZ
    frames = -(-len(x) // hop)
    x = np.concatenate([x, np.zeros(frames * hop - len(x))])
    rms = np.sqrt((x.reshape(frames, hop) ** 2).mean(axis=1))
    db = 20 * np.log10(np.maximum(rms, 1e-12))
    v = np.ceil((db - FLOOR) / -FLOOR * 255)
    v = np.where(db < FLOOR, 0, np.clip(v, 1, 255)).astype(np.uint8)
    return base64.b64encode(v.tobytes()).decode('ascii')


def song_levels(src):
    """levels.json for the song directory src (a path, or a URL ending in /)."""
    meta = json.loads(read(src, 'meta.json'))
    stems = {}
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for stem in STEMS:
            try:
                read_ok = src.startswith(('http://', 'https://')) or os.path.isdir(os.path.join(src, stem))
                if not read_ok:
                    continue
                stems[stem] = stem_levels(src, stem, meta, pool)
            except urllib.error.HTTPError as e:
                if e.code in (403, 404):
                    continue  # the song has no such stem
                raise
    if not stems:
        sys.exit(f'{src}: no stems found')
    return {'hz': HZ, 'floor': FLOOR, 'stems': stems}


def write(levels, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'levels.json')
    with open(path, 'w') as f:
        json.dump(levels, f, separators=(',', ':'))
        f.write('\n')
    print(f'wrote {path} ({", ".join(levels["stems"])})')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('songs', nargs='*', metavar='DIR|ID', help='a local song directory, or a song id in songs.yaml')
    ap.add_argument('--all', action='store_true', help='every song in songs.yaml')
    args = ap.parse_args()
    if not args.songs and not args.all:
        ap.error('give a song directory, song ids, or --all')

    songs = None
    def catalog():
        nonlocal songs
        if songs is None:
            import yaml12
            with open(os.path.join(ROOT, 'songs.yaml'), encoding='utf-8') as f:
                songs = {s['id']: s for s in yaml12.load(f.read())}
        return songs

    targets = list(catalog()) if args.all else args.songs
    for t in targets:
        if os.path.isdir(t):
            write(song_levels(t.rstrip('/') + '/'), t)
        elif t in catalog():
            print(f'measuring {t}', flush=True)
            write(song_levels(catalog()[t]['dir']), os.path.join(ROOT, 'audio', 'songs', t))
        else:
            sys.exit(f'{t}: not a directory or a song id in songs.yaml')


if __name__ == '__main__':
    main()
