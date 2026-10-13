import { NeutronLink, PARAMS, PARAM_BY_KEY, clampParam } from './protocol.js';
import { parseFirmware, describeImage, DfuSeDevice, buildDfuSe, FLASH_BASE, FLASH_SIZE } from './dfu.js';
import { Tuner, describePitch, noteName } from './tuner.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
};

const state = {
  midi: null,
  link: null,
  info: null,
  values: {},
  dirty: false,
  views: new Map(), // param id -> [update(value)]
  dfu: null,
};

////////////////////////////////////////////////////////////////////////////
// small ui helpers

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isError);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}

function log(msg) {
  const l = $('#log');
  const time = new Date().toLocaleTimeString();
  l.textContent += `${time}  ${msg}\n`;
  l.scrollTop = l.scrollHeight;
}

function confirmDialog(title, text, okLabel = 'OK') {
  const d = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

function setStatus(text, s) {
  $('#status-text').textContent = text;
  $('#status').dataset.state = s;
}

function setDirty(d) {
  state.dirty = d;
  $('#dirty').hidden = !d;
}

////////////////////////////////////////////////////////////////////////////
// value formatting

function driftHz(v) {
  const inc = 21475 + Math.floor((v * v) / 1024) * 217; // same as osc_shape.c
  return (inc * 6000) / 2 ** 32;
}

function formatValue(p, v) {
  if (v === undefined) return '';
  if (p.options) return p.options[v] ?? String(v);
  if (p.toggle) return v ? 'On' : 'Off';
  if (p.percent) return `${Math.round((v / p.max) * 100)}%`;
  if (p.degrees) return `${Math.round((v * 360) / 4096)}°`;
  if (p.driftHz) return `${driftHz(v).toFixed(2)} Hz`;
  if (p.unit) return `${v} ${p.unit}`;
  if (p.hex) return `${v < 0 ? '-' : ''}0x${Math.abs(v).toString(16).toUpperCase().padStart(4, '0')}`;
  return String(v);
}

////////////////////////////////////////////////////////////////////////////
// sending values: newest value wins, one request in flight per parameter

const senders = new Map();

function sendValue(p, v) {
  v = clampParam(p, v);
  state.values[p.id] = v;
  refreshViews(p.id, v);
  if (!state.link) return;
  let s = senders.get(p.id);
  if (!s) {
    s = { busy: false, next: null };
    senders.set(p.id, s);
  }
  s.next = v;
  if (s.busy) return;
  const pump = async () => {
    s.busy = true;
    while (s.next !== null) {
      const val = s.next;
      s.next = null;
      try {
        const actual = await state.link.set(p.id, val);
        if (s.next === null) {
          state.values[p.id] = actual;
          refreshViews(p.id, actual);
        }
        setDirty(true);
        if (p.key === 'paraphony') await reloadValues(); // also changes the mod inputs
      } catch (e) {
        toast(e.message, true);
      }
    }
    s.busy = false;
  };
  pump();
}

function refreshViews(id, v) {
  for (const update of state.views.get(id) || []) update(v);
}

function bindView(id, update) {
  if (!state.views.has(id)) state.views.set(id, []);
  state.views.get(id).push(update);
  if (state.values[id] !== undefined) update(state.values[id]);
}

////////////////////////////////////////////////////////////////////////////
// controls

function control(p, opts = {}) {
  const value = el('span', { class: 'field-value' });
  const head = el('div', { class: 'field-head' }, el('span', { class: 'field-label' }, opts.label || p.label), value);
  let field;

  if (p.toggle) {
    const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': p.label });
    input.addEventListener('change', () => sendValue(p, input.checked ? 1 : 0));
    field = el('div', { class: 'field inline' }, el('span', { class: 'field-label' }, opts.label || p.label),
      el('label', { class: 'switch' }, input, el('span')));
    bindView(p.id, (v) => { input.checked = !!v; });
    return field;
  }

  if (p.options && (p.options.length <= 3 && p.options.every((o) => o.length <= 12))) {
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': p.label });
    const buttons = p.options.map((o, i) => el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => sendValue(p, i) }, o));
    seg.append(...buttons);
    field = el('div', { class: 'field' }, head, seg);
    bindView(p.id, (v) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === v))));
    return field;
  }

  if (p.options) {
    const select = el('select', { 'aria-label': p.label, onchange: () => sendValue(p, Number(select.value)) },
      p.options.map((o, i) => el('option', { value: i }, o)));
    field = el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('span', { class: 'field-label' }, opts.label || p.label)), select);
    bindView(p.id, (v) => { select.value = String(v); });
    return field;
  }

  const range = el('input', { type: 'range', min: p.min, max: p.max, step: 1, 'aria-label': p.label });
  range.addEventListener('input', () => {
    value.textContent = formatValue(p, Number(range.value));
    sendValue(p, Number(range.value));
  });
  field = el('div', { class: 'field' }, head, range);
  bindView(p.id, (v) => {
    if (document.activeElement !== range) range.value = String(v);
    value.textContent = formatValue(p, v);
  });
  return field;
}

