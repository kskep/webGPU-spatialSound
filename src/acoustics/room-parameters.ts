// ISO 3382-1 room-acoustic parameters of an impulse response. Pure functions, no I/O.
import { BAND_CENTERS } from './model.ts';

export const ONSET_FRACTION = 0.3;

// Half-width of the DRR window around the direct sound (seconds).
export const DIRECT_WINDOW_SECONDS = 0.0025;

// Just-noticeable differences (ISO 3382-1, Annex A).
export const JND = {
  reverberationTime: 0.05, // relative, for T20/T30/EDT
  clarity: 1, // dB, for C80/C50
  definition: 0.05, // absolute, for D50
} as const;

// Parameters of one octave band. Null times mean the decay was too short.
export interface BandParameters {
  centre: number;
  t20: number | null; // seconds
  t30: number | null;
  edt: number | null;
  c50: number; // dB
  c80: number;
  d50: number; // 0..1
  drr: number; // dB
  usableSeconds: number;
  dynamicRangeDb: number;
}

export interface RoomParametersOptions {
  noiseCompensation?: boolean; // Lundeby noise handling (for measurements)
  bands?: readonly number[];
  keepCurves?: boolean; // return Schroeder curves for plotting
  curveStepSamples?: number;
}

export interface RoomParameters {
  sampleRate: number;
  onsetSample: number;
  bands: BandParameters[];
  curves?: Float32Array[]; // Schroeder decay curves per band (dB), only with keepCurves
}

export const ANALYSIS_BANDS: readonly number[] = BAND_CENTERS.filter((centre) => centre >= 125);

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const BUTTERWORTH4_Q = [0.5411961, 1.306563];

// RBJ biquad low-pass or high-pass via bilinear transform.
function biquad(kind: 'low' | 'high', frequency: number, q: number, rate: number): Biquad {
  const w = (2 * Math.PI * frequency) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cosine = Math.cos(w);
  const a0 = 1 + alpha;
  const edge = kind === 'low' ? (1 - cosine) / 2 : (1 + cosine) / 2;
  const middle = kind === 'low' ? 1 - cosine : -(1 + cosine);
  return { b0: edge / a0, b1: middle / a0, b2: edge / a0, a1: (-2 * cosine) / a0, a2: (1 - alpha) / a0 };
}

// Runs signal through the biquad cascade (direct form II transposed), in place.
function filterForward(signal: Float64Array, sections: Biquad[]): void {
  for (const { b0, b1, b2, a1, a2 } of sections) {
    let z1 = 0;
    let z2 = 0;
    for (let n = 0; n < signal.length; n++) {
      const x = signal[n];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      signal[n] = y;
    }
  }
}

// Zero-phase octave-band filter around `centre` Hz (forward + backward pass, zero-padded).
export function octaveBand(signal: ArrayLike<number>, rate: number, centre: number): Float64Array {
  const padding = Math.ceil(rate * 0.2);
  const data = new Float64Array(signal.length + padding);
  for (let n = 0; n < signal.length; n++) {
    data[n] = signal[n];
  }
  const lower = centre / Math.SQRT2;
  const upper = Math.min(centre * Math.SQRT2, 0.45 * rate);
  const sections = [
    ...BUTTERWORTH4_Q.map((q) => biquad('high', lower, q, rate)),
    ...BUTTERWORTH4_Q.map((q) => biquad('low', upper, q, rate)),
  ];
  filterForward(data, sections);
  // EDW FILTRAROUME KAI ANAPODA GIA NA MIN PROSTHESOUME KATHYSTERISI FASIS STO BAND SIGNAL.
  data.reverse();
  filterForward(data, sections);
  data.reverse();
  return data.subarray(0, signal.length);
}

