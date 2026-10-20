// Bakes depend on two keys: geometry/air/trace settings, and source pose/directivity.
// Listener orientation is excluded because direction bins are fixed in world space.
// Keys use 53 bits from two 32-bit hashes of the serialised settings.
import type { Scene } from '../acoustics/model.ts';
import type { SceneObject } from '../geometry/acoustic-scene.ts';
import { geometryKey } from '../geometry/geometry-key.ts';

// cyrb53 string hash: 53 bits as 14 hexadecimal digits.
export function hashString(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}

// The key of the room (see the file comment for what it covers).
export function sceneKeyOf(scene: Scene, objects: SceneObject[]): string {
  return hashString(
    JSON.stringify({
      geometry: geometryKey(scene, objects),
      air: scene.airDbPerMeter,
      earlyOrder: scene.earlyOrder,
      receiverRadius: scene.receiverRadius,
      speed: scene.speed,
    }),
  );
}

// The key of the source: position, forward vector and directivity pattern.
export function sourceKeyOf(scene: Scene): string {
  return hashString(
    JSON.stringify({
      source: scene.source,
      forward: scene.sourceForward,
      directivity: scene.sourceDirectivity,
    }),
  );
}