const SETTINGS_LAYOUT = [
  { title: 'Oscillator 1', keys: ['o1oct', 'o1widerange', 'o1pwrange', 'o1glide', 'o1moddis'] },
  { title: 'Oscillator 2', keys: ['o2oct', 'o2widerange', 'o2pwrange', 'o2glide', 'o2moddis'] },
  { title: 'Voices', keys: ['paraphony', 'osync', 'gateretrig'] },
  { title: 'Filter', keys: ['filtertype', 'filterkeytrack'] },
  { title: 'LFO', keys: ['lfomode', 'lfokeysync', 'lfomidisync', 'lfoextsynctype', 'lfosyncstart'] },
  { title: 'LFO as an oscillator', tag: 'oscillator modes', keys: ['lfooscsrc', 'lfooscquant'],
    note: 'LFO RATE sets the pitch offset: ±12 semitones, or ±40 with key sync on.' },
  { title: 'Shape drift', keys: ['shpdrift_depth', 'shpdrift_rate'],
    note: 'Slow movement of both oscillator shapes around the knob positions. OSC 2 drifts at a different speed.' },
  { title: 'Assign output', keys: ['asmode'] },
];

function buildSettings() {
  const grid = $('#settings-grid');
  grid.replaceChildren(...SETTINGS_LAYOUT.map((card) => el('article', { class: 'card' },
    el('h3', {}, card.title, card.tag ? el('span', { class: 'tag' }, card.tag) : null),
    card.note ? el('p', { class: 'muted' }, card.note) : null,
    card.keys.map((k) => control(PARAM_BY_KEY[k])))));
}

function stepper(p) {
  const val = el('span', { class: 'val' });
  const repeat = (delta) => {
    let timer;
    const step = () => sendValue(p, (state.values[p.id] ?? 0) + delta);
    const stop = () => { clearTimeout(timer); clearInterval(timer); };
    return {
      onpointerdown: (e) => {
        e.preventDefault();
        step();
        timer = setTimeout(() => { timer = setInterval(step, 70); }, 400);
      },
      onpointerup: stop,
      onpointerleave: stop,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); step(); } },
    };
  };
  const btn = (d) => el('button', { class: 'btn small', type: 'button', 'aria-label': `${p.label} ${d > 0 ? '+' : ''}${d}`, ...repeat(d) }, `${d > 0 ? '+' : '−'}${Math.abs(d)}`);
  bindView(p.id, (v) => { val.textContent = formatValue(p, v); });
  return el('div', { class: 'cal-row' }, el('span', {}, p.label), val,
    el('div', { class: 'stepper' }, [-64, -8, -1, 1, 8, 64].map(btn)));
}

