// Packs source directivity into the tracers' uniform buffer (seven vec4f at the end of Params).
import { getDirectivityPattern } from '../config/directivity.ts';
import { normalise, patternNormalisation } from '../acoustics/directivity.ts';
import type { Scene } from '../acoustics/model.ts';

// first directivity float in the uniform buffer
export const DIRECTIVITY_FLOAT_OFFSET = 52;

// size of the Params uniform block in bytes (52 + 28 directivity floats)
export const PARAMS_UNIFORM_BYTES = (DIRECTIVITY_FLOAT_OFFSET + 28) * 4;

// first shell-scattering float in the shoebox tracer's uniform buffer
// (six vec4f for walls/floor/ceiling bands, plus one vec4f of band means)
export const SHELL_SCATTERING_FLOAT_OFFSET = DIRECTIVITY_FLOAT_OFFSET + 28;

// shoebox tracer's Params block: common block + 28 scattering floats
export const SHOEBOX_UNIFORM_BYTES = (SHELL_SCATTERING_FLOAT_OFFSET + 28) * 4;

// mean of eight float32 band values (shader uses this as the diffuse branch probability)
export function bandMeanScattering(bands: readonly number[]): number {
  let sum = 0;
  for (const value of bands) sum += Math.fround(value);
  return Math.fround(sum / bands.length);
}

// writes directivity fields of scene into the uniform data
export function writeDirectivityUniform(floats: Float32Array, scene: Scene): void {
  const pattern = getDirectivityPattern(scene.sourceDirectivity);
  const forward = normalise(scene.sourceForward);
  const normalisation = patternNormalisation(pattern);

  floats.set([...forward, 0], DIRECTIVITY_FLOAT_OFFSET);
  floats.set(pattern.alpha, DIRECTIVITY_FLOAT_OFFSET + 4);
  floats.set(pattern.exponent, DIRECTIVITY_FLOAT_OFFSET + 12);
  floats.set(normalisation, DIRECTIVITY_FLOAT_OFFSET + 20);
}
