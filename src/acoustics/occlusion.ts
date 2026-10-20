import { BAND_CENTERS, directionPan, distance, type Arrival, type Bands, type Scene, type Vec3 } from './model.ts';
import { segmentOccluded, type BVH } from '../geometry/bvh.ts';
import { objectBounds, type SceneObject } from '../geometry/acoustic-scene.ts';
import { sourceDirectivityWeights } from './directivity.ts';

// Occlusion and diffraction for early reflections
// Tests ISM paths against objects, applies Maekawa single-edge diffraction
// for blocked direct sound. Blocked reflections are just dropped.

export type DiffractedArrival = Arrival;

export interface OcclusionResult {
  arrivals: DiffractedArrival[];
  occluded: number;
  diffracted: number;
}

interface Box {
  min: Vec3;
  max: Vec3;
}

const MAX_DIFFRACTION_PATHS = 4;
const DEDUPLICATE_DISTANCE = 0.01;
const EDGE_NUDGE = 0.001;
const BOX_SHRINK = 1e-6;

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

// fold coordinate back into room bounds
function foldIntoRoom(coordinate: number, origin: number, size: number): number {
  const period = 2 * size;
  let offset = (coordinate - origin) % period;
  if (offset < 0) {
    offset += period;
  }
  if (offset > size) {
    offset = period - offset;
  }
  return origin + offset;
}

// unfold image-source path back into room coordinates
export function specularPathPoints(scene: Scene, imagePosition: Vec3): Vec3[] {
  const listener = scene.listener;
  const roomOrigin: Vec3 = [-scene.dimensions[0] / 2, 0, -scene.dimensions[2] / 2];
  const direction = subtract(imagePosition, listener);

  // find where the line crosses room boundaries
  const crossings: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-12) {
      continue;
    }
    const size = scene.dimensions[axis];
    const from = Math.min(listener[axis], imagePosition[axis]);
    const to = Math.max(listener[axis], imagePosition[axis]);
    const firstPlane = Math.ceil((from - roomOrigin[axis]) / size);
    const lastPlane = Math.floor((to - roomOrigin[axis]) / size);
    for (let plane = firstPlane; plane <= lastPlane; plane++) {
      const t = (roomOrigin[axis] + plane * size - listener[axis]) / direction[axis];
      if (t > 1e-12 && t < 1 - 1e-12) {
        crossings.push(t);
      }
    }
  }
  crossings.sort((p, q) => p - q);

  const foldPoint = (t: number): Vec3 => {
    const point: Vec3 = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      point[axis] = foldIntoRoom(
        listener[axis] + t * direction[axis],
        roomOrigin[axis],
        scene.dimensions[axis],
      );
    }
    return point;
  };

  return [[...listener] as Vec3, ...crossings.map(foldPoint), foldPoint(1)];
}

function boxEdges(box: Box): Array<[Vec3, Vec3]> {
  const edges: Array<[Vec3, Vec3]> = [];
  for (let axis = 0; axis < 3; axis++) {
    const otherA = (axis + 1) % 3;
    const otherB = (axis + 2) % 3;
    for (const sideA of [box.min[otherA], box.max[otherA]]) {
      for (const sideB of [box.min[otherB], box.max[otherB]]) {
        const start: Vec3 = [0, 0, 0];
        const end: Vec3 = [0, 0, 0];
        start[axis] = box.min[axis];
        end[axis] = box.max[axis];
        start[otherA] = end[otherA] = sideA;
        start[otherB] = end[otherB] = sideB;
        edges.push([start, end]);
      }
    }
  }
  return edges;
}

// segment vs AABB test (slab method)
function segmentHitsBox(from: Vec3, to: Vec3, box: Box): boolean {
  let near = 0;
  let far = 1;
  for (let axis = 0; axis < 3; axis++) {
    const low = box.min[axis] + BOX_SHRINK;
    const high = box.max[axis] - BOX_SHRINK;
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-12) {
      if (from[axis] <= low || from[axis] >= high) {
        return false;
      }
      continue;
    }
    let t0 = (low - from[axis]) / delta;
    let t1 = (high - from[axis]) / delta;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
    }
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near >= far) {
      return false;
    }
  }
  return true;
}

// find point on edge that minimizes source-point-listener path (ternary search)
function shortestPathPointOnEdge(start: Vec3, end: Vec3, source: Vec3, listener: Vec3): Vec3 {
  const pointAt = (t: number): Vec3 => [
    start[0] + t * (end[0] - start[0]),
    start[1] + t * (end[1] - start[1]),
    start[2] + t * (end[2] - start[2]),
  ];
  const pathLength = (t: number): number => {
    const point = pointAt(t);
    return distance(source, point) + distance(point, listener);
  };

  let low = 0;
  let high = 1;
  // EDW PSAXNOUME PANW STIN AKMI TO SHMEIO ME TIN MIKROTERI DIADROMI PIGI-AKMI-LISTENER.
  for (let iteration = 0; iteration < 60; iteration++) {
    const first = low + (high - low) / 3;
    const second = high - (high - low) / 3;
    if (pathLength(first) < pathLength(second)) {
      high = second;
    }
    else {
      low = first;
    }
  }
  return pointAt((low + high) / 2);
}

