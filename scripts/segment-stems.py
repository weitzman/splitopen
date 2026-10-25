#!/usr/bin/env python3
"""Encode a song's stems as short Opus segments, the form the player streams.

    scripts/segment-stems.py --out audio/songs/<id> \\
        guitar=G.wav bass=B.wav keys=P.wav+O.wav drums=D.wav vocals=V.wav

Only the stems given are encoded (the song's band lists which ones it has;
see bands.yaml); any of guitar, bass, keys, drums, vocals, horns, flute.

Each stem goes to <out>/<stem>/NNN.opus, where segment N holds seconds
[N*10, (N+1)*10) of the stem. Every segment after the first also carries a
0.1 s lead-in before that span, and every segment a 0.02 s tail after it,
which the player skips: an Opus decoder started cold needs a few frames to
settle, and the resampler and encoder smear the first and last few samples
of whatever they are given. Decoded and lined up on the grid, the segments
are then continuous to within codec noise; scripts/seam-test.py checks that.

<out>/meta.json records the duration and the grid for the player and for
check-songs.py:

    {"duration": 399.738, "segment": 10, "lead": 0.1, "segments": 40}

A stem given as a+b is the sum of both files (piano and other make keys).
Any input ffmpeg reads will do; each stem is resampled once to 48 kHz, the
rate Opus works at, so every cut falls on a sample. Stems shorter than the
longest are padded with silence to the same grid.
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

STEMS = ['guitar', 'bass', 'keys', 'drums', 'vocals', 'horns', 'flute']
RATE = 48000


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def ffmpeg(*args):
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args]


def to_wav48(inputs, out):
    """Sum the inputs (if more than one) into one 48 kHz float WAV."""
    cmd = ffmpeg()
    for f in inputs:
        cmd += ['-i', f]
    if len(inputs) > 1:
        cmd += ['-filter_complex', f'amix=inputs={len(inputs)}:normalize=0']
    cmd += ['-ar', str(RATE), '-c:a', 'pcm_f32le', out]
    run(cmd)


def sample_count(wav):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'a:0',
         '-show_entries', 'stream=time_base,duration_ts', '-of', 'csv=p=0', wav],
        check=True, capture_output=True, text=True).stdout.strip()
    tb, ts = out.split(',')
    num, den = tb.split('/')
    return round(int(ts) * int(num) * RATE / int(den))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', required=True, help='song directory, audio/songs/<id>')
    ap.add_argument('--bitrate', default='128k')
    ap.add_argument('--segment', type=float, default=10.0, help='seconds per segment')
    ap.add_argument('--lead', type=float, default=0.1, help='seconds before each segment but the first')
    ap.add_argument('--tail', type=float, default=0.02, help='seconds after each segment')
    ap.add_argument('stems', nargs='+', metavar='STEM=FILE[+FILE]')
    args = ap.parse_args()

    inputs = {}
    for spec in args.stems:
        if '=' not in spec:
            sys.exit(f'expected STEM=FILE, got {spec}')
        stem, files = spec.split('=', 1)
        if stem not in STEMS:
            sys.exit(f'unknown stem {stem}; one of {", ".join(STEMS)}')
        inputs[stem] = files.split('+')
        for f in inputs[stem]:
            if not os.path.isfile(f):
                sys.exit(f'{stem}: no such file {f}')
    stems = [s for s in STEMS if s in inputs]

    seg = round(args.segment * RATE)
    lead = round(args.lead * RATE)
    tail = round(args.tail * RATE)
    tmp = tempfile.mkdtemp(prefix='segment-stems-')
    try:
        wavs = {}
        for stem in stems:
            wavs[stem] = os.path.join(tmp, stem + '.wav')
            print(f'resampling {stem}', flush=True)
            to_wav48(inputs[stem], wavs[stem])
        n = max(sample_count(w) for w in wavs.values())
        count = math.ceil(n / seg)
        print(f'{n / RATE:.3f} s -> {count} segments of {args.segment:g} s per stem', flush=True)

        jobs = []
        for stem in stems:
            d = os.path.join(args.out, stem)
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d)
            for k in range(count):
                start = max(0, k * seg - lead)
                end = min(n, (k + 1) * seg + tail)
                jobs.append(ffmpeg(
                    '-i', wavs[stem],
                    '-af', f'atrim=start_sample={start}:end_sample={end},apad=whole_len={end - start}',
                    '-c:a', 'libopus', '-b:a', args.bitrate,
                    os.path.join(d, f'{k:03d}.opus')))
        with ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
            for _ in pool.map(run, jobs):
                pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    meta = {'duration': round(n / RATE, 3), 'segment': args.segment, 'lead': args.lead, 'segments': count}
    with open(os.path.join(args.out, 'meta.json'), 'w') as f:
        json.dump(meta, f)
        f.write('\n')
    print(f'wrote {len(jobs)} segments and meta.json to {args.out}')


if __name__ == '__main__':
    main()
