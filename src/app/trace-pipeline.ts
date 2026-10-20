// Runs a trace and combines it with early reflections and probe data.
import { earlyArrivals, type Arrival, type Scene, type TraceResult, type Vec3 } from '../acoustics/model';
import { applyEarlyOcclusion } from '../acoustics/occlusion';
import { RoomDecayCache } from '../acoustics/room-decay-cache';
import { EchoPathMemory, exactEchoesAt, type SpecularRaysReport } from '../acoustics/specular-echoes';
import type { SpecularRaySettings } from '../config/specular-rays';
import type { SceneObject } from '../geometry/acoustic-scene';
import { describeSceneProblem } from '../geometry/scene-problems';
import { PreparedSceneCache, type PreparedScene, type PreprocessingCosts } from '../gpu/prepared-scene';
import type { MeshTracer, MeshTraceResult } from '../gpu/mesh-tracer';
import { resolveTerminationFor } from '../gpu/scene-termination';
import type { AppTraceResult } from '../gpu/trace-types';
import { getQualityPreset, resolveBudget } from '../config/quality-presets';
import type { StochasticSource } from '../config/probes';
import type { ProbeBlend } from '../probes/probe-blend';
import type { ProbeTraceOutput } from '../probes/probe-baker';
import type { TraceRequest } from '../scheduler/acoustic-scheduler';
import type { AudioUpdateTimings, StageTimings, TraceCallTimings } from './stage-timings';

// What one finished trace hands over to `TracePipeline.apply`.
export interface TracedFrame {
  trace: TraceResult & Partial<MeshTraceResult>;
  // The scene as it was when the trace started, with the preset's ray count, bounces and early order.
  snapshot: Scene;
  // Clock reading (performance.now) when `run` started: the start of the total pipeline time.
  requestStartedMs: number;
  // The prepared scene (mesh, BVH, statistics) the trace ran with.
  prepared: PreparedScene;
  // True when `prepared` came from the cache; the step costs are then zero (nothing was rebuilt).
  preprocessReused: boolean;
  // What the preprocessing of this update cost: all zeros when the cached scene was reused.
  preprocessingCosts: PreprocessingCosts;
  // Where the stochastic part came from. A request for 'probes' that found no usable probe is 'trace'.
  stochasticSource: StochasticSource;
  // The blend that replaced the GPU trace (only when `stochasticSource` is 'probes').
  probeBlend?: ProbeBlend;
}

// What the pipeline asks of the probe cache (implemented by `ProbeController`).
export interface ProbeSource {
  blend(listener: Vec3, speed: number, prepared: PreparedScene): ProbeBlend | undefined;
  // Called when a request for probes ended in a live trace.
  noteFallback(reason: string): void;
}

// The parts of the application state the pipeline needs.
export interface TracePipelineContext {
  getScene(): Scene;
  getSceneObjects(): SceneObject[];
  getMeshTracer(): MeshTracer | undefined;
  getResult(): AppTraceResult | undefined;
  setResult(result: AppTraceResult): void;
  // Re-renders the audio when playback is running; resolves with its timings, or undefined if not playing.
  refreshAudio(scene: Scene, result: AppTraceResult): Promise<AudioUpdateTimings | undefined>;
  // Used by the fixed-bounce comparison scripts.
  useFixedBounces?(): boolean;
  // Optional specular echoes from the ray paths.
  getSpecularRays?(): SpecularRaySettings;
  // Id of the selected rendering architecture (src/config/render-modes.ts).
  getRenderModeId(): string;
  // Receives the stage timings of every finished update.
  recordStageTimings(timings: StageTimings): void;
  // Without a probe cache, every update traces live.
  probes?: ProbeSource;
  status(message: string): void;
}

export interface EarlyPart {
  arrivals: Arrival[];
  occluded: number;
  diffracted: number;
}

// Probe updates have no GPU timings.
const NO_TRACE_TIMINGS: TraceCallTimings = {
  earlyMs: 0,
  gpuDispatchMs: 0,
  gpuReadbackMs: 0,
  gpuDecodeMs: 0,
  decayFitMs: 0,
};

// Preprocessing costs of an update that reused the cached scene: nothing was rebuilt.
const NO_PREPROCESSING_COSTS: PreprocessingCosts = {
  meshBuildMs: 0,
  bvhBuildMs: 0,
  trianglePackMs: 0,
  statisticsMs: 0,
  gpuUploadMs: 0,
};

export class TracePipeline {
  // Updated only by full-quality traces.
  readonly roomDecay = new RoomDecayCache();

  // Camera and source movement reuse the prepared geometry.
  private readonly preparedScenes = new PreparedSceneCache();

