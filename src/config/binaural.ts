import type { Vec3 } from '../acoustics/model.ts';

// Identifier of one toggle; also the key in `BinauralToggles`.
export type BinauralToggleId = 'diffuseFieldEq' | 'hrtfInterpolation' | 'stochasticHrtf' | 'lateCoherence';

// The current on/off state of every toggle.
export type BinauralToggles = Record<BinauralToggleId, boolean>;

// One row of the toggle table (the GUI shows `label`, with `description` as its hint).
export interface BinauralToggleEntry {
  id: BinauralToggleId;
  label: string;
  description: string;
  // State at start-up.
  defaultValue: boolean;
}

export const BINAURAL_TOGGLES: BinauralToggleEntry[] = [
  {
    id: 'diffuseFieldEq',
    label: 'HRTF diffuse-field EQ',
    description: 'Equalise the HRTF set to a flat diffuse-field average instead of unit frontal energy.',
    defaultValue: true,
  },
  {
    id: 'hrtfInterpolation',
    label: 'HRTF interpolation',
    description: 'Interpolate between measured directions instead of using the nearest one.',
    defaultValue: true,
  },
  {
    id: 'stochasticHrtf',
    label: 'Stochastic field through HRTF',
    description: 'Render the traced diffuse part through the HRTF of direction bins instead of panning it.',
    defaultValue: true,
  },
  {
    id: 'lateCoherence',
    label: 'Late-field interaural coherence',
    description: 'Give the late reverberation the interaural coherence of a diffuse field at the ears.',
    defaultValue: true,
  },
];

// The toggles at their start-up state (all on).
export function defaultBinauralToggles(): BinauralToggles {
  return Object.fromEntries(
    BINAURAL_TOGGLES.map((entry) => [entry.id, entry.defaultValue]),
  ) as BinauralToggles;
}

// All toggles off: the renderer behaves exactly as it did before Task M.
export function binauralTogglesOff(): BinauralToggles {
  return Object.fromEntries(BINAURAL_TOGGLES.map((entry) => [entry.id, false])) as BinauralToggles;
}

// A set of directions, in listener coordinates (x forward, y left, z up), that the stochastic part is binned into.
export type DirectionBinSet = { id: string; label: string; description: string } & (
  { kind: 'cube' } | { kind: 'icosphere'; subdivisions: number } | { kind: 'explicit'; directions: Vec3[] }
);

export const DIRECTION_BIN_SETS: DirectionBinSet[] = [
  {
    id: 'cube-26',
    label: '26 directions',
    description: 'The 6 faces, 12 edges and 8 corners of a cube (about 40 degrees apart).',
    kind: 'cube',
  },
  {
    id: 'icosphere-42',
    label: '42 directions',
    description: 'Icosahedron with each edge split once (about 32 degrees apart).',
    kind: 'icosphere',
    subdivisions: 1,
  },
];

// Tunable numbers (see the header for the meaning of each).
export interface BinauralSettings {
  diffuseField: {
    clampDb: number;
    lowFlattenHz: number;
    highFlattenHz: number;
    smoothingOctaves: number;
    poleToleranceDegrees: number;
  };
  interpolation: {
    cacheStepDegrees: number;
    cacheEntries: number;
    shiftHalfWidth: number;
  };
  stochastic: {
    binSetId: string;
    shareWindowSeconds: number;
    minBinShare: number;
  };
}

export const BINAURAL_SETTINGS: BinauralSettings = {
  diffuseField: {
    clampDb: 12,
    lowFlattenHz: 100,
    highFlattenHz: 16000,
    smoothingOctaves: 1 / 3,
    poleToleranceDegrees: 3,
  },
  interpolation: {
    cacheStepDegrees: 1,
    cacheEntries: 4096,
    shiftHalfWidth: 8,
  },
  stochastic: {
    binSetId: 'cube-26',
    shareWindowSeconds: 0.02,
    minBinShare: 0.002,
  },
};

// Adds a direction-bin set at runtime (tests and experiments); the id must be new.
export function registerDirectionBinSet(set: DirectionBinSet): void {
  validateDirectionBinSet(set);
  if (DIRECTION_BIN_SETS.some((existing) => existing.id === set.id))
    throw new Error(`Direction-bin set "${set.id}" already exists.`);
  DIRECTION_BIN_SETS.push(set);
}

// Looks a direction-bin set up by id; throws a readable error for an unknown id.
export function getDirectionBinSet(id: string): DirectionBinSet {
  const set = DIRECTION_BIN_SETS.find((entry) => entry.id === id);
  if (!set) throw new Error(`Unknown direction-bin set "${id}".`);
  return set;
}

