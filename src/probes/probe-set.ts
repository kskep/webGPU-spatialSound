// Probe editing returns a new set, leaving the previous set unchanged.
// Scene/source changes make all bakes stale; moving a probe only stales its bake.
// Placement checks keep probes inside the room, clear of objects and the source.
import type { Vec3 } from '../acoustics/model.ts';
import { insideObject, type SceneObject } from '../geometry/acoustic-scene.ts';
import { PROBE_CONFIG, type ProbeConfig, type ProbeGridConfig } from '../config/probes.ts';
import { fieldBytes, type ProbeBake } from './probe-data.ts';

export type BakeState = 'unbaked' | 'baked' | 'stale';

// One probe.
export interface Probe {
  // Stable id (never reused inside a set).
  id: string;
  label: string;
  position: Vec3;
  // A disabled probe stays in the set but is never used by the blend.
  enabled: boolean;
  origin: 'grid' | 'manual';
  bake?: ProbeBake;
  bakeState: BakeState;
}

// The settings a set was created with (informational, and used to refuse blends of incompatible bakes).
export interface ProbeCreatedWith {
  bakePresetId: string;
  timeBinMs: number;
  directionBinSetId: string;
}

export interface ProbeSet {
  probes: Probe[];
  // Scene key the baked probes are valid for (probe-keys.ts).
  sceneKey: string;
  // Source key the baked probes are valid for.
  sourceKey: string;
  createdWith: ProbeCreatedWith;
  // Counter behind the ids of new probes.
  nextId: number;
}

// Result of an editing operation. A refused edit carries a message for the user.
export type EditResult =
  { ok: true; set: ProbeSet; probe?: Probe; message?: string } | { ok: false; message: string };

// Everything `validatePlacement` needs to know about the room.
export interface PlacementContext {
  // Room interior (`roomBounds`).
  bounds: { min: Vec3; max: Vec3 };
  objects: SceneObject[];
  // Metres from walls, floor and ceiling.
  wallClearance: number;
  // Metres from objects.
  objectClearance: number;
  // Source position and the smallest distance a probe may have from it.
  source?: { position: Vec3; clearance: number };
}

const AXIS_NAMES = ['x', 'y', 'z'];

// An empty set for the given keys.
export function emptyProbeSet(
  sceneKey: string,
  sourceKey: string,
  config: ProbeConfig = PROBE_CONFIG,
): ProbeSet {
  return {
    probes: [],
    sceneKey,
    sourceKey,
    createdWith: {
      bakePresetId: config.bakePresetId,
      timeBinMs: config.timeBinMs,
      directionBinSetId: config.directionBinSetId,
    },
    nextId: 1,
  };
}

// A readable reason why `position` may not hold a probe, or undefined when it may.
export function validatePlacement(position: Vec3, context: PlacementContext): string | undefined {
  if (position.length !== 3 || position.some((value) => !Number.isFinite(value)))
    return 'A probe position needs three finite numbers.';
  const { min, max } = context.bounds;
  for (let axis = 0; axis < 3; axis++) {
    const low = min[axis] + context.wallClearance;
    const high = max[axis] - context.wallClearance;
    if (position[axis] < low - 1e-9 || position[axis] > high + 1e-9) {
      const inside = position[axis] >= min[axis] && position[axis] <= max[axis];
      return inside
        ? `A probe must be at least ${context.wallClearance} m from the walls (${AXIS_NAMES[axis]} must be between ${low.toFixed(2)} and ${high.toFixed(2)} m).`
        : `The position is outside the room (${AXIS_NAMES[axis]} = ${position[axis].toFixed(2)} m).`;
    }
  }
  const blocker = insideObject(position, context.objects, context.objectClearance);
  if (blocker)
    return `The position is inside or too close to an object (${blocker.name ?? blocker.material}); keep ${context.objectClearance} m clear.`;
  if (context.source) {
    const separation = Math.hypot(...position.map((value, axis) => value - context.source!.position[axis]));
    if (separation < context.source.clearance)
      return `The position is too close to the sound source (closer than ${context.source.clearance.toFixed(2)} m).`;
  }
  return undefined;
}

// The set with one probe replaced; the order is kept.
function withProbe(set: ProbeSet, id: string, change: (probe: Probe) => Probe): ProbeSet {
  return { ...set, probes: set.probes.map((probe) => (probe.id === id ? change(probe) : probe)) };
}

function findProbe(set: ProbeSet, id: string): Probe | undefined {
  return set.probes.find((probe) => probe.id === id);
}

