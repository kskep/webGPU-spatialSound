// checks whether the current scene can be traced
import type { Scene } from '../acoustics/model';
import { insideObject, objectsOutsideRoom, type SceneObject } from './acoustic-scene';

// returns an error message if the scene can't be traced, or undefined if it's fine
export function describeSceneProblem(
  scene: Scene,
  objects: SceneObject[],
  tracer: 'mesh' | 'shoebox',
): string | undefined {
  if (objects.length === 0) return undefined;

  if (tracer === 'shoebox') {
    return 'The analytic shoebox tracer cannot model scene objects. Choose "BVH mesh" or set Furniture Scene to None.';
  }

  const outside = objectsOutsideRoom(scene, objects);
  if (outside.length > 0) {
    const [width, height, depth] = scene.dimensions;
    const names = outside.map((object) => object.name).join(', ');
    return `Scene objects do not fit this ${width} x ${height} x ${depth} m room (${names}). Pick a larger room preset or set Furniture Scene to None.`;
  }

  const sourceBlocker = insideObject(scene.source, objects, scene.receiverRadius);
  if (sourceBlocker)
    return `The sound source is inside "${sourceBlocker.name}". Move it out of the object to trace.`;

  const listenerBlocker = insideObject(scene.listener, objects, scene.receiverRadius);
  if (listenerBlocker)
    return `The listener (camera) is inside "${listenerBlocker.name}". Move out of the object to trace.`;

  return undefined;
}
