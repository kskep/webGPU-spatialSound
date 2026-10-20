import {
  BAND_CENTERS,
  effectiveMaterials,
  effectiveScattering,
  type Bands,
  type Scene,
  type Vec3,
} from '../acoustics/model.ts';
import {
  normalizeObjectMaterialName,
  objectMaterial,
  resolveObjectMaterialId,
  type AcousticMaterial,
} from './materials.ts';

// Acoustic scene: triangle list for the room shell and box objects, shared by the BVH tracer.

export interface SceneObject {
  name: string;
  center: Vec3;
  size: Vec3;
  material: string;
}

export interface SceneObjectFile {
  name: string;
  objects: Array<{
    type: 'box';
    name?: string;
    center: Vec3;
    size: Vec3;
    material?: string | { preset?: string };
  }>;
}

export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  // index into AcousticMesh.materials
  material: number;
  // shell triangles are handled by the image-source method
  shell: boolean;
  // face id this triangle belongs to (index into AcousticMesh.faces); optional for test triangles
  surface?: number;
}

// One flat axis-aligned rectangle (a face of the room shell or of a box object).
// Its index in AcousticMesh.faces is the surface id the shader reports for a reflection.
export interface SurfaceFace {
  // axis perpendicular to the face (0=x, 1=y, 2=z) and its coordinate on that axis
  axis: number;
  coordinate: number;
  // bounding rectangle on the other two axes
  min: Vec3;
  max: Vec3;
  // index into AcousticMesh.materials
  material: number;
  shell: boolean;
}

export interface AcousticMesh {
  triangles: Triangle[];
  materials: AcousticMaterial[];
  objects: SceneObject[];
  // flat faces indexed by their triangles' surface id
  faces: SurfaceFace[];
}

// Material slots 0–2 are always the room walls, floor and ceiling.
export const SHELL_WALLS = 0;
export const SHELL_FLOOR = 1;
export const SHELL_CEILING = 2;

export function parseSceneObjects(file: SceneObjectFile): SceneObject[] {
  if (!Array.isArray(file.objects)) throw new Error('Scene file has no objects list.');
  return file.objects.map((object, index) => {
    if (object.type !== 'box') throw new Error(`Object ${index} is not a box.`);
    const material =
      typeof object.material === 'string' ? object.material : (object.material?.preset ?? 'CONCRETE');
    return {
      name: object.name ?? `Object ${index + 1}`,
      center: [...object.center] as Vec3,
      size: [...object.size] as Vec3,
      material: normalizeObjectMaterialName(material),
    };
  });
}

function quad(
  triangles: Triangle[],
  corners: [Vec3, Vec3, Vec3, Vec3],
  material: number,
  shell: boolean,
  surface: number,
): void {
  triangles.push({ a: corners[0], b: corners[1], c: corners[2], material, shell, surface });
  triangles.push({ a: corners[0], b: corners[2], c: corners[3], material, shell, surface });
}

// six faces of an axis-aligned box, two triangles each
function boxFaces(
  min: Vec3,
  max: Vec3,
): Array<{ corners: [Vec3, Vec3, Vec3, Vec3]; axis: number; side: 'min' | 'max' }> {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    {
      axis: 0,
      side: 'min',
      corners: [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
    },
    {
      axis: 0,
      side: 'max',
      corners: [
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
      ],
    },
    {
      axis: 1,
      side: 'min',
      corners: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
    },
    {
      axis: 1,
      side: 'max',
      corners: [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
    },
    {
      axis: 2,
      side: 'min',
      corners: [
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
      ],
    },
    {
      axis: 2,
      side: 'max',
      corners: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
    },
  ];
}

// room interior bounds: x/z centred, floor at y = 0
export function roomBounds(scene: Scene): { min: Vec3; max: Vec3 } {
  const [w, h, d] = scene.dimensions;
  return { min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] };
}

export function objectBounds(object: SceneObject): { min: Vec3; max: Vec3 } {
  const half = object.size.map((v) => v / 2);
  return {
    min: object.center.map((v, i) => v - half[i]) as Vec3,
    max: object.center.map((v, i) => v + half[i]) as Vec3,
  };
}