// Adds a probe at `position`. Refused when the placement rules fail or the set is full.
export function addProbe(
  set: ProbeSet,
  position: Vec3,
  context: PlacementContext,
  options: { label?: string; origin?: 'grid' | 'manual'; maxProbes?: number } = {},
): EditResult {
  const maxProbes = options.maxProbes ?? PROBE_CONFIG.maxProbes;
  if (set.probes.length >= maxProbes)
    return { ok: false, message: `The probe set is full (${maxProbes} probes). Delete a probe first.` };
  const problem = validatePlacement(position, context);
  if (problem) return { ok: false, message: problem };
  const id = `p${set.nextId}`;
  const probe: Probe = {
    id,
    label: options.label?.trim() || `Probe ${set.nextId}`,
    position: [...position],
    enabled: true,
    origin: options.origin ?? 'manual',
    bakeState: 'unbaked',
  };
  return { ok: true, set: { ...set, probes: [...set.probes, probe], nextId: set.nextId + 1 }, probe };
}

// Moves a probe. A baked probe becomes stale (only this one); an unbaked one stays unbaked.
export function moveProbe(set: ProbeSet, id: string, position: Vec3, context: PlacementContext): EditResult {
  const probe = findProbe(set, id);
  if (!probe) return { ok: false, message: `There is no probe "${id}".` };
  const problem = validatePlacement(position, context);
  if (problem) return { ok: false, message: problem };
  const next = withProbe(set, id, (current) => ({
    ...current,
    position: [...position],
    bakeState: current.bakeState === 'unbaked' ? 'unbaked' : 'stale',
  }));
  return { ok: true, set: next, probe: findProbe(next, id) };
}

// Deletes a probe.
export function removeProbe(set: ProbeSet, id: string): EditResult {
  if (!findProbe(set, id)) return { ok: false, message: `There is no probe "${id}".` };
  return { ok: true, set: { ...set, probes: set.probes.filter((probe) => probe.id !== id) } };
}

// Enables or disables a probe (a disabled probe is kept but not used).
export function setEnabled(set: ProbeSet, id: string, enabled: boolean): EditResult {
  if (!findProbe(set, id)) return { ok: false, message: `There is no probe "${id}".` };
  const next = withProbe(set, id, (probe) => ({ ...probe, enabled }));
  return { ok: true, set: next, probe: findProbe(next, id) };
}

// Renames a probe. An empty label is refused.
export function relabel(set: ProbeSet, id: string, label: string): EditResult {
  if (!findProbe(set, id)) return { ok: false, message: `There is no probe "${id}".` };
  if (label.trim() === '') return { ok: false, message: 'A probe needs a label.' };
  const next = withProbe(set, id, (probe) => ({ ...probe, label: label.trim() }));
  return { ok: true, set: next, probe: findProbe(next, id) };
}

// Removes every probe; the keys and the settings stay.
export function clearProbes(set: ProbeSet): ProbeSet {
  return { ...set, probes: [] };
}

// Stores a finished bake: the probe becomes 'baked' for the keys the set holds now.
export function storeBake(set: ProbeSet, id: string, bake: ProbeBake): ProbeSet {
  return withProbe(set, id, (probe) => ({ ...probe, bake, bakeState: 'baked' }));
}

export function invalidate(set: ProbeSet, newSceneKey: string, newSourceKey: string): ProbeSet {
  if (set.sceneKey === newSceneKey && set.sourceKey === newSourceKey) return set;
  return {
    ...set,
    sceneKey: newSceneKey,
    sourceKey: newSourceKey,
    probes: set.probes.map((probe) =>
      probe.bakeState === 'baked' ? { ...probe, bakeState: 'stale' as const } : probe,
    ),
  };
}

// Counts of the probes in each state, for the debug panel.
export interface ProbeCounts {
  total: number;
  unbaked: number;
  baked: number;
  stale: number;
  disabled: number;
}

export function countProbes(set: ProbeSet): ProbeCounts {
  const counts: ProbeCounts = { total: set.probes.length, unbaked: 0, baked: 0, stale: 0, disabled: 0 };
  for (const probe of set.probes) {
    counts[probe.bakeState]++;
    if (!probe.enabled) counts.disabled++;
  }
  return counts;
}

// Memory held by the baked fields of the set, in bytes.
export function setMemoryBytes(set: ProbeSet): number {
  return set.probes.reduce((sum, probe) => sum + (probe.bake ? fieldBytes(probe.bake.data) : 0), 0);
}

// Probes that need a bake: unbaked or stale.
export function probesNeedingBake(set: ProbeSet): Probe[] {
  return set.probes.filter((probe) => probe.bakeState !== 'baked');
}

// Grid

// Positions of a grid layer along one axis: centred in [low, high], spaced `spacing` apart.
function gridAxis(low: number, high: number, spacing: number): number[] {
  if (high < low) return [];
  const steps = Math.floor((high - low) / spacing + 1e-9);
  const start = low + (high - low - steps * spacing) / 2;
  return Array.from({ length: steps + 1 }, (_, i) => start + i * spacing);
}

