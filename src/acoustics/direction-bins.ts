// Share the smoothed energy envelope between listener-local direction bins.
// Measure each bin's share in time windows, interpolate between windows, and
// renormalise per band so the shares keep the original total energy.
// Hits without a direction are spread equally between bins.
import type { Vec3 } from './model.ts';

export interface BinnedHit {
  // Arrival time in seconds.
  time: number;
  // Energy per octave band.
  energyBands: ArrayLike<number>;
  bin: number;
  // Directionless histogram hits are shared equally; their bin index is ignored.
  spread?: boolean;
}

// The envelope (energy per time bin, per band) that belongs to one direction bin.
export interface BinEnvelope {
  bin: number;
  // One Float64Array per octave band, the same length as the total envelope.
  bands: Float64Array[];
}

// Index of the direction (unit vectors) with the largest dot product with `local`.
export function nearestDirection(local: Vec3, directions: Vec3[]): number {
  let best = 0;
  let score = -Infinity;
  for (let i = 0; i < directions.length; i++) {
    // EDW SYGKRINOUME DOT PRODUCTS GIA NA VROUME TIN KATEFTHYNSI POU EINAI PIO KONTA STO HIT.
    const dot = local[0] * directions[i][0] + local[1] * directions[i][1] + local[2] * directions[i][2];
    if (dot > score) {
      score = dot;
      best = i;
    }
  }
  return best;
}

export interface DistributeOptions {
  // The smoothed total envelope: one array per octave band.
  total: Float64Array[];
  // Duration of one envelope bin in seconds.
  binSeconds: number;
  hits: BinnedHit[];
  binCount: number;
  // Length of the windows in which the shares are measured.
  windowSeconds: number;
  // A bin is skipped when its share of the energy is below this in every band.
  minShare: number;
}

export interface Distribution {
  bins: BinEnvelope[];
  skipped: number[];
}

export function distributeEnvelope(options: DistributeOptions): Distribution {
  const { total, binSeconds, hits, binCount, windowSeconds, minShare } = options;
  const envelopeLength = total[0].length;
  const duration = envelopeLength * binSeconds;
  const windows = Math.max(1, Math.ceil(duration / windowSeconds));

  // Energy per band, window and bin; and per band and window over all bins.
  const energy = new Float64Array(8 * windows * binCount);
  const windowTotal = new Float64Array(8 * windows);
  for (const hit of hits) {
    const window = Math.min(windows - 1, Math.max(0, Math.floor(hit.time / windowSeconds)));
    for (let band = 0; band < 8; band++) {
      if (hit.spread) {
        for (let bin = 0; bin < binCount; bin++) {
          energy[(band * windows + window) * binCount + bin] += hit.energyBands[band] / binCount;
        }
      } else {
        energy[(band * windows + window) * binCount + hit.bin] += hit.energyBands[band];
      }
      windowTotal[band * windows + window] += hit.energyBands[band];
    }
  }
  // Shares per band, window and bin; empty windows copy the nearest non-empty one.
  const shares = new Float64Array(energy.length);
  for (let band = 0; band < 8; band++) {
    for (let window = 0; window < windows; window++) {
      let source = window;
      if (windowTotal[band * windows + window] === 0) {
        source = -1;
        for (let distance = 1; distance < windows && source < 0; distance++) {
          if (window - distance >= 0 && windowTotal[band * windows + window - distance] > 0) {
            source = window - distance;
          }
          else if (window + distance < windows && windowTotal[band * windows + window + distance] > 0) {
            source = window + distance;
          }
        }
        if (source < 0) {
          continue;
        }
      }
      const sum = windowTotal[band * windows + source];
      for (let bin = 0; bin < binCount; bin++) {
        shares[(band * windows + window) * binCount + bin] =
          energy[(band * windows + source) * binCount + bin] / sum;
      }
    }
  }

  // Envelope of every bin: total envelope times the share, interpolated between window centres.
  const envelopes: Float64Array[][] = [];
  for (let bin = 0; bin < binCount; bin++) {
    const bands: Float64Array[] = [];
    for (let band = 0; band < 8; band++) {
      bands.push(new Float64Array(envelopeLength));
    }
    envelopes.push(bands);
  }
  for (let band = 0; band < 8; band++) {
    const totalBand = total[band];
    for (let step = 0; step < envelopeLength; step++) {
      if (totalBand[step] === 0) {
        continue;
      }
      // EDW KANOUME INTERPOLATION ANAMESA STA XRONIKA PARATHYRA GIA NA MIN ALLAZEI APOTOMA I KATEFTHYNSI.
      const position = ((step + 0.5) * binSeconds) / windowSeconds - 0.5;
      let first = Math.floor(position);
      let fraction = position - first;
      if (first < 0) {
        first = 0;
        fraction = 0;
      } else if (first >= windows - 1) {
        first = windows - 1;
        fraction = 0;
      }
      const base = (band * windows + first) * binCount;
      for (let bin = 0; bin < binCount; bin++) {
        let share = shares[base + bin];
        if (fraction !== 0) {
          share = (1 - fraction) * shares[base + bin] + fraction * shares[base + binCount + bin];
        }
        envelopes[bin][band][step] = totalBand[step] * share;
      }
    }
  }

  // Decide which bins stay: a bin must hold at least `minShare` of some band's energy.
  const bandTotals = total.map((band) => band.reduce((sum, v) => sum + v, 0));
  const kept: number[] = [];
  const skipped: number[] = [];
  const binFractions: number[] = [];
  for (let bin = 0; bin < binCount; bin++) {
    let largest = 0;
    for (let band = 0; band < 8; band++) {
      if (bandTotals[band] === 0) {
        continue;
      }
      let sum = 0;
      for (const v of envelopes[bin][band]) {
        sum += v;
      }
      largest = Math.max(largest, sum / bandTotals[band]);
    }
    binFractions.push(largest);
    if (largest > 0 && largest >= minShare) {
      kept.push(bin);
    }
    else {
      skipped.push(bin);
    }
  }
  if (kept.length === 0 && bandTotals.some((v) => v > 0)) {
    // Never drop everything: keep the strongest bin.
    const strongest = binFractions.indexOf(Math.max(...binFractions));
    kept.push(strongest);
    skipped.splice(skipped.indexOf(strongest), 1);
  }

  // Exact conservation: rescale each band so that the kept bins add up to the total.
  for (let band = 0; band < 8; band++) {
    let keptSum = 0;
    for (const bin of kept) {
      for (const v of envelopes[bin][band]) {
        keptSum += v;
      }
    }
    if (keptSum > 0 && bandTotals[band] > 0) {
      // EDW EPANAFEROUME TIN ENERGEIA TWN KEPT BINS STO ARXIKO SYNOLO GIA NA MIN XANETAI IXOS.
      const scale = bandTotals[band] / keptSum;
      for (const bin of kept) {
        const values = envelopes[bin][band];
        for (let step = 0; step < envelopeLength; step++) {
          values[step] *= scale;
        }
      }
    }
  }
  return { bins: kept.map((bin) => ({ bin, bands: envelopes[bin] })), skipped };
}
