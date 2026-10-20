import type { Arrival, Bands, Vec3 } from '../acoustics/model.ts';
import type { LateDecay } from '../acoustics/decay-fit.ts';
import type { ProbeConfig } from '../config/probes.ts';
import { blendFields, fieldToArrivals, type ProbeField } from './probe-data.ts';
import type { Probe, ProbeSet } from './probe-set.ts';

// True when the straight segment between two points is blocked by an object.
export type OcclusionTest = (from: Vec3, to: Vec3) => boolean;

// A distance below this (metres) counts as "at the probe".
const AT_PROBE_DISTANCE = 1e-9;

// One probe in use, with its distance and normalised weight.
export interface ProbeChoice {
  probe: Probe;
  distance: number;
  weight: number;
}

// The outcome of choosing probes for one listener position.
export interface ProbeSelection {
  // The probes in use (empty when none qualifies), nearest first.
  choices: ProbeChoice[];
  // Enabled, baked, compatible probes in the set.
  eligible: number;
  // Eligible probes ignored because an object blocked the line of sight (only those that were tested).
  occluded: number;
  // Why nothing was chosen, for the debug panel; undefined when something was.
  reason?: string;
}

export function inverseDistanceWeights(distances: number[], power: number, nextDistance?: number): number[] {
  if (distances.length === 0) return [];
  const atProbe = distances.findIndex((distance) => distance < AT_PROBE_DISTANCE);
  if (atProbe >= 0) return distances.map((_, index) => (index === atProbe ? 1 : 0));
  const raw = (distance: number): number => 1 / Math.pow(distance, power);
  let weights = distances.map(raw);
  if (nextDistance !== undefined && nextDistance > AT_PROBE_DISTANCE) {
    const cut = raw(nextDistance);
    // EDW MEIWNOUME TA VARI ME VASI TON EPOMENO GEITONA GIA NA FEYGEI OMALA ENA PROBE APO TO BLEND.
    const reduced = weights.map((weight) => Math.max(0, weight - cut));
    // Equal distances would leave no weight at all; the plain weights are used then.
    if (reduced.reduce((sum, weight) => sum + weight, 0) > 0) weights = reduced;
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // EDW KANOUME TA VARI NA ATHROIZOUN SE 1 GIA NA MIN ALLAZEI I STATHMI APO TO PLITHOS TWN PROBES.
  return weights.map((weight) => weight / total);
}

// True when the probe's bake was made with the current direction set and time bin.
function isCompatible(probe: Probe, config: ProbeConfig): boolean {
  const data = probe.bake?.data;
  return (
    !!data &&
    data.binSetId === config.directionBinSetId &&
    Math.abs(data.timeBinSeconds - config.timeBinMs / 1000) < 1e-12
  );
}

// Chooses the probes for `listener` and gives them weights. See the file comment for the rules.
export function selectProbes(
  set: ProbeSet,
  listener: Vec3,
  config: ProbeConfig,
  occluded?: OcclusionTest,
): ProbeSelection {
  const usable = set.probes.filter(
    (probe) => probe.enabled && probe.bakeState === 'baked' && isCompatible(probe, config),
  );
  if (usable.length === 0) {
    const enabled = set.probes.filter((probe) => probe.enabled).length;
    return {
      choices: [],
      eligible: 0,
      occluded: 0,
      reason: enabled === 0 ? 'no enabled probes' : 'no baked, up-to-date probe',
    };
  }
  const byDistance = usable
    .map((probe) => ({
      probe,
      distance: Math.hypot(...probe.position.map((value, axis) => value - listener[axis])),
    }))
    .sort((a, b) => a.distance - b.distance);

  // Walk outwards until k probes and the (k+1)-th, which only shapes the weights, are found.
  const wanted = config.neighbours + 1;
  const visible: typeof byDistance = [];
  let blocked = 0;
  for (const candidate of byDistance) {
    if (visible.length >= wanted) break;
    if (config.lineOfSight && occluded && occluded(listener, candidate.probe.position)) {
      blocked++;
      continue;
    }
    visible.push(candidate);
  }
  if (visible.length === 0)
    return {
      choices: [],
      eligible: usable.length,
      occluded: blocked,
      reason: 'every nearby probe is behind an object',
    };

  const chosen = visible.slice(0, config.neighbours);
  const next = visible.length > config.neighbours ? visible[config.neighbours] : undefined;
  const weights = inverseDistanceWeights(
    chosen.map((entry) => entry.distance),
    config.weightPower,
    next?.distance,
  );
  return {
    choices: chosen.map((entry, index) => ({ ...entry, weight: weights[index] })),
    eligible: usable.length,
    occluded: blocked,
  };
}

// Weighted mean of RT60 values; infinite if any contributing value is infinite.
function weightedRt60(values: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (weights[i] === 0) continue;
    if (!Number.isFinite(values[i])) return Infinity;
    sum += weights[i] * values[i];
  }
  return sum;
}

