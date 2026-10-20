import { effectiveMaterials, effectiveScattering, type Scene } from '../acoustics/model.ts';
import type { SceneObject } from './acoustic-scene.ts';

// JSON key that identifies the acoustic geometry of a scene.
// Includes dimensions, shell absorption/scattering, and objects.
// Does NOT include listener/source position, rays, bounces, etc. (those go in the uniform buffer).
export function geometryKey(scene: Scene, objects: SceneObject[]): string {
  const shell = effectiveMaterials(scene);
  const shellScattering = effectiveScattering(scene);
  return JSON.stringify({
    dimensions: scene.dimensions,
    walls: shell.walls,
    floor: shell.floor,
    ceiling: shell.ceiling,
    scattering: [shellScattering.walls, shellScattering.floor, shellScattering.ceiling],
    objects: objects.map((object) => [object.center, object.size, object.material]),
  });
}
