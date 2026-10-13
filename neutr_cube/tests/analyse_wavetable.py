#!/usr/bin/env python3
"""Checks the wavetable render from test_wavetable.c:
 - aliasing (energy away from the harmonics of f0) stays below -45 dB
 - output stays inside the dac range with headroom
 - fundamental frequency is the note frequency
"""
import sys
import numpy as np

SR = 48000
NOTES = [24, 36, 48, 60, 72, 84, 96, 108]
SHAPES = 9
data = np.fromfile(sys.argv[1], dtype='<u2').astype(np.float64)
blocks = data.reshape(len(NOTES), SHAPES, SR)
fails = 0
print('note  f0(Hz)  worst alias(dB)  peak use  harmonics>-60dB (min..max over morph)')
for ni, note in enumerate(NOTES):
    worst, nh = -999, []
    f0 = 440.0 * 2 ** ((note - 69) / 12)
    for si in range(SHAPES):
        x = blocks[ni, si] - 32768
        peak = np.max(np.abs(x)) / 32768
        if peak > 0.99:
            print('  clipping risk note %d shape %d peak %.3f' % (note, si, peak)); fails += 1
        X = np.abs(np.fft.rfft(x * np.hanning(len(x))))
        freqs = np.fft.rfftfreq(len(x), 1 / SR)
        k = np.argmax(X[1:]) + 1
        harm = np.zeros_like(X, dtype=bool)
        h = 1
        while h * f0 < SR / 2:
            harm |= np.abs(freqs - h * f0) < 6
            h += 1
        harm |= freqs < 3
        total = np.sum(X ** 2)
        alias = np.sum(X[~harm] ** 2)
        worst = max(worst, 10 * np.log10(alias / total + 1e-30))
        lvl = 20 * np.log10(X / X.max() + 1e-12)
        nh.append(int(np.sum([lvl[np.argmin(np.abs(freqs - hh * f0))] > -60 for hh in range(1, int(SR / 2 / f0))])))
        if si == 0 and abs(freqs[k] - f0) > max(2, f0 * 0.003):
            print('  pitch error note %d: %.1f Hz vs %.1f' % (note, freqs[k], f0)); fails += 1
    print('%4d %8.1f %12.1f      %.2f      %d..%d' % (note, f0, worst, peak, min(nh), max(nh)))
    if worst > -45:
        fails += 1
print('wavetable: all passed' if not fails else 'wavetable: %d FAILED' % fails)
sys.exit(1 if fails else 0)
