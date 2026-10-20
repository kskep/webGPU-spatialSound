// Group specular hits by their ordered reflection surfaces, then make one echo
// per path. Echoes use either Monte Carlo estimates or exact image sources.
// Selected hits leave the stochastic pool; conserveEnergy returns any residual.
// See config/specular-rays.ts for the settings.
import { BAND_CENTERS, directionPan, type Arrival, type Bands, type Scene, type Vec3 } from './model.ts';
import { sourceDirectivityWeights } from './directivity.ts';
import { segmentOccluded, type BVH } from '../geometry/bvh.ts';
import type { AcousticMesh, SurfaceFace } from '../geometry/acoustic-scene.ts';
import type { SpecularAmplitudeMode, SpecularRaySettings } from '../config/specular-rays.ts';

export type SpecularGeometry = Pick<AcousticMesh, 'faces' | 'materials'>;

// Allow for rounding at face edges (metres).
const FACE_TOLERANCE = 1e-6;
// Stop occlusion tests just short of reflecting faces (metres).
const END_MARGIN = 1e-4;

export interface PathGroup {
  // Surface ids in the order the path reflects from them, starting at the source.
  surfaces: number[];
  // The stochastic arrivals (receiver hits) of the rays that found the path.
  hits: Arrival[];
}

// Compare surface lists as well as hashes so collisions cannot merge paths.
export class SpecularPathCollector {
  private readonly byKey = new Map<number, PathGroup>();
  // Hits whose surface list differed from the one of their hash: they stay diffuse.
  hashCollisions = 0;

  // Only the first `reflections` surface ids belong to this hit.
  add(reflections: number, hash: number, surfaces: ArrayLike<number>, hit: Arrival): void {
    // 32-bit hash * 2048 + bounce count fits exactly in a double.
    const key = hash * 2048 + reflections;
    let group = this.byKey.get(key);
    if (!group) {
      group = { surfaces: Array.from({ length: reflections }, (_, k) => surfaces[k]), hits: [] };
      this.byKey.set(key, group);
    } else if (group.surfaces.some((id, k) => id !== surfaces[k])) {
      this.hashCollisions++;
      return;
    }
    group.hits.push(hit);
  }

