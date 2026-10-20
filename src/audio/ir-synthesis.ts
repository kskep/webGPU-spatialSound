import {
  BAND_CENTERS,
  directionPan,
  eyringBands,
  type Arrival,
  type Scene,
  type TraceResult,
} from '../acoustics/model.ts';
import {
  decayRatesFromRT60,
  earliestDirectTime,
  ENVELOPE_DEFAULTS,
  smoothStochasticEnvelope,
} from '../acoustics/envelope.ts';
import type { HrtfBank } from './hrtf.ts';
import { addBandNoise, bandNoiseSeed } from './band-noise.ts';
import type { BinauralSettings, BinauralToggles } from '../config/binaural.ts';
import { renderStochasticBinaural } from './stochastic-binaural.ts';

export { addBandNoise, bandNoiseSeed };
// twiddle factors exp(-2*pi*i*k/size) per transform size
const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();

// in-place radix-2 FFT (inverse divides by n); duplicated from dsp/stream-core.mjs
function fft(real: Float64Array, imag: Float64Array, inverse = false): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    let table = twiddles.get(size);
    if (!table) {
      table = { cos: new Float64Array(size / 2), sin: new Float64Array(size / 2) };
      for (let j = 0; j < size / 2; j++) {
        table.cos[j] = Math.cos((-2 * Math.PI * j) / size);
        table.sin[j] = Math.sin((-2 * Math.PI * j) / size);
      }
      twiddles.set(size, table);
    }
    for (let start = 0; start < n; start += size)
      for (let j = 0; j < size / 2; j++) {
        const cosine = table.cos[j];
        const sine = table.sin[j] * (inverse ? -1 : 1);
        const top = start + j;
        const bottom = top + size / 2;
        const rotatedReal = cosine * real[bottom] - sine * imag[bottom];
        const rotatedImag = sine * real[bottom] + cosine * imag[bottom];
        real[bottom] = real[top] - rotatedReal;
        imag[bottom] = imag[top] - rotatedImag;
        real[top] += rotatedReal;
        imag[top] += rotatedImag;
      }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
}
// minimum-phase FIR whose magnitude follows octave-band pressure gains (homomorphic/cepstral method)
// gains[0..7] are interpolated in log-frequency/log-gain; the caller places the kernel at the arrival time
export function pressureKernel(gains: number[], rate: number, n = 1024): Float32Array {
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  const gainAt = (frequency: number) => {
    if (frequency <= BAND_CENTERS[0]) return gains[0];
    for (let i = 1; i < 8; i++)
      if (frequency <= BAND_CENTERS[i]) {
        const fraction =
          Math.log(frequency / BAND_CENTERS[i - 1]) / Math.log(BAND_CENTERS[i] / BAND_CENTERS[i - 1]);
        return Math.exp(
          Math.log(Math.max(1e-12, gains[i - 1])) * (1 - fraction) +
            Math.log(Math.max(1e-12, gains[i])) * fraction,
        );
      }
    return gains[7];
  };
  for (let bin = 0; bin < n; bin++)
    // EDW METATREPOUME TA BAND GAINS SE LOG SPECTRUM GIA NA KATASKEVASOUME TO PRESSURE FILTER.
    real[bin] = Math.log(Math.max(1e-12, gainAt((Math.min(bin, n - bin) * rate) / n)));
  fft(real, imag, true);
  for (let bin = 1; bin < n / 2; bin++) real[bin] *= 2;
  for (let bin = n / 2 + 1; bin < n; bin++) real[bin] = 0;
  imag.fill(0);
  fft(real, imag);
  for (let bin = 0; bin < n; bin++) {
    const magnitude = Math.exp(real[bin]);
    const phase = imag[bin];
    real[bin] = magnitude * Math.cos(phase);
    imag[bin] = magnitude * Math.sin(phase);
  }
  fft(real, imag, true);
  return Float32Array.from(real);
}
// time spent in the IR build stages (milliseconds)
export interface IrBuildTimings {
  envelopeSmoothingMs: number;
  stochasticHrtfMs?: number;
}

