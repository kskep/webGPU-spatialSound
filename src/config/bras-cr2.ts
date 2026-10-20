import type { Vec3 } from '../acoustics/model.ts';

// Path of the scene folder under external/bras (git-ignored; the listening page serves it in dev only).
export const BRAS_CR2_FOLDER = 'CR2/1 Scene descriptions/CR2 small room (seminar room)';

export const BRAS_CR2_ROOM = {
  // Width (BRAS x), height, depth (BRAS y) of the shoebox in metres: the app's `dimensions` order.
  dimensions: [5.86, 2.988, 8.28] as Vec3,
  // BRAS x and y of the centre of the room, in metres.
  centre: [0.105, -0.033] as [number, number],
  // Volume documented by BRAS, in cubic metres (Documentation, scene CR2).
  documentedVolume: 145,
} as const;

// Conditions during the measurement (BRAS documentation, scene CR2).
export const BRAS_CR2_CONDITIONS = {
  temperatureCelsius: 19.5,
  relativeHumidityPercent: 41.7,
  // Sampling rate of every measured response.
  sampleRate: 44100,
} as const;

// A measurement position in BRAS coordinates (metres).
export interface BrasPoint {
  id: string;
  // Position in the BRAS frame (x, y horizontal, z up).
  position: Vec3;
}

export const BRAS_CR2_OMNI_POSES = {
  sources: [
    { id: 'LS1', position: [0.931, -2.547, 0.723] },
    { id: 'LS2', position: [0.119, 2.88, 0.723] },
  ] as BrasPoint[],
  receivers: [
    { id: 'MP1', position: [-0.993, 1.426, 1.23] },
    { id: 'MP2', position: [0.439, -0.147, 1.23] },
    { id: 'MP3', position: [1.361, -0.603, 1.23] },
    { id: 'MP4', position: [-1.11, -0.256, 1.23] },
    { id: 'MP5', position: [-0.998, -1.409, 1.23] },
  ] as BrasPoint[],
} as const;

export const BRAS_CR2_BINAURAL_POSES = {
  sources: [
    { id: 'LS3', position: [1.498, -1.974, 1.026] },
    { id: 'LS4', position: [0.758, -3.17, 1.026] },
    { id: 'LS5', position: [-0.746, -3.17, 1.03] },
    { id: 'LS6', position: [-1.502, -1.974, 0.816] },
    { id: 'LS7', position: [0, -1.974, 1.5] },
  ] as BrasPoint[],
  receiver: { id: 'MP6', position: [0, 2.026, 1.23] } as BrasPoint,
  // Direction the head faces for HATO 0, in the BRAS frame.
  headForward: [0, -1, 0] as Vec3,
} as const;

// Names of the measured files, relative to `BRAS_CR2_FOLDER`.
export const BRAS_CR2_FILES = {
  // Omnidirectional response of loudspeaker `ls` (1 or 2) at microphone `mp` (1 to 5).
  rir: (ls: number, mp: number): string => `RIRs/wav/CR2_RIR_LS${ls}_MP${mp}_Dodecahedron.wav`,
  // Binaural response of loudspeaker `ls` (3 to 7) at MP6, head orientation 0 degrees (two channels: left, right).
  brir: (ls: number): string => `BRIRs/wav/CR2_BRIR_LS${ls}_MP6_HATO0.wav`,
} as const;

// Maps a BRAS position (or direction offset when `isDirection`) to the app frame; see the file header.
export function braSToApp(point: Vec3, isDirection = false): Vec3 {
  const [centreX, centreY] = isDirection ? [0, 0] : BRAS_CR2_ROOM.centre;
  return [point[0] - centreX, point[2], -(point[1] - centreY)];
}

// Position of a BRAS point in the app frame, rounded to millimetres.
export function appPoint(point: Vec3): Vec3 {
  return braSToApp(point).map((value) => Math.round(value * 1000) / 1000) as Vec3;
}
