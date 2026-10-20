// Divide the smoothed stochastic energy between listener-local directions.
// Each bin gets independent octave-band noise, convolved with its left/right HRIR.
// Sharing that bin's noise between ears preserves the HRTF timing and level cues.
// The per-band normalisation keeps the traced energy.
import type { Arrival, Vec3 } from '../acoustics/model.ts';
import { distributeEnvelope, nearestDirection, type BinnedHit } from '../acoustics/direction-bins.ts';
import { smoothStochasticEnvelope, ENVELOPE_DEFAULTS } from '../acoustics/envelope.ts';
import {
  BINAURAL_SETTINGS,
  directionBinVectors,
  getDirectionBinSet,
  type BinauralSettings,
} from '../config/binaural.ts';
import { fft } from './dsp/stream-core.mjs';
import { addBandNoise } from './band-noise.ts';
import { addDelayed } from './hrtf-processing.ts';
import { toListenerLocal, type HRIR, type HrtfBank, type HrtfOptions } from './hrtf.ts';

// Seed of the noise of one octave band and one direction bin (independent of every other pair).
export function binNoiseSeed(sceneSeed: number, band: number, bin: number): number {
  return ((sceneSeed || 1) ^ (((band * 64 + bin + 1) * 0x9e3779b9) >>> 0) ^ 0x5bd1e995) >>> 0;
}

// What the stochastic rendering did, for the telemetry and the tests.
export interface StochasticBinauralReport {
  // Number of direction bins in the set and how many of them carried noise.
  binCount: number;
  activeBins: number;
  skippedBins: number;
  // Milliseconds spent smoothing the total envelope.
  envelopeMs: number;
  // Milliseconds spent on noise, HRIR lookup and convolution.
  renderMs: number;
}

export interface StochasticBinauralInput {
  arrivals: Arrival[];
  // Listener forward vector (world), to convert hit directions to listener coordinates.
  forward: Vec3;
  hrtf: HrtfBank;
  hrtfOptions: HrtfOptions;
  rate: number;
  // Length of the response in seconds.
  duration: number;
  onsetSeconds: number;
  decayRates: ArrayLike<number>;
  sceneSeed: number;
  settings?: BinauralSettings;
  left: Float32Array;
  right: Float32Array;
}

// An HRIR with its asset delays applied (the RIEC asset has none, so this usually copies nothing).
function withDelays(hrir: HRIR): { left: Float32Array; right: Float32Array } {
  if (Math.abs(hrir.delayLeft) < 1e-9 && Math.abs(hrir.delayRight) < 1e-9)
    return { left: hrir.left, right: hrir.right };
  const extra = Math.ceil(Math.max(0, hrir.delayLeft, hrir.delayRight)) + 10;
  const left = new Float32Array(hrir.left.length + extra);
  const right = new Float32Array(hrir.right.length + extra);
  addDelayed(left, hrir.left, hrir.delayLeft, 1, 8);
  addDelayed(right, hrir.right, hrir.delayRight, 1, 8);
  return { left, right };
}

// The octave-band noise of one direction bin, all bands added (mono, `length` samples).
function binSignal(
  bands: Float64Array[],
  binSeconds: number,
  bin: number,
  sceneSeed: number,
  rate: number,
  length: number,
): Float32Array {
  const signal = new Float32Array(length);
  for (let band = 0; band < 8; band++)
    addBandNoise(signal, bands[band], binSeconds, band, binNoiseSeed(sceneSeed, band, bin), rate);
  return signal;
}

