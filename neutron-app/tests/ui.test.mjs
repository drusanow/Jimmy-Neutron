// Browser test: the real UI in Chromium, Web MIDI wired to the simulated Neutron
// (firmware usb_midi.c + sysex.c) and WebUSB to the simulated STM32 bootloader.
// Screenshots go to $SCREENSHOTS when set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/serve.mjs';
import { startSimulatedNeutron, SIM_PATH } from './sim-midi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let chromium = null;
try {
  const require = createRequire(join(execSync('npm root -g').toString().trim(), 'x'));
  ({ chromium } = require('playwright'));
} catch (e) { /* not installed */ }

const skip = (!chromium && 'playwright not installed') || (!existsSync(SIM_PATH) && 'run "make test" in neutr_cube first');
const shots = process.env.SCREENSHOTS;
const PORT = 8765;
let server; let browser; let sim; let page;

const MOCK_MIDI = `
  (() => {
    const input = new EventTarget();
    Object.assign(input, { id: 'in1', name: 'Neutron neutr_cube', state: 'connected', open: async () => {} });
    const output = { id: 'out1', name: 'Neutron neutr_cube', state: 'connected', open: async () => {},
      send: (d) => window.__midiOut(Array.from(d)) };
    window.__midiIn = (d) => input.dispatchEvent(Object.assign(new Event('midimessage'), { data: Uint8Array.from(d) }));
    const access = new EventTarget();
    access.inputs = new Map([['in1', input]]);
    access.outputs = new Map([['out1', output]]);
    navigator.requestMIDIAccess = async (o) => { window.__sysexAsked = !!(o && o.sysex); return access; };
  })();`;

before(async () => {
  if (skip) return;
  server = await startServer(PORT);
  browser = await chromium.launch();
  sim = startSimulatedNeutron();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => { throw e; });
  await page.exposeFunction('__midiOut', (bytes) => sim.output.send(bytes));
  sim.input.addEventListener('midimessage', (e) => page.evaluate((d) => window.__midiIn(d), Array.from(e.data)));
  await page.addInitScript(MOCK_MIDI);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`);
});

after(async () => {
  await browser?.close();
  server?.close();
  sim?.stop();
});

const shot = (name) => shots && page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });

test('connects and shows the settings', { skip }, async () => {
  await page.click('#connect');
  await page.waitForSelector('#status[data-state="on"]');
  assert.equal(await page.evaluate(() => window.__sysexAsked), true);
  assert.match(await page.textContent('#info-line'), /1\.6\.0-cube · MIDI channel 1/);
  assert.equal(await page.isVisible('#settings-grid'), true);
  assert.equal(await page.locator('#settings-grid .card').count(), 8);
  await shot('settings');
});

test('changing a setting reaches the synth and marks unsaved', { skip }, async () => {
  sim.events.length = 0;
  await page.selectOption('#settings-grid select[aria-label="LFO mode"]', '6');
  await page.waitForSelector('#dirty:not([hidden])');
  await page.click('#settings-grid .seg[aria-label="Filter mode"] button:has-text("High pass")');
  await page.waitForFunction(() => document.querySelector('.seg[aria-label="Filter mode"] button[aria-pressed="true"]')?.textContent === 'High pass');
  const set = sim.output.sent.filter((m) => m[4] === 0x03).map((m) => [m[5], m[6]]);
  assert.deepEqual(set.slice(-2), [[29, 6], [19, 2]]);
  await page.click('#save');
  await page.waitForSelector('#dirty[hidden]', { state: 'attached' });
  assert.ok(sim.events.includes('save'));
});

test('voice mode updates the mod input switches', { skip }, async () => {
  await page.selectOption('#settings-grid select[aria-label="Voice mode"]', '1');
  await page.waitForFunction(() => [...document.querySelectorAll('.seg[aria-label="Mod inputs (CV and mod depth)"] button[aria-pressed="true"]')]
    .every((b) => b.textContent === 'Off'));
});

test('tuning page: autotune and calibration steppers', { skip }, async () => {
  await page.click('#tab-tuning');
  sim.events.length = 0;
  await page.click('[data-autotune="1"]');
  await page.waitForSelector('#autotune-status.ok');
  assert.ok(sim.events.includes('autotune 1'));
  const val = page.locator('.cal-group').first().locator('.cal-row').first().locator('.val');
  assert.equal(await val.textContent(), '0x8A11');
  await page.locator('.cal-group').first().locator('button[aria-label="Note DAC scale +8"]').dispatchEvent('pointerdown');
  await page.locator('.cal-group').first().locator('button[aria-label="Note DAC scale +8"]').dispatchEvent('pointerup');
  await page.waitForFunction(() => document.querySelector('.cal-group .cal-row .val').textContent === '0x8A19');
  sim.events.length = 0;
  await page.click('#test-notes button:has-text("A4")');
  await page.click('#test-notes button:has-text("A4")');
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sim.events.includes('noteon 69 100'));
  assert.ok(sim.events.includes('noteoff 69'));
  await shot('tuning');
});

test('firmware page: install through the simulated bootloader', { skip }, async () => {
  await page.click('#tab-firmware');
  await page.waitForFunction(() => /kB/.test(document.querySelector('#fw-summary').textContent));
  assert.match(await page.textContent('#fw-summary'), /settings and calibration are kept/);
  await page.addScriptTag({ type: 'module', content: `
    import { FakeStm32Dfu } from '/tests/fake-stm32-dfu.mjs';
    window.__dfu = new FakeStm32Dfu();
    Object.defineProperty(navigator, 'usb', { value: { requestDevice: async () => window.__dfu }, configurable: true });
    window.__dfuReady = true;` });
  await page.waitForFunction(() => window.__dfuReady);
  await page.evaluate(() => { document.querySelector('#dfu-connect').disabled = false; });
  await page.click('#dfu-connect');
  await page.waitForSelector('#dfu-flash:not([disabled])');
  await page.click('#dfu-flash');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => /Firmware installed/.test(document.querySelector('#toast').textContent), null, { timeout: 60000 });
  const bin = new Uint8Array(readFileSync(join(here, '..', 'firmware', 'neutr_cube.bin')));
  const flashed = await page.evaluate((n) => Array.from(window.__dfu.flash.slice(0, n)), bin.length);
  assert.deepEqual(Uint8Array.from(flashed), bin);
  assert.equal(await page.evaluate(() => window.__dfu.manifested), 0x08000000);
  await shot('firmware');
});

test('phone width and light mode render', { skip }, async () => {
  if (!shots) return;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tab-settings');
  await shot('settings-phone');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(400); // colour transitions
  await shot('settings-light');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false);
});
