// Which response builder a mode uses.
export type RenderArchitecture = 'hybrid' | 'full-ir';

// One selectable way of rendering the room response.
export interface RenderMode {
  id: string;
  label: string;
  description: string;
  architecture: RenderArchitecture;
  // Longest impulse response the mode may produce, in seconds.
  maxIrSeconds: number;
}

// Tunable values of the 'full-ir' response builder (see the header for the meaning of each).
export interface FullIrSettings {
  budgetGuardFactor: number;
  levelWindowSeconds: number;
  crossfadeSeconds: number;
  tailDecayDb: number;
  truncationFadeSeconds: number;
  minJoinSeconds: number;
  noiseSeedSalt: number;
}

// Id of the mode that is selected when the app starts. It must exist in the table.
export const DEFAULT_RENDER_MODE_ID = 'hybrid';

export const MAX_FULL_IR_SECONDS = 3.0;

// The 2-second streaming budget of the hybrid architecture (its FIR is the early part only).
export const MAX_HYBRID_IR_SECONDS = 2.0;

export const RENDER_MODES: RenderMode[] = [
  {
    id: 'hybrid',
    label: 'Hybrid (early FIR + FDN)',
    description:
      'Explicit early reflections in a short convolved response, with a persistent feedback delay network carrying the late field.',
    architecture: 'hybrid',
    maxIrSeconds: MAX_HYBRID_IR_SECONDS,
  },
  {
    id: 'full-ir',
    label: 'Full impulse response',
    description:
      'One complete stereo impulse response, including a synthetic tail that continues the fitted decay, convolved by the streaming convolver alone.',
    architecture: 'full-ir',
    maxIrSeconds: MAX_FULL_IR_SECONDS,
  },
];

export const FULL_IR_SETTINGS: FullIrSettings = {
  budgetGuardFactor: 0.7,
  levelWindowSeconds: 0.06,
  crossfadeSeconds: 0.08,
  tailDecayDb: 60,
  truncationFadeSeconds: 0.1,
  minJoinSeconds: 0.07,
  noiseSeedSalt: 0x5bd1e995,
};

const KNOWN_ARCHITECTURES: RenderArchitecture[] = ['hybrid', 'full-ir'];

// Longest response the app can hold at all (keeps the worklet memory in a sensible range).
const IR_SECONDS_LIMIT = 10;

// Throws a readable error when one mode has a bad value.
export function validateRenderMode(mode: RenderMode): void {
  const name = `Render mode "${mode?.id}"`;
  if (typeof mode?.id !== 'string' || mode.id.length === 0) throw new Error('Render mode needs an id.');
  if (typeof mode.label !== 'string' || mode.label.length === 0) throw new Error(`${name}: needs a label.`);
  if (typeof mode.description !== 'string') throw new Error(`${name}: description must be text.`);
  if (!KNOWN_ARCHITECTURES.includes(mode.architecture)) {
    throw new Error(
      `${name}: architecture must be one of ${KNOWN_ARCHITECTURES.join(', ')} (got "${mode.architecture}").`,
    );
  }
  if (
    !Number.isFinite(mode.maxIrSeconds) ||
    mode.maxIrSeconds < 0.5 ||
    mode.maxIrSeconds > IR_SECONDS_LIMIT
  ) {
    throw new Error(
      `${name}: maxIrSeconds must be between 0.5 and ${IR_SECONDS_LIMIT} (got ${mode.maxIrSeconds}).`,
    );
  }
}

// Throws a readable error when the full-IR settings contain a bad value.
export function validateFullIrSettings(settings: FullIrSettings = FULL_IR_SETTINGS): void {
  const mustBePositive: (keyof FullIrSettings)[] = [
    'levelWindowSeconds',
    'crossfadeSeconds',
    'tailDecayDb',
    'truncationFadeSeconds',
    'minJoinSeconds',
  ];
  for (const key of mustBePositive) {
    if (!Number.isFinite(settings[key]) || settings[key] <= 0) {
      throw new Error(`Full-IR setting ${key} must be a positive number (got ${settings[key]}).`);
    }
  }
  if (
    !Number.isFinite(settings.budgetGuardFactor) ||
    settings.budgetGuardFactor <= 0 ||
    settings.budgetGuardFactor > 1
  ) {
    throw new Error(
      `Full-IR setting budgetGuardFactor must be in (0, 1] (got ${settings.budgetGuardFactor}).`,
    );
  }
  if (!Number.isInteger(settings.noiseSeedSalt)) {
    throw new Error('Full-IR setting noiseSeedSalt must be an integer.');
  }
}

export function validateRenderModeTable(
  table: RenderMode[] = RENDER_MODES,
  settings: FullIrSettings = FULL_IR_SETTINGS,
): void {
  const seen = new Set<string>();
  for (const mode of table) {
    validateRenderMode(mode);
    if (seen.has(mode.id)) throw new Error(`Render mode id "${mode.id}" is used twice.`);
    seen.add(mode.id);
    if (mode.architecture === 'full-ir' && mode.maxIrSeconds <= settings.crossfadeSeconds * 2) {
      throw new Error(
        `Render mode "${mode.id}": maxIrSeconds (${mode.maxIrSeconds}) is too short for the tail crossfade of ${settings.crossfadeSeconds} s.`,
      );
    }
  }
  if (!seen.has(DEFAULT_RENDER_MODE_ID)) {
    throw new Error(`The default render mode "${DEFAULT_RENDER_MODE_ID}" is missing from the table.`);
  }
  validateFullIrSettings(settings);
}

// Looks up a mode by id. Throws a readable error for an unknown id.
export function getRenderMode(id: string, table: RenderMode[] = RENDER_MODES): RenderMode {
  const mode = table.find((candidate) => candidate.id === id);
  if (!mode) {
    const known = table.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown render mode "${id}". Known modes: ${known}.`);
  }
  return mode;
}

export function registerRenderMode(mode: RenderMode): () => void {
  validateRenderMode(mode);
  if (RENDER_MODES.some((candidate) => candidate.id === mode.id)) {
    throw new Error(`Render mode id "${mode.id}" is already registered.`);
  }
  RENDER_MODES.push(mode);
  return () => {
    const index = RENDER_MODES.indexOf(mode);
    if (index >= 0) RENDER_MODES.splice(index, 1);
  };
}