function convolveBins(
  signals: { signal: Float32Array; hrir: { left: Float32Array; right: Float32Array } }[],
  left: Float32Array,
  right: Float32Array,
): void {
  if (signals.length === 0) return;
  const hrirLength = Math.max(...signals.map(({ hrir }) => hrir.left.length));
  let size = 2;
  while (size < 2 * hrirLength) size *= 2;
  const hop = size - hrirLength + 1;
  const length = left.length;
  // Spectrum of (left HRIR + i right HRIR) per bin.
  const filters = signals.map(({ hrir }) => {
    const real = new Float64Array(size);
    const imag = new Float64Array(size);
    real.set(hrir.left);
    imag.set(hrir.right);
    fft(real, imag);
    return { real, imag };
  });
  const blockReal = new Float64Array(size);
  const blockImag = new Float64Array(size);
  const sumReal = new Float64Array(size);
  const sumImag = new Float64Array(size);
  for (let start = 0; start < length; start += hop) {
    const stop = Math.min(length, start + hop);
    sumReal.fill(0);
    sumImag.fill(0);
    let any = false;
    signals.forEach(({ signal }, index) => {
      let silent = true;
      for (let i = start; i < stop; i++)
        if (signal[i] !== 0) {
          silent = false;
          break;
        }
      if (silent) return;
      any = true;
      blockReal.fill(0);
      blockImag.fill(0);
      for (let i = start; i < stop; i++) blockReal[i - start] = signal[i];
      fft(blockReal, blockImag);
      const filter = filters[index];
      for (let k = 0; k < size; k++) {
        // EDW POLLAPLASIAZOUME TA SPECTRA SIGNAL KAI HRIR GIA NA KANOUME CONVOLUTION ME FFT.
        sumReal[k] += blockReal[k] * filter.real[k] - blockImag[k] * filter.imag[k];
        sumImag[k] += blockReal[k] * filter.imag[k] + blockImag[k] * filter.real[k];
      }
    });
    if (!any) continue;
    fft(sumReal, sumImag, true);
    const limit = Math.min(size, length - start);
    for (let i = 0; i < limit; i++) {
      left[start + i] += sumReal[i];
      right[start + i] += sumImag[i];
    }
  }
}

export function renderStochasticBinaural(input: StochasticBinauralInput): StochasticBinauralReport {
  const settings = input.settings ?? BINAURAL_SETTINGS;
  const started = performance.now();
  const directions = directionBinVectors(getDirectionBinSet(settings.stochastic.binSetId));
  const binSeconds = ENVELOPE_DEFAULTS.binSeconds;

  // The smoothed total envelope, unweighted: the same estimator as the panned path.
  const total = smoothStochasticEnvelope(input.arrivals, {
    duration: input.duration,
    onsetSeconds: input.onsetSeconds,
    decayRates: input.decayRates,
    binSeconds,
    neighbours: ENVELOPE_DEFAULTS.neighbours,
  });
  const envelopeMs = performance.now() - started;

  // Direction bin of every hit, in listener coordinates.
  const hits: BinnedHit[] = [];
  for (const arrival of input.arrivals) {
    if (arrival.kind !== 'stochastic' || arrival.time < 0 || arrival.time >= input.duration) continue;
    hits.push({
      time: arrival.time,
      energyBands: arrival.energyBands,
      // Binned late-histogram arrivals  have no direction: they are spread over all bins.
      bin: arrival.binned
        ? 0
        : nearestDirection(toListenerLocal(arrival.direction, input.forward), directions),
      spread: arrival.binned === true,
    });
  }
  // EDW MOIRAZOUME TIN ENERGEIA SE KATEFTHYNSEIS GIA NA PERASEI APO TO SWSTO HRTF KATHE BIN.
  const { bins, skipped } = distributeEnvelope({
    total: total.bands,
    binSeconds: total.binSeconds,
    hits,
    binCount: directions.length,
    windowSeconds: settings.stochastic.shareWindowSeconds,
    minShare: settings.stochastic.minBinShare,
  });

  const signals = bins.map(({ bin, bands }) => ({
    signal: binSignal(bands, total.binSeconds, bin, input.sceneSeed, input.rate, input.left.length),
    hrir: withDelays(input.hrtf.resolveLocal(directions[bin], input.rate, input.hrtfOptions)),
  }));
  convolveBins(signals, input.left, input.right);
  return {
    binCount: directions.length,
    activeBins: bins.length,
    skippedBins: skipped.length,
    envelopeMs,
    renderMs: performance.now() - started - envelopeMs,
  };
}
