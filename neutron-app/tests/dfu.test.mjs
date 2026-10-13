// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseFirmware, parseDfuSe, describeImage, buildDfuSe, parseMemoryLayout, DfuSeDevice,
  FLASH_BASE, SETTINGS_PAGE,
} from '../js/dfu.js';
import { FakeStm32Dfu } from './fake-stm32-dfu.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const cube = join(repo, 'neutr_cube');
const build = join(cube, 'build');
const read = (p) => new Uint8Array(readFileSync(p));
const haveBuild = existsSync(join(build, 'neutr_cube.bin'));

test('parses the original firmware files in the repo', () => {
  const stock = parseDfuSe(read(join(cube, 'Neutron_Dfuse_rom_dump_1_2_6.dfu')));
  assert.equal(stock.length, 1);
  assert.equal(stock[0].address, FLASH_BASE);
  assert.equal(stock[0].data.length, 128 * 1024);
  assert.equal(describeImage(stock).touchesSettings, true);

  const r15 = parseFirmware('r15f.dfu', read(join(cube, 'r15f.dfu')));
  assert.equal(r15[0].data.length, 78436);
});

test('damaged dfu file is rejected', () => {
  const b = read(join(cube, 'r15f.dfu'));
  b[500] ^= 0xFF;
  assert.throws(() => parseDfuSe(b), /crc/);
});

test('bin, hex and dfu of the build give the same image', { skip: !haveBuild && 'run make in neutr_cube first' }, () => {
  const bin = parseFirmware('neutr_cube.bin', read(join(build, 'neutr_cube.bin')));
  const hex = parseFirmware('neutr_cube.hex', read(join(build, 'neutr_cube.hex')));
  const dfu = parseFirmware('neutr_cube.dfu', read(join(build, 'neutr_cube.dfu')));
  assert.equal(hex.length, 1);
  assert.deepEqual(hex[0].data, bin[0].data);
  assert.deepEqual(dfu[0].data, bin[0].data);
  assert.equal(describeImage(bin).touchesSettings, false);
});

test('memory layout string', () => {
  assert.deepEqual(parseMemoryLayout('@Internal Flash  /0x08000000/064*0002Kg'), { start: FLASH_BASE, pages: 64, pageSize: 2048 });
});

test('image outside flash is refused', () => {
  assert.throws(() => describeImage([{ address: 0x08000000, data: new Uint8Array(130 * 1024) }]), /outside/);
  assert.throws(() => describeImage([{ address: 0x20000000, data: new Uint8Array(4) }]), /outside/);
});

async function openFake(initial) {
  const fake = new FakeStm32Dfu(initial);
  const dfu = new DfuSeDevice(fake);
  await dfu.open();
  return { fake, dfu };
}

test('flashing over the original firmware keeps the settings page', { skip: !haveBuild && 'run make in neutr_cube first' }, async () => {
  const stock = parseDfuSe(read(join(cube, 'Neutron_Dfuse_rom_dump_1_2_6.dfu')))[0].data;
  const { fake, dfu } = await openFake(stock);
  assert.equal(dfu.transferSize, 2048);
  const image = parseFirmware('neutr_cube.bin', read(join(build, 'neutr_cube.bin')));
  const stages = new Set();
  await dfu.flash(image, (s) => stages.add(s));
  assert.deepEqual([...stages], ['erase', 'write', 'verify']);
  const len = image[0].data.length;
  assert.deepEqual(fake.flash.subarray(0, len), image[0].data);
  const sp = SETTINGS_PAGE - FLASH_BASE;
  assert.deepEqual(fake.flash.subarray(sp), stock.subarray(sp), 'settings page and above untouched');
  assert.ok(fake.erasedPages.every((a) => a < SETTINGS_PAGE));
  await dfu.leave();
  assert.equal(fake.manifested, FLASH_BASE);
});

test('restoring the full original dump', async () => {
  const stockFile = read(join(cube, 'Neutron_Dfuse_rom_dump_1_2_6.dfu'));
  const garbage = new Uint8Array(128 * 1024).map((_, i) => (i * 7) & 0xFF);
  const { fake, dfu } = await openFake(garbage);
  await dfu.flash(parseFirmware('stock.dfu', stockFile));
  assert.deepEqual(fake.flash, parseDfuSe(stockFile)[0].data);
  assert.equal(fake.erasedPages.length, 64);
});

test('backup: read the whole flash and write it as a DfuSe file', async () => {
  const content = new Uint8Array(128 * 1024).map((_, i) => (i * 13 + 5) & 0xFF);
  const { dfu } = await openFake(content);
  const back = await dfu.read(FLASH_BASE, content.length);
  assert.deepEqual(back, content);
  const file = buildDfuSe(back);
  assert.deepEqual(parseDfuSe(file)[0].data, content);
  // same format as tools/bin2dfu.py
  assert.equal(String.fromCharCode(...file.slice(0, 5)), 'DfuSe');
});

test('a failed write is reported, and the next attempt recovers', async () => {
  const { fake, dfu } = await openFake();
  const image = [{ address: FLASH_BASE, data: new Uint8Array(4096).fill(0x12) }];
  const realErase = fake.execute.bind(fake);
  let skipErase = true;
  fake.execute = function () {
    if (skipErase && this.pending.block === 0 && this.pending.data[0] === 0x41) {
      this.pending = null; // pretend the erase did nothing
      this.flash.fill(0x00, 0, 4096);
      return;
    }
    realErase();
  };
  await assert.rejects(dfu.flash(image), /failed/);
  skipErase = false;
  await dfu.flash(image);
  assert.deepEqual(fake.flash.subarray(0, 4096), image[0].data);
});
