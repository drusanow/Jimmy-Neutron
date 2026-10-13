// Editor protocol for the neutr_cube firmware (see neutr_cube/neutr_src/sysex.c).
//
//   request:  F0 7D 4E 43 <cmd> <payload> F7
//   reply:    F0 7D 4E 43 <cmd|0x40> <payload> F7
//   values:   21 bit signed, 3 bytes, least significant 7 bits first

export const SYSEX_HEADER = [0xF0, 0x7D, 0x4E, 0x43];

export const CMD = {
  INFO: 0x01,
  GET_ALL: 0x02,
  SET: 0x03,
  SAVE: 0x04,
  AUTOTUNE: 0x05,
  DEFAULTS: 0x06,
  BOOTLOADER: 0x07,
};

const TUNE_CF_MIN = 0x4CCC;
const TUNE_CF_MAX = 0xA666;

// id must match sx_params[] in sysex.c
export const PARAMS = [
  { id: 0, key: 'o1tunecf', label: 'Note DAC scale', min: TUNE_CF_MIN, max: TUNE_CF_MAX, hex: true },
  { id: 1, key: 'o1tuneoctcf', label: 'Octave DAC scale', min: TUNE_CF_MIN, max: TUNE_CF_MAX, hex: true },
  { id: 2, key: 'o1tuneoff', label: 'Pitch offset', min: -0x8000, max: 0x7FFF, hex: true },
  { id: 3, key: 'o2tunecf', label: 'Note DAC scale', min: TUNE_CF_MIN, max: TUNE_CF_MAX, hex: true },
  { id: 4, key: 'o2tuneoctcf', label: 'Octave DAC scale', min: TUNE_CF_MIN, max: TUNE_CF_MAX, hex: true },
  { id: 5, key: 'o2tuneoff', label: 'Pitch offset', min: -0x8000, max: 0x7FFF, hex: true },
  { id: 6, key: 'o1oct', label: 'Range', min: 0, max: 2, options: ["32'", "16'", "8'"] },
  { id: 7, key: 'o2oct', label: 'Range', min: 0, max: 2, options: ["32'", "16'", "8'"] },
  { id: 8, key: 'o1pwrange', label: 'Pitch bend range', min: 0, max: 24, unit: 'semitones' },
  { id: 9, key: 'o2pwrange', label: 'Pitch bend range', min: 0, max: 24, unit: 'semitones' },
  { id: 10, key: 'o1widerange', label: 'Tune knob range', min: 0, max: 1, options: ['±1 octave', 'Wide'] },
  { id: 11, key: 'o2widerange', label: 'Tune knob range', min: 0, max: 1, options: ['±1 octave', 'Wide'] },
  { id: 12, key: 'o1moddis', label: 'Mod inputs (CV and mod depth)', min: 0, max: 1, options: ['On', 'Off'] },
  { id: 13, key: 'o2moddis', label: 'Mod inputs (CV and mod depth)', min: 0, max: 1, options: ['On', 'Off'] },
  { id: 14, key: 'o1glide', label: 'Portamento', min: 0, max: 0xFFF, percent: true },
  { id: 15, key: 'o2glide', label: 'Portamento', min: 0, max: 0xFFF, percent: true },
  { id: 16, key: 'osync', label: 'Osc sync (OSC 2 to OSC 1)', min: 0, max: 1, toggle: true },
  { id: 17, key: 'paraphony', label: 'Voice mode', min: 0, max: 2,
    options: ['Mono', 'Paraphonic', 'Paraphonic pad (gate from the 2nd note)'] },
  { id: 18, key: 'flttunecf', label: 'Filter key track scale', min: TUNE_CF_MIN, max: TUNE_CF_MAX, hex: true },
  { id: 19, key: 'filtertype', label: 'Filter mode', min: 0, max: 2, options: ['Low pass', 'Band pass', 'High pass'] },
  { id: 20, key: 'filterkeytrack', label: 'Key tracking', min: 0, max: 1, toggle: true },
  { id: 21, key: 'astunecf', label: 'Assign out scale', min: 0, max: 0xFFFF, hex: true },
  { id: 22, key: 'astuneoff', label: 'Assign out offset', min: -0x8000, max: 0x7FFF, hex: true },
  { id: 23, key: 'asmode', label: 'Assign out source', min: 0, max: 4,
    options: ['OSC 1 pitch', 'OSC 2 pitch', 'Velocity', 'Mod wheel', 'Aftertouch'] },
  { id: 24, key: 'gateretrig', label: 'Retrigger envelopes on every note', min: 0, max: 1, toggle: true },
  { id: 25, key: 'lfokeysync', label: 'Key sync (wide pitch range in oscillator modes)', min: 0, max: 1, toggle: true },
  { id: 26, key: 'lfoextsynctype', label: 'Sync input edge', min: 0, max: 2, options: ['Rising', 'Falling', 'Both'] },
  { id: 27, key: 'lfosyncstart', label: 'Retrigger phase', min: 0, max: 0xFFF, degrees: true },
  { id: 28, key: 'lfomidisync', label: 'Sync to MIDI clock', min: 0, max: 1, toggle: true },
  { id: 29, key: 'lfomode', label: 'LFO mode', min: 0, max: 6, options: [
    'Classic LFO', 'Assign 2 shaper', 'Monophonic oscillator', 'Polyphonic (5 voices)',
    'Attenuverter (rate × shape)', 'Classic (1.4 engine)', 'Wavetable oscillator'] },
  { id: 30, key: 'shpdrift_depth', label: 'Shape drift depth', min: 0, max: 0xFFF, percent: true },
  { id: 31, key: 'shpdrift_rate', label: 'Shape drift speed', min: 0, max: 0xFFF, driftHz: true },
  { id: 32, key: 'lfooscsrc', label: 'Oscillator modes follow', min: 0, max: 1, options: ['OSC 2', 'OSC 1'] },
  { id: 33, key: 'lfooscquant', label: 'Snap LFO RATE pitch to semitones', min: 0, max: 1, toggle: true },
];