// Throws a readable error when one bin set is unusable.
export function validateDirectionBinSet(set: DirectionBinSet): void {
  if (!set.id || !set.label) throw new Error('A direction-bin set needs an id and a label.');
  if (
    set.kind === 'icosphere' &&
    !(Number.isInteger(set.subdivisions) && set.subdivisions >= 0 && set.subdivisions <= 4)
  )
    throw new Error(`Direction-bin set "${set.id}": subdivisions must be an integer from 0 to 4.`);
  if (set.kind === 'explicit') {
    if (set.directions.length < 2)
      throw new Error(`Direction-bin set "${set.id}": needs at least two directions.`);
    for (const direction of set.directions)
      if (
        direction.length !== 3 ||
        direction.some((v) => !Number.isFinite(v)) ||
        Math.hypot(...direction) < 1e-6
      )
        throw new Error(`Direction-bin set "${set.id}": every direction must be a finite non-zero 3-vector.`);
  }
}

// Checks the whole configuration; called at start-up and by the tests.
export function validateBinauralConfig(
  settings: BinauralSettings = BINAURAL_SETTINGS,
  toggles: BinauralToggleEntry[] = BINAURAL_TOGGLES,
  sets: DirectionBinSet[] = DIRECTION_BIN_SETS,
): void {
  const ids = new Set<string>();
  for (const entry of toggles) {
    if (!entry.id || !entry.label) throw new Error('A binaural toggle needs an id and a label.');
    if (ids.has(entry.id)) throw new Error(`Binaural toggle "${entry.id}" is listed twice.`);
    ids.add(entry.id);
  }
  const field = settings.diffuseField;
  if (!(field.clampDb > 0 && field.clampDb <= 40))
    throw new Error('diffuseField.clampDb must be in (0, 40] dB.');
  if (!(field.lowFlattenHz > 0 && field.lowFlattenHz < field.highFlattenHz))
    throw new Error('diffuseField: lowFlattenHz must be positive and below highFlattenHz.');
  if (!(field.smoothingOctaves > 0 && field.smoothingOctaves <= 2))
    throw new Error('diffuseField.smoothingOctaves must be in (0, 2].');
  if (!(field.poleToleranceDegrees >= 0 && field.poleToleranceDegrees < 90))
    throw new Error('diffuseField.poleToleranceDegrees must be in [0, 90).');
  if (!(settings.interpolation.cacheStepDegrees >= 0 && settings.interpolation.cacheStepDegrees <= 10))
    throw new Error('interpolation.cacheStepDegrees must be in [0, 10].');
  if (!(Number.isInteger(settings.interpolation.cacheEntries) && settings.interpolation.cacheEntries >= 16))
    throw new Error('interpolation.cacheEntries must be an integer of at least 16.');
  if (!(
    Number.isInteger(settings.interpolation.shiftHalfWidth) && settings.interpolation.shiftHalfWidth >= 2
  ))
    throw new Error('interpolation.shiftHalfWidth must be an integer of at least 2.');
  const stochastic = settings.stochastic;
  if (!(stochastic.shareWindowSeconds >= 0.001 && stochastic.shareWindowSeconds <= 1))
    throw new Error('stochastic.shareWindowSeconds must be between 1 ms and 1 s.');
  if (!(stochastic.minBinShare >= 0 && stochastic.minBinShare < 0.5))
    throw new Error('stochastic.minBinShare must be in [0, 0.5).');
  for (const set of sets) validateDirectionBinSet(set);
  if (!sets.some((set) => set.id === stochastic.binSetId))
    throw new Error(`stochastic.binSetId "${stochastic.binSetId}" is not in the direction-bin table.`);
}

// Unit directions of a bin set, in listener coordinates (x forward, y left, z up).
export function directionBinVectors(set: DirectionBinSet): Vec3[] {
  const normalise = (v: Vec3): Vec3 => {
    const length = Math.hypot(...v);
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  if (set.kind === 'explicit') return set.directions.map(normalise);
  if (set.kind === 'cube') {
    const out: Vec3[] = [];
    for (const x of [-1, 0, 1])
      for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) out.push(normalise([x, y, z]));
    return out;
  }
  // Icosahedron, then split every edge `subdivisions` times (midpoints pushed onto the sphere).
  const phi = (1 + Math.sqrt(5)) / 2;
  let vertices: Vec3[] = [
    [-1, phi, 0],
    [1, phi, 0],
    [-1, -phi, 0],
    [1, -phi, 0],
    [0, -1, phi],
    [0, 1, phi],
    [0, -1, -phi],
    [0, 1, -phi],
    [phi, 0, -1],
    [phi, 0, 1],
    [-phi, 0, -1],
    [-phi, 0, 1],
  ].map((v) => normalise(v as Vec3));
  let faces: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let step = 0; step < set.subdivisions; step++) {
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let index = midpoints.get(key);
      if (index === undefined) {
        index = vertices.length;
        vertices.push(normalise([0, 1, 2].map((axis) => vertices[a][axis] + vertices[b][axis]) as Vec3));
        midpoints.set(key, index);
      }
      return index;
    };
    const next: [number, number, number][] = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return vertices;
}
