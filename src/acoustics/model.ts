import { atmosphericLoss } from './air.ts';
import type { LateDecay } from './decay-fit.ts';
import type { TerminationReport } from '../config/ray-termination.ts';
import type { SpecularRaysReport } from './specular-echoes.ts';
import { DEFAULT_DIRECTIVITY_ID, DIRECTIVITY_PATTERNS } from '../config/directivity.ts';
import { defaultForward, imageEmissionDirection, sourceDirectivityWeights } from './directivity.ts';

export type Vec3 = [number, number, number];
export const BAND_CENTERS = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const;
export type Bands = [number, number, number, number, number, number, number, number];

export interface SurfaceMaterials {
  walls: Bands;
  floor: Bands;
  ceiling: Bands;
}

export interface Scene {
  dimensions: Vec3;
  source: Vec3;
  listener: Vec3;
  listenerForward: Vec3;
  absorption: number;
  // scattering coefficient - with shellScattering it acts as a scale factor on the curves
  scattering: number;
  // per-surface scattering curves (optional, for room presets)
  shellScattering?: SurfaceMaterials;
  rays: number;
  bounces: number;
  receiverRadius: number;
  seed: number;
  speed: number;
  materials: SurfaceMaterials;
  airDbPerMeter: Bands;
  earlyOrder: number;
  sourceForward: Vec3;
  sourceDirectivity: string;
}

export interface Arrival {
  time: number;
  energy: number;
  energyBands: Bands;
  order: number;
  distance: number;
  direction: Vec3;
  pan: number;
  kind: 'direct' | 'specular' | 'stochastic';
  imagePosition?: Vec3;
  diffracted?: boolean;
  // for histogram bins from GPU - sums multiple ray hits
  binned?: boolean;
  hitCount?: number;
  // discrete echo found by ray tracing (not image-source)
  rayTraced?: boolean;
}

export interface TraceResult {
  arrivals: Arrival[];
  paths: number[][];
  elapsedMs: number;
  analyticalCount: number;
  lateListenerPosition?: Vec3;
  tracedRays?: number;
  tracedBounces?: number;
  termination?: TerminationReport;
  specularRays?: SpecularRaysReport;
  lateDecay?: LateDecay;
  lateDecayThisTrace?: LateDecay;
  lateDecayOrigin?: 'full-trace' | 'provisional' | 'probes';
}

