import type { TraceResult } from '../acoustics/model';
import type { BVH } from '../geometry/bvh';
import type { StageTimings } from '../app/stage-timings';
import type { StochasticSource } from '../config/probes';

// which tracer produced a result
export type TracerChoice = 'mesh' | 'shoebox';

// a TraceResult plus app-level metadata about how it was produced
export type AppTraceResult = TraceResult & {
  tracer: TracerChoice;
  bvh?: BVH['stats'];
  occludedEarly: number;
  diffractedEarly: number;
  qualityPreset: string;
  requestId: number;
  tracedEarlyOrder: number;
  stageTimings?: StageTimings;
  // where the stochastic part came from: GPU trace or baked probes
  stochasticSource?: StochasticSource;
  // probes the stochastic part was blended from (nearest first)
  probesUsed?: { id: string; label: string; weight: number; distance: number }[];
};