function buildCalibration() {
  const group = (title, keys, extra = []) => el('div', { class: 'cal-group' }, el('h4', {}, title), extra, keys.map((k) => stepper(PARAM_BY_KEY[k])));
  $('#cal-grid').replaceChildren(
    group('Oscillator 1', ['o1tunecf', 'o1tuneoctcf', 'o1tuneoff'], [control(PARAM_BY_KEY.o1oct)]),
    group('Oscillator 2', ['o2tunecf', 'o2tuneoctcf', 'o2tuneoff'], [control(PARAM_BY_KEY.o2oct)]),
    group('Filter and assign output', ['flttunecf', 'astunecf', 'astuneoff']),
  );
}

////////////////////////////////////////////////////////////////////////////
// MIDI connection

const isNeutron = (port) => /neutron|neutr_cube/i.test(port.name || '');

async function ensureMidi() {
  if (state.midi) return state.midi;
  if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI. Use Chrome, Edge or Opera, or the Mac app.');
  state.midi = await navigator.requestMIDIAccess({ sysex: true });
  state.midi.addEventListener('statechange', onMidiStateChange);
  return state.midi;
}

function listPorts() {
  const outs = [...state.midi.outputs.values()].filter((o) => o.state !== 'disconnected');
  const sel = $('#port');
  const current = sel.value;
  sel.replaceChildren(...outs.map((o) => el('option', { value: o.id }, o.name)));
  sel.hidden = outs.length < 2;
  if (outs.some((o) => o.id === current)) sel.value = current;
  else {
    const n = outs.find(isNeutron);
    if (n) sel.value = n.id;
  }
  return outs;
}

function matchingInput(output) {
  const ins = [...state.midi.inputs.values()].filter((i) => i.state !== 'disconnected');
  return ins.find((i) => i.name === output.name) || ins.find(isNeutron) || ins[0];
}

let reconnectTimer = null;
function onMidiStateChange(e) {
  listPorts();
  if (e.port.state === 'disconnected' && state.link && (e.port === state.link.output || e.port === state.link.input)) {
    disconnect('Neutron disconnected');
  } else if (e.port.state === 'connected' && !state.link && isNeutron(e.port)) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect().catch(() => {}), 400);
  }
}

function disconnect(text = 'Not connected') {
  if (state.link) state.link.close();
  state.link = null;
  state.info = null;
  setStatus(text, 'off');
  $('#savebar').hidden = true;
  $('#settings-grid').hidden = true;
  $('#settings-footer').hidden = true;
  $('#settings-empty').hidden = false;
  $('#connect').textContent = 'Connect';
  $('#enter-bootloader').disabled = true;
  stopAllNotes();
}

async function connect() {
  await ensureMidi();
  const outs = listPorts();
  if (!outs.length) throw new Error('No MIDI devices found. Is the Neutron connected with USB?');
  const output = state.midi.outputs.get($('#port').value) || outs.find(isNeutron) || outs[0];
  const input = matchingInput(output);
  if (!input) throw new Error('The MIDI device has no input port');
  if (state.link) state.link.close();
  setStatus(`Connecting to ${output.name}…`, 'busy');
  await output.open?.();
  await input.open?.();
  state.link = new NeutronLink(input, output);
  try {
    state.info = await state.link.info();
  } catch (e) {
    state.link.close();
    state.link = null;
    setStatus(`${output.name}: no neutr_cube firmware`, 'error');
    throw new Error(`${output.name} does not answer. Settings need the neutr_cube firmware, install it on the Firmware tab.`);
  }
  await reloadValues();
  setDirty(false);
  setStatus(`${output.name}`, 'on');
  $('#info-line').textContent = `Firmware ${state.info.version} · MIDI channel ${state.info.midiChannel + 1}`;
  $('#savebar').hidden = false;
  $('#settings-empty').hidden = true;
  $('#settings-grid').hidden = false;
  $('#settings-footer').hidden = false;
  $('#connect').textContent = 'Reconnect';
  $('#enter-bootloader').disabled = false;
  if (state.info.paramCount !== PARAMS.length) {
    toast(`This firmware has ${state.info.paramCount} settings, the editor knows ${PARAMS.length}. Update both to the same version.`, true);
  }
}