// Index of the direct sound (first sample above ONSET_FRACTION of the peak, refined to local max).
export function directOnset(channels: ArrayLike<number>[], rate: number): number {
  const length = channels[0].length;
  const amplitude = (n: number) => Math.hypot(...channels.map((channel) => channel[n]));
  let peak = 0;
  for (let n = 0; n < length; n++) {
    peak = Math.max(peak, amplitude(n));
  }
  let first = 0;
  while (first < length && amplitude(first) < ONSET_FRACTION * peak) {
    first++;
  }
  let best = first;
  const stop = Math.min(length, first + Math.round(0.002 * rate));
  for (let n = first; n < stop; n++) {
    if (amplitude(n) > amplitude(best)) {
      best = n;
    }
  }
  return best;
}

// Least-squares slope (dB/s) of the Schroeder curve between highDb and lowDb; null if too short.
function decaySlope(curveDb: Float64Array, rate: number, highDb: number, lowDb: number): number | null {
  let count = 0;
  let sumT = 0;
  let sumL = 0;
  let sumTT = 0;
  let sumTL = 0;
  let reached = false;
  for (let n = 0; n < curveDb.length; n++) {
    const level = curveDb[n];
    if (level <= lowDb) {
      reached = true;
    }
    if (level > highDb || level < lowDb) {
      if (level < lowDb) {
        break;
      }
      continue;
    }
    const time = n / rate;
    count++;
    sumT += time;
    sumL += level;
    sumTT += time * time;
    sumTL += time * level;
  }
  if (!reached || count < 3) {
    return null;
  }
  const denominator = count * sumTT - sumT * sumT;
  return denominator === 0 ? null : (count * sumTL - sumT * sumL) / denominator;
}

function timeFromSlope(slope: number | null): number | null {
  if (slope === null || slope >= 0) {
    return null;
  }
  // EDW EPEKTEINOUME TIN KLISI TIS KAMPYLIS SE PTWSI 60 dB GIA NA VGALEI XRONO ANTIXISIS.
  return -60 / slope;
}

interface LundebyResult {
  end: number; // sample index of the end of usable decay
  noise: number; // noise energy per sample
  slopeDbPerSecond: number; // decay rate (negative)
}

function blockLevels(energy: Float64Array, block: number): { db: number[]; centres: number[] } {
  const db: number[] = [];
  const centres: number[] = [];
  for (let start = 0; start + block <= energy.length; start += block) {
    let sum = 0;
    for (let n = start; n < start + block; n++) {
      sum += energy[n];
    }
    db.push(10 * Math.log10(Math.max(sum / block, 1e-300)));
    centres.push(start + block / 2);
  }
  return { db, centres };
}

// Linear regression y = a + bx; returns [a, b].
function regression(x: number[], y: number[]): [number, number] {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denominator = n * sxx - sx * sx;
  const b = denominator === 0 ? 0 : (n * sxy - sx * sy) / denominator;
  return [(sy - b * sx) / n, b];
}

// Lundeby et al. (1995): iteratively finds where the decay meets the noise floor.
export function lundeby(energy: Float64Array, rate: number): LundebyResult | null {
  const total = energy.length;
  if (total < 0.2 * rate) {
    return null;
  }
  const noiseOf = (from: number): number => {
    let sum = 0;
    for (let n = from; n < total; n++) {
      sum += energy[n];
    }
    return Math.max(sum / (total - from), 1e-300);
  };
  let noise = noiseOf(Math.floor(0.9 * total));
  let block = Math.round(0.01 * rate);
  let line: [number, number] = [0, 0];
  let cross = total;
  for (let iteration = 0; iteration < 10; iteration++) {
    const { db, centres } = blockLevels(energy, Math.max(block, 8));
    const noiseDb = 10 * Math.log10(noise);
    // Regression over the blocks from the start to the first block within 10 dB of the noise.
    let last = db.length;
    for (let i = 0; i < db.length; i++) {
      if (db[i] < noiseDb + 10) {
        last = i;
        break;
      }
    }
    if (last < 2) {
      return null;
    }
    line = regression(centres.slice(0, last), db.slice(0, last));
    if (line[1] >= 0) {
      return null;
    }
    // EDW VRISKOUME POU TO FIT SYNANTA TON THORYVO GIA NA MIN METRAME TO NOISE FLOOR WS REVERB.
    const newCross = Math.min(total, (noiseDb - line[0]) / line[1]);
    // Estimate noise 5 dB past the crossing, including at least the last 10%.
    const slopePerSample = -line[1];
    const noiseStart = Math.min(Math.floor(0.9 * total), Math.floor(newCross + 5 / slopePerSample));
    noise = noiseOf(Math.max(noiseStart, 0));
    // Blocks of about 4 per 10 dB of decay (samples).
    block = Math.max(Math.round(10 / slopePerSample / 4), 8);
    const moved = Math.abs(newCross - cross);
    cross = newCross;
    if (moved < 0.001 * rate) {
      break;
    }
  }
  const end = Math.max(1, Math.min(total, Math.floor(cross)));
  return { end, noise, slopeDbPerSecond: line[1] * rate };
}

