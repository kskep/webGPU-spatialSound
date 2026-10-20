// Energy weights are g(theta)^2 / N, normalised to the power of an omni source.
import {
  DEFAULT_SOURCE_FORWARD,
  NORMALISATION_QUADRATURE_STEPS,
  getDirectivityPattern,
  type DirectivityPattern,
} from '../config/directivity.ts';
import type { Bands, Vec3 } from './model.ts';

function energyGain(pattern: DirectivityPattern, band: number, cosTheta: number): number {
  const alpha = pattern.alpha[band];
  const base = Math.abs(alpha + (1 - alpha) * cosTheta);
  const pressure = Math.pow(base, pattern.exponent[band]);
  // EDW METATREPOUME TO PRESSURE GAIN SE ENERGY GAIN GIA TO VAROS TOU RAY.
  return pressure * pressure;
}

const normalisationCache = new Map<string, Bands>();

// mean of g^2 over sphere by midpoint quadrature
export function patternNormalisation(pattern: DirectivityPattern): Bands {
  const key = JSON.stringify([pattern.alpha, pattern.exponent, NORMALISATION_QUADRATURE_STEPS]);
  const cached = normalisationCache.get(key);
  if (cached) {
    return cached;
  }

  const steps = NORMALISATION_QUADRATURE_STEPS;
  const normalisation = pattern.alpha.map((alpha, band) => {
    // omni case - no need to integrate
    if (alpha === 1) {
      return 1;
    }

    let sum = 0;
    // EDW PROSEGGIZOUME TON MESO ORO PANW STI SFAIRA GIA NA EXOUN TA PATTERNS TIN IDIA SYNOLIKI ISXY.
    for (let step = 0; step < steps; step++) {
      const cosTheta = -1 + (2 * (step + 0.5)) / steps;
      sum += energyGain(pattern, band, cosTheta);
    }
    return sum / steps;
  }) as Bands;

  normalisationCache.set(key, normalisation);
  return normalisation;
}

export function directivityIndexDb(pattern: DirectivityPattern): Bands {
  return patternNormalisation(pattern).map((normalisation) => 10 * Math.log10(1 / normalisation)) as Bands;
}

export function directivityEnergyWeights(pattern: DirectivityPattern, cosTheta: number): Bands {
  const normalisation = patternNormalisation(pattern);
  const clamped = Math.max(-1, Math.min(1, cosTheta));
  return pattern.alpha.map((_, band) => energyGain(pattern, band, clamped) / normalisation[band]) as Bands;
}

export function normalise(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 1e-12) {
    throw new Error('Source forward vector must be a finite, non-zero direction.');
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function sourceDirectivityWeights(
  scene: { sourceDirectivity: string; sourceForward: Vec3 },
  emissionDirection: Vec3,
): Bands {
  const pattern = getDirectivityPattern(scene.sourceDirectivity);
  const forward = normalise(scene.sourceForward);
  const direction = normalise(emissionDirection);
  const cosTheta = forward[0] * direction[0] + forward[1] * direction[1] + forward[2] * direction[2];
  return directivityEnergyWeights(pattern, cosTheta);
}

// emission direction for an image-source path
// the real direction is the unfolded direction with odd-reflection axes flipped
export function imageEmissionDirection(
  image: Vec3,
  listener: Vec3,
  axisReflections: [number, number, number],
): Vec3 {
  const unfolded: Vec3 = [listener[0] - image[0], listener[1] - image[1], listener[2] - image[2]];
  const length = Math.hypot(unfolded[0], unfolded[1], unfolded[2]);
  return unfolded.map((component, axis) => {
    const flip = axisReflections[axis] % 2 === 1 ? -1 : 1;
    return (flip * component) / length;
  }) as Vec3;
}

export function forwardFromAngles(yawDegrees: number, pitchDegrees: number): Vec3 {
  const yaw = (yawDegrees * Math.PI) / 180;
  const pitch = (pitchDegrees * Math.PI) / 180;
  return [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
}

export function anglesFromForward(forward: Vec3): { yaw: number; pitch: number } {
  const unit = normalise(forward);
  const yaw = (Math.atan2(unit[0], unit[2]) * 180) / Math.PI;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, unit[1]))) * 180) / Math.PI;
  return { yaw, pitch };
}

export function defaultForward(): Vec3 {
  return [...DEFAULT_SOURCE_FORWARD];
}
