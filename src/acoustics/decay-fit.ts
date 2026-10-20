// Fit RT60 from the forward energy envelope; use Eyring if the fit is unreliable.
// A Schroeder fit would be biased by truncated ray tails.
import { BAND_CENTERS, distance, type Arrival, type Bands, type Scene } from './model.ts';
import { decayRatesFromRT60, ENVELOPE_DEFAULTS, smoothStochasticEnvelope } from './envelope.ts';
import {
  eyringBandsFromMesh,
  meshRoomStatistics,
  type AcousticMesh,
  type MeshRoomStatistics,
} from '../geometry/acoustic-scene.ts';

export type DecaySource = 'ray-fit' | 'eyring';

export interface DecayFitOptions {
  binSeconds?: number;
  startMeanFreeTimes?: number;
  truncationFactor?: number;
  completeUntilSeconds?: number;
  floorDb?: number;
  referenceSeconds?: number;
  minRSquared?: number;
  minDynamicRangeDb?: number;
  minWindowMeanFreeTimes?: number;
  minHits?: number;
  sanityRatio?: [number, number];
}

export const DECAY_FIT_DEFAULTS = {
  binSeconds: 0.001,
  startMeanFreeTimes: 3,
  truncationFactor: 0.7,
  floorDb: 40,
  referenceSeconds: 0.01,
  minRSquared: 0.9,
  minDynamicRangeDb: 15,
  minWindowMeanFreeTimes: 4,
  minHits: 200,
  sanityRatio: [0.25, 4],
} as const;

export interface BandFitQuality {
  start: number;
  end: number;
  rSquared: number;
  dynamicRangeDb: number;
  hits: number;
  slopeDbPerSecond: number;
  fittedRt60: number | null;
  reason: string;
}

export interface LateDecayFit {
  rt60Bands: Bands;
  eyringBands: Bands;
  source: DecaySource[];
  quality: BandFitQuality[];
}

export interface LateDecay extends LateDecayFit {
  stats: MeshRoomStatistics;
}

interface LineFit {
  slope: number;
  rSquared: number;
}

function fitLine(xs: number[], ys: number[]): LineFit | undefined {
  const count = xs.length;
  if (count < 3) {
    return undefined;
  }
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < count; i++) {
    meanX += xs[i];
    meanY += ys[i];
  }
  meanX /= count;
  meanY /= count;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  for (let i = 0; i < count; i++) {
    sumXX += (xs[i] - meanX) ** 2;
    sumXY += (xs[i] - meanX) * (ys[i] - meanY);
    sumYY += (ys[i] - meanY) ** 2;
  }
  if (sumXX === 0 || sumYY === 0) {
    return undefined;
  }
  // EDW KANOUME LEAST-SQUARES FIT GIA NA VROUME TIN KLISI TIS ENERGEIAKIS PTWSIS KAI TO R2.
  const slope = sumXY / sumXX;
  const rSquared = (slope * sumXY) / sumYY;
  return { slope, rSquared };
}

function rejectedQuality(reason: string, start = 0, end = 0): BandFitQuality {
  return {
    start,
    end,
    rSquared: 0,
    dynamicRangeDb: 0,
    hits: 0,
    slopeDbPerSecond: 0,
    fittedRt60: null,
    reason,
  };
}

