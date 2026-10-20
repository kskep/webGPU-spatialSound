export interface RoomMode {
  n: number[];
  frequency: number;
}
export interface ModalConfig {
  sampleRate: number;
  frequencies: number[];
  rt60s: number[];
}
export interface RoomModeDesignInput {
  dimensions: number[];
  speed: number;
  source: number[];
  listener: number[];
  rt60Bands: number[];
  sampleRate: number;
  windowStart: number;
  windowEnd: number;
  targetDensity: number[];
}
export interface RoomModeDesign {
  config: ModalConfig;
  weights: number[];
  couplings: number[];
  modes: RoomMode[];
  schroederHz: number;
  share: number[];
  scale: number[];
  fdnScale: number[];
}
export const MODAL_BAND_EDGES: number[];
export const MAX_ROOM_MODES: number;
export const MIN_MODE_HZ: number;
export function schroederFrequency(rt60: number, volume: number): number;
export function shoeboxModes(
  dimensions: number[],
  speed: number,
  maxFrequency: number,
  limit?: number,
): RoomMode[];
export function modeShape(n: number[], dimensions: number[], point: number[]): number;
export function modeNorm(n: number[]): number;
export function modeCoupling(n: number[], dimensions: number[], source: number[], listener: number[]): number;
export function modeRt60(frequency: number, rt60Bands: number[]): number;
export function resonatorCoefficients(
  frequency: number,
  rt60: number,
  sampleRate: number,
): { r: number; a1: number; a2: number; g: number };
export function modalShare(band: number, schroeder: number): number;
export function modalBand(frequency: number): number;
export class ModalBank {
  constructor(config: ModalConfig);
  count: number;
  frequencies: number[];
  setDecay(rt60s: number[]): void;
  matches(config: ModalConfig): boolean;
  tick(x: number, weights?: ArrayLike<number> | null, offset?: number): number;
}
export function modalPrefix(config: ModalConfig, weights: ArrayLike<number>, length: number): Float64Array;
export function designRoomModes(input: RoomModeDesignInput): RoomModeDesign;
