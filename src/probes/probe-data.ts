import type { Arrival, Bands, Vec3 } from '../acoustics/model.ts';
import type { LateDecay } from '../acoustics/decay-fit.ts';
import { nearestDirection } from '../acoustics/direction-bins.ts';
import { directionBinVectors, getDirectionBinSet } from '../config/binaural.ts';

// Hit counts of the cells: whole numbers when baked, weighted averages after a blend.
export type HitCounts = Uint32Array | Float64Array;

export interface ProbeField {
  // Id of the direction-bin set in src/config/binaural.ts.
  binSetId: string;
  // Width of a time bin in seconds.
  timeBinSeconds: number;
  // Number of directions in the set.
  directionBins: number;
  // Time bins of the directional grid (trailing empty bins are not stored).
  timeBins: number;
  directional: Float64Array;
  directionalHits: HitCounts;
  // Time bins of the omnidirectional row.
  omniBins: number;
  omni: Float64Array;
  omniHits: HitCounts;
}

// A baked field plus the exact per-band totals of the hits it was made from (to prove conservation).
export interface ProbeData extends ProbeField {
  // Per-band energy of all hits that went in, summed directly from the arrivals.
  inputBandEnergy: Bands;
}

// Everything a bake stores for one probe.
export interface ProbeBake {
  data: ProbeData;
  // The late-decay fit of the probe's own trace (fit per band, source, quality), as the live path measures it.
  lateDecay?: LateDecay;
  // Time the whole bake of this probe took: trace plus compression, in milliseconds.
  bakeMs: number;
  // Time of the GPU trace alone.
  traceMs: number;
  // Rays of the trace.
  rays: number;
  bounces: number;
  presetId: string;
  seed: number;
  // Image-source order of the scene when the probe was baked (the stochastic collection rule depends on it).
  earlyOrder: number;
}

// Options of `compressStochastic`.
export interface CompressOptions {
  binSetId: string;
  timeBinSeconds: number;
}

export function compressStochastic(arrivals: Arrival[], options: CompressOptions): ProbeData {
  const directions = directionBinVectors(getDirectionBinSet(options.binSetId));
  const count = directions.length;
  // EDW METATREPOUME XRONOUS AFIKSIS SE TIME BINS GIA NA APOTHIKEYSOUME TO PEDIO ME LIGOTERI MNIMI.
  const binOf = (time: number): number => Math.max(0, Math.floor(time / options.timeBinSeconds));

  // First pass: the extent of both grids, so that nothing beyond the last occupied bin is stored.
  let timeBins = 0;
  let omniBins = 0;
  for (const arrival of arrivals) {
    if (arrival.kind !== 'stochastic') continue;
    const bin = binOf(arrival.time) + 1;
    if (arrival.binned) omniBins = Math.max(omniBins, bin);
    else timeBins = Math.max(timeBins, bin);
  }

  const directional = new Float64Array(timeBins * count * 8);
  const directionalHits = new Uint32Array(timeBins * count);
  const omni = new Float64Array(omniBins * 8);
  const omniHits = new Uint32Array(omniBins);
  const inputBandEnergy = [0, 0, 0, 0, 0, 0, 0, 0] as Bands;

  for (const arrival of arrivals) {
    if (arrival.kind !== 'stochastic') continue;
    const time = binOf(arrival.time);
    const hits = arrival.hitCount ?? 1;
    for (let band = 0; band < 8; band++) inputBandEnergy[band] += arrival.energyBands[band];
    if (arrival.binned) {
      for (let band = 0; band < 8; band++) omni[time * 8 + band] += arrival.energyBands[band];
      omniHits[time] += hits;
    } else {
      const direction = nearestDirection(arrival.direction as Vec3, directions);
      const cell = time * count + direction;
      for (let band = 0; band < 8; band++) directional[cell * 8 + band] += arrival.energyBands[band];
      directionalHits[cell] += hits;
    }
  }
  return {
    binSetId: options.binSetId,
    timeBinSeconds: options.timeBinSeconds,
    directionBins: count,
    timeBins,
    directional,
    directionalHits,
    omniBins,
    omni,
    omniHits,
    inputBandEnergy,
  };
}

// Energy per band held by a field (directional cells plus the omnidirectional row).
export function fieldBandEnergy(field: ProbeField): Bands {
  const sums = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < field.directional.length; i++) sums[i % 8] += field.directional[i];
  for (let i = 0; i < field.omni.length; i++) sums[i % 8] += field.omni[i];
  return sums as Bands;
}

