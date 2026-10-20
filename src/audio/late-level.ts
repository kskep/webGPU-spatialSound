import { BAND_CENTERS, type Arrival } from '../acoustics/model.ts';

// Number of effective rays at which the measured level and the theory are trusted equally.
const HALF_CONFIDENCE_RAYS = 64;

// Integral of exp(-rate * t) dt from `begin` to `end` (seconds); the limit `end - begin` when rate is 0.
export function exponentialIntegral(rate: number, begin: number, end: number): number {
  return rate === 0 ? end - begin : (Math.exp(-rate * begin) - Math.exp(-rate * end)) / rate;
}

// Amplitude decay rate in 1/s of the energy envelope exp(-rate t) for a 60 dB decay in `rt60` seconds.
export function energyDecayRate(rt60: number): number {
  return rt60 === Infinity ? 0 : (6 * Math.LN10) / rt60;
}

export function bandFraction(band: number, sampleRate: number): number {
  const lower = band === 0 ? 0 : Math.sqrt(BAND_CENTERS[band - 1] * BAND_CENTERS[band]);
  const upper = Math.min(
    sampleRate / 2,
    band === 7 ? sampleRate / 2 : Math.sqrt(BAND_CENTERS[band] * BAND_CENTERS[band + 1]),
  );
  return Math.max(0, (upper - lower) / (sampleRate / 2));
}

// Per band: summed stochastic arrival energy in a window, and the sum of its squares.
export interface WindowEnergy {
  energy: number[];
  squared: number[];
}

export function windowStochasticEnergy(arrivals: Arrival[], start: number, end: number): WindowEnergy {
  const energy: number[] = Array(8).fill(0);
  const squared: number[] = Array(8).fill(0);
  for (const arrival of arrivals) {
    if (
      (arrival.kind !== 'stochastic' && !arrival.rayTraced) ||
      arrival.time < start ||
      arrival.time >= end
    ) {
      continue;
    }
    for (let band = 0; band < 8; band++) {
      energy[band] += arrival.energyBands[band];
      squared[band] += arrival.energyBands[band] ** 2 / (arrival.hitCount ?? 1);
    }
  }
  return { energy, squared };
}

// What `windowLateLevel` needs to know about one band and one window.
export interface WindowLevelInput {
  // Summed traced energy of the band in the window.
  energy: number;
  // Sum of the squares of the individual arrival energies (gives the effective ray count).
  squared: number;
  // `bandFraction` of the band.
  fraction: number;
  // Reverberation time of the band in seconds (0 = fully absorbing, Infinity = lossless).
  rt60: number;
  speed: number;
  // Room volume in cubic metres.
  volume: number;
  windowStart: number;
  windowEnd: number;
}

// Mean power density in the window, as measured, as predicted by theory, and the blend of both.
export interface WindowLevel {
  measured: number;
  theory: number;
  // Weight of the measurement in the blend, 0 ... 1.
  weight: number;
  target: number;
}

export function windowLateLevel(input: WindowLevelInput): WindowLevel {
  const windowDuration = input.windowEnd - input.windowStart;
  // An omnidirectional receiver senses scalar intensity c E/V, not the c E/(4V) wall flux.
  const theory =
    input.rt60 === 0
      ? 0
      : (((4 * Math.PI * input.speed) / input.volume) *
          input.fraction *
          exponentialIntegral(energyDecayRate(input.rt60), input.windowStart, input.windowEnd)) /
        windowDuration;
  // EDW EKTIMOUME TIN AKSIOPISTIA TWN RAYS GIA NA ZYGISOUME TI METRISI ME TI THEWRIA.
  const effectiveRays = input.squared > 0 ? input.energy ** 2 / input.squared : 0;
  const weight = effectiveRays / (effectiveRays + HALF_CONFIDENCE_RAYS);
  const measured = (4 * Math.PI * input.energy * input.fraction) / windowDuration;
  return { measured, theory, weight, target: weight * measured + (1 - weight) * theory };
}
