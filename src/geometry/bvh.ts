import type { Vec3 } from '../acoustics/model.ts';
import type { AcousticMesh, Triangle } from './acoustic-scene.ts';

// BVH built by median split on the longest centroid axis, flattened for WGSL traversal.
// Node layout (32 bytes): min xyz, first, max xyz, count. Leaf: count > 0. Internal: count = 0.

export interface BVHNode {
  min: Vec3;
  max: Vec3;
  // leaf: first triangle index. internal: left child index (right = left + 1).
  first: number;
  // number of triangles in a leaf; 0 for internal nodes
  count: number;
}

export interface BVH {
  nodes: BVHNode[];
  // triangles reordered so each leaf references a contiguous range
  triangles: Triangle[];
  stats: { triangles: number; nodes: number; leaves: number; maxDepth: number; leafSize: number };
}

export interface Hit {
  t: number;
  triangle: number;
}

export function buildBVH(input: Triangle[], leafSize = 4): BVH {
  if (input.length === 0) throw new Error('A BVH needs at least one triangle.');
  const centroid = input.map((t) => [0, 1, 2].map((i) => (t.a[i] + t.b[i] + t.c[i]) / 3) as Vec3);
  const order = input.map((_, i) => i);
  const nodes: BVHNode[] = [];
  let leaves = 0;
  let maxDepth = 0;

  const boundsOf = (start: number, end: number) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = input[order[i]];
      for (const v of [t.a, t.b, t.c]) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], v[axis]);
          max[axis] = Math.max(max[axis], v[axis]);
        }
      }
    }
    return { min, max };
  };

  const build = (nodeIndex: number, start: number, end: number, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    const { min, max } = boundsOf(start, end);
    const count = end - start;

    // Longest axis of the centroid bounds.
    const cmin: Vec3 = [Infinity, Infinity, Infinity];
    const cmax: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      for (let axis = 0; axis < 3; axis++) {
        cmin[axis] = Math.min(cmin[axis], centroid[order[i]][axis]);
        cmax[axis] = Math.max(cmax[axis], centroid[order[i]][axis]);
      }
    }
    const extent = cmax.map((v, i) => v - cmin[i]);
    let axis: number;
    if (extent[0] >= extent[1] && extent[0] >= extent[2]) {
      axis = 0;
    } else if (extent[1] >= extent[2]) {
      axis = 1;
    } else {
      axis = 2;
    }

    if (count <= leafSize || extent[axis] < 1e-9) {
      nodes[nodeIndex] = { min, max, first: start, count };
      leaves++;
      return;
    }

    const range = order.slice(start, end).sort((p, q) => centroid[p][axis] - centroid[q][axis]);
    for (let i = 0; i < count; i++) order[start + i] = range[i];
    // EDW XWRIZOUME TA TRIGWNA STI MESI TOU TAXINOMIMENOU AXONA GIA NA XTISOUME TO BVH.
    const middle = start + Math.floor(count / 2);

    const left = nodes.length;
    nodes.push(undefined as unknown as BVHNode, undefined as unknown as BVHNode);
    nodes[nodeIndex] = { min, max, first: left, count: 0 };
    build(left, start, middle, depth + 1);
    build(left + 1, middle, end, depth + 1);
  };

  nodes.push(undefined as unknown as BVHNode);
  build(0, 0, input.length, 0);

  return {
    nodes,
    triangles: order.map((i) => input[i]),
    stats: { triangles: input.length, nodes: nodes.length, leaves, maxDepth, leafSize },
  };
}

// Ray queries (CPU). The WGSL shader implements the same two functions.