// Bytes of memory that the arrays of a field occupy.
export function fieldBytes(field: ProbeField): number {
  return (
    field.directional.byteLength +
    field.directionalHits.byteLength +
    field.omni.byteLength +
    field.omniHits.byteLength
  );
}

// One input of `blendFields`: a field and its weight.
export interface WeightedField {
  field: ProbeField;
  weight: number;
}

export function blendFields(allParts: WeightedField[]): ProbeField {
  // A part with weight 0 contributes nothing, not even its length.
  const parts = allParts.filter((part) => part.weight !== 0);
  if (parts.length === 0) throw new Error('Nothing to blend.');
  const first = parts[0].field;
  for (const { field } of parts)
    if (
      field.binSetId !== first.binSetId ||
      field.directionBins !== first.directionBins ||
      field.timeBinSeconds !== first.timeBinSeconds
    )
      throw new Error('Probes with different direction sets or time bins cannot be blended.');

  const timeBins = Math.max(...parts.map(({ field }) => field.timeBins));
  const omniBins = Math.max(...parts.map(({ field }) => field.omniBins));
  const count = first.directionBins;
  const directional = new Float64Array(timeBins * count * 8);
  const directionalHits = new Float64Array(timeBins * count);
  const omni = new Float64Array(omniBins * 8);
  const omniHits = new Float64Array(omniBins);
  for (const { field, weight } of parts) {
    for (let i = 0; i < field.directional.length; i++) directional[i] += weight * field.directional[i];
    for (let i = 0; i < field.directionalHits.length; i++)
      directionalHits[i] += weight * field.directionalHits[i];
    for (let i = 0; i < field.omni.length; i++) omni[i] += weight * field.omni[i];
    for (let i = 0; i < field.omniHits.length; i++) omniHits[i] += weight * field.omniHits[i];
  }
  return {
    binSetId: first.binSetId,
    timeBinSeconds: first.timeBinSeconds,
    directionBins: count,
    timeBins,
    directional,
    directionalHits,
    omniBins,
    omni,
    omniHits,
  };
}

// Mean of the eight band energies: the convention of `Arrival.energy`.
function meanOfBands(bands: Bands): number {
  return bands.reduce((sum, value) => sum + value, 0) / 8;
}

// Hit count of a cell as a whole number of at least 1 (a cell with energy stands for at least one hit).
function wholeHits(hits: number): number {
  return Math.max(1, Math.round(hits));
}

export function fieldToArrivals(field: ProbeField, speed: number): Arrival[] {
  const directions = directionBinVectors(getDirectionBinSet(field.binSetId));
  const count = field.directionBins;
  const width = field.timeBinSeconds;
  const arrivals: Arrival[] = [];
  const bandsOf = (source: Float64Array, cell: number): Bands =>
    Array.from(source.subarray(cell * 8, cell * 8 + 8)) as Bands;

  for (let bin = 0; bin < field.timeBins; bin++) {
    // The non-empty directions of this bin, to space them evenly over the bin.
    const used: number[] = [];
    for (let d = 0; d < count; d++) {
      const cell = bin * count + d;
      for (let band = 0; band < 8; band++)
        if (field.directional[cell * 8 + band] > 0) {
          used.push(d);
          break;
        }
    }
    used.forEach((d, index) => {
      const cell = bin * count + d;
      const bands = bandsOf(field.directional, cell);
      const time = (bin + (index + 0.5) / used.length) * width;
      arrivals.push({
        time,
        distance: time * speed,
        energy: meanOfBands(bands),
        energyBands: bands,
        order: 1,
        direction: [...directions[d]] as Vec3,
        pan: 0,
        kind: 'stochastic',
        hitCount: wholeHits(field.directionalHits[cell]),
      });
    });
  }
  for (let bin = 0; bin < field.omniBins; bin++) {
    const bands = bandsOf(field.omni, bin);
    if (!(meanOfBands(bands) > 0)) continue;
    const time = (bin + 0.5) * width;
    arrivals.push({
      time,
      distance: time * speed,
      energy: meanOfBands(bands),
      energyBands: bands,
      order: 1,
      direction: [0, 0, 0],
      pan: 0,
      kind: 'stochastic',
      binned: true,
      hitCount: wholeHits(field.omniHits[bin]),
    });
  }
  return arrivals;
}
