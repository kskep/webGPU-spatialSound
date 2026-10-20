import { BAND_CENTERS } from '../acoustics/model.ts';
export function bandNoiseSeed(sceneSeed: number, band: number, channel: number, salt = 0): number {
  return ((sceneSeed || 1) ^ ((band * 2 + channel + 1) * 0x9e3779b9) ^ salt) >>> 0;
}
// Scratch buffer for the filtered noise, kept between calls (the worker runs one build at a time).
let scratch = new Float32Array(0);

function firstSampleOfBin(bin: number, rate: number, binSeconds: number): number {
  let guess = Math.max(0, Math.ceil(bin * rate * binSeconds));
  while (guess > 0 && Math.floor((guess - 1) / rate / binSeconds) >= bin) guess--;
  while (Math.floor(guess / rate / binSeconds) < bin) guess++;
  return guess;
}

export function addBandNoise(
  output: Float32Array,
  bins: ArrayLike<number>,
  binSeconds: number,
  band: number,
  seed: number,
  rate: number,
): void {
  const length = output.length;
  const count = bins.length;
  let total = 0;
  for (let i = 0; i < count; i++) total += bins[i];
  if (total === 0) return;
  // White-source bandwidth weighting; no implicit convolver normalization.
  const lower = band === 0 ? 0 : Math.sqrt(BAND_CENTERS[band - 1] * BAND_CENTERS[band]);
  const upper = Math.min(
    rate / 2,
    band === 7 ? rate / 2 : Math.sqrt(BAND_CENTERS[band] * BAND_CENTERS[band + 1]),
  );
  if (upper <= lower) return;
  // Band-pass coefficients.
  const centre = Math.min(BAND_CENTERS[band], rate * 0.45);
  const omega = (2 * Math.PI * centre) / rate;
  const alpha = Math.sin(omega) / (2 * Math.SQRT2);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -b0;
  const a1 = (-2 * Math.cos(omega)) / a0;
  const a2 = (1 - alpha) / a0;
  if (scratch.length < length) scratch = new Float32Array(length);
  const filtered = scratch;
  let previousInput = 0;
  let olderInput = 0;
  let previousOutput = 0;
  let olderOutput = 0;
  let actual = 0;
  for (let bin = 0; bin < count; bin++) {
    const first = firstSampleOfBin(bin, rate, binSeconds);
    const last = bin === count - 1 ? length : Math.min(length, firstSampleOfBin(bin + 1, rate, binSeconds));
    const amplitude = Math.sqrt(bins[bin]);
    for (let i = first; i < last; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      // Single-precision noise sample, as if stored in a Float32Array before filtering.
      const input = Math.fround(((seed >>> 0) / 2147483648 - 1) * amplitude);
      const sample = b0 * input + b2 * olderInput - a1 * previousOutput - a2 * olderOutput;
      const stored = Math.fround(sample);
      filtered[i] = stored;
      actual += stored * stored;
      olderInput = previousInput;
      previousInput = input;
      olderOutput = previousOutput;
      previousOutput = sample;
    }
  }
  // EDW RYTHMIZOUME TO GAIN TOU NOISE GIA NA ANTISTOIXEI STIN ENERGEIA TIS BANDAS.
  const gain = Math.sqrt((4 * Math.PI * total * (upper - lower)) / (rate / 2) / Math.max(actual, 1e-30));
  for (let i = 0; i < length; i++) output[i] += filtered[i] * gain;
}
