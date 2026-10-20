import { BAND_CENTERS } from '../acoustics/model.ts';
import { fft } from './dsp/stream-core.mjs';

// Where and how loud the tail of one octave band is.
export interface TailBand {
  // Reverberation time in seconds: the power falls by 60 dB in this time. 0 = no tail.
  rt60: number;
  // Power density at the join, in the units of `late-level.ts`; 0 or less = no tail.
  startPowerDensity: number;
  // Time in seconds at which the tail has ended (it is silent from there on).
  endSeconds: number;
}

// The two times that shape the start of every tail (seconds).
export interface TailTiming {
  // The tail is at its full level from here on.
  joinSeconds: number;
  // The tail starts here with silence and fades in (equal power) until the join.
  crossfadeStartSeconds: number;
}

export function tailPowerDensity(band: TailBand, timing: TailTiming, time: number): number {
  if (band.startPowerDensity <= 0 || time < timing.crossfadeStartSeconds || time >= band.endSeconds) return 0;
  const rate = band.rt60 === Infinity ? 0 : (6 * Math.LN10) / band.rt60;
  // EDW SVINOUME TIN ISXY ME TO RT60 TIS BANDAS GIA NA SYNEXIZEI TO LATE TAIL.
  const decayed = band.startPowerDensity * Math.exp(-rate * (time - timing.joinSeconds));
  if (time >= timing.joinSeconds) return decayed;
  const phase =
    ((time - timing.crossfadeStartSeconds) / (timing.joinSeconds - timing.crossfadeStartSeconds)) *
    (Math.PI / 2);
  return decayed * Math.sin(phase) ** 2;
}

// Smallest power of two that is at least `value`.
function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

// Fills `target` with uniform white noise in [-1, 1) from a seeded xorshift32 generator.
function fillWhiteNoise(target: Float64Array, seed: number): void {
  let state = seed >>> 0 || 1;
  for (let i = 0; i < target.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    target[i] = (state >>> 0) / 2147483648 - 1;
  }
}

// Mean of the squares of the first `count` samples.
function meanSquare(data: Float64Array, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += data[i] * data[i];
  return sum / count;
}

export function addDecayingTails(
  left: Float32Array,
  right: Float32Array,
  bands: TailBand[],
  timing: TailTiming,
  rate: number,
  seed: number,
): void {
  const length = left.length;
  const size = nextPowerOfTwo(length);

  // One white-noise pair for all bands: left ear in the real part, right ear in the imaginary part.
  // The masks below are real and symmetric, so they filter both ears independently in one transform.
  const whiteReal = new Float64Array(size);
  const whiteImag = new Float64Array(size);
  fillWhiteNoise(whiteReal, seed);
  fillWhiteNoise(whiteImag, seed ^ 0x2545f491);
  fft(whiteReal, whiteImag);

  const bandReal = new Float64Array(size);
  const bandImag = new Float64Array(size);
  for (let band = 0; band < 8; band++) {
    if (bands[band].startPowerDensity <= 0) continue;

    // Keep only the bins of this band (bin k and bin size - k stand for the same frequency).
    const lowerEdge = band === 0 ? 0 : Math.sqrt(BAND_CENTERS[band - 1] * BAND_CENTERS[band]);
    const upperEdge = band === 7 ? rate / 2 + 1 : Math.sqrt(BAND_CENTERS[band] * BAND_CENTERS[band + 1]);
    bandReal.fill(0);
    bandImag.fill(0);
    for (let bin = 1; bin < size; bin++) {
      const frequency = (Math.min(bin, size - bin) * rate) / size;
      if (frequency < lowerEdge || frequency >= upperEdge) continue;
      bandReal[bin] = whiteReal[bin];
      bandImag[bin] = whiteImag[bin];
    }
    fft(bandReal, bandImag, true);

    // Scale to unit mean square first, so that the envelope below fixes the level exactly.
    const leftPower = meanSquare(bandReal, length);
    const rightPower = meanSquare(bandImag, length);
    if (leftPower === 0 || rightPower === 0) continue; // nothing of this band fits at this sample rate
    // EDW KANOUME NORMALISATION TO NOISE GIA NA ELEGXOUME TIN ISXY POU PAIRNEI KATHE AFTI.
    const leftScale = 1 / Math.sqrt(leftPower);
    const rightScale = 1 / Math.sqrt(rightPower);
    for (let i = 0; i < length; i++) {
      // Each ear carries half of the power; power per second becomes mean square per sample.
      const meanSquarePerEar = tailPowerDensity(bands[band], timing, i / rate) / (2 * rate);
      if (meanSquarePerEar === 0) continue;
      const amplitude = Math.sqrt(meanSquarePerEar);
      left[i] += bandReal[i] * leftScale * amplitude;
      right[i] += bandImag[i] * rightScale * amplitude;
    }
  }
}
