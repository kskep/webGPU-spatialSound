import { validateRayTermination, type RayTermination } from './ray-termination.ts';

// A named trace budget plus the rules for when it may run.
export interface QualityPreset {
  id: string;
  label: string;
  description: string;
  // Rays per trace, or 'scene' to follow the GUI.
  rays: number | 'scene';
  // Maximum bounces per ray, or 'scene' to follow the GUI.
  bounces: number | 'scene';
  // Image-source order, or 'scene' to follow the scene.
  earlyOrder: number | 'scene';
  // Numeric values never exceed the GUI value.
  capToScene: boolean;
  // Rate limit between two trace starts, in milliseconds.
  minUpdateIntervalMs: number;
  // May this trace replace the cached room decay?
  fullQuality: boolean;
  // How rays end. Omitted: a fixed bounce count, the behaviour before Task Q.
  termination?: RayTermination;
}

// Thresholds and delays used by the scheduler (units in the header comment).
export interface SchedulerSettings {
  coarseLinearSpeed: number;
  coarseAngularSpeed: number;
  movingWindowMs: number;
  settleDelayMs: number;
  sceneEditDebounceMs: number;
  nominalPoseIntervalMs: number;
  minPoseIntervalMs: number;
  speedSmoothing: number;
  historyLength: number;
}

// Limits that match validateScene() in src/acoustics/model.ts.
export const BUDGET_LIMITS = {
  rays: { min: 1024, max: 65536 },
  bounces: { min: 2, max: 64 },
  earlyOrder: { min: 1, max: 5 },
} as const;

// Preset ids the scheduler picks by itself in Auto mode. They must exist in the table.
export const AUTO_PRESET_IDS = {
  fast: 'moving-coarse',
  slow: 'moving-refine',
  settled: 'settled-full',
} as const;

// Value of the "Quality mode" dropdown that lets the scheduler choose.
export const AUTO_MODE_ID = 'auto';

// Label of the Auto entry in the dropdown.
export const AUTO_MODE_LABEL = 'Auto (scheduler)';

// Values of the old src/main.ts, plus the new slow-motion threshold.
export const SCHEDULER_SETTINGS: SchedulerSettings = {
  coarseLinearSpeed: 0.25,
  coarseAngularSpeed: 10,
  movingWindowMs: 220,
  settleDelayMs: 240,
  sceneEditDebounceMs: 180,
  nominalPoseIntervalMs: 16,
  minPoseIntervalMs: 8,
  speedSmoothing: 0.5,
  historyLength: 32,
};

const ENERGY_RULE: RayTermination = {
  mode: 'energy',
  energyCutoffDb: -80,
  maxPathSeconds: 'auto',
  maxBounces: 2000,
  detailedBounces: 'scene',
  histogramBinSeconds: 0.001,
};

// The shipped presets.
export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: 'moving-coarse',
    label: 'Moving, coarse',
    description: 'Fast motion: at most 4096 rays, one trace per 100 ms. Reuses the cached room decay.',
    rays: 4096,
    bounces: 'scene',
    earlyOrder: 'scene',
    capToScene: true,
    minUpdateIntervalMs: 100,
    fullQuality: false,
    termination: { ...ENERGY_RULE, maxPathSeconds: 0.5 },
  },
  {
    id: 'moving-refine',
    label: 'Moving, refine',
    description: 'Slow motion: at most 8192 rays, one trace per 200 ms. Reuses the cached room decay.',
    rays: 8192,
    bounces: 'scene',
    earlyOrder: 'scene',
    capToScene: true,
    minUpdateIntervalMs: 200,
    fullQuality: false,
    termination: { ...ENERGY_RULE, maxPathSeconds: 1 },
  },
  {
    id: 'settled-full',
    label: 'Settled, full quality',
    description:
      'The GUI ray and bounce settings. Used after motion stops and by the Calculate button. Updates the room decay.',
    rays: 'scene',
    bounces: 'scene',
    earlyOrder: 'scene',
    capToScene: false,
    minUpdateIntervalMs: 0,
    fullQuality: true,
    termination: { ...ENERGY_RULE },
  },
  {
    id: 'reference-static',
    label: 'Reference (static)',
    description:
      'Maximum budget for measurements: 65536 rays, 64 detailed bounces. Never chosen by Auto; select it explicitly.',
    rays: 65536,
    bounces: 64,
    earlyOrder: 'scene',
    capToScene: false,
    minUpdateIntervalMs: 0,
    fullQuality: true,
    termination: { ...ENERGY_RULE },
  },
];

