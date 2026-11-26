#!/usr/bin/env python3
"""Split BS-Roformer-SW's "other" stem between channels using the 53-stem
MVSep Mega model's estimates as a guide.

    scripts/split-other.py OTHER.wav --out DIR \\
        horns=mega/wind.wav keys=mega/organ.wav [flute=mega/flute.wav]

BS-Roformer-SW has no wind class and puts a horn section, a flute and, for
Tedeschi Trucks Band, the organ together in "other" (its piano stem holds
only piano). The Mega model (ZFTurbo, Music-Source-Separation-Training
release v1.0.21) tells them apart but its stems are rougher, so its output
is used only as a map: for every STFT bin, "other" is divided among the
named parts in proportion to the energy the Mega stems show there (a
Wiener-style mask), and the parts sum back to "other" exactly, so the mix
is unchanged. Each part goes to DIR/<name>.wav; keys from here is added to
BS-Roformer-SW's piano stem when the song is encoded.

The Mega model is run on the same source file as BS-Roformer-SW:

    python inference.py --model_type bs_roformer \\
        --config_path mvsep_mega_model_bs_roformer_53_stems.yaml \\
        --start_check_point mvsep_mega_model_bs_roformer_53_stems_v1.ckpt \\
        --input_folder <dir with the source wav> --store_dir <out>

A reference may be a sum of Mega stems, written a+b. Several references
can be given per part by repeating the name.
"""
import argparse
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import stft, istft

N_FFT = 4096
HOP = 1024


def read(path, n=None):
    x, sr = sf.read(path, dtype='float32', always_2d=True)
    return (x if n is None else x[:n]), sr


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('other', help='the BS-Roformer-SW "other" stem')
    ap.add_argument('--out', required=True, help='directory for <part>.wav files')
    ap.add_argument('--smooth', type=int, default=3, help='frames of mask smoothing either side (default 3)')
    ap.add_argument('parts', nargs='+', metavar='PART=MEGA.wav[+MEGA.wav]')
    args = ap.parse_args()

    other, sr = read(args.other)
    n = len(other)
    refs = {}
    for spec in args.parts:
        name, files = spec.split('=', 1)
        for f in files.split('+'):
            x, sr2 = read(f, n)
            if sr2 != sr:
                sys.exit(f'{f}: {sr2} Hz, other is {sr} Hz')
            if abs(len(x) - n) > sr // 10:
                sys.exit(f'{f}: length differs from other by {abs(len(x) - n) / sr:.2f} s; same source?')
            if len(x) < n:
                x = np.pad(x, ((0, n - len(x)), (0, 0)))
            refs[name] = refs.get(name, 0) + x
    names = list(refs)
    if len(names) < 2:
        sys.exit('give at least two parts')

    # Power spectrogram per reference, summed over channels and smoothed in
    # time so the mask does not flicker; the same window for other.
    def spec(x):
        _, _, z = stft(x.T, fs=sr, nperseg=N_FFT, noverlap=N_FFT - HOP, padded=True)
        return z
    pw = {}
    for name in names:
        p = (np.abs(spec(refs[name])) ** 2).sum(axis=0)
        if args.smooth:
            k = np.ones(2 * args.smooth + 1) / (2 * args.smooth + 1)
            p = np.apply_along_axis(lambda r: np.convolve(r, k, mode='same'), 1, p)
        pw[name] = p
    total = sum(pw.values())
    # Where every reference is silent, split evenly so the parts still sum to other.
    silent = total <= 1e-12
    zo = spec(other)
    os.makedirs(args.out, exist_ok=True)
    e_other = float((other ** 2).sum()) + 1e-12
    for name in names:
        mask = np.where(silent, 1 / len(names), pw[name] / np.where(silent, 1, total))
        _, y = istft(zo * mask[None, :, :], fs=sr, nperseg=N_FFT, noverlap=N_FFT - HOP)
        y = y.T[:n].astype('float32')
        if len(y) < n:
            y = np.pad(y, ((0, n - len(y)), (0, 0)))
        sf.write(os.path.join(args.out, name + '.wav'), y, sr, subtype='FLOAT')
        print(f'{name}: {10 * np.log10(float((y ** 2).sum()) / e_other + 1e-12):.1f} dB of other')


if __name__ == '__main__':
    main()
