// Probe cache controller: manages the probe set, baking, blending and GUI state.
// Ties the pure probe modules to the app without DOM code.
import type { Scene, Vec3 } from '../acoustics/model';
import { roomBounds, type SceneObject } from '../geometry/acoustic-scene';
import { segmentOccluded } from '../geometry/bvh';
import type { PreparedScene } from '../gpu/prepared-scene';
import {
  PROBE_CONFIG,
  getProbeMode,
  validateProbeConfig,
  type ProbeConfig,
  type ProbeGridConfig,
  type StochasticSource,
} from '../config/probes';
import type { RequestReason } from '../scheduler/acoustic-scheduler';
import { bakeProbes, type BakeSummary, type ProbeTraceOutput } from '../probes/probe-baker';
import { blendProbes, selectProbes, type OcclusionTest, type ProbeBlend } from '../probes/probe-blend';
import { fieldBytes } from '../probes/probe-data';
import { sceneKeyOf, sourceKeyOf } from '../probes/probe-keys';
import {
  addProbe,
  clearProbes,
  countProbes,
  describeGridReport,
  emptyProbeSet,
  exportProbeSet,
  generateGrid,
  importProbeSet,
  invalidate,
  moveProbe,
  probesNeedingBake,
  relabel,
  removeProbe,
  setEnabled,
  setMemoryBytes,
  storeBake,
  validatePlacement,
  type EditResult,
  type PlacementContext,
  type Probe,
  type ProbeCounts,
  type ProbeSet,
} from '../probes/probe-set';
import { probeView, type ProbeView, type UsedProbe } from '../probes/probe-view';
import type { ProbeSource } from './trace-pipeline';

// what the controller needs from the application
export interface ProbeControllerHooks {
  getScene(): Scene;
  getObjects(): SceneObject[];
  meshTracerReady(): boolean;
  traceForProbe(position: Vec3, presetId: string): Promise<ProbeTraceOutput>;
  currentPrepared(): PreparedScene;
  status(message: string, error?: boolean): void;
}

// a blend that was used, for the debug panel and the export
export interface BlendRecord {
  atMs: number;
  probes: (UsedProbe & { label: string; distance: number })[];
  selectMs: number;
  mixMs: number;
  occluded: number;
}

// state of a bake run, for the progress display
export interface BakeStatus {
  running: boolean;
  done: number;
  total: number;
  last?: BakeSummary;
}

// counters and state for the debug panel and the export
export interface ProbeStats {
  modeId: string;
  counts: ProbeCounts;
  memoryBytes: number;
  blends: number;
  fallbacks: number;
  lastFallbackReason?: string;
  lastBlend?: BlendRecord;
  bake: BakeStatus;
  sceneKey: string;
  sourceKey: string;
}

