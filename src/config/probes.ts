import { DIRECTION_BIN_SETS, validateDirectionBinSet, type DirectionBinSet } from './binaural.ts';
import { QUALITY_PRESETS, type QualityPreset } from './quality-presets.ts';

// Where the stochastic part of an update comes from.
export type StochasticSource = 'trace' | 'probes';

// One row of the mode table.
export interface ProbeModeEntry {
  id: string;
  label: string;
  description: string;
  moving: StochasticSource;
  settled: StochasticSource;
}

// The runtime modes. 'live' is the behaviour before Task R.
export const PROBE_MODES: ProbeModeEntry[] = [
  {
    id: 'live',
    label: 'Live tracing',
    description: 'Every update runs a GPU trace. The probes are ignored.',
    moving: 'trace',
    settled: 'trace',
  },
  {
    id: 'probes',
    label: 'Probes only',
    description: 'Every update blends the nearby probes. A live trace runs only where no probe is usable.',
    moving: 'probes',
    settled: 'probes',
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    description: 'Probes while the listener moves, then a live full-quality trace once it has stopped.',
    moving: 'probes',
    settled: 'trace',
  },
];

// The probe grid that "Add grid" and "Replace with grid" generate.
export interface ProbeGridConfig {
  spacing: number;
  heights: number[];
  // Metres from walls, floor, ceiling and objects.
  clearance: number;
}

// Everything tunable about probes (the header explains each field).
export interface ProbeConfig {
  grid: ProbeGridConfig;
  duplicateDistance: number;
  bakePresetId: string;
  timeBinMs: number;
  directionBinSetId: string;
  neighbours: number;
  weightPower: number;
  lineOfSight: boolean;
  defaultMode: string;
  maxProbes: number;
  bakeBatchSize: number;
}

// The shipped values.
export const PROBE_CONFIG: ProbeConfig = {
  grid: { spacing: 2, heights: [1.7], clearance: 0.5 },
  duplicateDistance: 0.05,
  bakePresetId: 'settled-full',
  timeBinMs: 2,
  directionBinSetId: 'cube-26',
  neighbours: 4,
  weightPower: 2,
  lineOfSight: true,
  defaultMode: 'hybrid',
  maxProbes: 64,
  bakeBatchSize: 1,
};

// Limits the validator enforces.
export const PROBE_LIMITS = {
  spacing: { min: 0.25, max: 20 },
  height: { min: 0, max: 100 },
  clearance: { min: 0.05, max: 5 },
  timeBinMs: { min: 0.5, max: 50 },
  neighbours: { min: 1, max: 16 },
  weightPower: { min: 0.5, max: 8 },
  maxProbes: { min: 1, max: 1024 },
} as const;

// Looks a mode up by id; throws a readable error for an unknown id.
export function getProbeMode(id: string, modes: ProbeModeEntry[] = PROBE_MODES): ProbeModeEntry {
  const mode = modes.find((entry) => entry.id === id);
  if (!mode)
    throw new Error(`Unknown probe mode "${id}". Known modes: ${modes.map((m) => m.id).join(', ')}.`);
  return mode;
}

// The two source fields of a mode must be valid.
function validateMode(mode: ProbeModeEntry): void {
  if (!mode.id || !mode.label) throw new Error('A probe mode needs an id and a label.');
  for (const field of ['moving', 'settled'] as const)
    if (mode[field] !== 'trace' && mode[field] !== 'probes')
      throw new Error(`Probe mode "${mode.id}": ${field} must be 'trace' or 'probes'.`);
}

// Checks a number against `limits`; the message names the field.
function checkRange(name: string, value: number, limits: { min: number; max: number }): void {
  if (!Number.isFinite(value) || value < limits.min || value > limits.max)
    throw new Error(`${name} must be between ${limits.min} and ${limits.max} (got ${value}).`);
}

export function validateProbeConfig(
  config: ProbeConfig = PROBE_CONFIG,
  modes: ProbeModeEntry[] = PROBE_MODES,
  presets: QualityPreset[] = QUALITY_PRESETS,
  binSets: DirectionBinSet[] = DIRECTION_BIN_SETS,
): void {
  checkRange('Probe grid spacing', config.grid.spacing, PROBE_LIMITS.spacing);
  if (config.grid.heights.length === 0) throw new Error('The probe grid needs at least one height.');
  for (const height of config.grid.heights) checkRange('Probe grid height', height, PROBE_LIMITS.height);
  checkRange('Probe clearance', config.grid.clearance, PROBE_LIMITS.clearance);
  if (!(config.duplicateDistance >= 0 && config.duplicateDistance < config.grid.spacing))
    throw new Error('duplicateDistance must be at least 0 and smaller than the grid spacing.');
  if (!presets.some((preset) => preset.id === config.bakePresetId))
    throw new Error(`bakePresetId "${config.bakePresetId}" is not in the quality-preset table.`);
  checkRange('timeBinMs', config.timeBinMs, PROBE_LIMITS.timeBinMs);
  const set = binSets.find((entry) => entry.id === config.directionBinSetId);
  if (!set)
    throw new Error(`directionBinSetId "${config.directionBinSetId}" is not in the direction-bin table.`);
  validateDirectionBinSet(set);
  if (!Number.isInteger(config.neighbours)) throw new Error('neighbours must be a whole number.');
  checkRange('neighbours', config.neighbours, PROBE_LIMITS.neighbours);
  checkRange('weightPower', config.weightPower, PROBE_LIMITS.weightPower);
  if (typeof config.lineOfSight !== 'boolean') throw new Error('lineOfSight must be true or false.');
  const ids = new Set<string>();
  for (const mode of modes) {
    validateMode(mode);
    if (ids.has(mode.id)) throw new Error(`Probe mode "${mode.id}" is listed twice.`);
    ids.add(mode.id);
  }
  if (!ids.has(config.defaultMode))
    throw new Error(`defaultMode "${config.defaultMode}" is not in the mode table.`);
  if (!ids.has('live'))
    throw new Error('The mode table needs a "live" entry (the behaviour without probes).');
  if (!Number.isInteger(config.maxProbes)) throw new Error('maxProbes must be a whole number.');
  checkRange('maxProbes', config.maxProbes, PROBE_LIMITS.maxProbes);
  if (!Number.isInteger(config.bakeBatchSize) || config.bakeBatchSize < 1)
    throw new Error('bakeBatchSize must be a whole number of at least 1.');
}

// Colours of the probe spheres in the viewport (red, green, blue in 0 ... 1).
export const PROBE_COLOURS = {
  unbaked: [0.55, 0.62, 0.78],
  baked: [0.25, 0.85, 0.4],
  stale: [0.95, 0.6, 0.15],
  disabled: [0.35, 0.35, 0.35],
  selected: [1, 1, 1],
} as const;

// Radius in metres of a probe sphere in the viewport, and the factor by which the selected one is larger.
export const PROBE_DRAW = { radius: 0.09, selectedScale: 1.5 } as const;
