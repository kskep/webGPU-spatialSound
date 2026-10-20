// Smooth sparse hits with a Hann kernel whose width follows the K nearest hits.
// Compensate for decay, then rescale each band to preserve its total energy.

import type { Arrival } from './model.ts';

export const ENVELOPE_DEFAULTS = {
  method: 'adaptive-knn-hann-kde-decay-compensated',
  neighbours: 12,
  binSeconds: 0.001,
  minBandwidth: 0.0005,
  maxBandwidth: 0.025,
} as const;

const MAX_COMPENSATION_EXPONENT = 600;

export interface EnvelopeOptions {
  binSeconds?: number;
  duration: number;
  onsetSeconds?: number;
  neighbours?: number;
  decayRates?: ArrayLike<number>;
  minBandwidth?: number;
  maxBandwidth?: number;
  weight?: (arrival: Arrival) => number;
}

export interface StochasticEnvelope {
  binSeconds: number;
  start: number;
  bands: Float64Array[];
  bandwidth: Float64Array;
  raw: Float64Array[];
}

// decay rate from RT60: 6*ln10 / RT60
export function decayRatesFromRT60(rt60: ArrayLike<number>): Float64Array {
  const rates = new Float64Array(8);
  for (let band = 0; band < 8; band++) {
    const time = rt60[band];
    const usable = Number.isFinite(time) && time > 0;
    // EDW METATREPOUME TO RT60 SE EKTHETIKO RYTHMO APOSTVESIS GIA TIN KATHE BANDA.
    rates[band] = usable ? (6 * Math.LN10) / time : 0;
  }
  return rates;
}

export function earliestDirectTime(arrivals: Arrival[]): number {
  let earliest = Infinity;
  for (const arrival of arrivals) {
    if (arrival.kind === 'direct' && arrival.time < earliest) {
      earliest = arrival.time;
    }
  }
  return Number.isFinite(earliest) ? earliest : 0;
}

function compensation(rate: number, secondsSinceOnset: number): number {
  const exponent = Math.min(rate * secondsSinceOnset, MAX_COMPENSATION_EXPONENT);
  return Math.exp(exponent);
}

// distance to Kth nearest neighbor in sorted array
function distanceToKthNeighbour(sortedTimes: Float64Array, position: number, k: number): number {
  const center = sortedTimes[position];
  let below = position - 1;
  let above = position + 1;
  let distance = Infinity;
  for (let taken = 0; taken < k; taken++) {
    const belowDistance = below >= 0 ? center - sortedTimes[below] : Infinity;
    const aboveDistance = above < sortedTimes.length ? sortedTimes[above] - center : Infinity;
    if (belowDistance === Infinity && aboveDistance === Infinity) {
      break;
    }
    if (belowDistance <= aboveDistance) {
      distance = belowDistance;
      below--;
    } else {
      distance = aboveDistance;
      above++;
    }
  }
  return distance;
}