// What `generateGrid` did, for the status line.
export interface GridReport {
  added: number;
  // Candidate positions that broke a placement rule (walls, objects, source).
  skippedInvalid: number;
  // Candidate positions next to an existing probe.
  skippedDuplicate: number;
  // True when the set filled up and the grid was cut short.
  truncated: boolean;
  // Grid probes removed by 'replace'.
  removed: number;
}

export function gridPositions(bounds: PlacementContext['bounds'], grid: ProbeGridConfig): Vec3[] {
  const xs = gridAxis(bounds.min[0] + grid.clearance, bounds.max[0] - grid.clearance, grid.spacing);
  const zs = gridAxis(bounds.min[2] + grid.clearance, bounds.max[2] - grid.clearance, grid.spacing);
  const positions: Vec3[] = [];
  for (const y of grid.heights) for (const x of xs) for (const z of zs) positions.push([x, y, z]);
  return positions;
}

export function generateGrid(
  set: ProbeSet,
  grid: ProbeGridConfig,
  context: PlacementContext,
  mode: 'add' | 'replace',
  config: Pick<ProbeConfig, 'maxProbes' | 'duplicateDistance'> = PROBE_CONFIG,
): { set: ProbeSet; report: GridReport } {
  const report: GridReport = {
    added: 0,
    skippedInvalid: 0,
    skippedDuplicate: 0,
    truncated: false,
    removed: 0,
  };
  let next = set;
  if (mode === 'replace') {
    const kept = set.probes.filter((probe) => probe.origin !== 'grid');
    report.removed = set.probes.length - kept.length;
    next = { ...set, probes: kept };
  }
  const placement = { ...context, wallClearance: Math.max(context.wallClearance, grid.clearance) };
  for (const position of gridPositions(context.bounds, grid)) {
    if (validatePlacement(position, placement)) {
      report.skippedInvalid++;
      continue;
    }
    const taken = next.probes.some(
      (probe) =>
        Math.hypot(...probe.position.map((value, axis) => value - position[axis])) < config.duplicateDistance,
    );
    if (taken) {
      report.skippedDuplicate++;
      continue;
    }
    const added = addProbe(next, position, placement, { origin: 'grid', maxProbes: config.maxProbes });
    if (!added.ok) {
      report.truncated = true;
      break;
    }
    next = added.set;
    report.added++;
  }
  return { set: next, report };
}

// One sentence about a grid report, for the status line.
export function describeGridReport(report: GridReport, maxProbes: number): string {
  const parts = [`${report.added} probes added`];
  if (report.removed > 0) parts.push(`${report.removed} grid probes replaced`);
  if (report.skippedInvalid > 0)
    parts.push(`${report.skippedInvalid} positions skipped (walls, objects or source)`);
  if (report.skippedDuplicate > 0)
    parts.push(`${report.skippedDuplicate} skipped (a probe is already there)`);
  if (report.truncated) parts.push(`stopped at the limit of ${maxProbes} probes`);
  return parts.join('; ') + '.';
}

// Export and import

// Format tag and version of the exported file.
export const PROBE_FILE_FORMAT = 'acoustic-webgpu-probe-set';
export const PROBE_FILE_VERSION = 1;

// Bytes of a typed array as base64.
function toBase64(array: ArrayBufferView): string {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  let text = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(text);
}

// A new typed array of the given kind from base64 text.
function fromBase64<T extends Float64Array | Uint32Array>(
  text: string,
  Kind: new (buffer: ArrayBuffer) => T,
): T {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Kind(bytes.buffer);
}

// JSON cannot hold Infinity (a lossless room has an infinite RT60), so it travels as a word.
function infinityReplacer(_key: string, value: unknown): unknown {
  if (value === Infinity) return '@Infinity';
  if (value === -Infinity) return '@-Infinity';
  return value;
}
function infinityReviver(_key: string, value: unknown): unknown {
  if (value === '@Infinity') return Infinity;
  if (value === '@-Infinity') return -Infinity;
  return value;
}

// The probe set as JSON text, with the scene and source keys. The baked fields are stored as base64.
export function exportProbeSet(set: ProbeSet): string {
  const file = {
    format: PROBE_FILE_FORMAT,
    version: PROBE_FILE_VERSION,
    sceneKey: set.sceneKey,
    sourceKey: set.sourceKey,
    createdWith: set.createdWith,
    nextId: set.nextId,
    probes: set.probes.map((probe) => ({
      id: probe.id,
      label: probe.label,
      position: probe.position,
      enabled: probe.enabled,
      origin: probe.origin,
      bakeState: probe.bakeState,
      bake: probe.bake && {
        ...probe.bake,
        data: {
          ...probe.bake.data,
          directional: toBase64(probe.bake.data.directional),
          directionalHits: toBase64(probe.bake.data.directionalHits),
          omni: toBase64(probe.bake.data.omni),
          omniHits: toBase64(probe.bake.data.omniHits),
        },
      },
    })),
  };
  return JSON.stringify(file, infinityReplacer);
}

