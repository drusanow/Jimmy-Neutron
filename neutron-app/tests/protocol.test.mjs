// End to end: app protocol code <-> firmware usb_midi.c + sysex.c (simulated device)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { NeutronLink, PARAMS, PARAM_BY_KEY, encodeValue, decodeValue, buildRequest } from '../js/protocol.js';
import { startSimulatedNeutron, SIM_PATH } from './sim-midi.mjs';

const skip = !existsSync(SIM_PATH) && 'run "make test" in neutr_cube first';
let sim;
let link;

before(() => {
  if (skip) return;
  sim = startSimulatedNeutron();
  link = new NeutronLink(sim.input, sim.output);
});
after(() => { if (sim) { link.close(); sim.stop(); } });

test('value encoding round trip', () => {
  for (const v of [0, 1, 127, 128, 0xFFF, 0x7FFF, 0xFFFF, -1, -0x8000, 0xFFFFF, -0x100000]) {
    assert.equal(decodeValue(...encodeValue(v)), v);
  }
  assert.throws(() => buildRequest(3, [0x80]));
});

test('info', { skip }, async () => {
  const info = await link.info();
  assert.equal(info.protocol, 1);
  assert.equal(info.version, '1.6.0-cube');
  assert.equal(info.paramCount, PARAMS.length, 'app and firmware know the same parameters');
});

test('read all parameters', { skip }, async () => {
  const v = await link.getAll();
  assert.equal(Object.keys(v).length, PARAMS.length);
  assert.equal(v[PARAM_BY_KEY.o1tunecf.id], 0x8A00);
  assert.equal(v[PARAM_BY_KEY.o1oct.id], 1);
  assert.equal(v[PARAM_BY_KEY.asmode.id], 2);
  assert.equal(v[PARAM_BY_KEY.shpdrift_rate.id], 0x600);
});

test('every parameter accepts its whole range', { skip }, async () => {
  for (const p of PARAMS) {
    assert.equal(await link.set(p.id, p.min), p.min, `${p.key} min`);
    assert.equal(await link.set(p.id, p.max), p.max, `${p.key} max`);
  }
});

test('out of range values are limited by the firmware', { skip }, async () => {
  assert.equal(await link.set(PARAM_BY_KEY.o1pwrange.id, 99), 24);
  assert.equal(await link.set(PARAM_BY_KEY.lfomode.id, 9), 6);
  assert.equal(await link.set(PARAM_BY_KEY.o1tunecf.id, 0), 0x4CCC);
  assert.equal(await link.set(PARAM_BY_KEY.o2tuneoff.id, -1234), -1234);
  assert.equal(await link.set(PARAM_BY_KEY.lfosyncstart.id, 0x800), 0x800);
});

test('unknown parameter is reported', { skip }, async () => {
  await assert.rejects(link.set(100, 1), /not supported/);
});

test('voice mode switch applies the panel side effects', { skip }, async () => {
  sim.events.length = 0;
  await link.set(PARAM_BY_KEY.paraphony.id, 1);
  assert.ok(sim.events.includes('paramode 1'));
  const v = await link.getAll();
  assert.equal(v[PARAM_BY_KEY.o1moddis.id], 1);
  await link.set(PARAM_BY_KEY.paraphony.id, 0);
  assert.equal((await link.getAll())[PARAM_BY_KEY.o2moddis.id], 0);
});

test('autotune updates the calibration', { skip }, async () => {
  sim.events.length = 0;
  await link.autotune(2);
  assert.deepEqual(sim.events.filter((e) => e.startsWith('autotune')), ['autotune 2']);
  const v = await link.getAll();
  assert.equal(v[PARAM_BY_KEY.o2tunecf.id], 0x8A22);
});

test('save, defaults, bootloader', { skip }, async () => {
  sim.events.length = 0;
  await link.save();
  await link.set(PARAM_BY_KEY.o1oct.id, 2);
  await link.defaults();
  assert.equal((await link.getAll())[PARAM_BY_KEY.o1oct.id], 1);
  await link.bootloader();
  assert.ok(sim.events.includes('save'));
  assert.ok(sim.events.includes('defaults'));
  assert.ok(sim.events.includes('bootloader'));
});

test('test notes reach the synth', { skip }, async () => {
  sim.events.length = 0;
  link.note(0, 69, 100);
  link.note(0, 69, 0);
  await link.info(); // round trip so the notes are processed
  assert.ok(sim.events.includes('noteon 69 100'));
  assert.ok(sim.events.includes('noteoff 69'));
});
