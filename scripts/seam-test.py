#!/usr/bin/env python3
"""Check that a stem's segments join without seams when played on the grid.

    scripts/seam-test.py audio/songs/<id>/<stem> [--ref <source audio>]

Decodes every segment the way the player does (skipping each one's lead-in
and tail), lines them up end to end, and looks at the joins. Two measures:

- the sample-to-sample jump at each join, against the largest jump found
  anywhere else in the stem: a seam shows up as a jump the music never makes;
- with --ref, the error against the source around each join (20 ms either
  side) against the error elsewhere: a seam shows up as a local spike.

Prints both and exits non-zero when a join stands out. Needs ffmpeg and numpy.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

RATE = 48000


def decode(path):
    raw = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', path,
         '-f', 'f32le', '-ac', '2', '-ar', str(RATE), '-'],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('stem_dir')
    ap.add_argument('--ref', help='the source the stem was encoded from')
    args = ap.parse_args()

    with open(os.path.join(os.path.dirname(args.stem_dir.rstrip('/')), 'meta.json')) as f:
        meta = json.load(f)
    seg = round(meta['segment'] * RATE)
    lead = round(meta['lead'] * RATE)
    count = meta['segments']

    parts = []
    for k in range(count):
        pcm = decode(os.path.join(args.stem_dir, f'{k:03d}.opus'))
        skip = lead if k else 0
        parts.append(pcm[skip:skip + seg])
    stitched = np.concatenate(parts)
    joins = [k * seg for k in range(1, count)]
    ok = True

    # Jumps: the biggest step between neighbouring samples, at joins and elsewhere.
    mono = stitched.mean(axis=1)
    jump = np.abs(np.diff(mono))
    at_joins = max(jump[j - 1] for j in joins)
    mask = np.ones(len(jump), dtype=bool)
    for j in joins:
        mask[j - 1] = False
    elsewhere = jump[mask].max()
    print(f'largest jump at a join {at_joins:.5f}, elsewhere {elsewhere:.5f}')
    if at_joins > elsewhere * 1.5:
        print('  a join steps further than the music does anywhere else', file=sys.stderr)
        ok = False

    if args.ref:
        ref = decode(args.ref)
        n = min(len(ref), len(stitched))
        err = (stitched[:n] - ref[:n]).mean(axis=1)
        w = round(0.02 * RATE)
        rms = lambda x: float(np.sqrt(np.mean(x * x))) if len(x) else 0.0
        join_rms = max(rms(err[j - w:j + w]) for j in joins if j + w <= n)
        # Windows of the same size everywhere, 95th percentile so a loud passage does not hide a seam.
        blocks = err[:n - n % (2 * w)].reshape(-1, 2 * w)
        block_rms = np.sqrt((blocks * blocks).mean(axis=1))
        typical = float(np.percentile(block_rms, 95))
        print(f'error vs source: overall rms {rms(err):.5f}, worst 40 ms around a join {join_rms:.5f}, '
              f'95th percentile of 40 ms windows elsewhere {typical:.5f}')
        if join_rms > typical * 2:
            print('  the error spikes at a join', file=sys.stderr)
            ok = False

    print('seams: none found' if ok else 'seams: FOUND')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
