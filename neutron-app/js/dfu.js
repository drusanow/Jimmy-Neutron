// Firmware files and the STM32 ROM bootloader (USB DFU with ST's DfuSe extensions) over WebUSB.
//
// The ROM bootloader is part of the chip and can not be erased, so flashing can always be
// retried. Only the flash pages covered by the image are erased: an image smaller than
// 114 kB (any neutr_cube build) leaves the saved settings and calibration page alone.

export const STM32_DFU_FILTER = { vendorId: 0x0483, productId: 0xDF11 };

export const FLASH_BASE = 0x08000000;
export const FLASH_SIZE = 128 * 1024;
export const SETTINGS_PAGE = 0x0801C800; // neutr_cube saved parameters

const DFU = { DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };
const STATE = { dfuIDLE: 2, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
const DFUSE = { SET_ADDRESS: 0x21, ERASE_PAGE: 0x41 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

////////////////////////////////////////////////////////////////////////////
// firmware files -> list of {address, data: Uint8Array}

export function parseFirmware(name, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const lower = name.toLowerCase();
  if (lower.endsWith('.dfu') || isDfuSe(b)) return parseDfuSe(b);
  if (lower.endsWith('.hex')) return parseIntelHex(new TextDecoder().decode(b));
  return [{ address: FLASH_BASE, data: b }];
}

function isDfuSe(b) {
  return b.length > 11 && String.fromCharCode(...b.slice(0, 5)) === 'DfuSe';
}

export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return crc >>> 0; // DfuSe stores the crc without the final inversion
}

export function parseDfuSe(b) {
  if (!isDfuSe(b)) throw new Error('not a DfuSe file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const stored = dv.getUint32(b.length - 4, true);
  if (crc32(b.subarray(0, b.length - 4)) !== stored) throw new Error('DfuSe file is damaged (crc mismatch)');
  const targets = b[10];
  let off = 11;
  const segments = [];
  for (let t = 0; t < targets; t++) {
    if (String.fromCharCode(...b.slice(off, off + 6)) !== 'Target') throw new Error('DfuSe file: bad target prefix');
    const alt = b[off + 6];
    const elements = dv.getUint32(off + 270, true);
    off += 274;
    for (let e = 0; e < elements; e++) {
      const address = dv.getUint32(off, true);
      const size = dv.getUint32(off + 4, true);
      off += 8;
      if (alt === 0) segments.push({ address, data: b.slice(off, off + size) });
      off += size;
    }
  }
  if (!segments.length) throw new Error('DfuSe file has no flash image');
  return segments;
}

export function parseIntelHex(text) {
  const segments = [];
  let base = 0;
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error('hex file: bad line');
    const bytes = line.slice(1).match(/../g).map((h) => parseInt(h, 16));
    const sum = bytes.reduce((a, c) => a + c, 0) & 0xFF;
    if (sum !== 0) throw new Error('hex file: checksum error');
    const [len, hi, lo, type] = bytes;
    const data = bytes.slice(4, 4 + len);
    if (type === 0) {
      const addr = base + ((hi << 8) | lo);
      if (!cur || cur.end !== addr) {
        cur = { address: addr, chunks: [], end: addr };
        segments.push(cur);
      }
      cur.chunks.push(...data);
      cur.end += len;
    } else if (type === 1) {
      break;
    } else if (type === 4) {
      base = ((data[0] << 8) | data[1]) * 0x10000;
    } else if (type === 2) {
      base = ((data[0] << 8) | data[1]) * 16;
    }
  }
  return segments.map((s) => ({ address: s.address, data: Uint8Array.from(s.chunks) }));
}

// checks an image fits the Neutron's flash; returns a summary
export function describeImage(segments) {
  let lo = Infinity;
  let hi = 0;
  let bytes = 0;
  for (const s of segments) {
    if (s.address < FLASH_BASE || s.address + s.data.length > FLASH_BASE + FLASH_SIZE) {
      throw new Error(`image data at 0x${s.address.toString(16)} is outside the Neutron's flash`);
    }
    lo = Math.min(lo, s.address);
    hi = Math.max(hi, s.address + s.data.length);
    bytes += s.data.length;
  }
  return { start: lo, end: hi, bytes, touchesSettings: hi > SETTINGS_PAGE };
}

// DfuSe file for a backup (same layout as tools/bin2dfu.py)
export function buildDfuSe(data, address = FLASH_BASE) {
  const element = new Uint8Array(8 + data.length);
  const ev = new DataView(element.buffer);
  ev.setUint32(0, address, true);
  ev.setUint32(4, data.length, true);
  element.set(data, 8);
  const target = new Uint8Array(274 + element.length);
  const tv = new DataView(target.buffer);
  target.set([...'Target'].map((c) => c.charCodeAt(0)), 0);
  target[6] = 0;
  tv.setUint32(7, 1, true);
  target.set([...'ST...'].map((c) => c.charCodeAt(0)), 11);
  tv.setUint32(266, element.length, true);
  tv.setUint32(270, 1, true);
  target.set(element, 274);
  const body = new Uint8Array(11 + target.length + 16);
  const bv = new DataView(body.buffer);
  body.set([...'DfuSe'].map((c) => c.charCodeAt(0)), 0);
  body[5] = 1;
  bv.setUint32(6, 11 + target.length, true);
  body[10] = 1;
  body.set(target, 11);
  const s = 11 + target.length;
  bv.setUint16(s, 0xFFFF, true);
  bv.setUint16(s + 2, STM32_DFU_FILTER.productId, true);
  bv.setUint16(s + 4, STM32_DFU_FILTER.vendorId, true);
  bv.setUint16(s + 6, 0x011A, true);
  body.set([0x55, 0x46, 0x44, 16], s + 8);
  bv.setUint32(s + 12, crc32(body.subarray(0, s + 12)), true);
  return body;
}

////////////////////////////////////////////////////////////////////////////
// device

// "@Internal Flash  /0x08000000/064*0002Kg" -> {start, pageSize, pages}
export function parseMemoryLayout(name) {
  const m = /\/0x([0-9a-fA-F]+)\/(\d+)\*(\d+)([ KM ])/.exec(name || '');
  if (!m) return null;
  const mult = { ' ': 1, K: 1024, M: 1024 * 1024 }[m[4]];
  return { start: parseInt(m[1], 16), pages: parseInt(m[2], 10), pageSize: parseInt(m[3], 10) * mult };
}

export class DfuSeDevice {
  constructor(usbDevice, log = () => {}) {
    this.dev = usbDevice;
    this.log = log;
    this.interfaceNumber = 0;
    this.alternate = 0;
    this.transferSize = 1024;
    this.layout = { start: FLASH_BASE, pages: 64, pageSize: 2048 };
  }

  static async request(usb) {
    return usb.requestDevice({ filters: [STM32_DFU_FILTER] });
  }

  async open() {
    const d = this.dev;
    await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    // find the "Internal Flash" alternate setting
    let found = null;
    for (const itf of d.configuration.interfaces) {
      for (const alt of itf.alternates) {
        if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01 && /flash/i.test(alt.interfaceName || '')) {
          found = { itf, alt };
          break;
        }
      }
      if (found) break;
    }
    if (!found) throw new Error('this device has no DFU "Internal Flash" interface');
    this.interfaceNumber = found.itf.interfaceNumber;
    this.alternate = found.alt.alternateSetting;
    this.layout = parseMemoryLayout(found.alt.interfaceName) || this.layout;
    await d.claimInterface(this.interfaceNumber);
    await d.selectAlternateInterface(this.interfaceNumber, this.alternate);
    this.transferSize = (await this.readTransferSize()) || this.transferSize;
    this.log(`bootloader: ${this.layout.pages} pages of ${this.layout.pageSize} bytes, transfer size ${this.transferSize}`);
    await this.toIdle();
  }

  async close() {
    try { await this.dev.close(); } catch (e) { /* already gone */ }
  }

  // wTransferSize from the DFU functional descriptor in the configuration descriptor
  async readTransferSize() {
    const r = await this.dev.controlTransferIn({
      requestType: 'standard', recipient: 'device', request: 6, value: 0x0200, index: 0,
    }, 512);
    if (r.status !== 'ok') return null;
    const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    for (let i = 0; i + 1 < b.length && b[i] > 0; i += b[i]) {
      if (b[i + 1] === 0x21 && b[i] >= 7) return b[i + 5] | (b[i + 6] << 8);
    }
    return null;
  }

  async out(request, value, data) {
    const r = await this.dev.controlTransferOut({
      requestType: 'class', recipient: 'interface', request, value, index: this.interfaceNumber,
    }, data);
    if (r.status !== 'ok') throw new Error(`DFU request ${request} failed (${r.status})`);
  }

  async in(request, value, length) {
    const r = await this.dev.controlTransferIn({
      requestType: 'class', recipient: 'interface', request, value, index: this.interfaceNumber,
    }, length);
    if (r.status !== 'ok') throw new Error(`DFU request ${request} failed (${r.status})`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async getStatus() {
    const s = await this.in(DFU.GETSTATUS, 0, 6);
    return { status: s[0], pollTimeout: s[1] | (s[2] << 8) | (s[3] << 16), state: s[4] };
  }

  async toIdle() {
    let st = await this.getStatus();
    if (st.state === STATE.dfuERROR) {
      await this.out(DFU.CLRSTATUS, 0);
      st = await this.getStatus();
    }
    if (st.state !== STATE.dfuIDLE) {
      await this.out(DFU.ABORT, 0);
      st = await this.getStatus();
    }
    if (st.state !== STATE.dfuIDLE) throw new Error(`bootloader is not ready (state ${st.state})`);
  }

  // after a download request: wait while the device is busy
  async waitDone(what) {
    for (let i = 0; i < 500; i++) {
      const st = await this.getStatus();
      if (st.status !== 0) {
        throw new Error(`${what} failed (DFU status ${st.status}${st.status === 3 ? ': flash is write protected' : ''})`);
      }
      if (st.state !== STATE.dfuDNBUSY) return st;
      await sleep(Math.max(st.pollTimeout, 1));
    }
    throw new Error(`${what}: bootloader timeout`);
  }

  async dfuseCommand(cmd, address, what) {
    const b = new Uint8Array([cmd, address & 0xFF, (address >>> 8) & 0xFF, (address >>> 16) & 0xFF, (address >>> 24) & 0xFF]);
    await this.out(DFU.DNLOAD, 0, b);
    await this.waitDone(what);
  }

  pagesFor(segments) {
    const { start, pageSize, pages } = this.layout;
    const set = new Set();
    for (const s of segments) {
      const first = Math.floor((s.address - start) / pageSize);
      const last = Math.floor((s.address + s.data.length - 1 - start) / pageSize);
      for (let p = first; p <= last; p++) {
        if (p < 0 || p >= pages) throw new Error('image does not fit the flash');
        set.add(p);
      }
    }
    return [...set].sort((a, b) => a - b).map((p) => start + p * pageSize);
  }

  async read(address, length, progress = () => {}) {
    const out = new Uint8Array(length);
    const xs = this.transferSize;
    await this.toIdle();
    await this.dfuseCommand(DFUSE.SET_ADDRESS, address, 'set address');
    await this.out(DFU.ABORT, 0);
    for (let done = 0, block = 2; done < length; block++) {
      const n = Math.min(xs, length - done);
      const chunk = await this.in(DFU.UPLOAD, block, n);
      if (chunk.length !== n) throw new Error('short read from the bootloader');
      out.set(chunk, done);
      done += n;
      progress(done / length);
    }
    await this.out(DFU.ABORT, 0);
    return out;
  }

  // erase, write, verify. progress(stage, fraction)
  async flash(segments, progress = () => {}) {
    describeImage(segments);
    const xs = this.transferSize;
    await this.toIdle();

    const pages = this.pagesFor(segments);
    for (let i = 0; i < pages.length; i++) {
      await this.dfuseCommand(DFUSE.ERASE_PAGE, pages[i], `erasing 0x${pages[i].toString(16)}`);
      progress('erase', (i + 1) / pages.length);
    }
    this.log(`erased ${pages.length} pages`);

    const total = segments.reduce((a, s) => a + s.data.length, 0);
    let written = 0;
    for (const s of segments) {
      for (let off = 0; off < s.data.length; off += xs) {
        const chunk = s.data.subarray(off, Math.min(off + xs, s.data.length));
        await this.dfuseCommand(DFUSE.SET_ADDRESS, s.address + off, 'set address');
        await this.out(DFU.DNLOAD, 2, chunk);
        await this.waitDone(`writing 0x${(s.address + off).toString(16)}`);
        written += chunk.length;
        progress('write', written / total);
      }
    }
    this.log(`wrote ${written} bytes`);

    let checked = 0;
    for (const s of segments) {
      const back = await this.read(s.address, s.data.length, (f) => progress('verify', (checked + f * s.data.length) / total));
      for (let i = 0; i < back.length; i++) {
        if (back[i] !== s.data[i]) throw new Error(`verify failed at 0x${(s.address + i).toString(16)}`);
      }
      checked += s.data.length;
    }
    this.log('verified');
  }

  // leave the bootloader and start the firmware at the start of flash
  async leave() {
    await this.toIdle();
    await this.dfuseCommand(DFUSE.SET_ADDRESS, FLASH_BASE, 'set address');
    await this.out(DFU.DNLOAD, 0, new Uint8Array(0));
    try {
      await this.getStatus(); // the device resets here, errors are expected
    } catch (e) { /* gone */ }
    await this.close();
  }
}