export function blendLateDecay(
  items: { decay: LateDecay | undefined; weight: number }[],
): LateDecay | undefined {
  const withFit = items.filter(
    (item): item is { decay: LateDecay; weight: number } => !!item.decay && item.weight > 0,
  );
  if (withFit.length === 0) return undefined;
  const total = withFit.reduce((sum, item) => sum + item.weight, 0);
  const weights = withFit.map((item) => item.weight / total);
  const heaviest = withFit[weights.indexOf(Math.max(...weights))].decay;

  const rt60Bands = Array.from({ length: 8 }, (_, band) =>
    weightedRt60(
      withFit.map((item) => item.decay.rt60Bands[band]),
      weights,
    ),
  ) as Bands;
  const source = Array.from({ length: 8 }, (_, band) => {
    const fitted = withFit.reduce(
      (sum, item, index) => sum + (item.decay.source[band] === 'ray-fit' ? weights[index] : 0),
      0,
    );
    return fitted >= 0.5 ? 'ray-fit' : 'eyring';
  }) as LateDecay['source'];
  return { ...heaviest, rt60Bands, source };
}

// Milliseconds each part of a blend took (for the Chapter 5 rows and the debug panel).
export interface BlendTimings {
  // Choosing the probes: distances, line-of-sight tests, weights.
  selectMs: number;
  // Weighted sum of the stored fields.
  mixMs: number;
  // Turning the blended field into pseudo-arrivals.
  arrivalsMs: number;
  // Late-decay blend.
  decayMs: number;
}

// The blend for one listener position: what replaces the GPU trace of an update.
export interface ProbeBlend {
  selection: ProbeSelection;
  field: ProbeField;
  // Pseudo-arrivals for the response synthesis (`kind: 'stochastic'`).
  arrivals: Arrival[];
  lateDecay?: LateDecay;
  timings: BlendTimings;
}

export function blendProbes(
  set: ProbeSet,
  listener: Vec3,
  config: ProbeConfig,
  speed: number,
  occluded?: OcclusionTest,
): ProbeBlend | undefined {
  let started = performance.now();
  const selection = selectProbes(set, listener, config, occluded);
  const selectMs = performance.now() - started;
  if (selection.choices.length === 0) return undefined;

  started = performance.now();
  const field = blendFields(
    selection.choices.map(({ probe, weight }) => ({ field: probe.bake!.data, weight })),
  );
  const mixMs = performance.now() - started;

  started = performance.now();
  const arrivals = fieldToArrivals(field, speed);
  const arrivalsMs = performance.now() - started;

  started = performance.now();
  const lateDecay = blendLateDecay(
    selection.choices.map(({ probe, weight }) => ({ decay: probe.bake!.lateDecay, weight })),
  );
  const decayMs = performance.now() - started;
  return { selection, field, arrivals, lateDecay, timings: { selectMs, mixMs, arrivalsMs, decayMs } };
}