  groups(): PathGroup[] {
    return [...this.byKey.values()];
  }
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function mirror(point: Vec3, face: SurfaceFace): Vec3 {
  const image: Vec3 = [...point];
  image[face.axis] = 2 * face.coordinate - point[face.axis];
  return image;
}

// Mode A: the group's own ray energy

// Sum hit energy; use energy-weighted time and direction for the echo.
export function monteCarloEcho(scene: Scene, group: PathGroup): Arrival {
  const bands = Array<number>(BAND_CENTERS.length).fill(0);
  let weightSum = 0;
  let timeSum = 0;
  const directionSum: Vec3 = [0, 0, 0];
  for (const hit of group.hits) {
    for (let band = 0; band < bands.length; band++) {
      bands[band] += hit.energyBands[band];
    }
    const weight = hit.energy;
    weightSum += weight;
    // EDW ZYGIZOUME XRONO KAI KATEFTHYNSI ME TIN ENERGEIA GIA NA VGALEI ENA ECHO APO POLLA HITS.
    timeSum += weight * hit.time;
    for (let axis = 0; axis < 3; axis++) {
      directionSum[axis] += weight * hit.direction[axis];
    }
  }
  const time = timeSum / weightSum;
  const length = norm(directionSum) || 1;
  const direction: Vec3 = [directionSum[0] / length, directionSum[1] / length, directionSum[2] / length];
  const distance = time * scene.speed;
  return {
    time,
    distance,
    energy: bands.reduce((sum, value) => sum + value, 0) / bands.length,
    energyBands: bands as Bands,
    order: group.surfaces.length,
    direction,
    imagePosition: scene.listener.map((v, axis) => v + direction[axis] * distance) as Vec3,
    pan: directionPan(direction, scene.listenerForward),
    kind: 'specular',
    rayTraced: true,
    hitCount: group.hits.length,
  };
}

// Mode B: the exact image source

// Return the crossing only if it lies between the endpoints and inside the face.
function crossFace(from: Vec3, target: Vec3, face: SurfaceFace): Vec3 | undefined {
  const span = target[face.axis] - from[face.axis];
  if (Math.abs(span) < 1e-12) {
    return undefined;
  }
  const t = (face.coordinate - from[face.axis]) / span;
  if (!(t > 1e-9 && t < 1 - 1e-9)) {
    return undefined;
  }
  const point: Vec3 = [
    from[0] + t * (target[0] - from[0]),
    from[1] + t * (target[1] - from[1]),
    from[2] + t * (target[2] - from[2]),
  ];
  point[face.axis] = face.coordinate;
  for (let axis = 0; axis < 3; axis++) {
    if (axis === face.axis) {
      continue;
    }
    if (point[axis] < face.min[axis] - FACE_TOLERANCE || point[axis] > face.max[axis] + FACE_TOLERANCE) {
      return undefined;
    }
  }
  return point;
}

// True when an object blocks the leg between two points on faces (the end points are not tested).
function legBlocked(bvh: BVH, from: Vec3, to: Vec3): boolean {
  const delta = subtract(to, from);
  const length = norm(delta);
  if (length < 3 * END_MARGIN) {
    return false;
  }
  const unit: Vec3 = [delta[0] / length, delta[1] / length, delta[2] / length];
  const start: Vec3 = from.map((v, axis) => v + unit[axis] * END_MARGIN) as Vec3;
  const end: Vec3 = to.map((v, axis) => v - unit[axis] * END_MARGIN) as Vec3;
  return segmentOccluded(bvh, start, end);
}

// Rebuild the image-source path, rejecting blocked legs or missed faces.
// Band energy = directivity * product((1-absorption)(1-scattering)) * air / (4*pi*d^2).
export function exactEcho(
  scene: Scene,
  geometry: SpecularGeometry,
  bvh: BVH,
  surfaces: readonly number[],
): Arrival | undefined {
  const faces = surfaces.map((id) => geometry.faces[id]);
  if (faces.length === 0 || faces.some((face) => face === undefined)) {
    return undefined;
  }

  // images[k] = the source mirrored across the first k surfaces.
  // EDW KATHREFTIZOUME DIADOXIKA TIN PIGI GIA NA ANAKATASKEVASOUME AKRIVWS TI SPECULAR DIADROMI.
  const images: Vec3[] = [scene.source];
  for (const face of faces) {
    images.push(mirror(images[images.length - 1], face));
  }
  const image = images[images.length - 1];

  // Trace reflection points backwards from the listener.
  const points: Vec3[] = [scene.listener];
  for (let k = faces.length; k >= 1; k--) {
    const point = crossFace(points[points.length - 1], images[k], faces[k - 1]);
    if (!point) {
      return undefined;
    }
    points.push(point);
  }
  points.push(scene.source);
  for (let leg = 0; leg + 1 < points.length; leg++) {
    if (legBlocked(bvh, points[leg], points[leg + 1])) {
      return undefined;
    }
  }

  const toImage = subtract(image, scene.listener);
  const length = norm(toImage);
  const direction: Vec3 = [toImage[0] / length, toImage[1] / length, toImage[2] / length];
  // The source radiates towards the first reflection point (the second to last point of the walk).
  const directivity = sourceDirectivityWeights(scene, subtract(points[points.length - 2], scene.source));
  const bands = BAND_CENTERS.map((_, band) => {
    let survival = directivity[band];
    for (const face of faces) {
      const material = geometry.materials[face.material];
      survival *= (1 - material.absorption[band]) * (1 - material.scattering[band]);
    }
    return (
      (survival * Math.pow(10, (-scene.airDbPerMeter[band] * length) / 10)) / (4 * Math.PI * length * length)
    );
  }) as Bands;
  return {
    time: length / scene.speed,
    distance: length,
    energy: bands.reduce((sum, value) => sum + value, 0) / bands.length,
    energyBands: bands,
    order: faces.length,
    direction,
    imagePosition: image,
    pan: directionPan(direction, scene.listenerForward),
    kind: 'specular',
    rayTraced: true,
  };
}

// Skip invalid paths and keep the strongest maxEchoes.
export function exactEchoesAt(
  scene: Scene,
  geometry: SpecularGeometry,
  bvh: BVH,
  paths: readonly (readonly number[])[],
  maxEchoes: number,
): Arrival[] {
  const echoes: Arrival[] = [];
  for (const surfaces of paths) {
    const echo = exactEcho(scene, geometry, bvh, surfaces);
    if (echo) {
      echoes.push(echo);
    }
  }
  return echoes.sort((first, second) => second.energy - first.energy).slice(0, maxEchoes);
}

export interface SpecularRaysReport {
  mode: SpecularAmplitudeMode;
  // The cap on the number of echoes the report was made with (mode B rebuilds the echoes for later poses).
  maxEchoes: number;
  // Distinct specular paths with at least one tagged hit and at most `maxOrder` reflections.
  pathsFound: number;
  // Paths with fewer than `minHits` hits (they stay diffuse).
  belowMinHits: number;
  // Paths dropped because the exact construction found no valid path (mode B).
  rejected: number;
  // Paths that qualified but were beyond the `maxEchoes` strongest (they stay diffuse).
  cappedOut: number;
  // Hits whose surface list did not match their hash (they stay diffuse).
  hashCollisions: number;
  echoes: number;
  // Receiver hits removed from the stochastic pool and replaced by the echoes.
  hitsUsed: number;
  // Summed energy (mean of the bands) of the removed hits, before any residual is returned.
  energyMoved: number;
  // Summed energy (mean of the bands) of the echoes. Equal to `energyMoved` in mode A.
  echoEnergy: number;
  // Mode B with `conserveEnergy`: energy (mean of the bands) the removed hits keep in the diffuse pool.
  residualEnergy: number;
  // Number of reflections of the strongest echo; undefined without echoes.
  strongestOrder?: number;
  // Surface lists of the echoes: mode B rebuilds them for later poses from these.
  paths: number[][];
  // Echoes in `paths` that came from the memory of earlier updates (set by the pipeline).
  remembered?: number;
  // Grouping and selection time, ms.
  clusterMs: number;
}

export interface SpecularExtraction {
  echoes: Arrival[];
  // The hits that became echoes; remove them from the stochastic arrivals.
  removed: Set<Arrival>;
  // Scaled copies of removed hits that stay in the stochastic pool (mode B with `conserveEnergy`).
  residual: Arrival[];
  report: SpecularRaysReport;
}

// Return scaled copies of the energy left after replacing hits with an exact echo.
// Each band keeps max(0, 1 - echoEnergy/hitEnergy).
function residualHits(group: PathGroup, echo: Arrival): { hits: Arrival[]; energy: number } {
  const total = Array<number>(echo.energyBands.length).fill(0);
  for (const hit of group.hits) {
    for (let band = 0; band < total.length; band++) {
      total[band] += hit.energyBands[band];
    }
  }
  // EDW KRATAME STI DIAXYTI DEKSAMENI TIN ENERGEIA POU DEN METAFERTHIKE STO EXACT ECHO.
  const keep = total.map((hits, band) => (hits > 0 ? Math.max(0, 1 - echo.energyBands[band] / hits) : 0));
  if (keep.every((fraction) => fraction === 0)) {
    return { hits: [], energy: 0 };
  }
  let energy = 0;
  const hits: Arrival[] = [];
  for (const hit of group.hits) {
    const bands = hit.energyBands.map((value, band) => value * keep[band]) as Bands;
    const scaled = bands.reduce((sum, value) => sum + value, 0) / bands.length;
    energy += scaled;
    hits.push({ ...hit, energyBands: bands, energy: scaled });
  }
  return { hits, energy };
}

// Keep the strongest qualifying paths and mark their hits for removal.
export function extractSpecularEchoes(
  scene: Scene,
  geometry: SpecularGeometry,
  bvh: BVH,
  settings: SpecularRaySettings,
  collector: SpecularPathCollector,
): SpecularExtraction {
  const started = performance.now();
  const groups = collector.groups().filter((group) => group.surfaces.length <= settings.maxOrder);
  const candidates: Array<{ group: PathGroup; echo: Arrival }> = [];
  let belowMinHits = 0;
  let rejected = 0;
  for (const group of groups) {
    if (group.hits.length < settings.minHits) {
      belowMinHits++;
      continue;
    }
    const echo =
      settings.mode === 'monte-carlo'
        ? monteCarloEcho(scene, group)
        : exactEcho(scene, geometry, bvh, group.surfaces);
    if (echo) {
      candidates.push({ group, echo });
    }
    else {
      rejected++;
    }
  }
  candidates.sort((first, second) => second.echo.energy - first.echo.energy);
  const kept = candidates.slice(0, settings.maxEchoes);

  const removed = new Set<Arrival>();
  const residual: Arrival[] = [];
  let energyMoved = 0;
  let residualEnergy = 0;
  for (const { group, echo } of kept) {
    for (const hit of group.hits) {
      removed.add(hit);
      energyMoved += hit.energy;
    }
    if (settings.mode === 'image-source' && settings.conserveEnergy) {
      const rest = residualHits(group, echo);
      residual.push(...rest.hits);
      residualEnergy += rest.energy;
    }
  }
  const echoes = kept.map(({ echo }) => echo);
  return {
    echoes,
    removed,
    residual,
    report: {
      mode: settings.mode,
      maxEchoes: settings.maxEchoes,
      pathsFound: groups.length,
      belowMinHits,
      rejected,
      cappedOut: candidates.length - kept.length,
      hashCollisions: collector.hashCollisions,
      echoes: echoes.length,
      hitsUsed: removed.size,
      energyMoved,
      echoEnergy: echoes.reduce((sum, echo) => sum + echo.energy, 0),
      residualEnergy,
      ...(echoes.length > 0 ? { strongestOrder: echoes[0].order } : {}),
      paths: kept.map(({ group }) => group.surfaces),
      clusterMs: performance.now() - started,
    },
  };
}

// Memory of found paths (mode B)

// Remember paths briefly to avoid flickering when a trace misses a weak echo.
// Each remembered path is checked again for the current listener pose.
export class EchoPathMemory {
  private readonly entries = new Map<string, { surfaces: number[]; age: number }>();
  // The room and source the remembered paths belong to; another one clears the memory.
  private scene = '';

  // Refresh found paths and expire those older than memoryUpdates.
  update(found: readonly number[][], memoryUpdates: number, key: string): number[][] {
    if (key !== this.scene) {
      this.entries.clear();
      this.scene = key;
    }
    for (const entry of this.entries.values()) {
      entry.age++;
    }
    for (const surfaces of found) {
      this.entries.set(surfaces.join(','), { surfaces, age: 0 });
    }
    for (const [path, entry] of this.entries) {
      if (entry.age > memoryUpdates) {
        this.entries.delete(path);
      }
    }
    return [...this.entries.values()].map((entry) => entry.surfaces);
  }

  clear(): void {
    this.entries.clear();
  }
}