  // Remember recent specular paths so echoes can follow the listener.
  private readonly echoMemory = new EchoPathMemory();

  private context: TracePipelineContext;

  // Probe-only updates do not increase this counter.
  gpuTraceCount = 0;

  constructor(context: TracePipelineContext) {
    this.context = context;
  }

  // The GPU must be ready before tracing.
  isReady(): boolean {
    return this.context.getMeshTracer() !== undefined;
  }

  // Explains why `scene` must not be traced, or returns undefined when it is fine.
  sceneProblem(scene: Scene = this.context.getScene()): string | undefined {
    return describeSceneProblem(scene, this.context.getSceneObjects(), 'mesh');
  }

  // How often the prepared scene was reused (hits) and rebuilt (misses) so far.
  preparedSceneCacheStats(): { hits: number; misses: number } {
    return { hits: this.preparedScenes.hits, misses: this.preparedScenes.misses };
  }

  // Drops the prepared scene and frees its GPU buffers (the GPU device was lost).
  releasePreparedScene(): void {
    this.preparedScenes.clear();
  }

  // Keep the early reflection order consistent with the traced stochastic field.
  // Objects block early paths and can add diffraction around their edges.
  currentEarlyArrivals(earlyOrder?: number): EarlyPart {
    const scene = this.context.getScene();
    const objects = this.context.getSceneObjects();
    const order = earlyOrder ?? this.context.getResult()?.tracedEarlyOrder ?? scene.earlyOrder;
    const sceneAtOrder = order === scene.earlyOrder ? scene : { ...scene, earlyOrder: order };

    const exact = earlyArrivals(sceneAtOrder);
    if (objects.length === 0) {
      return { arrivals: exact, occluded: 0, diffracted: 0 };
    }
    return applyEarlyOcclusion(
      sceneAtOrder,
      exact,
      this.preparedScenes.get(scene, objects).prepared.bvh,
      objects,
    );
  }

  // Monte Carlo echoes stay at the trace pose. Exact echoes follow the live listener.
  currentRayTracedEchoes(result: AppTraceResult | undefined): Arrival[] {
    const report = result?.specularRays;
    if (!result || !report) return [];
    if (report.mode === 'monte-carlo') return result.arrivals.filter((arrival) => arrival.rayTraced);
    return this.rebuildEchoes(this.context.getScene(), this.currentPrepared(), report);
  }

  // Mode B: the exact echoes of the report's paths for `scene`.
  private rebuildEchoes(scene: Scene, prepared: PreparedScene, report: SpecularRaysReport): Arrival[] {
    return exactEchoesAt(scene, prepared.mesh, prepared.bvh, report.paths, report.maxEchoes);
  }

  // Fall back to the trace pose if the listener has moved inside an object.
  private earlyPartAtTracePose(frame: TracedFrame): EarlyPart {
    const { snapshot, prepared } = frame;
    return applyEarlyOcclusion(snapshot, earlyArrivals(snapshot), prepared.bvh, prepared.objects);
  }

  // Runs the GPU trace for one scheduler request.
  async run(request: TraceRequest): Promise<TracedFrame> {
    const requestStartedMs = performance.now();
    const objects = this.context.getSceneObjects();

    // The trace works on a copy, so GUI edits while the GPU is busy cannot change it half way.
    const snapshot = structuredClone(this.context.getScene());
    snapshot.rays = request.budget.rays;
    snapshot.bounces = request.budget.bounces;
    snapshot.earlyOrder = request.budget.earlyOrder;

    // Reuse the BVH and GPU buffers while the geometry stays the same.
    const { prepared, reused } = this.preparedScenes.get(snapshot, objects);

    // Use the baked field if there are usable probes near the listener.
    if (request.source === 'probes' && this.context.probes) {
      const blend = this.context.probes.blend(snapshot.listener, snapshot.speed, prepared);
      if (blend) return this.frameFromProbes(snapshot, blend, requestStartedMs, prepared, reused);
      this.context.probes.noteFallback('no usable probe near the listener');
    }

    // Early reflections are added later, using the latest listener position.
    const rule = this.context.useFixedBounces?.() ? undefined : request.preset.termination;
    this.gpuTraceCount++;
    const trace = await this.context.getMeshTracer()!.trace(snapshot, prepared, {
      includeEarlyPart: false,
      termination: resolveTerminationFor(rule, snapshot, prepared.statistics),
      specularRays: this.context.getSpecularRays?.(),
    });

    // Costs are read after the trace because the GPU upload happens inside the first trace.
    const preprocessingCosts = reused ? { ...NO_PREPROCESSING_COSTS } : { ...prepared.costs };
    return {
      trace,
      snapshot,
      requestStartedMs,
      prepared,
      preprocessReused: reused,
      preprocessingCosts,
      stochasticSource: 'trace',
    };
  }