async function reloadValues() {
  const values = await state.link.getAll();
  Object.assign(state.values, values);
  for (const [id, v] of Object.entries(values)) refreshViews(Number(id), v);
}

////////////////////////////////////////////////////////////////////////////
// test notes

const activeNotes = new Set();

function playNote(note, on) {
  if (!state.link) { toast('Connect the Neutron first', true); return false; }
  state.link.note(state.info.midiChannel, note, on ? 100 : 0);
  if (on) activeNotes.add(note); else activeNotes.delete(note);
  return true;
}

function stopAllNotes() {
  for (const n of activeNotes) { try { state.link?.note(state.info.midiChannel, n, 0); } catch (e) { /* gone */ } }
  activeNotes.clear();
  document.querySelectorAll('#test-notes button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
}

function buildTestNotes() {
  const notes = [24, 36, 48, 60, 72, 84, 96, 69];
  $('#test-notes').replaceChildren(...notes.map((n) => el('button', {
    class: 'btn', type: 'button', 'aria-pressed': 'false',
    onclick: (e) => {
      const b = e.currentTarget;
      const on = b.getAttribute('aria-pressed') !== 'true';
      if (on) stopAllNotes();
      if (playNote(n, on)) b.setAttribute('aria-pressed', String(on));
    },
  }, noteName(n))));
}

////////////////////////////////////////////////////////////////////////////
// tuner

let tuner = null;
function setupTuner() {
  const needle = $('#tuner-needle');
  tuner = new Tuner((hz) => {
    const box = $('#tuner');
    if (!hz) { box.classList.remove('live'); return; }
    const ref = Number($('#tuner-ref').value) || 440;
    const d = describePitch(hz, ref);
    box.classList.add('live');
    $('#tuner-note').textContent = d.name;
    $('#tuner-cents').textContent = `${d.cents >= 0 ? '+' : ''}${d.cents.toFixed(1)} cents`;
    $('#tuner-hz').textContent = `${hz.toFixed(2)} Hz`;
    needle.style.left = `${50 + Math.max(-50, Math.min(50, d.cents))}%`;
  });
  $('#tuner-toggle').addEventListener('click', async (e) => {
    if (tuner.running) {
      tuner.stop();
      e.target.textContent = 'Start tuner';
      $('#tuner').classList.remove('live');
      return;
    }
    try {
      await tuner.start();
      e.target.textContent = 'Stop tuner';
    } catch (err) {
      toast(`Microphone not available: ${err.message}`, true);
    }
  });
}

////////////////////////////////////////////////////////////////////////////
// firmware

const fw = { segments: null, name: null };

async function loadBundled() {
  try {
    const meta = await (await fetch('firmware/firmware.json', { cache: 'no-cache' })).json();
    $('#bundled-version').textContent = meta.version;
    fw.bundled = meta;
    if ($('input[name="fwsrc"]:checked').value === 'bundled') await selectBundled();
  } catch (e) {
    $('#bundled-version').textContent = '(not included in this copy)';
  }
}

async function selectBundled() {
  if (!fw.bundled) return;
  const data = new Uint8Array(await (await fetch(`firmware/${fw.bundled.file}`, { cache: 'no-cache' })).arrayBuffer());
  setImage(`neutr_cube ${fw.bundled.version}`, parseFirmware(fw.bundled.file, data));
}

function setImage(name, segments) {
  const info = describeImage(segments);
  fw.segments = segments;
  fw.name = name;
  fw.info = info;
  const kb = (info.bytes / 1024).toFixed(1);
  const line = $('#fw-summary');
  line.className = 'status-line';
  line.textContent = `${name}: ${kb} kB. ${info.touchesSettings
    ? 'Replaces the saved settings and calibration.'
    : 'Saved settings and calibration are kept.'}`;
  updateDfuButtons();
}

function updateDfuButtons() {
  $('#dfu-flash').disabled = !(state.dfu && fw.segments);
  $('#dfu-backup').disabled = !state.dfu;
  $('#dfu-leave').disabled = !state.dfu;
}

function progress(stage, f) {
  const p = $('#dfu-progress');
  p.hidden = false;
  p.querySelector('.bar').style.width = `${Math.round(f * 100)}%`;
  p.querySelector('.label').textContent = `${stage} ${Math.round(f * 100)}%`;
}

function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setupFirmware() {
  if (!navigator.usb) {
    const w = $('#usb-support');
    w.hidden = false;
    w.textContent = 'Firmware updates need WebUSB: use Chrome, Edge or Opera on a computer, or the Mac app.';
    $('#dfu-connect').disabled = true;
  }

  document.querySelectorAll('input[name="fwsrc"]').forEach((r) => r.addEventListener('change', async () => {
    if (r.value === 'file' && r.checked) $('#fw-file').click();
    if (r.value === 'bundled' && r.checked) await selectBundled().catch((e) => toast(e.message, true));
  }));

  $('#fw-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      setImage(f.name, parseFirmware(f.name, new Uint8Array(await f.arrayBuffer())));
      log(`selected ${f.name}`);
    } catch (err) {
      fw.segments = null;
      const line = $('#fw-summary');
      line.className = 'status-line err';
      line.textContent = `${f.name}: ${err.message}`;
      updateDfuButtons();
    }
  });

  $('#enter-bootloader').addEventListener('click', async () => {
    try {
      await state.link.bootloader();
      log('Neutron restarting into the bootloader');
      disconnect('Neutron in bootloader');
      toast('The Neutron is in bootloader mode. Now press Connect to bootloader.');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#dfu-connect').addEventListener('click', async () => {
    try {
      const dev = await DfuSeDevice.request(navigator.usb);
      state.dfu = new DfuSeDevice(dev, log);
      await state.dfu.open();
      log(`connected to ${dev.productName || 'STM32 bootloader'}`);
      updateDfuButtons();
    } catch (e) {
      state.dfu = null;
      updateDfuButtons();
      if (e.name !== 'NotFoundError') {
        log(`error: ${e.message}`);
        toast(`${e.message}${/access|claim/i.test(e.message) ? ' (on Windows the bootloader needs the WinUSB driver, see the help)' : ''}`, true);
      }
    }
  });

  $('#dfu-backup').addEventListener('click', async () => {
    try {
      log('reading the whole flash…');
      const data = await state.dfu.read(FLASH_BASE, FLASH_SIZE, (f) => progress('backup', f));
      const stamp = new Date().toISOString().slice(0, 10);
      download(`neutron-backup-${stamp}.dfu`, buildDfuSe(data));
      log('backup saved');
    } catch (e) {
      log(`error: ${e.message}`);
      toast(e.message, true);
    }
  });

  $('#dfu-flash').addEventListener('click', async () => {
    const ok = await confirmDialog('Install firmware?', `${fw.name} will be written to the Neutron. ${fw.info.touchesSettings
      ? 'This image also replaces the saved settings and calibration.'
      : 'Saved settings and calibration are kept.'} Do not disconnect during the update.`, 'Install');
    if (!ok) return;
    const buttons = ['#dfu-flash', '#dfu-backup', '#dfu-leave', '#dfu-connect'].map((s) => $(s));
    buttons.forEach((b) => { b.disabled = true; });
    try {
      log(`installing ${fw.name}`);
      await state.dfu.flash(fw.segments, progress);
      progress('done', 1);
      log('starting the new firmware');
      await state.dfu.leave();
      state.dfu = null;
      toast('Firmware installed. The Neutron restarts.');
    } catch (e) {
      log(`error: ${e.message}`);
      toast(`Update failed: ${e.message}. The bootloader is still there, try again.`, true);
    } finally {
      $('#dfu-connect').disabled = !navigator.usb;
      updateDfuButtons();
    }
  });

  $('#dfu-leave').addEventListener('click', async () => {
    try {
      await state.dfu.leave();
      log('left the bootloader');
    } catch (e) {
      log(`error: ${e.message}`);
    }
    state.dfu = null;
    updateDfuButtons();
  });

  loadBundled();
}

