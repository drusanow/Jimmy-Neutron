import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, describePitch } from '../js/tuner.js';

const SR = 48000;
const wave = (f, kind, n = 4096) => Float32Array.from({ length: n }, (_, i) => {
  const ph = (i * f / SR) % 1;
  if (kind === 'saw') return 0.5 * (2 * ph - 1);
  if (kind === 'square') return ph < 0.5 ? 0.4 : -0.4;
  return 0.5 * Math.sin(2 * Math.PI * ph);
});

test('detects pitch of analog-like waveforms within 2 cents', () => {
  for (const kind of ['sine', 'saw', 'square']) {
    for (const f of [32.70, 55, 110, 261.63, 440, 880, 1760]) {
      const got = detectPitch(wave(f, kind), SR);
      const cents = 1200 * Math.log2(got / f);
      assert.ok(Math.abs(cents) < 2, `${kind} ${f} Hz -> ${got.toFixed(2)} (${cents.toFixed(2)} cents)`);
    }
  }
});

test('silence gives no reading', () => {
  assert.equal(detectPitch(new Float32Array(4096), SR), 0);
});

test('note names and cents', () => {
  assert.deepEqual(describePitch(440), { midi: 69, name: 'A4', cents: 0 });
  const d = describePitch(261.63 * 2 ** (10 / 1200));
  assert.equal(d.name, 'C4');
  assert.ok(Math.abs(d.cents - 10) < 0.1);
});