export function buildAcousticMesh(scene: Scene, objects: SceneObject[] = []): AcousticMesh {
  const shellMaterials = effectiveMaterials(scene);
  const shellScattering = effectiveScattering(scene);
  const materials: AcousticMaterial[] = [
    { absorption: shellMaterials.walls, scattering: shellScattering.walls },
    { absorption: shellMaterials.floor, scattering: shellScattering.floor },
    { absorption: shellMaterials.ceiling, scattering: shellScattering.ceiling },
  ];
  const triangles: Triangle[] = [];
  const faces: SurfaceFace[] = [];

  // Every box adds its six faces in the order of `boxFaces`; the face's index is its surface id.
  const addBox = (
    min: Vec3,
    max: Vec3,
    materialOf: (axis: number, side: 'min' | 'max') => number,
    shell: boolean,
  ) => {
    for (const face of boxFaces(min, max)) {
      const material = materialOf(face.axis, face.side);
      const coordinate = face.side === 'min' ? min[face.axis] : max[face.axis];
      const faceMin: Vec3 = [...min];
      const faceMax: Vec3 = [...max];
      faceMin[face.axis] = faceMax[face.axis] = coordinate;
      quad(triangles, face.corners, material, shell, faces.length);
      faces.push({ axis: face.axis, coordinate, min: faceMin, max: faceMax, material, shell });
    }
  };

  const room = roomBounds(scene);
  addBox(
    room.min,
    room.max,
    (axis, side) => {
      if (axis !== 1) return SHELL_WALLS;
      if (side === 'min') return SHELL_FLOOR;
      return SHELL_CEILING;
    },
    true,
  );

  const materialSlots = new Map<string, number>();
  for (const object of objects) {
    // Objects that name the same library material (by alias or by id) share one slot.
    const materialId = resolveObjectMaterialId(object.material);
    let slot = materialSlots.get(materialId);
    if (slot === undefined) {
      slot = materials.length;
      materials.push(objectMaterial(materialId));
      materialSlots.set(materialId, slot);
    }
    const bounds = objectBounds(object);
    addBox(bounds.min, bounds.max, () => slot, false);
  }

  return { triangles, materials, objects, faces };
}

// true when a point lies inside any object (rejects source/listener placements)
export function insideObject(point: Vec3, objects: SceneObject[], margin = 0): SceneObject | undefined {
  return objects.find((object) => {
    const { min, max } = objectBounds(object);
    return point.every((v, i) => v > min[i] - margin && v < max[i] + margin);
  });
}

// objects that stick out of the room box -- scene must not be traced
export function objectsOutsideRoom(scene: Scene, objects: SceneObject[]): SceneObject[] {
  const room = roomBounds(scene);
  const tolerance = 1e-9;
  return objects.filter((object) => {
    const bounds = objectBounds(object);
    return [0, 1, 2].some(
      (axis) =>
        bounds.min[axis] < room.min[axis] - tolerance || bounds.max[axis] > room.max[axis] + tolerance,
    );
  });
}

// geometry and absorption totals for Eyring-type decay estimates
export interface MeshRoomStatistics {
  // air volume in m^3 (room minus objects)
  volume: number;
  // exposed surface area in m^2 (only what rays can hit)
  surfaceArea: number;
  // mean free path 4V/S in metres
  meanFreePath: number;
  // equivalent absorption area per band in m^2
  absorptionArea: Bands;
  // area of mesh triangles rays can never reach
  hiddenArea: number;
}

function triangleArea(triangle: Triangle): number {
  const [ax, ay, az] = triangle.a;
  const edge1 = [triangle.b[0] - ax, triangle.b[1] - ay, triangle.b[2] - az];
  const edge2 = [triangle.c[0] - ax, triangle.c[1] - ay, triangle.c[2] - az];
  // Half the length of the cross product of two edges.
  const crossX = edge1[1] * edge2[2] - edge1[2] * edge2[1];
  const crossY = edge1[2] * edge2[0] - edge1[0] * edge2[2];
  const crossZ = edge1[0] * edge2[1] - edge1[1] * edge2[0];
  // EDW TO MISO METRO TOU CROSS PRODUCT MAS DINEI TO EMVADON TOU TRIGWNOU GIA TA ROOM STATISTICS.
  return 0.5 * Math.hypot(crossX, crossY, crossZ);
}