// Per-band parameters; energy includes the short lead-in before the direct sound.
function bandParameters(
  centre: number,
  energy: Float64Array,
  rate: number,
  limit: number,
  tail: number,
  noiseDbBelowPeak: number,
  lead: number,
  curve?: { values: Float32Array; step: number },
): BandParameters {
  const half = Math.round(DIRECT_WINDOW_SECONDS * rate);
  // Schroeder backward integral over [0, limit) plus the tail; dB relative to the total.
  const integral = new Float64Array(limit);
  let running = tail;
  for (let n = limit - 1; n >= 0; n--) {
    running += energy[n];
    integral[n] = running;
  }
  const total = integral[0];
  const curveDb = new Float64Array(limit);
  for (let n = 0; n < limit; n++) {
    curveDb[n] = 10 * Math.log10(Math.max(integral[n] / total, 1e-300));
  }
  if (curve) {
    for (let i = 0; i < curve.values.length; i++) {
      curve.values[i] = curveDb[Math.min(limit - 1, i * curve.step)];
    }
  }

  const before = (seconds: number): number => {
    // Times count from t0, which is `lead` samples after the start of `energy`.
    const index = Math.min(limit, lead + Math.round(seconds * rate));
    return index >= limit ? total : total - integral[index];
  };
  const clarity = (seconds: number): number => {
    const early = before(seconds);
    return 10 * Math.log10(Math.max(early, 1e-300) / Math.max(total - early, 1e-300));
  };
  // The direct window includes lead samples before t0 and half + 1 after it.
  let directEnergy = 0;
  for (let n = 0; n < Math.min(limit, lead + half + 1); n++) {
    directEnergy += energy[n];
  }
  return {
    centre,
    t20: timeFromSlope(decaySlope(curveDb, rate, -5, -25)),
    t30: timeFromSlope(decaySlope(curveDb, rate, -5, -35)),
    edt: timeFromSlope(decaySlope(curveDb, rate, 0, -10)),
    c50: clarity(0.05),
    c80: clarity(0.08),
    d50: before(0.05) / total,
    drr: 10 * Math.log10(Math.max(directEnergy, 1e-300) / Math.max(total - directEnergy, 1e-300)),
    usableSeconds: limit / rate,
    dynamicRangeDb: noiseDbBelowPeak,
  };
}