// What `importProbeSet` hands back.
export interface ProbeImport {
  set: ProbeSet;
  // True when the file's keys or settings differ from the current ones: its baked probes load as stale.
  mismatch: boolean;
  // A sentence for the user.
  message: string;
}

// Throws a readable error for a malformed number array of a file.
function requireNumbers(value: unknown, length: number, what: string): void {
  if (!Array.isArray(value) || value.length !== length || value.some((v) => !Number.isFinite(v)))
    throw new Error(`The probe file is damaged: ${what} is not a list of ${length} numbers.`);
}

export function importProbeSet(
  text: string,
  current: { sceneKey: string; sourceKey: string; createdWith: ProbeCreatedWith },
): ProbeImport {
  let file: any;
  try {
    file = JSON.parse(text, infinityReviver);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (file?.format !== PROBE_FILE_FORMAT) throw new Error('The file is not an exported probe set.');
  if (file.version !== PROBE_FILE_VERSION)
    throw new Error(
      `Unsupported probe file version ${file.version} (this app reads version ${PROBE_FILE_VERSION}).`,
    );
  if (!Array.isArray(file.probes)) throw new Error('The probe file has no probe list.');

  const probes: Probe[] = file.probes.map((raw: any): Probe => {
    requireNumbers(raw.position, 3, `the position of "${raw.id}"`);
    if (typeof raw.id !== 'string' || typeof raw.label !== 'string')
      throw new Error('The probe file is damaged: a probe has no id or label.');
    let bake: ProbeBake | undefined;
    if (raw.bake) {
      const data = raw.bake.data;
      bake = {
        ...raw.bake,
        data: {
          ...data,
          directional: fromBase64(data.directional, Float64Array),
          directionalHits: fromBase64(data.directionalHits, Uint32Array),
          omni: fromBase64(data.omni, Float64Array),
          omniHits: fromBase64(data.omniHits, Uint32Array),
        },
      };
      const field = bake!.data;
      if (
        field.directional.length !== field.timeBins * field.directionBins * 8 ||
        field.directionalHits.length !== field.timeBins * field.directionBins ||
        field.omni.length !== field.omniBins * 8 ||
        field.omniHits.length !== field.omniBins
      )
        throw new Error(`The probe file is damaged: the stored field of "${raw.id}" has the wrong size.`);
    }
    return {
      id: raw.id,
      label: raw.label,
      position: raw.position as Vec3,
      enabled: raw.enabled !== false,
      origin: raw.origin === 'grid' ? 'grid' : 'manual',
      bake,
      bakeState: bake ? (raw.bakeState === 'stale' ? 'stale' : 'baked') : 'unbaked',
    };
  });

  const loaded: ProbeSet = {
    probes,
    sceneKey: String(file.sceneKey),
    sourceKey: String(file.sourceKey),
    createdWith: file.createdWith as ProbeCreatedWith,
    nextId: Math.max(Number(file.nextId) || 1, 1 + probes.length),
  };
  const sceneDiffers = loaded.sceneKey !== current.sceneKey;
  const sourceDiffers = loaded.sourceKey !== current.sourceKey;
  const settingsDiffer =
      loaded.createdWith.directionBinSetId !== current.createdWith.directionBinSetId ||
      loaded.createdWith.timeBinMs !== current.createdWith.timeBinMs;
  const mismatch = sceneDiffers || sourceDiffers || settingsDiffer;
  const wasBaked = probes.filter((probe) => probe.bakeState === 'baked').length;

  let set = invalidate(loaded, current.sceneKey, current.sourceKey);
  if (settingsDiffer)
    set = {
      ...set,
      probes: set.probes.map((probe) =>
        probe.bakeState === 'baked' ? { ...probe, bakeState: 'stale' as const } : probe,
      ),
      createdWith: current.createdWith,
    };
  const reasons = [
    sceneDiffers && 'another room',
    sourceDiffers && 'another source',
    settingsDiffer && 'other probe settings',
  ].filter(Boolean);
  const message = mismatch
    ? `Imported ${probes.length} probes, but the file was made for ${reasons.join(' and ')}: ${wasBaked} baked probes are loaded as stale. Re-bake them before they are used.`
    : `Imported ${probes.length} probes (${wasBaked} baked).`;
  return { set, mismatch, message };
}