export interface IrBuildOptions {
  duration?: number;
  rt60Bands?: ArrayLike<number>;
  timings?: IrBuildTimings;
  binaural?: BinauralToggles;
  binauralSettings?: BinauralSettings;
}
export interface StereoIR {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  duration: number;
  analyticalCount: number;
}
// linear convolution via FFT (zero-padded to the next power of two)
function convolve(a: Float32Array, b: Float32Array): Float32Array {
  const length = a.length + b.length - 1;
  let size = 1;
  while (size < length) size *= 2;
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  ar.set(a);
  br.set(b);
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < size; k++) {
    const real = ar[k] * br[k] - ai[k] * bi[k];
    ai[k] = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = real;
  }
  fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, length));
}
// binaural IR of one trace: coherent filtered early arrivals + energy-preserving decorrelated late field
// early: pressure kernels at each arrival convolved with HRIRs (or equal-power panned)
export function synthesizeIR(
  scene: Scene,
  result: TraceResult,
  rate: number,
  hrtf?: HrtfBank,
  options: IrBuildOptions = {},
): StereoIR {
  const maximum = result.arrivals.reduce((value, arrival) => Math.max(value, arrival.time), 0.5);
  const duration = options.duration ?? maximum + 0.08;
  const length = Math.ceil(duration * rate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  // Equalisation and interpolation of the HRTF apply to every response looked up below.
  const hrtfOptions = options.binaural
    ? { equalise: options.binaural.diffuseFieldEq, interpolate: options.binaural.hrtfInterpolation }
    : {};
  for (const arrival of result.arrivals) {
    if (arrival.kind === 'stochastic') continue;
    if (arrival.energy === 0) continue;
    const kernel = pressureKernel(
      arrival.energyBands.map((bandEnergy) => Math.sqrt(4 * Math.PI * bandEnergy)),
      rate,
    );
    const ears = hrtf?.resolve(arrival.direction, scene.listenerForward, rate, hrtfOptions);
    const angle = ((directionPan(arrival.direction, scene.listenerForward) + 1) * Math.PI) / 4;
    const kernels = ears
      ? [convolve(kernel, ears.left), convolve(kernel, ears.right)]
      : [
          Float32Array.from(kernel, (v) => v * Math.cos(angle)),
          Float32Array.from(kernel, (v) => v * Math.sin(angle)),
        ];
    for (let channel = 0; channel < 2; channel++) {
      const start = arrival.time * rate + (ears ? (channel === 0 ? ears.delayLeft : ears.delayRight) : 0);
      const index = Math.floor(start);
      const fraction = start - index;
      const output = channel === 0 ? left : right;
      for (let tap = 0; tap < kernels[channel].length && index + tap < length - 1; tap++) {
        output[index + tap] += kernels[channel][tap] * (1 - fraction);
        output[index + tap + 1] += kernels[channel][tap] * fraction;
      }
    }
  }
  // Stochastic part, binaural: the total envelope shared out over direction bins, each rendered
  // through its own HRIR pair (see stochastic-binaural.ts).
  const onsetSeconds = earliestDirectTime(result.arrivals);
  if (hrtf && options.binaural?.stochasticHrtf) {
    const report = renderStochasticBinaural({
      arrivals: result.arrivals,
      forward: scene.listenerForward,
      hrtf,
      hrtfOptions,
      rate,
      duration,
      onsetSeconds,
      decayRates: decayRatesFromRT60(options.rt60Bands ?? eyringBands(scene)),
      sceneSeed: scene.seed,
      settings: options.binauralSettings,
      left,
      right,
    });
    if (options.timings) {
      options.timings.envelopeSmoothingMs = report.envelopeMs;
      options.timings.stochasticHrtfMs = report.renderMs;
    }
    return { left, right, sampleRate: rate, duration, analyticalCount: result.analyticalCount };
  }
  // Stochastic part, panned: a gap-free, energy-conserving 1 ms envelope per band and ear.
  // The left and right ears are smoothed separately (same hit times, so the same
  // adaptive bandwidths), with each hit weighted by its pan gain. Smoothing the
  // two channels directly guarantees that each channel keeps exactly the energy
  // it had before (sum of energy * pan gain), which a smoothed pan ratio would not.
  // Decay compensation only shapes the smoothing; the caller may pass the measured RT60 instead of Eyring.
  const decayRates = decayRatesFromRT60(options.rt60Bands ?? eyringBands(scene));
  const panGain = (arrival: Arrival, ear: 'left' | 'right'): number => {
    const pan = directionPan(arrival.direction, scene.listenerForward);
    return ear === 'left' ? (1 - pan) / 2 : (1 + pan) / 2;
  };
  const envelopeStarted = performance.now();
  const envelopes = (['left', 'right'] as const).map((ear) =>
    smoothStochasticEnvelope(result.arrivals, {
      duration,
      onsetSeconds,
      decayRates,
      binSeconds: ENVELOPE_DEFAULTS.binSeconds,
      neighbours: ENVELOPE_DEFAULTS.neighbours,
      weight: (arrival) => panGain(arrival, ear),
    }),
  );
  if (options.timings) options.timings.envelopeSmoothingMs = performance.now() - envelopeStarted;
  const binSeconds = envelopes[0].binSeconds;
  for (let band = 0; band < 8; band++)
    for (let channel = 0; channel < 2; channel++) {
      const seed = bandNoiseSeed(scene.seed, band, channel);
      addBandNoise(
        channel === 0 ? left : right,
        envelopes[channel].bands[band],
        binSeconds,
        band,
        seed,
        rate,
      );
    }
  return { left, right, sampleRate: rate, duration, analyticalCount: result.analyticalCount };
}