// ISO 3382-1 parameters of an impulse response (one or two channels).
export function analyzeRoomImpulse(
  channels: ArrayLike<number>[],
  rate: number,
  options: RoomParametersOptions = {},
): RoomParameters {
  const centres = options.bands ?? ANALYSIS_BANDS;
  const onset = directOnset(channels, rate);
  const half = Math.round(DIRECT_WINDOW_SECONDS * rate);
  // Include zero-phase filter pre-ringing in the direct sound window.
  const start = Math.max(0, onset - half);
  const bands: BandParameters[] = [];
  const curves: Float32Array[] = [];
  for (const centre of centres) {
    const length = channels[0].length - start;
    const energy = new Float64Array(length);
    for (const channel of channels) {
      const filtered = octaveBand(channel, rate, centre);
      for (let n = 0; n < length; n++) {
        energy[n] += filtered[start + n] ** 2;
      }
    }
    let limit = length;
    let tail = 0;
    let dynamicRange = Infinity;
    if (options.noiseCompensation) {
      const found = lundeby(energy, rate);
      if (found) {
        limit = found.end;
        // Decay rate per sample of the fitted line; the tail integral of noise * exp(-k n) is noise / k.
        const k = (-found.slopeDbPerSecond / rate / 10) * Math.LN10;
        tail = k > 0 ? found.noise / k : 0;
        let peak = 0;
        for (let n = 0; n < Math.min(length, onset - start + half + 1); n++) {
          peak = Math.max(peak, energy[n]);
        }
        dynamicRange = 10 * Math.log10(Math.max(peak, 1e-300) / found.noise);
      }
    }
    const step = options.curveStepSamples ?? 64;
    let curve: { values: Float32Array; step: number } | undefined;
    if (options.keepCurves) {
      const values = new Float32Array(Math.ceil(length / step)).fill(-120);
      curve = { values, step };
    }
    bands.push(bandParameters(centre, energy, rate, limit, tail, dynamicRange, onset - start, curve));
    if (curve) {
      curves.push(curve.values);
    }
  }
  return {
    sampleRate: rate,
    onsetSample: onset,
    bands,
    curves: options.keepCurves ? curves : undefined,
  };
}

export interface BinauralBand {
  centre: number;
  iaccEarly: number; // IACC 0-80 ms
  iaccLate: number; // IACC 80 ms to lateSeconds
  ildEarlyDb: number; // interaural level difference 0-80 ms (dB)
  ildDirectDb: number; // ILD of the direct sound alone (dB)
}

// IACC and interaural level difference per band of a binaural response.
export function binauralIndicators(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  rate: number,
  lateSeconds: number,
  bandCentres: readonly number[] = ANALYSIS_BANDS,
): BinauralBand[] {
  const onset = directOnset([left, right], rate);
  const early = Math.round(0.08 * rate);
  const maxLag = Math.round(0.001 * rate);
  const lateEnd = Math.min(left.length, onset + Math.round(lateSeconds * rate));
  const result: BinauralBand[] = [];
  for (const centre of bandCentres) {
    const l = octaveBand(left, rate, centre);
    const r = octaveBand(right, rate, centre);
    const correlation = (from: number, to: number): number => {
      let ll = 0;
      let rr = 0;
      for (let n = from; n < to; n++) {
        ll += l[n] ** 2;
        rr += r[n] ** 2;
      }
      let best = 0;
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        let sum = 0;
        for (let n = Math.max(from, from - lag); n < Math.min(to, to - lag); n++) {
          sum += l[n] * r[n + lag];
        }
        best = Math.max(best, Math.abs(sum));
      }
      // EDW KANONIKOPOIOUME TIN CROSS-CORRELATION TWN DYO AFTIWN GIA NA VGALEI TON DEIKTI IACC.
      return best / Math.sqrt(Math.max(ll * rr, 1e-300));
    };
    const level = (from: number, to: number): number => {
      let leftEnergy = 0;
      let rightEnergy = 0;
      for (let n = Math.max(0, from); n < Math.min(l.length, to); n++) {
        leftEnergy += l[n] ** 2;
        rightEnergy += r[n] ** 2;
      }
      return 10 * Math.log10(Math.max(leftEnergy, 1e-300) / Math.max(rightEnergy, 1e-300));
    };
    const half = Math.round(DIRECT_WINDOW_SECONDS * rate);
    result.push({
      centre,
      iaccEarly: correlation(onset, Math.min(l.length, onset + early)),
      iaccLate: correlation(onset + early, lateEnd),
      ildEarlyDb: level(onset, onset + early),
      ildDirectDb: level(onset - half, onset + half + 1),
    });
  }
  return result;
}
