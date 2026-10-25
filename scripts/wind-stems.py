#!/usr/bin/env python3
"""Split BS-Roformer-SW's "other" stem into horns and flute.

    scripts/wind-stems.py OTHER.wav FLUTE.wav --horns horns.wav --flute flute.wav

BS-Roformer-SW has no wind class: a horn section and a flute both land in
its "other" stem (and nowhere else; see the TTB test of 2026-10-25). The
53-stem MVSep Mega model (ZFTurbo, Music-Source-Separation-Training release
v1.0.21) does have a flute stem, so the flute is taken from it and the horns
are what is left of "other" once that flute is subtracted. The two stems
then still sum to "other", so the mix is unchanged.

The Mega model is run on the same source file as BS-Roformer-SW with
inference.py from that repository:

    python inference.py --model_type bs_roformer \\
        --config_path mvsep_mega_model_bs_roformer_53_stems.yaml \\
        --start_check_point mvsep_mega_model_bs_roformer_53_stems_v1.ckpt \\
        --input_folder <dir with the source wav> --store_dir <out>

and writes <out>/<source>/flute.wav among 52 others. Both inputs must be
the same length and rate (44.1 kHz stereo); the flute is clipped to the
energy of "other" per sample block so a stray loud flute estimate cannot
leave negative horns.
"""
import argparse
import sys

import numpy as np
import soundfile as sf


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('other', help='the BS-Roformer-SW "other" stem')
    ap.add_argument('flute', help='the Mega model flute stem of the same source')
    ap.add_argument('--horns', required=True, help='output WAV: other minus flute')
    ap.add_argument('--flute-out', dest='flute_out', required=True, help='output WAV: the flute')
    args = ap.parse_args()

    other, sr = sf.read(args.other, dtype='float32', always_2d=True)
    flute, sr2 = sf.read(args.flute, dtype='float32', always_2d=True)
    if sr != sr2:
        sys.exit(f'sample rates differ: {sr} vs {sr2}')
    if abs(len(other) - len(flute)) > sr // 10:
        sys.exit(f'lengths differ by {abs(len(other) - len(flute)) / sr:.2f} s; same source file?')
    n = min(len(other), len(flute))
    other, flute = other[:n], flute[:n]

    # The flute estimate may not sit exactly inside "other"; scale it per
    # 100 ms block so its energy never exceeds other's there.
    block = sr // 10
    for a in range(0, n, block):
        o = other[a:a + block]; f = flute[a:a + block]
        eo, ef = float((o ** 2).sum()), float((f ** 2).sum())
        if ef > eo and ef > 0:
            flute[a:a + block] = f * np.sqrt(eo / ef)
    horns = other - flute

    sf.write(args.horns, horns, sr, subtype='FLOAT')
    sf.write(args.flute_out, flute, sr, subtype='FLOAT')
    e = lambda x: 10 * np.log10(float((x ** 2).sum()) + 1e-12)
    print(f'other {e(other):.1f} dB -> horns {e(horns):.1f} dB, flute {e(flute):.1f} dB (relative)')


if __name__ == '__main__':
    main()