function boxCenter(box: Box): Vec3 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

function insideRoom(scene: Scene, point: Vec3): boolean {
  const [width, height, depth] = scene.dimensions;
  return (
    Math.abs(point[0]) <= width / 2 && point[1] >= 0 && point[1] <= height && Math.abs(point[2]) <= depth / 2
  );
}

function findDiffractionPoints(scene: Scene, boxes: Box[]): Vec3[] {
  const candidates: Array<{ point: Vec3; pathLength: number }> = [];

  for (let boxIndex = 0; boxIndex < boxes.length; boxIndex++) {
    const box = boxes[boxIndex];
    const otherBoxes = boxes.filter((_, index) => index !== boxIndex);
    const isBlocked = (from: Vec3, to: Vec3): boolean =>
      otherBoxes.some((other) => segmentHitsBox(from, to, other));
    const center = boxCenter(box);

    for (const [start, end] of boxEdges(box)) {
      const onEdge = shortestPathPointOnEdge(start, end, scene.source, scene.listener);

      // push point outside the box
      const outward = subtract(onEdge, center);
      const outwardLength = length(outward) || 1;
      const point: Vec3 = [
        onEdge[0] + (EDGE_NUDGE * outward[0]) / outwardLength,
        onEdge[1] + (EDGE_NUDGE * outward[1]) / outwardLength,
        onEdge[2] + (EDGE_NUDGE * outward[2]) / outwardLength,
      ];

      if (!insideRoom(scene, point)) {
        continue;
      }
      if (isBlocked(scene.source, point) || isBlocked(point, scene.listener)) {
        continue;
      }

      candidates.push({
        point,
        pathLength: distance(scene.source, point) + distance(point, scene.listener),
      });
    }
  }

  candidates.sort((p, q) => p.pathLength - q.pathLength);

  const kept: Vec3[] = [];
  for (const candidate of candidates) {
    if (kept.length >= MAX_DIFFRACTION_PATHS) {
      break;
    }
    const isDuplicate = kept.some((other) => distance(other, candidate.point) < DEDUPLICATE_DISTANCE);
    if (!isDuplicate) {
      kept.push(candidate.point);
    }
  }
  return kept;
}

function diffractedArrival(scene: Scene, edgePoint: Vec3): DiffractedArrival {
  const straight = distance(scene.source, scene.listener);
  const pathLength = distance(scene.source, edgePoint) + distance(edgePoint, scene.listener);
  const detour = pathLength - straight;

  // The sound leaves the real source towards the edge point, so that is the emission direction.
  const directivity = sourceDirectivityWeights(scene, subtract(edgePoint, scene.source));

  const energyBands = BAND_CENTERS.map((frequency, band) => {
    const wavelength = scene.speed / frequency;
    // EDW APO TIN EPIPLEON DIADROMI KAI TO MIKOS KYMATOS EKTIMOUME TIN APWLEIA DIFFRACTION ME MAEKAWA.
    const fresnelNumber = (2 * detour) / wavelength;
    const insertionLossDb = 10 * Math.log10(3 + 20 * fresnelNumber);
    const airFactor = Math.pow(10, (-scene.airDbPerMeter[band] * pathLength) / 10);
    const screenFactor = Math.pow(10, -insertionLossDb / 10);
    return (directivity[band] * screenFactor * airFactor) / (4 * Math.PI * pathLength * pathLength);
  }) as Bands;

  const toEdge = subtract(edgePoint, scene.listener);
  const toEdgeLength = length(toEdge);
  const direction: Vec3 = [toEdge[0] / toEdgeLength, toEdge[1] / toEdgeLength, toEdge[2] / toEdgeLength];

  return {
    time: pathLength / scene.speed,
    distance: pathLength,
    order: 0,
    kind: 'direct',
    direction,
    pan: directionPan(direction, scene.listenerForward),
    imagePosition: undefined,
    energyBands,
    energy: energyBands.reduce((sum, value) => sum + value, 0) / energyBands.length,
    diffracted: true,
  };
}

export function applyEarlyOcclusion(
  scene: Scene,
  arrivals: Arrival[],
  bvh: BVH,
  objects: SceneObject[],
): OcclusionResult {
  const result: DiffractedArrival[] = [];
  let occluded = 0;
  let diffractedCount = 0;
  const boxes: Box[] = objects.map((object) => objectBounds(object));

  for (const arrival of arrivals) {
    if (arrival.kind === 'stochastic' || !arrival.imagePosition) {
      result.push(arrival);
      continue;
    }

    const path = specularPathPoints(scene, arrival.imagePosition);
    let blocked = false;
    for (let index = 0; index + 1 < path.length && !blocked; index++) {
      blocked = segmentOccluded(bvh, path[index], path[index + 1]);
    }
    if (!blocked) {
      result.push(arrival);
      continue;
    }

    occluded++;
    if (arrival.kind !== 'direct') {
      continue;
    }

    for (const point of findDiffractionPoints(scene, boxes)) {
      result.push(diffractedArrival(scene, point));
      diffractedCount++;
    }
  }

  result.sort((p, q) => p.time - q.time);
  return { arrivals: result, occluded, diffracted: diffractedCount };
}