// pause between probes of a bake so the page can draw and handle input
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class ProbeController implements ProbeSource {
  // The settings; `grid` is edited by the GUI, the rest is the shipped configuration.
  readonly config: ProbeConfig;
  private current: ProbeSet;
  private modeId = 'live';
  // False until the user picks a mode; the first finished bake then switches to `config.defaultMode`.
  private modeChosen = false;
  private selected: string | undefined;
  private showProbes = true;
  private showBlend = false;
  private blendCount = 0;
  private fallbackCount = 0;
  private fallbackReason: string | undefined;
  private recentBlend: BlendRecord | undefined;
  private baking: BakeStatus = { running: false, done: 0, total: 0 };
  private bakeAbort: AbortController | undefined;
  private listeners = new Set<() => void>();
  private hooks: ProbeControllerHooks;

  constructor(hooks: ProbeControllerHooks, config: ProbeConfig = structuredClone(PROBE_CONFIG)) {
    validateProbeConfig(config);
    this.hooks = hooks;
    this.config = config;
    const scene = hooks.getScene();
    this.current = emptyProbeSet(sceneKeyOf(scene, hooks.getObjects()), sourceKeyOf(scene), config);
  }

  // Observation
  // Calls `listener` after every change; returns the function that stops it.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get set(): ProbeSet {
    return this.current;
  }
  get mode(): string {
    return this.modeId;
  }
  get selectedId(): string | undefined {
    return this.selected;
  }
  get selectedProbe(): Probe | undefined {
    return this.current.probes.find((probe) => probe.id === this.selected);
  }
  get probesVisible(): boolean {
    return this.showProbes;
  }
  get blendVisible(): boolean {
    return this.showBlend;
  }
  get bakeStatus(): BakeStatus {
    return this.baking;
  }

  // Counters and state for the debug panel and the export.
  stats(): ProbeStats {
    return {
      modeId: this.modeId,
      counts: countProbes(this.current),
      memoryBytes: setMemoryBytes(this.current),
      blends: this.blendCount,
      fallbacks: this.fallbackCount,
      lastFallbackReason: this.fallbackReason,
      lastBlend: this.recentBlend,
      bake: { ...this.baking },
      sceneKey: this.current.sceneKey,
      sourceKey: this.current.sourceKey,
    };
  }

  // The stats plus one line per probe (position, state, bake cost, memory): the "probes" part of the export.
  report() {
    return {
      ...this.stats(),
      config: {
        bakePresetId: this.config.bakePresetId,
        timeBinMs: this.config.timeBinMs,
        directionBinSetId: this.config.directionBinSetId,
        neighbours: this.config.neighbours,
        weightPower: this.config.weightPower,
        lineOfSight: this.config.lineOfSight,
        grid: this.config.grid,
      },
      probes: this.current.probes.map((probe) => ({
        id: probe.id,
        label: probe.label,
        position: probe.position,
        enabled: probe.enabled,
        origin: probe.origin,
        bakeState: probe.bakeState,
        bakeMs: probe.bake?.bakeMs ?? null,
        traceMs: probe.bake?.traceMs ?? null,
        rays: probe.bake?.rays ?? null,
        bytes: ProbeController.probeBytes(probe),
      })),
    };
  }

  // What the viewport draws, for the listener at `listener`.
  view(listener: Vec3): ProbeView {
    const used = this.showBlend && this.recentBlend ? this.recentBlend.probes : undefined;
    return probeView(this.current, this.selected, this.showProbes, listener, used);
  }

  // Settings
  setShowProbes(value: boolean): void {
    this.showProbes = value;
    this.emit();
  }

  setShowBlend(value: boolean): void {
    this.showBlend = value;
    this.emit();
  }

  // Chooses the runtime mode. A choice by the user stops the automatic switch after the first bake.
  setMode(id: string, chosenByUser = true): void {
    getProbeMode(id);
    this.modeId = id;
    if (chosenByUser) this.modeChosen = true;
    this.emit();
  }

  // Changes the grid settings after checking them; returns an error message, or undefined when accepted.
  setGrid(grid: ProbeGridConfig): string | undefined {
    try {
      validateProbeConfig({ ...this.config, grid });
    } catch (error) {
      return (error as Error).message;
    }
    this.config.grid = { ...grid, heights: [...grid.heights] };
    this.emit();
    return undefined;
  }

  select(id: string | undefined): void {
    this.selected = id && this.current.probes.some((probe) => probe.id === id) ? id : undefined;
    this.emit();
  }

  // Editing
  // The placement rules for the current room (walls, objects, source).
  placementContext(): PlacementContext {
    const scene = this.hooks.getScene();
    return {
      bounds: roomBounds(scene),
      objects: this.hooks.getObjects(),
      wallClearance: this.config.grid.clearance,
      objectClearance: Math.max(this.config.grid.clearance, scene.receiverRadius),
      source: { position: scene.source, clearance: scene.receiverRadius * 2 + 0.02 },
    };
  }

  // Stores the result of an edit and tells the user when it was refused.
  private commit(result: EditResult, success?: string): boolean {
    if (!result.ok) {
      this.hooks.status(result.message, true);
      return false;
    }
    this.current = result.set;
    if (success) this.hooks.status(success);
    this.emit();
    return true;
  }

  // Adds a probe at `position` and selects it.
  addProbeAt(position: Vec3): void {
    const result = addProbe(this.current, position, this.placementContext(), {
      maxProbes: this.config.maxProbes,
    });
    if (this.commit(result, undefined) && result.ok) {
      this.selected = result.probe!.id;
      this.hooks.status(`Added ${result.probe!.label}. Bake it to use it.`);
      this.emit();
    }
  }

  // Adds a probe at the camera (the listener). The keyboard shortcut P calls this.
  addAtCamera(): void {
    this.addProbeAt([...this.hooks.getScene().listener]);
  }

  // Moves a probe; a refused move leaves it where it was. Returns whether it moved.
  moveProbeTo(id: string, position: Vec3): boolean {
    return this.commit(moveProbe(this.current, id, position, this.placementContext()));
  }

  // Moves the selected probe to the camera.
  moveSelectedToCamera(): void {
    if (this.selected) this.moveProbeTo(this.selected, [...this.hooks.getScene().listener]);
  }

  removeSelected(): void {
    if (!this.selected) return;
    const id = this.selected;
    if (this.commit(removeProbe(this.current, id), 'Probe deleted.')) this.selected = undefined;
    this.emit();
  }

  setProbeEnabled(id: string, enabled: boolean): void {
    this.commit(setEnabled(this.current, id, enabled));
  }

  setProbeLabel(id: string, label: string): void {
    this.commit(relabel(this.current, id, label));
  }

  // Adds or replaces grid probes with the current grid settings.
  generateGrid(mode: 'add' | 'replace'): void {
    const { set, report } = generateGrid(
      this.current,
      this.config.grid,
      this.placementContext(),
      mode,
      this.config,
    );
    this.current = set;
    if (this.selected && !set.probes.some((probe) => probe.id === this.selected)) this.selected = undefined;
    this.hooks.status(
      describeGridReport(report, this.config.maxProbes),
      report.added === 0 && report.truncated,
    );
    this.emit();
  }

  // Deletes every probe.
  clearAll(): void {
    this.current = clearProbes(this.current);
    this.selected = undefined;
    this.hooks.status('All probes deleted.');
    this.emit();
  }

  // Staleness
  sceneChanged(): void {
    const scene = this.hooks.getScene();
    const sceneKey = sceneKeyOf(scene, this.hooks.getObjects());
    const sourceKey = sourceKeyOf(scene);
    const next = invalidate(this.current, sceneKey, sourceKey);
    if (next === this.current) return;
    const hadBakes = this.current.probes.some((probe) => probe.bakeState === 'baked');
    this.current = next;
    if (hadBakes)
      this.hooks.status('The scene or the source changed: the baked probes are stale. Bake them again.');
    this.emit();
  }

  // True while the scene and source still have the given keys (those the running bake started with).
  private keysMatch(keys: { sceneKey: string; sourceKey: string }): boolean {
    const scene = this.hooks.getScene();
    return (
      keys.sceneKey === sceneKeyOf(scene, this.hooks.getObjects()) && keys.sourceKey === sourceKeyOf(scene)
    );
  }

  // Baking
  bakeAll(): Promise<BakeSummary | undefined> {
    return this.bake(this.current.probes.filter((probe) => probe.enabled));
  }

  bakeStale(): Promise<BakeSummary | undefined> {
    return this.bake(probesNeedingBake(this.current).filter((probe) => probe.enabled));
  }

  bakeSelected(): Promise<BakeSummary | undefined> {
    const probe = this.selectedProbe;
    return this.bake(probe ? [probe] : []);
  }

  // Stops a running bake before its next probe.
  cancelBake(): void {
    if (this.baking.running) this.bakeAbort?.abort();
  }

  // Bakes `targets` one after another; resolves with the summary, or undefined when nothing was started.
  private async bake(targets: Probe[]): Promise<BakeSummary | undefined> {
    if (this.baking.running) {
      this.hooks.status('A bake is already running. Cancel it first.', true);
      return undefined;
    }
    if (!this.hooks.meshTracerReady()) {
      this.hooks.status('Baking needs the BVH mesh tracer and a ready GPU.', true);
      return undefined;
    }
    if (targets.length === 0) {
      this.hooks.status('Nothing to bake: no enabled probes need it.');
      return undefined;
    }

    // A bake is only valid for the keys it started with: an edit meanwhile stops it (`bakeProbes` checks
    // `keysCurrent` before every probe and after every trace) and what it traced is not stored.
    const startKeys = { sceneKey: this.current.sceneKey, sourceKey: this.current.sourceKey };
    const abort = new AbortController();
    this.bakeAbort = abort;
    this.baking = { running: true, done: 0, total: targets.length };
    this.hooks.status(`Baking ${targets.length} probes…`);
    this.emit();

    // A probe that is moved or deleted while its trace runs must not receive the bake of the old position.
    const positions = new Map(targets.map((probe) => [probe.id, probe.position.join(',')]));
    const context = (): PlacementContext => this.placementContext();
    const summary = await bakeProbes(
      targets,
      {
        traceAt: (position) => this.hooks.traceForProbe(position, this.config.bakePresetId),
        placementProblem: (probe) => validatePlacement(probe.position, context()),
        keysCurrent: () => this.keysMatch(startKeys),
        now: () => performance.now(),
        pause: nextTask,
      },
      {
        config: this.config,
        signal: abort.signal,
        onProgress: (progress) => {
          this.baking = { ...this.baking, done: progress.done };
          this.emit();
        },
        onBaked: (id, bake) => {
          const probe = this.current.probes.find((candidate) => candidate.id === id);
          if (!probe || probe.position.join(',') !== positions.get(id)) return;
          this.current = storeBake(this.current, id, bake);
          this.emit();
        },
      },
    );
    this.baking = {
      running: false,
      done: summary.baked.length + summary.failed.length,
      total: targets.length,
      last: summary,
    };
    this.bakeAbort = undefined;

    const seconds = (summary.totalMs / 1000).toFixed(1);
    if (summary.cancelled) {
      const why = summary.stopReason === 'scene-changed' ? 'the scene changed' : 'cancelled';
      this.hooks.status(
        `Bake stopped (${why}): ${summary.baked.length} of ${targets.length} probes baked.`,
        summary.stopReason === 'scene-changed',
      );
    } else if (summary.failed.length > 0) {
      this.hooks.status(
        `Baked ${summary.baked.length} probes in ${seconds} s; ${summary.failed.length} failed: ${summary.failed[0].message}`,
        true,
      );
    } else {
      this.hooks.status(`Baked ${summary.baked.length} probes in ${seconds} s.`);
    }
    // The first successful bake selects the default mode, unless the user already picked one.
    if (summary.baked.length > 0 && !this.modeChosen && this.modeId !== this.config.defaultMode) {
      this.modeId = this.config.defaultMode;
      this.hooks.status(
        `${this.hooks.getScene() ? 'Baked ' + summary.baked.length + ' probes in ' + seconds + ' s. ' : ''}Mode set to ${getProbeMode(this.modeId).label}.`,
      );
    }
    this.emit();
    return summary;
  }

  // Export and import
  // The set as JSON text, with the scene and source keys.
  exportText(): string {
    return exportProbeSet(this.current);
  }

  // Replaces the set by an imported one. A file for another scene or source loads as stale, with a message.
  importText(text: string): void {
    try {
      const scene = this.hooks.getScene();
      const loaded = importProbeSet(text, {
        sceneKey: sceneKeyOf(scene, this.hooks.getObjects()),
        sourceKey: sourceKeyOf(scene),
        createdWith: this.current.createdWith,
      });
      this.cancelBake();
      this.current = loaded.set;
      this.selected = undefined;
      this.hooks.status(loaded.message, loaded.mismatch);
      this.emit();
    } catch (error) {
      this.hooks.status((error as Error).message, true);
    }
  }

  // Runtime: scheduler and pipeline
  // Selection of probes for the listener, with the line-of-sight test of the current geometry.
  private occlusionFor(prepared: PreparedScene): OcclusionTest | undefined {
    if (prepared.objects.length === 0) return undefined;
    return (from, to) => segmentOccluded(prepared.bvh, from, to);
  }

  stochasticSource(reason: RequestReason): StochasticSource {
    const mode = getProbeMode(this.modeId);
    const wanted = reason === 'motion' ? mode.moving : mode.settled;
    if (wanted === 'trace') return 'trace';
    if (!this.hooks.meshTracerReady()) return 'trace';
    const prepared = this.hooks.currentPrepared();
    const selection = selectProbes(
      this.current,
      this.hooks.getScene().listener,
      this.config,
      this.occlusionFor(prepared),
    );
    if (selection.choices.length > 0) return 'probes';
    this.noteFallback(selection.reason ?? 'no usable probe');
    return 'trace';
  }

  blend(listener: Vec3, speed: number, prepared: PreparedScene): ProbeBlend | undefined {
    const blend = blendProbes(this.current, listener, this.config, speed, this.occlusionFor(prepared));
    if (!blend) return undefined;
    this.blendCount++;
    this.recentBlend = {
      atMs: performance.now(),
      probes: blend.selection.choices.map(({ probe, weight, distance }) => ({
        id: probe.id,
        label: probe.label,
        position: [...probe.position] as Vec3,
        weight,
        distance,
      })),
      selectMs: blend.timings.selectMs,
      mixMs: blend.timings.mixMs + blend.timings.arrivalsMs + blend.timings.decayMs,
      occluded: blend.selection.occluded,
    };
    this.emit();
    return blend;
  }

  noteFallback(reason: string): void {
    this.fallbackCount++;
    this.fallbackReason = reason;
    this.emit();
  }

  // Bytes of memory the baked field of one probe holds (0 for an unbaked probe).
  static probeBytes(probe: Probe): number {
    return probe.bake ? fieldBytes(probe.bake.data) : 0;
  }
}
