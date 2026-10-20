import type { LateLayout } from '../audio/dsp/late-fdn.mjs';

// Layout of a non-standard network.
export interface LateFieldLayout {
  lines: number;
  ratioRange: [number, number];
  minDelayBaseSeconds: number;
}

// One selectable layout of the late field.
export interface LateFieldProfile {
  id: string;
  label: string;
  description: string;
  // null = the standard network, unchanged.
  layout: LateFieldLayout | null;
}

// The shipped profiles.
export const LATE_FIELD_PROFILES: LateFieldProfile[] = [
  {
    id: 'standard',
    label: 'Standard (8 lines)',
    description: 'Eight delay lines per band, scaled by the mean free time (the network before Task O).',
    layout: null,
  },
  {
    id: 'dense',
    label: 'Dense (32 lines)',
    description:
      'Thirty-two lines per band, 0.55 to 2.0 times a delay base of at least 60 ms: many more resonances, so the late field is noise-like instead of metallic.',
    layout: { lines: 32, ratioRange: [0.55, 2], minDelayBaseSeconds: 0.06 },
  },
];

// Profile the application starts with. It must exist in the table.
export const DEFAULT_LATE_FIELD_PROFILE = 'dense';

// Throws a readable error when a profile table is inconsistent.
export function validateLateFieldProfiles(
  profiles: LateFieldProfile[] = LATE_FIELD_PROFILES,
  defaultId: string = DEFAULT_LATE_FIELD_PROFILE,
): void {
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id || seen.has(profile.id))
      throw new Error(`Late field profile "${profile.id}": missing or repeated id.`);
    seen.add(profile.id);
    const layout = profile.layout;
    if (!layout) continue;
    const [shortest, longest] = layout.ratioRange;
    if (layout.lines < 8 || (layout.lines & (layout.lines - 1)) !== 0)
      throw new Error(`Late field profile "${profile.id}": lines must be a power of two, 8 or more.`);
    if (!(shortest > 0 && longest > shortest))
      throw new Error(`Late field profile "${profile.id}": ratioRange must be increasing and positive.`);
    if (!(layout.minDelayBaseSeconds >= 0 && Number.isFinite(layout.minDelayBaseSeconds)))
      throw new Error(`Late field profile "${profile.id}": minDelayBaseSeconds must be >= 0.`);
  }
  if (!seen.has(defaultId)) throw new Error(`Default late field profile "${defaultId}" is not in the table.`);
}

// The profile with this id; throws for an unknown id.
export function getLateFieldProfile(
  id: string,
  profiles: LateFieldProfile[] = LATE_FIELD_PROFILES,
): LateFieldProfile {
  const profile = profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error(`Unknown late field profile "${id}".`);
  return profile;
}

export function lateLayoutOf(profile: LateFieldProfile): LateLayout | undefined {
  const layout = profile.layout;
  if (!layout) return undefined;
  const [shortest, longest] = layout.ratioRange;
  return {
    delayRatios: Array.from(
      { length: layout.lines },
      (_, line) => shortest * (longest / shortest) ** (line / (layout.lines - 1)),
    ),
    minDelayBase: layout.minDelayBaseSeconds,
  };
}
