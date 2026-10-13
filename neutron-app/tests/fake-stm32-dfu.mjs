// Simulated STM32F072 ROM bootloader (USB DFU + DfuSe) with a WebUSB-like USBDevice API.
// Flash behaves like the real thing: programming only works on erased (0xFF) bytes.

const FLASH_BASE = 0x08000000;
const PAGE = 2048;
const PAGES = 64;
const XFER = 2048;
const S = { dfuIDLE: 2, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
const ERR = { OK: 0, errTARGET: 1, errWRITE: 3, errADDRESS: 8, errSTALLEDPKT: 15 };

function configDescriptor() {
  const itf = (alt, str) => [9, 4, 0, alt, 0, 0xFE, 0x01, 0x02, str];
  const func = [9, 0x21, 0x0B, 0xFF, 0x00, XFER & 0xFF, XFER >> 8, 0x1A, 0x01];
  const body = [...itf(0, 4), ...itf(1, 5), ...func];
  const total = 9 + body.length;
  return Uint8Array.from([9, 2, total & 0xFF, total >> 8, 1, 1, 0, 0x80, 50, ...body]);
}

export class FakeStm32Dfu {
  constructor(initialFlash) {
    this.flash = new Uint8Array(PAGES * PAGE).fill(0xFF);
    if (initialFlash) this.flash.set(initialFlash.subarray(0, this.flash.length));
    this.state = S.dfuIDLE;
    this.status = ERR.OK;
    this.pointer = FLASH_BASE;
    this.pending = null;
    this.opened = false;
    this.claimed = false;
    this.manifested = null;
    this.erasedPages = [];
    this.configuration = null;
    this.vendorId = 0x0483;
    this.productId = 0xDF11;
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() {
    this.configuration = {
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        alternates: [
          { alternateSetting: 0, interfaceClass: 0xFE, interfaceSubclass: 1, interfaceName: '@Internal Flash  /0x08000000/064*0002Kg' },
          { alternateSetting: 1, interfaceClass: 0xFE, interfaceSubclass: 1, interfaceName: '@Option Bytes  /0x1FFFF800/01*016 e' },
        ],
      }],
    };
  }
  async claimInterface() { this.claimed = true; }
  async selectAlternateInterface(i, alt) { this.alt = alt; }

  check() {
    if (!this.opened || this.manifested !== null) throw new Error('device disconnected');
  }

  fail(status) {
    this.status = status;
    this.state = S.dfuERROR;
  }

  offset(addr, len) {
    const o = addr - FLASH_BASE;
    if (o < 0 || o + len > this.flash.length) return -1;
    return o;
  }

  async controlTransferIn(setup, length) {
    this.check();
    if (setup.requestType === 'standard') {
      const d = configDescriptor().slice(0, length);
      return { status: 'ok', data: new DataView(d.buffer) };
    }
    switch (setup.request) {
      case 3: { // GETSTATUS
        let shown = this.state;
        if (this.state === S.dfuDNBUSY) {
          this.execute();
          shown = S.dfuDNBUSY; // like the ROM: busy once, the operation is done afterwards
          if (this.state === S.dfuDNBUSY) this.state = S.dfuDNLOAD_IDLE;
        } else if (this.state === S.dfuMANIFEST) {
          this.manifested = this.pointer;
          throw new Error('device reset');
        }
        const b = Uint8Array.from([this.status, 5, 0, 0, shown, 0]);
        return { status: 'ok', data: new DataView(b.buffer) };
      }
      case 5: { // GETSTATE
        const b = Uint8Array.from([this.state]);
        return { status: 'ok', data: new DataView(b.buffer) };
      }
      case 2: { // UPLOAD
        if (this.state !== S.dfuIDLE && this.state !== S.dfuUPLOAD_IDLE) return { status: 'stall' };
        if (setup.value < 2) return { status: 'stall' };
        const addr = this.pointer + (setup.value - 2) * XFER;
        const o = this.offset(addr, length);
        if (o < 0 || length > XFER) { this.fail(ERR.errADDRESS); return { status: 'stall' }; }
        this.state = S.dfuUPLOAD_IDLE;
        const d = this.flash.slice(o, o + length);
        return { status: 'ok', data: new DataView(d.buffer) };
      }
      default:
        return { status: 'stall' };
    }
  }

  async controlTransferOut(setup, data) {
    this.check();
    const bytes = data ? new Uint8Array(data.buffer ? data.buffer : data, data.byteOffset || 0, data.byteLength ?? data.length) : new Uint8Array(0);
    switch (setup.request) {
      case 1: // DNLOAD
        if (this.state !== S.dfuIDLE && this.state !== S.dfuDNLOAD_IDLE) { this.fail(ERR.errSTALLEDPKT); return { status: 'stall' }; }
        if (bytes.length > XFER) { this.fail(ERR.errSTALLEDPKT); return { status: 'stall' }; }
        if (bytes.length === 0) {
          this.state = S.dfuMANIFEST;
          return { status: 'ok', bytesWritten: 0 };
        }
        this.pending = { block: setup.value, data: Uint8Array.from(bytes) };
        this.state = S.dfuDNBUSY;
        return { status: 'ok', bytesWritten: bytes.length };
      case 4: // CLRSTATUS
        this.status = ERR.OK;
        this.state = S.dfuIDLE;
        return { status: 'ok' };
      case 6: // ABORT
        this.state = S.dfuIDLE;
        return { status: 'ok' };
      default:
        return { status: 'stall' };
    }
  }

  execute() {
    const { block, data } = this.pending;
    this.pending = null;
    if (block === 0) {
      const addr = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
      if (data[0] === 0x21 && data.length === 5) {
        this.pointer = addr >>> 0;
      } else if (data[0] === 0x41 && data.length === 5) {
        const o = this.offset(addr >>> 0, 1);
        if (o < 0 || o % PAGE) { this.fail(ERR.errTARGET); return; }
        this.flash.fill(0xFF, o, o + PAGE);
        this.erasedPages.push(addr >>> 0);
      } else {
        this.fail(ERR.errSTALLEDPKT);
      }
      return;
    }
    if (block < 2) { this.fail(ERR.errSTALLEDPKT); return; }
    const addr = this.pointer + (block - 2) * XFER;
    const o = this.offset(addr, data.length);
    if (o < 0) { this.fail(ERR.errADDRESS); return; }
    for (let i = 0; i < data.length; i++) {
      if (this.flash[o + i] !== 0xFF && data[i] !== 0xFF) { this.fail(ERR.errWRITE); return; }
      this.flash[o + i] &= data[i];
    }
  }
}