// Moller-Trumbore ray/triangle intersection, returns distance or Infinity
export function intersectTriangle(origin: Vec3, direction: Vec3, t: Triangle): number {
  const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
  const e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
  const p = [
    direction[1] * e2[2] - direction[2] * e2[1],
    direction[2] * e2[0] - direction[0] * e2[2],
    direction[0] * e2[1] - direction[1] * e2[0],
  ];
  // EDW KANOUME RAY-TRIANGLE INTERSECTION GIA NA VROUME AN KAI POU TO RAY XTYPAEI TIN EPIFANEIA.
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const s = [origin[0] - t.a[0], origin[1] - t.a[1], origin[2] - t.a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return distance > 1e-6 ? distance : Infinity;
}

// slab test for ray-box intersection
function intersectBox(origin: Vec3, inverse: Vec3, node: BVHNode, tMax: number): number {
  let near = 0;
  let far = tMax;
  for (let axis = 0; axis < 3; axis++) {
    let t0 = (node.min[axis] - origin[axis]) * inverse[axis];
    let t1 = (node.max[axis] - origin[axis]) * inverse[axis];
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return Infinity;
  }
  return near;
}

function traverse(
  bvh: BVH,
  origin: Vec3,
  direction: Vec3,
  tMax: number,
  accept: (triangle: Triangle) => boolean,
  anyHit: boolean,
): Hit | undefined {
  const inverse = direction.map((v) => 1 / v) as Vec3;
  const stack = [0];
  let best: Hit | undefined;
  let limit = tMax;
  while (stack.length) {
    const node = bvh.nodes[stack.pop()!];
    if (intersectBox(origin, inverse, node, limit) === Infinity) continue;
    if (node.count === 0) {
      stack.push(node.first, node.first + 1);
      continue;
    }
    for (let i = node.first; i < node.first + node.count; i++) {
      const triangle = bvh.triangles[i];
      if (!accept(triangle)) continue;
      const t = intersectTriangle(origin, direction, triangle);
      if (t < limit) {
        best = { t, triangle: i };
        limit = t;
        if (anyHit) return best;
      }
    }
  }
  return best;
}

export function closestHit(bvh: BVH, origin: Vec3, direction: Vec3, tMax = Infinity): Hit | undefined {
  return traverse(bvh, origin, direction, tMax, () => true, false);
}

// true when an object (non-shell) triangle blocks the segment from->to
export function segmentOccluded(bvh: BVH, from: Vec3, to: Vec3): boolean {
  const delta = to.map((v, i) => v - from[i]) as Vec3;
  const length = Math.hypot(...delta);
  if (length < 1e-9) return false;
  const direction = delta.map((v) => v / length) as Vec3;
  return !!traverse(bvh, from, direction, length - 1e-6, (t) => !t.shell, true);
}

// brute-force reference used by the tests
export function closestHitBruteForce(triangles: Triangle[], origin: Vec3, direction: Vec3): Hit | undefined {
  let best: Hit | undefined;
  triangles.forEach((triangle, i) => {
    const t = intersectTriangle(origin, direction, triangle);
    if (t < (best?.t ?? Infinity)) best = { t, triangle: i };
  });
  return best;
}

// GPU packing

export interface PackedMesh {
  nodes: ArrayBuffer; // 32 bytes per node
  triangles: ArrayBuffer; // 48 bytes per triangle: a, material, b, flags, c, surface id
  materials: Float32Array; // 16 floats per material: absorption[8], scattering[8]
  objectTriangles: number;
}

export function packMesh(mesh: AcousticMesh, bvh: BVH): PackedMesh {
  const nodes = new ArrayBuffer(bvh.nodes.length * 32);
  const nodeF = new Float32Array(nodes);
  const nodeU = new Uint32Array(nodes);
  bvh.nodes.forEach((node, i) => {
    nodeF.set(node.min, i * 8);
    nodeU[i * 8 + 3] = node.first;
    nodeF.set(node.max, i * 8 + 4);
    nodeU[i * 8 + 7] = node.count;
  });

  const triangles = new ArrayBuffer(bvh.triangles.length * 48);
  const triF = new Float32Array(triangles);
  const triU = new Uint32Array(triangles);
  bvh.triangles.forEach((t, i) => {
    triF.set(t.a, i * 12);
    triU[i * 12 + 3] = t.material;
    triF.set(t.b, i * 12 + 4);
    triU[i * 12 + 7] = t.shell ? 1 : 0;
    triF.set(t.c, i * 12 + 8);
    triU[i * 12 + 11] = t.surface ?? 0;
  });

  const materials = new Float32Array(mesh.materials.length * 16);
  mesh.materials.forEach((m, i) => {
    materials.set(m.absorption, i * 16);
    materials.set(m.scattering, i * 16 + 8);
  });

  return { nodes, triangles, materials, objectTriangles: bvh.triangles.filter((t) => !t.shell).length };
}
