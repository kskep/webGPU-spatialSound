// Simulate a BRAS CR2 measurement pose using the reference trace budget.
// The caller compares the result with measured data. Needs WebGPU in the browser;
// both the listening page and validation scripts use this simulation.
import { defaultScene, earlyArrivals, type Scene, type TraceResult, type Vec3 } from '../acoustics/model.ts';
import { sceneFromRoomPreset } from '../acoustics/room-preset.ts';
import { BRAS_CR2_ROOM, braSToApp } from '../config/bras-cr2.ts';
import { getQualityPreset } from '../config/quality-presets.ts';
import type { BinauralToggles } from '../config/binaural.ts';
import type { SpecularRaySettings } from '../config/specular-rays.ts';
import { synthesizeFullIr, type FullIrSignal } from '../audio/full-ir-response.ts';
import { buildHybridResponse, type HybridResponse } from '../audio/hybrid-response.ts';
import type { HrtfBank } from '../audio/hrtf.ts';
import type { MeshTracer } from '../gpu/mesh-tracer.ts';
import { resolveTerminationFor } from '../gpu/scene-termination.ts';
import type { PreparedSceneCache } from '../gpu/prepared-scene.ts';

// Id of the preset in src/config/room-presets.ts.
export const BRAS_CR2_PRESET = 'BRAS_CR2';

// Id of the quality preset used for every trace (src/config/quality-presets.ts).
export const VALIDATION_QUALITY_PRESET = 'reference-static';

// Where the sound is made and heard, in BRAS coordinates (see src/config/bras-cr2.ts).
export interface BrasPose {
  source: Vec3;
  receiver: Vec3;
  // Direction the listener's head faces, BRAS frame. Omit for an omnidirectional receiver.
  headForward?: Vec3;
  // Seed of the ray tracer.
  seed?: number;
}

export function brasScene(pose: BrasPose): Scene {
  const scene = sceneFromRoomPreset(BRAS_CR2_PRESET, defaultScene());
  const quality = getQualityPreset(VALIDATION_QUALITY_PRESET);
  scene.rays = quality.rays === 'scene' ? scene.rays : quality.rays;
  scene.bounces = quality.bounces === 'scene' ? scene.bounces : quality.bounces;
  if (quality.earlyOrder !== 'scene') scene.earlyOrder = quality.earlyOrder;
  scene.source = braSToApp(pose.source);
  scene.listener = braSToApp(pose.receiver);
  if (pose.headForward) scene.listenerForward = braSToApp(pose.headForward, true);
  if (pose.seed !== undefined) scene.seed = pose.seed;
  return scene;
}

export async function traceScene(
  tracer: MeshTracer,
  cache: PreparedSceneCache,
  scene: Scene,
  fixedBounces = false,
  specularRays?: SpecularRaySettings,
): Promise<TraceResult> {
  const prepared = cache.get(scene, []).prepared;
  const rule = fixedBounces ? undefined : getQualityPreset(VALIDATION_QUALITY_PRESET).termination;
  const trace = await tracer.trace(scene, prepared, {
    includeEarlyPart: false,
    termination: resolveTerminationFor(rule, scene, prepared.statistics),
    specularRays,
  });
  const early = earlyArrivals(scene);
  // Ray-traced echoes  exist only when `specularRays` is enabled; the trace is for this pose, so they are used as they are.
  const echoes = trace.arrivals.filter((arrival) => arrival.rayTraced);
  const stochastic = trace.arrivals.filter((arrival) => arrival.kind === 'stochastic');
  return {
    ...trace,
    arrivals: [...early, ...echoes, ...stochastic],
    analyticalCount: early.length,
    lateListenerPosition: scene.listener,
    tracedRays: scene.rays,
    tracedBounces: scene.bounces,
  };
}

// Full impulse response (early part, traced part and synthetic tail; no feedback network).
export function fullImpulseResponse(
  scene: Scene,
  result: TraceResult,
  sampleRate: number,
  hrtf?: HrtfBank,
  binaural?: BinauralToggles,
): FullIrSignal {
  return synthesizeFullIr(scene, result, sampleRate, hrtf, { binaural });
}

// Hybrid response (the application's default architecture); render it with HybridRoomDsp to get audio.
export function hybridResponse(
  scene: Scene,
  result: TraceResult,
  sampleRate: number,
  hrtf?: HrtfBank,
  binaural?: BinauralToggles,
): HybridResponse {
  return buildHybridResponse(scene, result, sampleRate, hrtf, { binaural });
}

// Room volume of the preset's shoebox in cubic metres (for the report).
export function brasRoomVolume(): number {
  const [width, height, depth] = BRAS_CR2_ROOM.dimensions;
  return width * height * depth;
}
