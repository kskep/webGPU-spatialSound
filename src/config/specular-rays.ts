// How the amplitude of an echo is obtained.
export type SpecularAmplitudeMode = 'monte-carlo' | 'image-source';

export interface SpecularRaySettings {
  enabled: boolean;
  mode: SpecularAmplitudeMode;
  minHits: number;
  maxEchoes: number;
  maxOrder: number;
  conserveEnergy: boolean;
  memoryUpdates: number;
}

// One row of the mode table (the GUI dropdown is built from it).
export interface SpecularRayModeEntry {
  id: SpecularAmplitudeMode;
  label: string;
  description: string;
}

export const SPECULAR_RAY_MODES: SpecularRayModeEntry[] = [
  {
    id: 'monte-carlo',
    label: 'A: ray energy (Monte-Carlo)',
    description:
      'Each echo carries the summed energy of the ray hits that found the path. Unbiased, noisy for rarely found paths.',
  },
  {
    id: 'image-source',
    label: 'B: exact image source',
    description:
      'Each found path is rebuilt as an exact image source: exact timing, direction and energy. Paths no ray found are missing.',
  },
];

// Identifier of the mode used when the feature is switched on from the GUI.
export const DEFAULT_SPECULAR_MODE: SpecularAmplitudeMode = 'image-source';

export const SPECULAR_RAY_DEFAULTS: SpecularRaySettings = {
  enabled: false,
  mode: DEFAULT_SPECULAR_MODE,
  minHits: 1,
  maxEchoes: 96,
  maxOrder: 12,
  conserveEnergy: true,
  memoryUpdates: 3,
};

// Settings with the feature switched off (what the tracer sees when nothing is configured).
export function disabledSpecularRays(): SpecularRaySettings {
  return { ...SPECULAR_RAY_DEFAULTS, enabled: false };
}

// Throws when the settings are unusable.
export function validateSpecularRaySettings(settings: SpecularRaySettings = SPECULAR_RAY_DEFAULTS): void {
  if (!SPECULAR_RAY_MODES.some((entry) => entry.id === settings.mode)) {
    throw new Error(`Unknown specular ray mode "${settings.mode}".`);
  }
  const integers: Array<[string, number, number]> = [
    ['minHits', settings.minHits, 1],
    ['maxEchoes', settings.maxEchoes, 1],
    ['maxOrder', settings.maxOrder, 1],
    ['memoryUpdates', settings.memoryUpdates, 0],
  ];
  for (const [name, value, minimum] of integers) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`Specular ray setting ${name} must be an integer of at least ${minimum}.`);
    }
  }
}

// Looks up a mode by id; throws for an unknown one.
export function getSpecularRayMode(id: string): SpecularRayModeEntry {
  const entry = SPECULAR_RAY_MODES.find((mode) => mode.id === id);
  if (!entry) throw new Error(`Unknown specular ray mode "${id}".`);
  return entry;
}
