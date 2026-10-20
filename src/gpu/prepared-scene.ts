import type { Scene } from '../acoustics/model.ts';
import {
  buildAcousticMesh,
  meshRoomStatistics,
  type AcousticMesh,
  type MeshRoomStatistics,
  type SceneObject,
} from '../geometry/acoustic-scene.ts';
import { buildBVH, packMesh, type BVH, type PackedMesh } from '../geometry/bvh.ts';
import { geometryKey } from '../geometry/geometry-key.ts';

// Scene preprocessing done once per geometry revision.
// Holds the mesh, BVH, packed arrays, room statistics (CPU side)
// and GPU buffers created on first use. Cached and reused until the geometry key changes.

// milliseconds each preprocessing step took
export interface PreprocessingCosts {
  meshBuildMs: number;
  bvhBuildMs: number;
  trianglePackMs: number;
  statisticsMs: number;
  gpuUploadMs: number;
}

// the three read-only storage buffers (bindings 2-4 of mesh-trace.wgsl)
export interface SceneGpuBuffers {
  device: GPUDevice;
  nodes: GPUBuffer;
  triangles: GPUBuffer;
  materials: GPUBuffer;
}

export class PreparedScene {
  readonly key: string;
  readonly objects: SceneObject[];
  readonly mesh: AcousticMesh;
  readonly bvh: BVH;
  readonly packed: PackedMesh;
  readonly statistics: MeshRoomStatistics;
  readonly costs: PreprocessingCosts;

  private gpu: SceneGpuBuffers | undefined;
  // active traces keep buffers alive
  private activeTraces = 0;
  private retired = false;

  private constructor(
    key: string,
    objects: SceneObject[],
    mesh: AcousticMesh,
    bvh: BVH,
    packed: PackedMesh,
    statistics: MeshRoomStatistics,
    costs: PreprocessingCosts,
  ) {
    this.key = key;
    this.objects = objects;
    this.mesh = mesh;
    this.bvh = bvh;
    this.packed = packed;
    this.statistics = statistics;
    this.costs = costs;
  }

  // runs all CPU preprocessing steps and times each one
  static build(scene: Scene, objects: SceneObject[]): PreparedScene {
    const key = geometryKey(scene, objects);
    const ownObjects = structuredClone(objects);
    const costs: PreprocessingCosts = {
      meshBuildMs: 0,
      bvhBuildMs: 0,
      trianglePackMs: 0,
      statisticsMs: 0,
      gpuUploadMs: 0,
    };

    let stageStarted = performance.now();
    const mesh = buildAcousticMesh(scene, ownObjects);
    costs.meshBuildMs = performance.now() - stageStarted;

    stageStarted = performance.now();
    const bvh = buildBVH(mesh.triangles);
    costs.bvhBuildMs = performance.now() - stageStarted;

    stageStarted = performance.now();
    const packed = packMesh(mesh, bvh);
    costs.trianglePackMs = performance.now() - stageStarted;

    stageStarted = performance.now();
    const statistics = meshRoomStatistics(mesh, scene);
    costs.statisticsMs = performance.now() - stageStarted;

    return new PreparedScene(key, ownObjects, mesh, bvh, packed, statistics, costs);
  }

  // GPU buffers: first call uploads, later calls return the same buffers
  gpuBuffers(device: GPUDevice): SceneGpuBuffers {
    if (this.retired) throw new Error('This prepared scene was replaced; prepare the scene again.');
    if (this.gpu && this.gpu.device !== device) this.destroyGpuBuffers();
    if (!this.gpu) {
      const started = performance.now();
      this.gpu = {
        device,
        nodes: uploadStorage(device, this.packed.nodes),
        triangles: uploadStorage(device, this.packed.triangles),
        materials: uploadStorage(device, this.packed.materials.buffer as ArrayBuffer),
      };
      this.costs.gpuUploadMs = performance.now() - started;
    }
    return this.gpu;
  }

  // marks the start of a trace using these buffers
  beginUse(): void {
    this.activeTraces++;
  }

  // trace finished; destroys buffers if scene was replaced
  endUse(): void {
    this.activeTraces--;
    if (this.retired && this.activeTraces === 0) this.destroyGpuBuffers();
  }

  // releases GPU memory (immediately or when active traces finish)
  retire(): void {
    this.retired = true;
    if (this.activeTraces === 0) this.destroyGpuBuffers();
  }

  // true while GPU buffers exist (for leak-checking tests)
  get hasGpuBuffers(): boolean {
    return this.gpu !== undefined;
  }

  private destroyGpuBuffers(): void {
    if (!this.gpu) return;
    this.gpu.nodes.destroy();
    this.gpu.triangles.destroy();
    this.gpu.materials.destroy();
    this.gpu = undefined;
  }
}

// creates a read-only storage buffer with a copy of data
function uploadStorage(device: GPUDevice, data: ArrayBuffer): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

export interface PreparedSceneLookup {
  prepared: PreparedScene;
  reused: boolean;
}

// caches the most recent prepared scene; rebuilds on geometry key change
export class PreparedSceneCache {
  private current: PreparedScene | undefined;
  private hitCount = 0;
  private missCount = 0;

  get(scene: Scene, objects: SceneObject[]): PreparedSceneLookup {
    const key = geometryKey(scene, objects);
    if (this.current && this.current.key === key) {
      this.hitCount++;
      return { prepared: this.current, reused: true };
    }
    const prepared = PreparedScene.build(scene, objects);
    this.current?.retire();
    this.current = prepared;
    this.missCount++;
    return { prepared, reused: false };
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  // drops the cached scene and frees GPU buffers
  clear(): void {
    this.current?.retire();
    this.current = undefined;
  }
}