  // A probe blend goes through the same result and audio update as a live trace.
  private frameFromProbes(
    snapshot: Scene,
    blend: ProbeBlend,
    requestStartedMs: number,
    prepared: PreparedScene,
    reused: boolean,
  ): TracedFrame {
    // The budget of a probe update is the nearest probe's bake, not the preset's (which only set the rate).
    const nearest = blend.selection.choices[0].probe.bake!;
    snapshot.rays = nearest.rays;
    snapshot.bounces = nearest.bounces;
    const trace: TracedFrame['trace'] = {
      arrivals: blend.arrivals,
      analyticalCount: 0,
      paths: [],
      lateDecay: blend.lateDecay,
      elapsedMs: performance.now() - requestStartedMs,
    };
    return {
      trace,
      snapshot,
      requestStartedMs,
      prepared,
      preprocessReused: reused,
      preprocessingCosts: reused ? { ...NO_PREPROCESSING_COSTS } : { ...prepared.costs },
      stochasticSource: 'probes',
      probeBlend: blend,
    };
  }

  // Bake a position without replacing the current response or cached room decay.
  async traceForProbe(position: Vec3, presetId: string): Promise<ProbeTraceOutput> {
    const tracer = this.context.getMeshTracer();
    if (!tracer) throw new Error('The GPU must be ready before baking probes.');
    const preset = getQualityPreset(presetId);
    const scene = this.context.getScene();
    const budget = resolveBudget(preset, {
      rays: scene.rays,
      bounces: scene.bounces,
      earlyOrder: scene.earlyOrder,
    });
    const snapshot = structuredClone(scene);
    Object.assign(snapshot, budget, { listener: [...position] as Vec3 });
    const { prepared } = this.preparedScenes.get(snapshot, this.context.getSceneObjects());
    const trace = await tracer.trace(snapshot, prepared, {
      includeEarlyPart: false,
      termination: resolveTerminationFor(preset.termination, snapshot, prepared.statistics),
    });
    return {
      arrivals: trace.arrivals,
      lateDecay: trace.lateDecay,
      rays: snapshot.rays,
      bounces: snapshot.bounces,
      traceMs: trace.elapsedMs,
      seed: snapshot.seed,
      earlyOrder: snapshot.earlyOrder,
      presetId,
    };
  }

  // The prepared scene of the current geometry (built if needed): its BVH serves the line-of-sight tests.
  currentPrepared(): PreparedScene {
    const objects = this.context.getSceneObjects();
    return this.preparedScenes.get(this.context.getScene(), objects).prepared;
  }

  // Stores a trace that passed the scheduler's stale check as the current result.
  async apply(request: TraceRequest, frame: TracedFrame): Promise<void> {
    const { trace, snapshot } = frame;
    const scene = this.context.getScene();

    // Probes bring their own decay. Live traces update or reuse the room decay cache.
    if (frame.stochasticSource === 'probes') {
      trace.lateDecayOrigin = 'probes';
    } else {
      this.roomDecay.apply(trace, request.preset.fullQuality, request.revision);
    }

    // The listener may have moved during the GPU trace. Rebuild the cheap early
    // reflections at the current pose; the stochastic field keeps its traced position.
    const earlyStarted = performance.now();
    const early: EarlyPart = this.sceneProblem(scene)
      ? this.earlyPartAtTracePose(frame)
      : this.currentEarlyArrivals(snapshot.earlyOrder);
    // Exact specular echoes also follow the current pose.
    const specular = this.specularPartForApply(frame, scene);
    const earlyApplyMs = performance.now() - earlyStarted;

    const stochastic = trace.arrivals.filter((arrival) => arrival.kind === 'stochastic');
    const result: AppTraceResult = {
      ...trace,
      ...(specular.report ? { specularRays: specular.report } : {}),
      arrivals: [...early.arrivals, ...specular.echoes, ...stochastic],
      analyticalCount: early.arrivals.length,
      lateListenerPosition: snapshot.listener,
      tracedRays: snapshot.rays,
      tracedBounces: snapshot.bounces,
      tracer: 'mesh',
      occludedEarly: early.occluded,
      diffractedEarly: early.diffracted,
      qualityPreset: request.preset.id,
      requestId: request.id,
      tracedEarlyOrder: snapshot.earlyOrder,
    };
    if (frame.probeBlend) {
      result.stochasticSource = 'probes';
      result.probesUsed = frame.probeBlend.selection.choices.map(({ probe, weight, distance }) => ({
        id: probe.id,
        label: probe.label,
        weight,
        distance,
      }));
    }
    this.context.setResult(result);

    const audio = await this.context.refreshAudio(scene, result);
    const stageTimings = this.assembleTimings(request, frame, earlyApplyMs, audio);
    result.stageTimings = stageTimings;
    this.context.recordStageTimings(stageTimings);
    let kind = 'Moving update';
    if (frame.stochasticSource === 'probes') {
      kind = 'Probe update';
    } else if (request.preset.fullQuality) {
      kind = 'Full-quality update';
    }
    const sampled = result.arrivals.length - result.analyticalCount - specular.echoes.length;
    const echoNote = specular.report ? ` + ${specular.echoes.length} ray-traced echoes` : '';
    this.context.status(
      `Trace complete. ${sampled} sampled arrivals + ${result.analyticalCount} analytical arrivals${echoNote}. ${kind} [${request.preset.id}]; camera = listener.`,
    );
  }