// volume of the union of axis-aligned boxes clipped to the room (handles overlapping boxes)
function occupiedVolume(objects: SceneObject[], roomMin: Vec3, roomMax: Vec3): number {
  if (objects.length === 0) return 0;
  const boxes = objects.map((object) => {
    const bounds = objectBounds(object);
    return {
      min: bounds.min.map((v, axis) => Math.max(v, roomMin[axis])),
      max: bounds.max.map((v, axis) => Math.min(v, roomMax[axis])),
    };
  });
  const breakpoints = [0, 1, 2].map((axis) => {
    const values = new Set<number>();
    for (const box of boxes) {
      values.add(box.min[axis]);
      values.add(box.max[axis]);
    }
    return [...values].sort((a, b) => a - b);
  });
  let volume = 0;
  for (let i = 0; i + 1 < breakpoints[0].length; i++) {
    for (let j = 0; j + 1 < breakpoints[1].length; j++) {
      for (let k = 0; k + 1 < breakpoints[2].length; k++) {
        const cellMin = [breakpoints[0][i], breakpoints[1][j], breakpoints[2][k]];
        const cellMax = [breakpoints[0][i + 1], breakpoints[1][j + 1], breakpoints[2][k + 1]];
        const covered = boxes.some((box) =>
          [0, 1, 2].every((axis) => box.min[axis] <= cellMin[axis] && box.max[axis] >= cellMax[axis]),
        );
        if (covered) {
          volume += (cellMax[0] - cellMin[0]) * (cellMax[1] - cellMin[1]) * (cellMax[2] - cellMin[2]);
        }
      }
    }
  }
  return volume;
}