// Checks one value that may be an integer in [min, max] or the word 'scene'.
function validateBudgetValue(name: string, field: string, value: unknown, min: number, max: number): void {
  if (value === 'scene') return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name}: ${field} must be 'scene' or an integer between ${min} and ${max} (got ${String(value)}).`,
    );
  }
}

// Throws a readable error when `preset` is not usable.
export function validateQualityPreset(preset: QualityPreset): void {
  const name = `Quality preset "${preset?.id}"`;
  if (typeof preset?.id !== 'string' || preset.id.trim() === '') {
    throw new Error('Every quality preset needs a non-empty id.');
  }
  if (preset.id === AUTO_MODE_ID) {
    throw new Error(`${name}: the id "${AUTO_MODE_ID}" is reserved for the Auto entry of the dropdown.`);
  }
  if (typeof preset.label !== 'string' || preset.label.trim() === '') {
    throw new Error(`${name} needs a label for the dropdown.`);
  }
  if (typeof preset.description !== 'string') {
    throw new Error(`${name} needs a description (it may be an empty string).`);
  }
  validateBudgetValue(name, 'rays', preset.rays, BUDGET_LIMITS.rays.min, BUDGET_LIMITS.rays.max);
  validateBudgetValue(name, 'bounces', preset.bounces, BUDGET_LIMITS.bounces.min, BUDGET_LIMITS.bounces.max);
  validateBudgetValue(
    name,
    'earlyOrder',
    preset.earlyOrder,
    BUDGET_LIMITS.earlyOrder.min,
    BUDGET_LIMITS.earlyOrder.max,
  );
  if (typeof preset.capToScene !== 'boolean') throw new Error(`${name}: capToScene must be true or false.`);
  if (typeof preset.fullQuality !== 'boolean') throw new Error(`${name}: fullQuality must be true or false.`);
  if (!Number.isFinite(preset.minUpdateIntervalMs) || preset.minUpdateIntervalMs < 0) {
    throw new Error(`${name}: minUpdateIntervalMs must be 0 or more (got ${preset.minUpdateIntervalMs}).`);
  }
  if (preset.termination) validateRayTermination(preset.termination, name);
}

// Throws a readable error when the scheduler settings contain a bad value.
function validateSchedulerSettings(settings: SchedulerSettings = SCHEDULER_SETTINGS): void {
  const mustBePositive: (keyof SchedulerSettings)[] = [
    'coarseLinearSpeed',
    'coarseAngularSpeed',
    'movingWindowMs',
    'settleDelayMs',
    'nominalPoseIntervalMs',
    'minPoseIntervalMs',
    'historyLength',
  ];
  for (const key of mustBePositive) {
    if (!Number.isFinite(settings[key]) || settings[key] <= 0) {
      throw new Error(`Scheduler setting ${key} must be a positive number (got ${settings[key]}).`);
    }
  }
  if (!Number.isFinite(settings.sceneEditDebounceMs) || settings.sceneEditDebounceMs < 0) {
    throw new Error(
      `Scheduler setting sceneEditDebounceMs must be 0 or more (got ${settings.sceneEditDebounceMs}).`,
    );
  }
  if (
    !Number.isFinite(settings.speedSmoothing) ||
    settings.speedSmoothing <= 0 ||
    settings.speedSmoothing > 1
  ) {
    throw new Error(`Scheduler setting speedSmoothing must be in (0, 1] (got ${settings.speedSmoothing}).`);
  }
  if (settings.settleDelayMs < settings.movingWindowMs) {
    throw new Error(
      'Scheduler setting settleDelayMs must not be shorter than movingWindowMs, or a settled trace could be requested while the listener still counts as moving.',
    );
  }
}

export function validateQualityTable(
  table: QualityPreset[] = QUALITY_PRESETS,
  settings: SchedulerSettings = SCHEDULER_SETTINGS,
): void {
  const seen = new Set<string>();
  for (const preset of table) {
    validateQualityPreset(preset);
    if (seen.has(preset.id)) throw new Error(`Quality preset id "${preset.id}" is used twice.`);
    seen.add(preset.id);
  }
  for (const [role, id] of Object.entries(AUTO_PRESET_IDS)) {
    if (!seen.has(id))
      throw new Error(
        `Auto mode needs the preset "${id}" (role: ${role}), but it is missing from the table.`,
      );
  }
  const settled = table.find((preset) => preset.id === AUTO_PRESET_IDS.settled)!;
  if (!settled.fullQuality)
    throw new Error(`The preset "${settled.id}" must be fullQuality, or the room decay would never update.`);
  validateSchedulerSettings(settings);
}

// Looks up a preset by id. Throws a readable error for an unknown id.
export function getQualityPreset(id: string, table: QualityPreset[] = QUALITY_PRESETS): QualityPreset {
  const preset = table.find((candidate) => candidate.id === id);
  if (!preset) {
    const known = table.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown quality preset "${id}". Known presets: ${known}.`);
  }
  return preset;
}

export function registerQualityPreset(preset: QualityPreset): () => void {
  validateQualityPreset(preset);
  if (QUALITY_PRESETS.some((candidate) => candidate.id === preset.id)) {
    throw new Error(`Quality preset id "${preset.id}" is already registered.`);
  }
  QUALITY_PRESETS.push(preset);
  return () => {
    const index = QUALITY_PRESETS.indexOf(preset);
    if (index >= 0) QUALITY_PRESETS.splice(index, 1);
  };
}

// The numbers a trace will actually use after a preset is applied to the GUI settings.
export interface ResolvedBudget {
  rays: number;
  bounces: number;
  earlyOrder: number;
}

// Applies one preset field: 'scene' follows the GUI, a number is used (and capped if requested).
function resolveField(presetValue: number | 'scene', sceneValue: number, capToScene: boolean): number {
  if (presetValue === 'scene') return sceneValue;
  return capToScene ? Math.min(presetValue, sceneValue) : presetValue;
}

// Turns a preset plus the GUI settings into concrete trace numbers. Pure function.
export function resolveBudget(preset: QualityPreset, scene: ResolvedBudget): ResolvedBudget {
  return {
    rays: resolveField(preset.rays, scene.rays, preset.capToScene),
    bounces: resolveField(preset.bounces, scene.bounces, preset.capToScene),
    earlyOrder: resolveField(preset.earlyOrder, scene.earlyOrder, preset.capToScene),
  };
}