export function smoothStochasticEnvelope(arrivals: Arrival[], options: EnvelopeOptions): StochasticEnvelope {
  const binSeconds = options.binSeconds ?? ENVELOPE_DEFAULTS.binSeconds;
  const duration = options.duration;
  const onset = options.onsetSeconds ?? 0;
  const neighbours = Math.max(1, Math.floor(options.neighbours ?? ENVELOPE_DEFAULTS.neighbours));
  const minBandwidth = options.minBandwidth ?? ENVELOPE_DEFAULTS.minBandwidth;
  const maxBandwidth = options.maxBandwidth ?? ENVELOPE_DEFAULTS.maxBandwidth;
  const decayRates = options.decayRates ?? new Float64Array(8);
  const binCount = Math.max(1, Math.ceil(duration / binSeconds));

  const smoothed: Float64Array[] = [];
  const raw: Float64Array[] = [];
  for (let band = 0; band < 8; band++) {
    smoothed.push(new Float64Array(binCount));
    raw.push(new Float64Array(binCount));
  }
  const bandwidthSum = new Float64Array(binCount);
  const bandwidthWeight = new Float64Array(binCount);

  // filter to stochastic hits only, sorted by time
  const hits: Arrival[] = [];
  for (const arrival of arrivals) {
    if (arrival.kind !== 'stochastic') {
      continue;
    }
    if (arrival.time < 0 || arrival.time >= duration) {
      continue;
    }
    hits.push(arrival);
  }
  hits.sort((a, b) => a.time - b.time);
  const hitCount = hits.length;
  const times = new Float64Array(hitCount);
  for (let i = 0; i < hitCount; i++) {
    times[i] = hits[i].time;
  }

  // per-hit per-band energy and totals
  const inputTotals = new Float64Array(8);
  const energies = Array.from({ length: 8 }, () => new Float64Array(hitCount));
  for (let i = 0; i < hitCount; i++) {
    const gain = options.weight ? options.weight(hits[i]) : 1;
    const rawBin = Math.min(binCount - 1, Math.floor(times[i] / binSeconds));
    for (let band = 0; band < 8; band++) {
      const energy = hits[i].energyBands[band] * gain;
      energies[band][i] = energy;
      inputTotals[band] += energy;
      raw[band][rawBin] += energy;
    }
  }

  const scratch = new Float64Array(Math.ceil((2 * maxBandwidth) / binSeconds) + 4);
  const compensated = new Float64Array(8);

  for (let i = 0; i < hitCount; i++) {
    const time = times[i];

    // adaptive bandwidth from KNN
    const kthDistance = distanceToKthNeighbour(times, i, neighbours);
    // EDW ALLAZOUME TO PLATOS TOU KERNEL APO TA GEITONIKA HITS GIA NA GEMIZOUME TA ARAIA SHMEIA.
    const halfWidth = Math.min(maxBandwidth, Math.max(minBandwidth, kthDistance));

    // decay compensation
    for (let band = 0; band < 8; band++) {
      compensated[band] = energies[band][i] * compensation(decayRates[band], time - onset);
    }

    // Hann kernel
    let firstBin = Math.ceil((time - halfWidth) / binSeconds - 0.5);
    let lastBin = Math.floor((time + halfWidth) / binSeconds - 0.5);
    firstBin = Math.max(firstBin, Math.ceil(onset / binSeconds - 0.5), 0);
    lastBin = Math.min(lastBin, binCount - 1, Math.floor(duration / binSeconds - 0.5));
    let weightSum = 0;
    let usedBins = 0;
    if (lastBin >= firstBin && lastBin - firstBin < scratch.length) {
      usedBins = lastBin - firstBin + 1;
      for (let k = 0; k < usedBins; k++) {
        const binCenter = (firstBin + k + 0.5) * binSeconds;
        const offset = (binCenter - time) / halfWidth;
        // EDW DINOUME HANN VARI GIA NA APLWTHEI OMALA I ENERGEIA GYRW APO KATHE HIT.
        const weight = Math.abs(offset) < 1 ? 0.5 * (1 + Math.cos(Math.PI * offset)) : 0;
        scratch[k] = weight;
        weightSum += weight;
      }
    }

    if (weightSum > 1e-300) {
      for (let k = 0; k < usedBins; k++) {
        const weight = scratch[k] / weightSum;
        if (weight === 0) {
          continue;
        }
        const bin = firstBin + k;
        for (let band = 0; band < 8; band++) {
          smoothed[band][bin] += compensated[band] * weight;
        }
        bandwidthSum[bin] += halfWidth * weight;
        bandwidthWeight[bin] += weight;
      }
    } else {
      // kernel too narrow - put everything in nearest bin
      const bin = Math.min(binCount - 1, Math.floor(Math.max(time, onset) / binSeconds));
      for (let band = 0; band < 8; band++) {
        smoothed[band][bin] += compensated[band];
      }
      bandwidthSum[bin] += halfWidth;
      bandwidthWeight[bin] += 1;
    }
  }

  // undo compensation and rescale to conserve energy exactly
  for (let band = 0; band < 8; band++) {
    let outputTotal = 0;
    for (let bin = 0; bin < binCount; bin++) {
      const binTime = (bin + 0.5) * binSeconds;
      const value = smoothed[band][bin] / compensation(decayRates[band], binTime - onset);
      smoothed[band][bin] = value;
      outputTotal += value;
    }
    if (outputTotal > 0 && inputTotals[band] > 0) {
      // EDW DIORTHWNOUME TO GAIN META TO SMOOTHING GIA NA MEINEI IDIA I SYNOLIKI ENERGEIA TIS BANDAS.
      const scale = inputTotals[band] / outputTotal;
      for (let bin = 0; bin < binCount; bin++) {
        smoothed[band][bin] *= scale;
      }
    }
  }

  const bandwidth = new Float64Array(binCount);
  for (let bin = 0; bin < binCount; bin++) {
    if (bandwidthWeight[bin] > 0) {
      bandwidth[bin] = bandwidthSum[bin] / bandwidthWeight[bin];
    }
  }
  return { binSeconds, start: 0, bands: smoothed, bandwidth, raw };
}

// mean of all 8 bands / 8 (same as Arrival.energy)
export function meanBandEnvelope(bands: Float64Array[]): Float64Array {
  const mean = new Float64Array(bands[0].length);
  for (const band of bands) {
    for (let bin = 0; bin < mean.length; bin++) {
      mean[bin] += band[bin] / 8;
    }
  }
  return mean;
}