export function fitLateDecay(
  arrivals: Arrival[],
  scene: Scene,
  stats: MeshRoomStatistics,
  options: DecayFitOptions = {},
): LateDecayFit {
  const settings = { ...DECAY_FIT_DEFAULTS, ...options };
  const eyring = eyringBandsFromMesh(stats, scene.airDbPerMeter);
  const meanFreeTime = stats.meanFreePath / scene.speed;
  // Sound cannot arrive before the straight-line travel time from source to listener.
  const onset = distance(scene.source, scene.listener) / scene.speed;

  const stochastic = arrivals.filter((arrival) => arrival.kind === 'stochastic');
  let lastHitTime = 0;
  for (const arrival of stochastic) {
    lastHitTime = Math.max(lastHitTime, arrival.time);
  }

  const rt60Bands = [...eyring] as Bands;
  const source: DecaySource[] = BAND_CENTERS.map(() => 'eyring');
  if (stochastic.length === 0) {
    const quality = BAND_CENTERS.map(() => rejectedQuality('no stochastic hits'));
    return { rt60Bands, eyringBands: eyring, source, quality };
  }

  // Smooth the hits with mesh-Eyring decay compensation.
  const binSeconds = settings.binSeconds;
  const envelope = smoothStochasticEnvelope(stochastic, {
    duration: lastHitTime + 2 * binSeconds,
    binSeconds,
    onsetSeconds: onset,
    decayRates: decayRatesFromRT60(eyring),
    neighbours: ENVELOPE_DEFAULTS.neighbours,
  });
  const binCount = envelope.bands[0].length;

  // fit window bounds
  const startMeanFreeTimes = Math.max(settings.startMeanFreeTimes, scene.earlyOrder);
  // EDW KSEKINAME TO FIT META TO EARLY MEROS GIA NA METRISOUME KYRIWS TO LATE DECAY.
  const windowStart = onset + startMeanFreeTimes * meanFreeTime;
  const budgetEnd = options.completeUntilSeconds ?? settings.truncationFactor * scene.bounces * meanFreeTime;

  const quality: BandFitQuality[] = [];
  for (let band = 0; band < BAND_CENTERS.length; band++) {
    const energy = envelope.bands[band];
    const firstBin = Math.max(0, Math.ceil(windowStart / binSeconds - 0.5));

    // Level at the start of the window: mean over a short reference interval.
    const referenceBins = Math.max(1, Math.round(settings.referenceSeconds / binSeconds));
    let referenceLevel = 0;
    for (let bin = firstBin; bin < Math.min(binCount, firstBin + referenceBins); bin++) {
      referenceLevel += energy[bin] / referenceBins;
    }
    if (!(referenceLevel > 0)) {
      quality.push(rejectedQuality('no energy at the start of the fit window', windowStart, windowStart));
      continue;
    }

    // The window ends at the earliest of: bounce budget, floor level, last hit.
    const floorLevel = referenceLevel * Math.pow(10, -settings.floorDb / 10);
    let windowEnd = Math.min(budgetEnd, lastHitTime);
    for (let bin = firstBin + referenceBins; bin < binCount; bin++) {
      if (energy[bin] < floorLevel) {
        windowEnd = Math.min(windowEnd, bin * binSeconds);
        break;
      }
    }

    if (windowEnd - windowStart < settings.minWindowMeanFreeTimes * meanFreeTime) {
      quality.push(rejectedQuality('fit window shorter than 4 mean free times', windowStart, windowEnd));
      continue;
    }

    // fit a line through the dB envelope
    const times: number[] = [];
    const levelsDb: number[] = [];
    for (let bin = firstBin; bin < binCount; bin++) {
      const binTime = (bin + 0.5) * binSeconds;
      if (binTime < windowStart) {
        continue;
      }
      if (binTime > windowEnd) {
        break;
      }
      if (energy[bin] <= 0) {
        continue;
      }
      times.push(binTime);
      levelsDb.push(10 * Math.log10(energy[bin]));
    }
    const line = fitLine(times, levelsDb);
    let hits = 0;
    for (const arrival of stochastic) {
      if (arrival.time >= windowStart && arrival.time <= windowEnd) {
        hits += arrival.hitCount ?? 1;
      }
    }
    if (!line) {
      quality.push({ ...rejectedQuality('too few envelope bins to fit', windowStart, windowEnd), hits });
      continue;
    }

    const dynamicRangeDb = -line.slope * (windowEnd - windowStart);
    // EDW APO TIN KLISI SE dB/s VRISKOUME POSA DEYTEROLEPTA XREIAZONTAI GIA PTWSI 60 dB.
    const fittedRt60 = line.slope < 0 ? -60 / line.slope : null;
    // check if the fit is good enough
    const [lowRatio, highRatio] = settings.sanityRatio;
    let reason = 'accepted';
    if (hits < settings.minHits) {
      reason = `only ${hits} hits in the window (need ${settings.minHits})`;
    } else if (fittedRt60 === null) {
      reason = 'envelope does not decay';
    } else if (line.rSquared < settings.minRSquared) {
      reason = `R2 ${line.rSquared.toFixed(2)} below ${settings.minRSquared}`;
    } else if (dynamicRangeDb < settings.minDynamicRangeDb) {
      reason = `dynamic range ${dynamicRangeDb.toFixed(1)} dB below ${settings.minDynamicRangeDb} dB`;
    } else if (
      Number.isFinite(eyring[band]) &&
      (fittedRt60 < lowRatio * eyring[band] || fittedRt60 > highRatio * eyring[band])
    ) {
      reason = `fit ${fittedRt60.toFixed(2)} s outside ${lowRatio}x to ${highRatio}x Eyring`;
    }

    quality.push({
      start: windowStart,
      end: windowEnd,
      rSquared: line.rSquared,
      dynamicRangeDb,
      hits,
      slopeDbPerSecond: line.slope,
      fittedRt60,
      reason,
    });
    if (reason === 'accepted' && fittedRt60 !== null) {
      rt60Bands[band] = fittedRt60;
      source[band] = 'ray-fit';
    }
  }
  return { rt60Bands, eyringBands: eyring, source, quality };
}

export function traceLateDecay(
  scene: Scene,
  mesh: AcousticMesh,
  arrivals: Arrival[],
  options: DecayFitOptions = {},
): LateDecay {
  return lateDecayFromStatistics(scene, meshRoomStatistics(mesh, scene), arrivals, options);
}

export function lateDecayFromStatistics(
  scene: Scene,
  stats: MeshRoomStatistics,
  arrivals: Arrival[],
  options: DecayFitOptions = {},
): LateDecay {
  return { ...fitLateDecay(arrivals, scene, stats, options), stats };
}

export interface LateDecayRow {
  band: number;
  centerHz: number;
  fitRt60: number | null;
  eyringRt60: number | null;
  usedRt60: number | null;
  source: DecaySource;
  rSquared: number;
  windowStart: number;
  windowEnd: number;
  hits: number;
  dynamicRangeDb: number;
  reason: string;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function lateDecayTable(decay: LateDecay): LateDecayRow[] {
  return BAND_CENTERS.map((centerHz, band) => {
    const fit = decay.quality[band];
    return {
      band,
      centerHz,
      fitRt60: finiteOrNull(fit.fittedRt60),
      eyringRt60: finiteOrNull(decay.eyringBands[band]),
      usedRt60: finiteOrNull(decay.rt60Bands[band]),
      source: decay.source[band],
      rSquared: fit.rSquared,
      windowStart: fit.start,
      windowEnd: fit.end,
      hits: fit.hits,
      dynamicRangeDb: fit.dynamicRangeDb,
      reason: fit.reason,
    };
  });
}