export function defaultScene(): Scene {
  return {
    dimensions: [6, 3, 5],
    source: [0, 1.7, 0],
    listener: [0, 1.7, 2],
    listenerForward: [0, 0, -1],
    absorption: 0.6,
    scattering: 0.28,
    rays: 16384,
    bounces: 32,
    receiverRadius: 0.25,
    seed: 42,
    speed: 343,
    earlyOrder: 3,
    materials: {
      walls: [0.3, 0.3, 0.45, 0.6, 0.6, 0.7, 0.8, 0.8],
      floor: [0.15, 0.15, 0.2, 0.25, 0.25, 0.275, 0.3, 0.3],
      ceiling: [0.25, 0.25, 0.375, 0.5, 0.5, 0.6, 0.7, 0.7],
    },
    airDbPerMeter: atmosphericLoss(20, 50, 101.325),
    sourceForward: defaultForward(),
    sourceDirectivity: DEFAULT_DIRECTIVITY_ID,
  };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function validateScene(scene: Scene): void {
  if (scene.dimensions.some((v) => !Number.isFinite(v) || v < 2 || v > 100)) {
    throw new Error('Room dimensions must be between 2 and 100 metres.');
  }
  if (![scene.absorption, scene.scattering].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error('Material coefficients must be between 0 and 1.');
  }
  if (
    !Number.isInteger(scene.rays) ||
    scene.rays < 1024 ||
    scene.rays > 65536 ||
    !Number.isInteger(scene.bounces) ||
    scene.bounces < 2 ||
    scene.bounces > 64
  ) {
    throw new Error('Trace budget is outside supported limits.');
  }
  if (!Number.isInteger(scene.earlyOrder) || scene.earlyOrder < 1 || scene.earlyOrder > 5) {
    throw new Error('Image-source order must be between 1 and 5.');
  }
  if (
    !Number.isFinite(scene.receiverRadius) ||
    scene.receiverRadius <= 0 ||
    scene.receiverRadius > 0.5 ||
    !Number.isFinite(scene.speed) ||
    scene.speed <= 0 ||
    !Number.isInteger(scene.seed) ||
    scene.seed < 0 ||
    scene.seed > 0xffffffff
  ) {
    throw new Error('Invalid receiver, speed or seed.');
  }
  for (const bands of [scene.materials.walls, scene.materials.floor, scene.materials.ceiling]) {
    if (bands.length !== 8 || bands.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
      throw new Error('Every surface needs eight valid absorption bands.');
    }
  }
  if (scene.shellScattering) {
    for (const bands of [
      scene.shellScattering.walls,
      scene.shellScattering.floor,
      scene.shellScattering.ceiling,
    ]) {
      if (bands.length !== 8 || bands.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
        throw new Error('Every surface needs eight valid scattering bands.');
      }
    }
  }
  if (scene.airDbPerMeter.length !== 8 || scene.airDbPerMeter.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error('Invalid air attenuation.');
  }
  for (const point of [scene.source, scene.listener]) {
    if (
      point.some(
        (v, i) =>
          !Number.isFinite(v) ||
          v <= (i === 1 ? 0 : -scene.dimensions[i] / 2) + scene.receiverRadius ||
          v >= (i === 1 ? scene.dimensions[i] : scene.dimensions[i] / 2) - scene.receiverRadius,
      )
    ) {
      throw new Error('Source and listener must be inside the room, away from the walls.');
    }
  }
  if (distance(scene.source, scene.listener) <= 2 * scene.receiverRadius) {
    throw new Error('Move the source and listener farther apart.');
  }
  validateSourceDirectivity(scene);
}

function validateSourceDirectivity(scene: Scene): void {
  const forward = scene.sourceForward;
  if (
    !Array.isArray(forward) ||
    forward.length !== 3 ||
    forward.some((v) => !Number.isFinite(v)) ||
    Math.hypot(...forward) < 1e-9
  ) {
    throw new Error('Source forward must be a finite, non-zero 3D vector.');
  }
  if (!DIRECTIVITY_PATTERNS.some((pattern) => pattern.id === scene.sourceDirectivity)) {
    const known = DIRECTIVITY_PATTERNS.map((pattern) => pattern.id).join(', ');
    throw new Error(
      'Unknown source directivity "' + scene.sourceDirectivity + '". Known patterns: ' + known + '.',
    );
  }
}

// Scale wall absorption to match the 1 kHz slider value.
export function effectiveMaterials(scene: Scene): SurfaceMaterials {
  const reference = scene.materials.walls[4]; // 1kHz band
  const scale = reference > 0 ? scene.absorption / reference : 0;
  const walls = scene.materials.walls.map((v) =>
    reference > 0 ? Math.min(1, v * scale) : scene.absorption,
  ) as Bands;
  return { walls, floor: scene.materials.floor, ceiling: scene.materials.ceiling };
}

// The scattering slider scales preset curves, or supplies a flat value.
export function effectiveScattering(scene: Scene): SurfaceMaterials {
  const curves = scene.shellScattering;
  if (!curves) {
    const flat = (): Bands => Array(BAND_CENTERS.length).fill(scene.scattering) as Bands;
    return { walls: flat(), floor: flat(), ceiling: flat() };
  }
  const scale = (bands: Bands): Bands =>
    bands.map((value) => Math.min(1, Math.max(0, value * scene.scattering))) as Bands;
  return { walls: scale(curves.walls), floor: scale(curves.floor), ceiling: scale(curves.ceiling) };
}

// Prefer explicit band values; otherwise interpolate low/mid/high absorption.
export function materialBands(material: Record<string, unknown>): Bands {
  const low = Number(material.absorptionLow ?? 0.2);
  const mid = Number(material.absorptionMid ?? low);
  const high = Number(material.absorptionHigh ?? mid);
  const keys = [
    'absorption63', 'absorption125', 'absorption250', 'absorption500',
    'absorption1k', 'absorption2k', 'absorption4k', 'absorption8k',
  ];
  const bands: number[] = [];
  for (let band = 0; band < BAND_CENTERS.length; band++) {
    const explicit = material[keys[band]];
    if (explicit !== undefined && explicit !== null) {
      bands.push(Number(explicit));
      continue;
    }

    const frequency = BAND_CENTERS[band];
    let absorption: number;
    if (frequency <= 125) {
      absorption = low;
    } else if (frequency === 250) {
      absorption = (low + mid) / 2;
    } else if (frequency <= 1000) {
      absorption = mid;
    } else if (frequency === 2000) {
      absorption = (mid + high) / 2;
    } else {
      absorption = high;
    }
    bands.push(absorption);
  }
  return bands as Bands;
}

// panning based on direction relative to listener's heading
export function directionPan(direction: Vec3, forward: Vec3): number {
  const flat = Math.hypot(forward[0], forward[2]) || 1;
  return Math.max(-1, Math.min(1, (-direction[0] * forward[2] + direction[2] * forward[0]) / flat));
}

interface AxisImage {
  coordinate: number;
  lower: number;
  upper: number;
  order: number;
}

// mirror images along one axis (Allen & Berkley 1979)
function axisImages(source: number, length: number, origin: number, maxOrder: number): AxisImage[] {
  const images: AxisImage[] = [];
  for (let n = -maxOrder; n <= maxOrder; n++) {
    for (const parity of [0, 1]) {
      // EDW METRAME TIS ANAKLASEIS SE KATHE PLEYRA GIA NA FTIAKSOUME TIS EIKONIKES PIGES.
      let lower = Math.abs(n);
      let upper = Math.abs(n);
      if (parity === 1) {
        if (n > 0) {
          lower = n - 1;
          upper = n;
        } else {
          lower = 1 - n;
          upper = -n;
        }
      }
      const order = lower + upper;
      if (order <= maxOrder) {
        images.push({
          coordinate: origin + 2 * n * length + (parity ? -1 : 1) * (source - origin),
          lower,
          upper,
          order,
        });
      }
    }
  }
  return images;
}

// fraction of specular energy surviving scattering: (1-s)^n per surface
export function scatteringSurvival(
  scattering: SurfaceMaterials,
  band: number,
  wallHits: number,
  floorHits: number,
  ceilingHits: number,
): number {
  const wall = scattering.walls[band];
  const floor = scattering.floor[band];
  const ceiling = scattering.ceiling[band];
  if (wall === floor && floor === ceiling) {
    return Math.pow(1 - wall, wallHits + floorHits + ceilingHits);
  }
  return Math.pow(1 - wall, wallHits) * Math.pow(1 - floor, floorHits) * Math.pow(1 - ceiling, ceilingHits);
}

// image-source method for early reflections (Allen & Berkley 1979)
// computes up to earlyOrder reflections with per-band absorption, scattering,
// air attenuation and source directivity
export function earlyArrivals(scene: Scene): Arrival[] {
  const materials = effectiveMaterials(scene);
  const scattering = effectiveScattering(scene);
  const [width, height, depth] = scene.dimensions;
  const arrivals: Arrival[] = [];
  const axes = [
    axisImages(scene.source[0], width, -width / 2, scene.earlyOrder),
    axisImages(scene.source[1], height, 0, scene.earlyOrder),
    axisImages(scene.source[2], depth, -depth / 2, scene.earlyOrder),
  ];
  for (const imageX of axes[0]) {
    for (const imageY of axes[1]) {
      for (const imageZ of axes[2]) {
        const order = imageX.order + imageY.order + imageZ.order;
        if (order > scene.earlyOrder) {
          continue;
        }
        const image: Vec3 = [imageX.coordinate, imageY.coordinate, imageZ.coordinate];
        const length = distance(image, scene.listener);
        const direction = image.map((v, i) => (v - scene.listener[i]) / length) as Vec3;
        const emission = imageEmissionDirection(image, scene.listener, [
          imageX.order,
          imageY.order,
          imageZ.order,
        ]);
        const directivity = sourceDirectivityWeights(scene, emission);
        // EDW SYNDYAZOUME DIRECTIVITY, APORROFISI, SCATTERING KAI APWLEIES AERA GIA TIN ENERGEIA KATHE EARLY PATH.
        const bands = BAND_CENTERS.map(
          (_, i) =>
            (directivity[i] *
              Math.pow(1 - materials.walls[i], imageX.order + imageZ.order) *
              Math.pow(1 - materials.floor[i], imageY.lower) *
              Math.pow(1 - materials.ceiling[i], imageY.upper) *
              scatteringSurvival(scattering, i, imageX.order + imageZ.order, imageY.lower, imageY.upper) *
              Math.pow(10, (-scene.airDbPerMeter[i] * length) / 10)) /
            (4 * Math.PI * length * length),
        ) as Bands;
        arrivals.push({
          time: length / scene.speed,
          distance: length,
          order,
          direction,
          imagePosition: image,
          pan: directionPan(direction, scene.listenerForward),
          energyBands: bands,
          energy: bands.reduce((sum, band) => sum + band, 0) / 8,
          kind: order === 0 ? 'direct' : 'specular',
        });
      }
    }
  }
  return arrivals.sort((first, second) => first.time - second.time);
}

// Eyring reverberation time per octave band
// RT60 = 0.161 * V / (-S * ln(1-a) + 4*m*V)
export function eyringBands(scene: Scene): Bands {
  const [width, height, depth] = scene.dimensions;
  const materials = effectiveMaterials(scene);
  const area = 2 * (width * height + width * depth + height * depth);
  const volume = width * height * depth;
  return BAND_CENTERS.map((_, i) => {
    const average =
      (2 * height * (width + depth) * materials.walls[i] +
        width * depth * (materials.floor[i] + materials.ceiling[i])) /
      area;
    // EDW ME EYRING KAI APWLEIES AERA EKTIMOUME TO RT60 ANA BANDA.
    const boundary = average === 1 ? Infinity : -area * Math.log1p(-average);
    const air = (4 * volume * scene.airDbPerMeter[i] * Math.LN10) / 10;
    return boundary + air === 0 ? Infinity : (0.161 * volume) / (boundary + air);
  }) as Bands;
}

// RT60 at 1kHz only
export function eyringRT60(scene: Scene): number {
  return eyringBands(scene)[4];
}

// energy histogram - sum arrival energy per time bin
export function energyHistogram(arrivals: Arrival[], duration = 2, binSeconds = 0.002): Float64Array {
  const bins = new Float64Array(Math.ceil(duration / binSeconds));
  for (const arrival of arrivals) {
    const i = Math.floor(arrival.time / binSeconds);
    if (i >= 0 && i < bins.length) {
      bins[i] += arrival.energy;
    }
  }
  return bins;
}

// Schroeder backward integration in dB, clamped at -90dB
export function decayDb(bins: Float64Array): Float64Array {
  const out = new Float64Array(bins.length);
  let total = 0;
  // EDW ATHROIZOUME TIN ENERGEIA APO TO TELOS PROS TIN ARXI GIA TIN KAMPYLI SCHROEDER.
  for (let i = bins.length - 1; i >= 0; i--) {
    total += bins[i];
    out[i] = total;
  }
  return out.map((v) => 10 * Math.log10(Math.max(v / Math.max(total, 1e-30), 1e-9)));
}
