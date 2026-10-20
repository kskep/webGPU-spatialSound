export interface LateConfig {
  sampleRate: number;
  volume: number;
  surfaceArea: number;
  speed: number;
  meanFreeTime: number;
  rt60Bands: number[];
  // Delay-length ratios per line (power-of-two count, 8 or more); absent = the standard 8-line layout.
  delayRatios?: number[];
  // Shortest mean free time (seconds) the delay lengths are scaled by; absent = the mean free time itself.
  minDelayBase?: number;
  // Target interaural coherence per band (63 Hz... 8 kHz) the mixing was designed for; informational.
  interauralCoherence?: number[];
  // Per-band 2x2 left/right mixing matrices, flat: [m11, m12, m21, m22] for each of the 8 bands.
  coherenceMix?: number[];
}
export interface LatePrefix {
  left: Float32Array[];
  right: Float32Array[];
}
export function makeLateConfig(
  sampleRate: number,
  dimensions: number[],
  rt60Bands: number[],
  speed?: number,
  stats?: { volume: number; surfaceArea: number },
  layout?: LateLayout,
): LateConfig;
export interface LateLayout {
  delayRatios?: number[];
  minDelayBase?: number;
}
export const STANDARD_DELAY_RATIOS: number[];
export const DECAY_RAMP_SECONDS: number;
export const COHERENCE_RAMP_SECONDS: number;
export function mixedLeft(mix: ArrayLike<number>, offset: number, left: number, right: number): number;
export function mixedRight(mix: ArrayLike<number>, offset: number, left: number, right: number): number;
export function designCoherenceMix(
  prefix: LatePrefix,
  coherence: ArrayLike<number>,
  length: number,
  regularisation?: number,
): number[];
export function applyCoherenceMix(prefix: LatePrefix, mix: ArrayLike<number>, length: number): LatePrefix;
export class LateFdn {
  constructor(config: LateConfig);
  config: LateConfig;
  buffers: Float32Array[][];
  lines: number;
  bandL: Float64Array;
  bandR: Float64Array;
  setDecay(rt60Bands: number[], rampSeconds?: number): void;
  setCoherenceMix(mix: number[] | null | undefined, rampSeconds?: number): void;
  tick(input: number): void;
}
export function latePrefix(config: LateConfig, length: number): LatePrefix;
