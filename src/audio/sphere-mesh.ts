import type { Vec3 } from '../acoustics/model.ts';

// Size of the displacement that breaks exact coplanarity of the grid (unit sphere).
const HULL_JITTER = 1e-9;
// A point is outside a face when its signed distance to the face plane exceeds this.
const VISIBILITY_EPSILON = 1e-12;
// Barycentric coordinates down to this negative value still count as "inside the triangle".
const INSIDE_TOLERANCE = 1e-9;

// Deterministic pseudo-random number in [-1, 1) from two integers (a small integer hash).
function hashedUnit(index: number, axis: number): number {
  let h = Math.imul(index * 3 + axis + 1, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h / 2147483648 - 1;
}

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// One oriented hull face: corner indices (counter-clockwise seen from outside) and its plane.
interface HullFace {
  a: number;
  b: number;
  c: number;
  normal: Vec3;
  offset: number;
}

// Face through the corners `a`, `b`, `c` with the normal pointing away from `inside`.
function makeFace(points: Vec3[], a: number, b: number, c: number, inside: Vec3): HullFace {
  let normal = cross(subtract(points[b], points[a]), subtract(points[c], points[a]));
  const length = Math.hypot(...normal) || 1;
  normal = [normal[0] / length, normal[1] / length, normal[2] / length];
  const offset = dot(normal, points[a]);
  // Orient away from the interior reference point.
  if (dot(normal, inside) - offset > 0)
    return { a, b: c, c: b, normal: [-normal[0], -normal[1], -normal[2]], offset: -offset };
  return { a, b, c, normal, offset };
}

export function convexHull(points: Vec3[]): Int32Array {
  const count = points.length;
  if (count < 4) throw new Error('A sphere triangulation needs at least four points.');
  const displaced: Vec3[] = points.map((p, i) => [
    p[0] + HULL_JITTER * hashedUnit(i, 0),
    p[1] + HULL_JITTER * hashedUnit(i, 1),
    p[2] + HULL_JITTER * hashedUnit(i, 2),
  ]);

  // Initial tetrahedron: the first point, the farthest from it, the one farthest from their line,
  // and the one farthest from their plane.
  const first = 0;
  let second = 0;
  for (let i = 1; i < count; i++)
    if (
      dot(subtract(displaced[i], displaced[first]), subtract(displaced[i], displaced[first])) >
      dot(subtract(displaced[second], displaced[first]), subtract(displaced[second], displaced[first]))
    )
      second = i;
  let third = -1;
  let bestArea = -1;
  for (let i = 0; i < count; i++) {
    if (i === first || i === second) continue;
    const area = Math.hypot(
      ...cross(subtract(displaced[second], displaced[first]), subtract(displaced[i], displaced[first])),
    );
    if (area > bestArea) {
      bestArea = area;
      third = i;
    }
  }
  const planeNormal = cross(
    subtract(displaced[second], displaced[first]),
    subtract(displaced[third], displaced[first]),
  );
  let fourth = -1;
  let bestVolume = -1;
  for (let i = 0; i < count; i++) {
    if (i === first || i === second || i === third) continue;
    const volume = Math.abs(dot(planeNormal, subtract(displaced[i], displaced[first])));
    if (volume > bestVolume) {
      bestVolume = volume;
      fourth = i;
    }
  }
  if (bestVolume < 1e-12) throw new Error('The points are coplanar; no sphere triangulation exists.');
  const centre: Vec3 = [0, 1, 2].map(
    (axis) =>
      (displaced[first][axis] + displaced[second][axis] + displaced[third][axis] + displaced[fourth][axis]) /
      4,
  ) as Vec3;
  let faces: HullFace[] = [
    makeFace(displaced, first, second, third, centre),
    makeFace(displaced, first, second, fourth, centre),
    makeFace(displaced, first, third, fourth, centre),
    makeFace(displaced, second, third, fourth, centre),
  ];

  const used = new Set([first, second, third, fourth]);
  for (let point = 0; point < count; point++) {
    if (used.has(point)) continue;
    const visible: HullFace[] = [];
    const kept: HullFace[] = [];
    for (const face of faces) {
      if (dot(face.normal, displaced[point]) - face.offset > VISIBILITY_EPSILON) visible.push(face);
      else kept.push(face);
    }
    if (visible.length === 0) continue; // inside the current hull
    // Directed edges of the visible faces; those whose reverse is not among them form the horizon.
    const edges = new Set<number>();
    for (const face of visible) {
      edges.add(face.a * count + face.b);
      edges.add(face.b * count + face.c);
      edges.add(face.c * count + face.a);
    }
    for (const face of visible)
      for (const [from, to] of [
        [face.a, face.b],
        [face.b, face.c],
        [face.c, face.a],
      ])
        if (!edges.has(to * count + from)) kept.push(makeFace(displaced, from, to, point, centre));
    faces = kept;
  }
  const triangles = new Int32Array(faces.length * 3);
  faces.forEach((face, i) => triangles.set([face.a, face.b, face.c], i * 3));
  return triangles;
}

// Area in steradians of the spherical triangle with unit-vector corners `a`, `b`, `c`.
// EDW METRAME STEREA GWNIA GIA NA ZYGISOUME TA HRTF ME VASI TIN PERIOXI POU KALYPTOUN STI SFAIRA.
export function sphericalTriangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  // Van Oosterom and Strackee: tan(E / 2) = |a. (b x c)| / (1 + a.b + b.c + c.a).
  const numerator = Math.abs(dot(a, cross(b, c)));
  const denominator = 1 + dot(a, b) + dot(b, c) + dot(c, a);
  return 2 * Math.atan2(numerator, denominator);
}

