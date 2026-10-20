// Resolves a quality preset's ray termination rule into numbers for one trace.
// Separate from the tracer so Node code can use it without loading WebGPU.
import type { Scene } from '../acoustics/model.ts';
import {
  resolveTermination,
  type RayTermination,
  type ResolvedTermination,
} from '../config/ray-termination.ts';
import { eyringBandsFromMesh, type MeshRoomStatistics } from '../geometry/acoustic-scene.ts';

// Resolves termination rule for a scene. 'auto' follows mesh-Eyring RT60. Undefined for legacy fixed-bounce.
export function resolveTerminationFor(
  rule: RayTermination | undefined,
  scene: Scene,
  statistics: MeshRoomStatistics,
): ResolvedTermination | undefined {
  return resolveTermination(rule, scene.bounces, eyringBandsFromMesh(statistics, scene.airDbPerMeter));
}
