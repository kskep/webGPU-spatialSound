// Update timings in milliseconds, measured with performance.now().
// GPU dispatch/readback/decode, early reflections, IR building and renderer swap
// are recorded separately. Preprocessing is only charged when geometry changes.

export interface PreprocessingTimings {
  // True when this update reused the cached prepared scene (no preprocessing was done for it).
  preprocessReused: boolean;
  // Room shell and object boxes to a triangle list (`buildAcousticMesh`).
  meshBuildMs: number;
  // Median-split BVH over the triangles (`buildBVH`). It is also the BVH of the CPU occlusion tests.
  bvhBuildMs: number;
  // BVH and triangles to the GPU memory layout (`packMesh`).
  trianglePackMs: number;
  // Room volume, exposed surface and absorption area (`meshRoomStatistics`).
  statisticsMs: number;
  // `createBuffer` and `writeBuffer` calls for the node, triangle and material buffers (CPU side).
  gpuUploadMs: number;
  cacheHits: number;
  // Lookups that had to build the scene so far in this session: the first trace and each geometry or material edit.
  cacheMisses: number;
}

// What `MeshTracer.trace` measures inside one call.
export interface TraceCallTimings {
  // Image sources with occlusion and diffraction inside the trace call (0 when the caller asks for none).
  earlyMs: number;
  gpuDispatchMs: number;
  gpuReadbackMs: number;
  gpuDecodeMs: number;
  decayFitMs: number;
  // Bytes copied from the GPU to the CPU by this call (detailed records plus the late buffer and path tags).
  readbackBytes?: number;
  // grouping the tagged hits and building the echoes (also part of gpuDecodeMs). Absent when off.
  specularMs?: number;
}

// Timings of the audio side of one update, measured by `AudioPreview.play`.
export interface AudioUpdateTimings {
  // Worker round trip: postMessage there until the reply is received on the main thread.
  irBuildMs: number;
  // Time the worker spent computing, measured inside the worker.
  workerComputeMs: number;
  // Part of the worker time spent smoothing the stochastic hits into envelopes.
  envelopeSmoothingMs: number;
  // Part of the worker time spent on the binaural stochastic part: noise, HRIRs, convolution (0 when panned).
  stochasticHrtfMs: number;
  // Both message hops: the round trip minus the worker's own work.
  messagingMs: number;
  // One-off cost of loading the HRTF file in the worker (0 once loaded).
  hrtfLoadMs: number;
  // Creating the AudioWorkletNode (0 once it exists). Not part of the renderer swap.
  nodeSetupMs: number;
  // Post to the worklet until its ack.
  rendererSwapMs: number;
}

// All stages of one update. Audio fields are null when the sound was not playing.
export interface StageTimings {
  requestId: number;
  presetId: string;
  renderMode: string;
  // True when the audio stages were measured (the sound was playing).
  audioMeasured: boolean;
  preprocessing: PreprocessingTimings;
  gpuDispatchMs: number;
  gpuReadbackMs: number;
  gpuDecodeMs: number;
  // Bytes copied from the GPU to the CPU by the trace of this update (detailed records plus late buffer).
  gpuReadbackBytes?: number;
  // grouping the tagged specular hits into echoes (part of gpuDecodeMs). Absent when the feature is off.
  specularClusterMs?: number;
  // Image sources with occlusion and diffraction, computed when the result is applied.
  earlyApplyMs: number;
  acousticUpdateMs: number;
  decayFitMs: number;
  stochasticSource?: 'trace' | 'probes';
  // choosing the probes (distances, line-of-sight tests, weights). 0 for a live trace.
  probeSelectMs?: number;
  // mixing the stored fields, turning them into arrivals and blending the decay fits. 0 for a live trace.
  probeMixMs?: number;
  irBuildMs: number | null;
  workerComputeMs: number | null;
  envelopeSmoothingMs: number | null;
  stochasticHrtfMs: number | null;
  messagingMs: number | null;
  hrtfLoadMs: number | null;
  nodeSetupMs: number | null;
  stateBuildMs: number;
  rendererSwapMs: number | null;
  totalPipelineMs: number;
}

// Names of the numeric stages that the summary and the Chapter 5 table report.
export const SUMMARISED_STAGES = [
  'gpuDispatchMs',
  'gpuReadbackMs',
  'acousticUpdateMs',
  'stateBuildMs',
  'rendererSwapMs',
  'totalPipelineMs',
] as const;

export type SummarisedStage = (typeof SUMMARISED_STAGES)[number];

// Mean, minimum, maximum and number of the measured values of one stage.
export interface StageStatistics {
  count: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

// Statistics of one stage over many updates; null values (stage not measured) are skipped.
export function statisticsOf(values: (number | null)[]): StageStatistics | null {
  const measured = values.filter((value): value is number => value !== null);
  if (measured.length === 0) return null;
  const sum = measured.reduce((total, value) => total + value, 0);
  return {
    count: measured.length,
    meanMs: sum / measured.length,
    minMs: Math.min(...measured),
    maxMs: Math.max(...measured),
  };
}

// Statistics of every summarised stage over `entries`.
export function summariseStages(entries: StageTimings[]): Record<SummarisedStage, StageStatistics | null> {
  const summary = {} as Record<SummarisedStage, StageStatistics | null>;
  for (const stage of SUMMARISED_STAGES) summary[stage] = statisticsOf(entries.map((entry) => entry[stage]));
  return summary;
}

// The newest updates, kept for the debug panel and the export.
export class StageTimingLog {
  private readonly capacity: number;
  private readonly kept: StageTimings[] = [];

  constructor(capacity = 64) {
    this.capacity = capacity;
  }

  record(entry: StageTimings): void {
    this.kept.push(entry);
    if (this.kept.length > this.capacity) this.kept.shift();
  }

  clear(): void {
    this.kept.length = 0;
  }

  // Oldest first.
  entries(): readonly StageTimings[] {
    return this.kept;
  }

  latest(): StageTimings | undefined {
    return this.kept.at(-1);
  }

  // The log as written to the export: the entries and their statistics.
  toReport() {
    return { entries: [...this.kept], summary: summariseStages(this.kept) };
  }
}