// Corners and barycentric weights (sum 1, none negative) of the triangle that holds a direction.
export interface TriangleWeights {
  vertices: [number, number, number];
  weights: [number, number, number];
}

export class SphereTriangulation {
  readonly points: Vec3[];
  readonly triangles: Int32Array;
  private inverses: Float64Array;
  private incident: number[][];
  constructor(points: Vec3[]) {
    this.points = points;
    this.triangles = convexHull(points);
    const triangleCount = this.triangles.length / 3;
    this.inverses = new Float64Array(triangleCount * 9);
    this.incident = points.map(() => []);
    for (let t = 0; t < triangleCount; t++) {
      const [a, b, c] = [this.triangles[t * 3], this.triangles[t * 3 + 1], this.triangles[t * 3 + 2]];
      this.incident[a].push(t);
      this.incident[b].push(t);
      this.incident[c].push(t);
      this.inverses.set(invertColumns(points[a], points[b], points[c]), t * 9);
    }
  }

  // Barycentric weights of triangle `t` for the direction `u` (may be negative outside the triangle).
  private coordinates(t: number, u: Vec3): Vec3 {
    const m = this.inverses;
    const o = t * 9;
    return [
      m[o] * u[0] + m[o + 1] * u[1] + m[o + 2] * u[2],
      m[o + 3] * u[0] + m[o + 4] * u[1] + m[o + 5] * u[2],
      m[o + 6] * u[0] + m[o + 7] * u[1] + m[o + 8] * u[2],
    ];
  }

  locate(u: Vec3): TriangleWeights {
    let nearest = 0;
    let best = -Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const score = dot(this.points[i], u);
      if (score > best) {
        best = score;
        nearest = i;
      }
    }
    if (best > 1 - 1e-12) return { vertices: [nearest, nearest, nearest], weights: [1, 0, 0] };
    // Look at the triangles around the nearest corner first; fall back to all triangles.
    let chosen = -1;
    let chosenScore = -Infinity;
    let chosenWeights: Vec3 = [1, 0, 0];
    const consider = (t: number) => {
      const w = this.coordinates(t, u);
      const score = Math.min(w[0], w[1], w[2]);
      if (score > chosenScore) {
        chosenScore = score;
        chosen = t;
        chosenWeights = w;
      }
    };
    for (const t of this.incident[nearest]) consider(t);
    if (chosenScore < -INSIDE_TOLERANCE) for (let t = 0; t < this.triangles.length / 3; t++) consider(t);
    const w = chosenWeights.map((v) => Math.max(0, v));
    const sum = w[0] + w[1] + w[2] || 1;
    return {
      vertices: [this.triangles[chosen * 3], this.triangles[chosen * 3 + 1], this.triangles[chosen * 3 + 2]],
      weights: [w[0] / sum, w[1] / sum, w[2] / sum],
    };
  }

  solidAngleWeights(): Float64Array {
    const weights = new Float64Array(this.points.length);
    for (let t = 0; t < this.triangles.length; t += 3) {
      const [a, b, c] = [this.triangles[t], this.triangles[t + 1], this.triangles[t + 2]];
      const third = sphericalTriangleArea(this.points[a], this.points[b], this.points[c]) / 3;
      weights[a] += third;
      weights[b] += third;
      weights[c] += third;
    }
    const total = weights.reduce((sum, v) => sum + v, 0);
    return weights.map((v) => v / total);
  }
}

// Row-major inverse of the matrix whose columns are `a`, `b` and `c`.
function invertColumns(a: Vec3, b: Vec3, c: Vec3): number[] {
  const bc = cross(b, c);
  const ca = cross(c, a);
  const ab = cross(a, b);
  const determinant = dot(a, bc) || 1e-300;
  // The rows of the inverse are the cross products divided by the determinant.
  return [...bc, ...ca, ...ab].map((v) => v / determinant);
}