////////////////////////////////////////////////////////////////////////////

function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const show = (id) => {
    for (const t of tabs) {
      const sel = t.id === `tab-${id}`;
      t.setAttribute('aria-selected', String(sel));
      $(`#${t.getAttribute('aria-controls')}`).hidden = !sel;
    }
  };
  tabs.forEach((t) => t.addEventListener('click', () => {
    const id = t.id.replace('tab-', '');
    history.replaceState(null, '', `#${id}`);
    show(id);
  }));
  const fromHash = location.hash.slice(1);
  if (['settings', 'tuning', 'firmware'].includes(fromHash)) show(fromHash);
}

function setupActions() {
  $('#connect').addEventListener('click', () => connect().catch((e) => toast(e.message, true)));
  $('#port').addEventListener('change', () => connect().catch((e) => toast(e.message, true)));
  $('#save').addEventListener('click', async () => {
    try {
      await state.link.save();
      setDirty(false);
      toast('Saved to the Neutron');
    } catch (e) { toast(e.message, true); }
  });
  $('#reload').addEventListener('click', async () => {
    try {
      await reloadValues();
      setDirty(false);
      toast('Settings read from the Neutron');
    } catch (e) { toast(e.message, true); }
  });
  $('#defaults').addEventListener('click', async () => {
    const ok = await confirmDialog('Reset to defaults?',
      'All settings and the oscillator calibration go back to their defaults and are saved on the Neutron. Run automatic tuning afterwards.', 'Reset');
    if (!ok) return;
    try {
      await state.link.defaults();
      await reloadValues();
      setDirty(false);
      toast('Defaults restored');
    } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll('[data-autotune]').forEach((b) => b.addEventListener('click', async () => {
    if (!state.link) { toast('Connect the Neutron first', true); return; }
    const which = Number(b.dataset.autotune);
    const line = $('#autotune-status');
    const all = document.querySelectorAll('[data-autotune]');
    stopAllNotes();
    all.forEach((x) => { x.disabled = true; });
    line.className = 'status-line';
    line.textContent = 'Tuning… keep your hands off the keyboard.';
    try {
      await state.link.autotune(which);
      await reloadValues();
      setDirty(true);
      line.className = 'status-line ok';
      line.textContent = 'Done. Press Save to Neutron to keep the new calibration.';
    } catch (e) {
      line.className = 'status-line err';
      line.textContent = e.message;
    } finally {
      all.forEach((x) => { x.disabled = false; });
    }
  }));
  $('#notes-off').addEventListener('click', stopAllNotes);
  window.addEventListener('beforeunload', stopAllNotes);
}

function checkSupport() {
  if (!navigator.requestMIDIAccess) {
    const b = $('#support');
    b.hidden = false;
    b.textContent = 'This browser can not talk to MIDI devices. Use Chrome, Edge or Opera on a computer, or the Mac app.';
    $('#connect').disabled = true;
  }
}

function init() {
  checkSupport();
  setupTabs();
  buildSettings();
  buildCalibration();
  buildTestNotes();
  setupTuner();
  setupFirmware();
  setupActions();
  // connect without a click when the browser already allows MIDI
  navigator.permissions?.query({ name: 'midi', sysex: true }).then((p) => {
    if (p.state === 'granted') connect().catch(() => {});
  }).catch(() => {});
  if ('serviceWorker' in navigator && /^(https:|http:\/\/(localhost|127\.0\.0\.1))/.test(location.href)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
