import type { Bands } from '../acoustics/model.ts';

export interface DirectivityPattern {
  id: string;
  label: string;
  description: string;
  // Shape parameter per band (1 = omni, 0.5 = cardioid, 0 = dipole).
  alpha: Bands;
  // Power applied to the pressure gain per band (0.25 ... 8).
  exponent: Bands;
}

// Allowed range of the exponent.
export const EXPONENT_RANGE = { min: 0.25, max: 8 } as const;

// Number of equal steps in cos(theta) used to integrate g^2 over the sphere.
export const NORMALISATION_QUADRATURE_STEPS = 200_000;

// Pattern used by a new Scene. It must exist in the table.
export const DEFAULT_DIRECTIVITY_ID = 'omni';

// Forward vector of a new Scene: +z, towards the default listener.
export const DEFAULT_SOURCE_FORWARD: [number, number, number] = [0, 0, 1];

// Range of the GUI orientation sliders, in degrees. Yaw 0 points along +z, pitch 0 is horizontal.
export const ORIENTATION_LIMITS_DEGREES = {
  yaw: { min: -180, max: 180, step: 1 },
  pitch: { min: -90, max: 90, step: 1 },
} as const;

// Length in metres of the orientation arrow drawn from the source in the viewport.
export const ORIENTATION_ARROW_LENGTH = 0.8;

export const ORIENTATION_ARROW_STYLE = {
  shaftRadius: 0.025,
  headRadius: 0.09,
  headLengthFraction: 0.3,
  sides: 14,
  colour: [0.2, 0.95, 1.0],
} as const;

const bands = (values: number[]): Bands => values as Bands;
const sameForAllBands = (value: number): Bands => Array(8).fill(value) as Bands;

export const DIRECTIVITY_PATTERNS: DirectivityPattern[] = [
  {
    id: 'omni',
    label: 'Omnidirectional',
    description: 'Radiates equally in all directions. Identical to the behaviour before directivity existed.',
    alpha: sameForAllBands(1),
    exponent: sameForAllBands(1),
  },
  {
    id: 'cardioid',
    label: 'Cardioid',
    description: 'First-order cardioid in every band: full level on axis, a null directly behind the source.',
    alpha: sameForAllBands(0.5),
    exponent: sameForAllBands(1),
  },
  {
    id: 'human-voice',
    label: 'Human voice (illustrative)',
    description:
      'Nearly omnidirectional at low frequencies and increasingly forward-directed above 1 kHz. ' +
      'ILLUSTRATIVE values shaped after the trend of the speech directivity data of Chu and Warnock (2002); ' +
      'they are not a measurement of a specific talker.',
    alpha: bands([1, 0.95, 0.85, 0.75, 0.65, 0.5, 0.45, 0.4]),
    exponent: bands([1, 1, 1, 1, 1, 1, 1.25, 1.5]),
  },
  {
    id: 'loudspeaker',
    label: 'Loudspeaker (illustrative)',
    description:
      'Omnidirectional at 63 and 125 Hz, narrowing steadily with frequency as the cabinet and driver ' +
      'become large compared with the wavelength. ILLUSTRATIVE values, not a specific product.',
    alpha: bands([1, 1, 0.9, 0.75, 0.55, 0.4, 0.3, 0.25]),
    exponent: bands([1, 1, 1, 1, 1, 1.25, 1.5, 2]),
  },
];

// Throws a readable error when `pattern` is not usable.
export function validateDirectivityPattern(pattern: DirectivityPattern): void {
  const name = `Directivity pattern "${pattern?.id}"`;
  if (typeof pattern?.id !== 'string' || pattern.id.trim() === '') {
    throw new Error('Every directivity pattern needs a non-empty id.');
  }
  if (typeof pattern.label !== 'string' || pattern.label.trim() === '') {
    throw new Error(`${name} needs a label for the dropdown.`);
  }
  if (typeof pattern.description !== 'string') {
    throw new Error(`${name} needs a description (it may be an empty string).`);
  }
  if (!Array.isArray(pattern.alpha) || pattern.alpha.length !== 8) {
    throw new Error(`${name} needs exactly eight alpha values (one per band).`);
  }
  if (!Array.isArray(pattern.exponent) || pattern.exponent.length !== 8) {
    throw new Error(`${name} needs exactly eight exponent values (one per band).`);
  }
  pattern.alpha.forEach((alpha, band) => {
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new Error(`${name}: alpha of band ${band} must be between 0 and 1 (got ${alpha}).`);
    }
  });
  pattern.exponent.forEach((exponent, band) => {
    if (!Number.isFinite(exponent) || exponent < EXPONENT_RANGE.min || exponent > EXPONENT_RANGE.max) {
      throw new Error(
        `${name}: exponent of band ${band} must be between ${EXPONENT_RANGE.min} and ${EXPONENT_RANGE.max} (got ${exponent}).`,
      );
    }
  });
}

export function validateDirectivityTable(table: DirectivityPattern[] = DIRECTIVITY_PATTERNS): void {
  const seen = new Set<string>();
  for (const pattern of table) {
    validateDirectivityPattern(pattern);
    if (seen.has(pattern.id)) throw new Error(`Directivity pattern id "${pattern.id}" is used twice.`);
    seen.add(pattern.id);
  }
  if (!seen.has(DEFAULT_DIRECTIVITY_ID)) {
    throw new Error(`The default directivity pattern "${DEFAULT_DIRECTIVITY_ID}" is missing from the table.`);
  }
}

// Looks up a pattern by id. Throws a readable error for an unknown id.
export function getDirectivityPattern(id: string): DirectivityPattern {
  const pattern = DIRECTIVITY_PATTERNS.find((candidate) => candidate.id === id);
  if (!pattern) {
    const known = DIRECTIVITY_PATTERNS.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown source directivity "${id}". Known patterns: ${known}.`);
  }
  return pattern;
}

export function registerDirectivityPattern(pattern: DirectivityPattern): () => void {
  validateDirectivityPattern(pattern);
  if (DIRECTIVITY_PATTERNS.some((candidate) => candidate.id === pattern.id)) {
    throw new Error(`Directivity pattern id "${pattern.id}" is already registered.`);
  }
  DIRECTIVITY_PATTERNS.push(pattern);
  return () => {
    const index = DIRECTIVITY_PATTERNS.indexOf(pattern);
    if (index >= 0) DIRECTIVITY_PATTERNS.splice(index, 1);
  };
}
