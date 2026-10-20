// Sphere colours and blend lines for the viewport. Selected probes are larger;
// disabled probes are grey. Picking uses slightly enlarged spheres.
import type { Vec3 } from '../acoustics/model.ts';
import { PROBE_COLOURS, PROBE_DRAW } from '../config/probes.ts';
import type { ProbeSet } from './probe-set.ts';

// One sphere.
export interface ProbeSphere {
  id: string;
  position: Vec3;
  radius: number;
  color: [number, number, number];
}

// A line from the listener to a probe in use; `weight` (0 ... 1) sets how bright it is drawn.
export interface BlendLine {
  from: Vec3;
  to: Vec3;
  weight: number;
}

export interface ProbeView {
  spheres: ProbeSphere[];
  lines: BlendLine[];
}

// A probe in use, as the last blend recorded it.
export interface UsedProbe {
  id: string;
  position: Vec3;
  weight: number;
}

export function probeView(
  set: ProbeSet,
  selectedId: string | undefined,
  showProbes: boolean,
  listener: Vec3,
  usedProbes: UsedProbe[] | undefined,
): ProbeView {
  const spheres: ProbeSphere[] = [];
  if (showProbes) {
    for (const probe of set.probes) {
      const selected = probe.id === selectedId;
      const key = probe.enabled ? probe.bakeState : 'disabled';
      const color = selected ? PROBE_COLOURS.selected : PROBE_COLOURS[key];
      let radius = PROBE_DRAW.radius;
      if (selected) radius *= PROBE_DRAW.selectedScale;
      spheres.push({
        id: probe.id,
        position: probe.position,
        radius,
        color: [...color],
      });
    }
  }
  const lines: BlendLine[] = (usedProbes ?? []).map((used) => ({
    from: listener,
    to: used.position,
    weight: used.weight,
  }));
  return { spheres, lines };
}

export function pickProbe(view: ProbeView, origin: Vec3, direction: Vec3, enlarge = 1.6): string | undefined {
  let best: { id: string; t: number } | undefined;
  for (const sphere of view.spheres) {
    const offset = sphere.position.map((value, axis) => value - origin[axis]);
    const along = offset[0] * direction[0] + offset[1] * direction[1] + offset[2] * direction[2];
    if (along <= 0) continue;
    const closest = Math.hypot(...offset.map((value, axis) => value - along * direction[axis]));
    if (closest <= sphere.radius * enlarge && (!best || along < best.t)) best = { id: sphere.id, t: along };
  }
  return best?.id;
}