export const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export function encodeValue(v) {
  const u = v & 0x1FFFFF;
  return [u & 0x7F, (u >> 7) & 0x7F, (u >> 14) & 0x7F];
}

export function decodeValue(b0, b1, b2) {
  let v = b0 | (b1 << 7) | (b2 << 14);
  if (v & 0x100000) v -= 0x200000;
  return v;
}

export function buildRequest(cmd, payload = []) {
  for (const b of payload) {
    if (b < 0 || b > 0x7F) throw new Error('sysex payload byte out of range');
  }
  return [...SYSEX_HEADER, cmd, ...payload, 0xF7];
}

// returns {cmd, payload} for one of our replies, or null
export function parseReply(data) {
  const d = Array.from(data);
  if (d.length < 6 || d[d.length - 1] !== 0xF7) return null;
  for (let i = 0; i < 4; i++) if (d[i] !== SYSEX_HEADER[i]) return null;
  if (!(d[4] & 0x40)) return null;
  return { cmd: d[4] & 0x3F, payload: d.slice(5, -1) };
}

export function decodeInfo(p) {
  return {
    protocol: p[0],
    midiChannel: p[1], // 0..15
    paramCount: p[2],
    version: String.fromCharCode(...p.slice(3)),
  };
}

export function decodeAll(p) {
  const n = p[0];
  const values = {};
  for (let i = 0; i < n; i++) {
    const o = 1 + i * 4;
    values[p[o]] = decodeValue(p[o + 1], p[o + 2], p[o + 3]);
  }
  return values;
}

export function clampParam(param, v) {
  return Math.min(param.max, Math.max(param.min, Math.round(v)));
}

// Connection to a Neutron over Web MIDI (MIDIInput / MIDIOutput pair).
// Requests are serialised: one outstanding request at a time.
export class NeutronLink extends EventTarget {
  constructor(input, output) {
    super();
    this.input = input;
    this.output = output;
    this.queue = Promise.resolve();
    this.pending = null;
    this.onMessage = (e) => this.handle(e.data);
    input.addEventListener('midimessage', this.onMessage);
  }

  close() {
    this.input.removeEventListener('midimessage', this.onMessage);
    if (this.pending) this.pending.reject(new Error('disconnected'));
  }

  handle(data) {
    const r = parseReply(data);
    if (!r || !this.pending || r.cmd !== this.pending.cmd) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(r.payload);
  }

  request(cmd, payload = [], timeoutMs = 1500) {
    const run = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('no answer from the Neutron (is the neutr_cube firmware installed?)'));
      }, timeoutMs);
      this.pending = { cmd, resolve, reject, timer };
      this.output.send(buildRequest(cmd, payload));
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async info() { return decodeInfo(await this.request(CMD.INFO)); }
  async getAll() { return decodeAll(await this.request(CMD.GET_ALL)); }

  async set(id, value) {
    const p = await this.request(CMD.SET, [id, ...encodeValue(value)]);
    if (p[0] === 0x7F) throw new Error(`parameter ${id} not supported by this firmware`);
    return decodeValue(p[1], p[2], p[3]);
  }

  async save() {
    const p = await this.request(CMD.SAVE, [], 3000);
    if (p[0] !== 0) throw new Error(`saving failed (error ${p[0]})`);
  }

  // which: 1 = OSC 1, 2 = OSC 2, 3 = both. takes a few seconds
  async autotune(which) { await this.request(CMD.AUTOTUNE, [which], 30000); }
  async defaults() { await this.request(CMD.DEFAULTS, [], 3000); }
  async bootloader() { await this.request(CMD.BOOTLOADER, [], 2000); }

  note(channel, note, velocity) {
    this.output.send(velocity > 0 ? [0x90 | channel, note, velocity] : [0x80 | channel, note, 0]);
  }
}