  // Rebuild exact echoes from recently found paths, or keep Monte Carlo echoes as traced.
  private specularPartForApply(
    frame: TracedFrame,
    scene: Scene,
  ): { echoes: Arrival[]; report: SpecularRaysReport | undefined } {
    const report = frame.trace.specularRays;
    if (!report) return { echoes: [], report: undefined };
    if (report.mode === 'monte-carlo') {
      return { echoes: frame.trace.arrivals.filter((arrival) => arrival.rayTraced), report };
    }
    const memoryUpdates = this.context.getSpecularRays?.().memoryUpdates ?? 0;
    // A remembered path is only meaningful for the same room and the same source position.
    const memoryKey = `${frame.prepared.key}|${frame.snapshot.source.join(',')}`;
    const paths = this.echoMemory.update(report.paths, memoryUpdates, memoryKey);
    // A camera inside an object cannot be traced; the echoes then stay at the pose of the trace.
    const pose = this.sceneProblem(scene) ? frame.snapshot : scene;
    const echoes = this.rebuildEchoes(pose, frame.prepared, { ...report, paths });
    return {
      echoes,
      report: { ...report, paths, echoes: echoes.length, remembered: paths.length - report.paths.length },
    };
  }

  // Audio timings are null when playback is stopped.
  private assembleTimings(
    request: TraceRequest,
    frame: TracedFrame,
    earlyApplyMs: number,
    audio: AudioUpdateTimings | undefined,
  ): StageTimings {
    const call = frame.trace.traceTimings ?? NO_TRACE_TIMINGS;
    const decayFitMs = call.decayFitMs;
    return {
      requestId: request.id,
      presetId: request.preset.id,
      renderMode: this.context.getRenderModeId(),
      audioMeasured: audio !== undefined,
      preprocessing: {
        preprocessReused: frame.preprocessReused,
        ...frame.preprocessingCosts,
        cacheHits: this.preparedScenes.hits,
        cacheMisses: this.preparedScenes.misses,
      },
      gpuDispatchMs: call.gpuDispatchMs,
      gpuReadbackMs: call.gpuReadbackMs,
      gpuDecodeMs: call.gpuDecodeMs,
      gpuReadbackBytes: call.readbackBytes,
      earlyApplyMs,
      acousticUpdateMs: earlyApplyMs,
      decayFitMs,
      ...(call.specularMs !== undefined ? { specularClusterMs: call.specularMs } : {}),
      stochasticSource: frame.stochasticSource,
      probeSelectMs: frame.probeBlend?.timings.selectMs ?? 0,
      probeMixMs: frame.probeBlend
        ? frame.probeBlend.timings.mixMs +
          frame.probeBlend.timings.arrivalsMs +
          frame.probeBlend.timings.decayMs
        : 0,
      irBuildMs: audio?.irBuildMs ?? null,
      workerComputeMs: audio?.workerComputeMs ?? null,
      envelopeSmoothingMs: audio?.envelopeSmoothingMs ?? null,
      stochasticHrtfMs: audio?.stochasticHrtfMs ?? null,
      messagingMs: audio?.messagingMs ?? null,
      hrtfLoadMs: audio?.hrtfLoadMs ?? null,
      nodeSetupMs: audio?.nodeSetupMs ?? null,
      stateBuildMs: decayFitMs + (audio?.irBuildMs ?? 0),
      rendererSwapMs: audio?.rendererSwapMs ?? null,
      totalPipelineMs: performance.now() - frame.requestStartedMs,
    };
  }
}
