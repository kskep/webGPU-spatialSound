import type { Bands } from '../acoustics/model.ts';
import { getLibraryMaterial } from '../config/materials-library.ts';

// eight-band surface description for every acoustic triangle (63 Hz - 8 kHz)
export interface AcousticMaterial {
  absorption: Bands;
  scattering: Bands;
}

// Aliases from old scene files mapped to material library ids.
// Scene files can also use library ids directly (e.g. "stone-masonry").
export const OBJECT_MATERIAL_ALIASES: Record<string, string> = {
  CONCRETE: 'painted-concrete-block',
  WOOD: 'wood-panel-solid',
  GLASS: 'glass-window',
  CURTAIN: 'heavy-velour-curtain',
  CARPET: 'carpet-heavy-on-concrete',
  ACOUSTIC_PANEL: 'porous-absorber-100mm',
};

// resolves alias to library id (case-insensitive) or returns the name as-is
export function resolveObjectMaterialId(name: string): string {
  const alias = name.toUpperCase();
  return Object.hasOwn(OBJECT_MATERIAL_ALIASES, alias) ? OBJECT_MATERIAL_ALIASES[alias] : name;
}

// normalises the stored name: alias in upper case, library id as-is. Throws for unknown names.
export function normalizeObjectMaterialName(name: string): string {
  const materialId = resolveObjectMaterialId(name);
  getLibraryMaterial(materialId);
  if (materialId === name) return name;
  return name.toUpperCase();
}

// absorption and scattering of an object material; throws for unknown names
export function objectMaterial(name: string): AcousticMaterial {
  const { absorption, scattering } = getLibraryMaterial(resolveObjectMaterialId(name));
  return { absorption, scattering };
}