// axis-aligned rectangle in the two remaining coordinates after dropping a face's axis
interface Rectangle {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

// two coordinates closer than this (metres) are the same plane
const PLANE_TOLERANCE = 1e-6;

// for a face normal to axis a, the two other axes (u, v)
const FACE_AXES: Array<[number, number]> = [
  [1, 2],
  [0, 2],
  [0, 1],
];

function rectangleArea(rectangle: Rectangle): number {
  return Math.max(0, rectangle.u1 - rectangle.u0) * Math.max(0, rectangle.v1 - rectangle.v0);
}

// overlap of two rectangles, or undefined if they don't share area
function intersectRectangles(first: Rectangle, second: Rectangle): Rectangle | undefined {
  const overlap: Rectangle = {
    u0: Math.max(first.u0, second.u0),
    u1: Math.min(first.u1, second.u1),
    v0: Math.max(first.v0, second.v0),
    v1: Math.min(first.v1, second.v1),
  };
  return overlap.u1 > overlap.u0 && overlap.v1 > overlap.v0 ? overlap : undefined;
}

// exact area of a union of axis-aligned rectangles (grid-based, overlaps counted once)
function unionArea(rectangles: Rectangle[]): number {
  if (rectangles.length === 0) return 0;
  const uEdges = [...new Set(rectangles.flatMap((rectangle) => [rectangle.u0, rectangle.u1]))].sort(
    (a, b) => a - b,
  );
  const vEdges = [...new Set(rectangles.flatMap((rectangle) => [rectangle.v0, rectangle.v1]))].sort(
    (a, b) => a - b,
  );
  let area = 0;
  for (let i = 0; i + 1 < uEdges.length; i++) {
    for (let j = 0; j + 1 < vEdges.length; j++) {
      const cell: Rectangle = { u0: uEdges[i], u1: uEdges[i + 1], v0: vEdges[j], v1: vEdges[j + 1] };
      const covered = rectangles.some(
        (rectangle) =>
          rectangle.u0 <= cell.u0 &&
          rectangle.u1 >= cell.u1 &&
          rectangle.v0 <= cell.v0 &&
          rectangle.v1 >= cell.v1,
      );
      if (covered) area += rectangleArea(cell);
    }
  }
  return area;
}

// cross-section of a box along axis, as a rectangle in the (u, v) plane
function crossSection(min: Vec3, max: Vec3, axis: number): Rectangle {
  const [uAxis, vAxis] = FACE_AXES[axis];
  return { u0: min[uAxis], u1: max[uAxis], v0: min[vAxis], v1: max[vAxis] };
}

// a piece of surface a ray can hit, with the material's absorption
interface ExposedPatch {
  area: number;
  absorption: Bands;
}

// Computes the surface area rays can actually reach (exposed patches) and the total mesh area.
// Faces pressed against walls, floors, or other boxes are excluded.
function exposedSurface(
  mesh: AcousticMesh,
  roomMin: Vec3,
  roomMax: Vec3,
): { patches: ExposedPatch[]; meshArea: number } {
  const patches: ExposedPatch[] = [];
  const boxes = mesh.objects.map((object) => objectBounds(object));
  const objectAbsorption = mesh.objects.map((object) => objectMaterial(object.material).absorption);

  // Footprints of object faces pressed against each room surface, keyed by "axis:side".
  const footprints = new Map<string, Rectangle[]>();

  boxes.forEach((box, boxIndex) => {
    for (let axis = 0; axis < 3; axis++) {
      for (const side of ['min', 'max'] as const) {
        const plane = side === 'min' ? box.min[axis] : box.max[axis];
        const faceRectangle = crossSection(box.min, box.max, axis);

        // Rule 1: the face lies on the room surface it points into.
        const wallPlane = side === 'min' ? roomMin[axis] : roomMax[axis];
        if (Math.abs(plane - wallPlane) < PLANE_TOLERANCE) {
          const key = `${axis}:${side}`;
          const list = footprints.get(key) ?? [];
          const clipped = intersectRectangles(faceRectangle, crossSection(roomMin, roomMax, axis));
          if (clipped) list.push(clipped);
          footprints.set(key, list);
          continue;
        }

        // Rule 2: regions of this face covered by the other boxes.
        const covered: Rectangle[] = [];
        boxes.forEach((other, otherIndex) => {
          if (otherIndex === boxIndex) return;
          const buried =
            other.min[axis] + PLANE_TOLERANCE < plane && plane < other.max[axis] - PLANE_TOLERANCE;
          // The neighbour's face that would press against this one.
          const touchingPlane = side === 'max' ? other.min[axis] : other.max[axis];
          const pressed = Math.abs(touchingPlane - plane) < PLANE_TOLERANCE;
          // The neighbour's face on the same plane and facing the same way.
          const samePlane = side === 'max' ? other.max[axis] : other.min[axis];
          const coplanar = Math.abs(samePlane - plane) < PLANE_TOLERANCE && otherIndex < boxIndex;
          if (!buried && !pressed && !coplanar) return;
          const overlap = intersectRectangles(faceRectangle, crossSection(other.min, other.max, axis));
          if (overlap) covered.push(overlap);
        });
        const exposed = rectangleArea(faceRectangle) - unionArea(covered);
        if (exposed > 0) patches.push({ area: exposed, absorption: objectAbsorption[boxIndex] });
      }
    }
  });

  // Rule 3: the six room surfaces minus whatever stands on or against them.
  for (let axis = 0; axis < 3; axis++) {
    for (const side of ['min', 'max'] as const) {
      let shellMaterial = SHELL_WALLS;
      if (axis === 1) {
        shellMaterial = side === 'min' ? SHELL_FLOOR : SHELL_CEILING;
      }
      const faceArea = rectangleArea(crossSection(roomMin, roomMax, axis));
      const hidden = unionArea(footprints.get(`${axis}:${side}`) ?? []);
      patches.push({ area: faceArea - hidden, absorption: mesh.materials[shellMaterial].absorption });
    }
  }

  let meshArea = 0;
  for (const triangle of mesh.triangles) meshArea += triangleArea(triangle);
  return { patches, meshArea };
}

// Volume, exposed surface, mean free path and absorption area for Eyring's formula.
export function meshRoomStatistics(mesh: AcousticMesh, scene: Scene): MeshRoomStatistics {
  const room = roomBounds(scene);
  const [width, height, depth] = scene.dimensions;
  // EDW AFAIROUME TON OGKO TWN OBJECTS APO TO DWMATIO GIA NA VROUME TON ELEYTHERO AKOUSTIKO OGKO.
  const volume = width * height * depth - occupiedVolume(mesh.objects, room.min, room.max);

  const { patches, meshArea } = exposedSurface(mesh, room.min, room.max);
  let surfaceArea = 0;
  const absorptionArea = new Array<number>(BAND_CENTERS.length).fill(0);
  for (const patch of patches) {
    surfaceArea += patch.area;
    for (let band = 0; band < BAND_CENTERS.length; band++) {
      // EDW ZYGIZOUME TIN APORROFISI ME TO EMVADON GIA NA VROUME TIN ISODYNAMI APORROFITIKI EPIFANEIA.
      absorptionArea[band] += patch.area * patch.absorption[band];
    }
  }
  return {
    volume,
    surfaceArea,
    meanFreePath: (4 * volume) / surfaceArea,
    absorptionArea: absorptionArea as Bands,
    hiddenArea: meshArea - surfaceArea,
  };
}

// Eyring RT60 per band: RT60 = 0.161 V / (-S ln(1 - A/S) + 4mV)
export function eyringBandsFromMesh(stats: MeshRoomStatistics, airDbPerMeter: ArrayLike<number>): Bands {
  return BAND_CENTERS.map((_, band) => {
    const average = stats.absorptionArea[band] / stats.surfaceArea;
    const boundary = average >= 1 ? Infinity : -stats.surfaceArea * Math.log1p(-average);
    const air = (4 * stats.volume * airDbPerMeter[band] * Math.LN10) / 10;
    return boundary + air === 0 ? Infinity : (0.161 * stats.volume) / (boundary + air);
  }) as Bands;
}
