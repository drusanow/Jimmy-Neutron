// Microphone tuner: YIN pitch detection on the Web Audio input.

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// returns frequency in Hz, or 0 when no clear pitch
export function detectPitch(buf, sampleRate, threshold = 0.12) {
  const n = buf.length;
  const maxLag = Math.min(Math.floor(sampleRate / 25), Math.floor(n / 2)); // down to 25 Hz
  const minLag = Math.floor(sampleRate / 4000);
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / n) < 0.008) return 0; // too quiet

  const w = n - maxLag;
  const raw = new Float32Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i < w; i++) {
      const diff = buf[i] - buf[i + lag];
      s += diff * diff;
    }
    raw[lag] = s;
  }
  // cumulative mean normalised difference
  const d = new Float32Array(maxLag + 1);
  let running = 0;
  d[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    running += raw[lag];
    d[lag] = running ? (raw[lag] * lag) / running : 1;
  }
  let lag = -1;
  for (let t = Math.max(2, minLag); t < maxLag; t++) {
    if (d[t] < threshold) {
      while (t + 1 < maxLag && d[t + 1] < d[t]) t++;
      lag = t;
      break;
    }
  }
  if (lag < 0) return 0;
  // refine over several periods: the dip at m periods is located with the same interpolation
  // error as at one period, so dividing by m makes the estimate m times more exact
  const m = Math.max(1, Math.min(16, Math.floor(maxLag / lag) - 1));
  let best = lag;
  if (m > 1) {
    const centre = Math.round(lag * m);
    const span = Math.max(2, Math.ceil(m / 2));
    for (let t = centre - span; t <= centre + span; t++) {
      if (t > 1 && t <= maxLag && raw[t] < raw[best === lag ? centre : best]) best = t;
    }
    if (best === lag) best = centre;
  }
  // parabolic interpolation around the minimum of the raw difference
  const a = raw[best - 1];
  const b = raw[best];
  const c = raw[best + 1];
  const den = a + c - 2 * b;
  const shift = den ? (a - c) / (2 * den) : 0;
  return (sampleRate * m) / (best + shift);
}

export function describePitch(freq, a4 = 440) {
  const midi = 69 + 12 * Math.log2(freq / a4);
  const nearest = Math.round(midi);
  return {
    midi: nearest,
    name: NOTE_NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1),
    cents: (midi - nearest) * 100,
  };
}

export function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

export class Tuner {
  constructor(onReading) {
    this.onReading = onReading;
    this.timer = null;
  }

  get running() { return this.timer !== null; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buf);
      this.onReading(detectPitch(this.buf, this.ctx.sampleRate));
    }, 100);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close();
    this.stream = null;
    this.ctx = null;
  }
}
