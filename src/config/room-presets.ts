import { BAND_CENTERS, type Bands, type Vec3 } from '../acoustics/model.ts';
import { getLibraryMaterial } from './materials-library.ts';
import { BRAS_CR2_CONDITIONS, BRAS_CR2_OMNI_POSES, BRAS_CR2_ROOM, appPoint } from './bras-cr2.ts';

// Share of a surface covered by one library material.
export interface MaterialShare {
  // Id of an entry of MATERIALS_LIBRARY.
  material: string;
  // Fraction of the surface area, 0 ... 1. The fractions of a surface sum to 1.
  fraction: number;
}

// What a surface is made of, as an area-weighted mix, and why.
export interface SurfaceMix {
  shares: MaterialShare[];
  // Why this mix stands for the surface of this room.
  note: string;
}

// Realistic range of the mid-band Eyring reverberation time of a room type.
export interface Rt60Target {
  minSeconds: number;
  maxSeconds: number;
  // Source or short justification of the range.
  basis: string;
}

export interface RoomPresetConfig {
  name: string;
  description: string;
  dimensions: Vec3;
  walls: SurfaceMix;
  ceiling: SurfaceMix;
  floor: SurfaceMix;
  source: Vec3;
  listener: Vec3;
  target: Rt60Target;
  maxBassRatio?: number;
  // Why the default positions were chosen.
  positionNote: string;
  validation?: boolean;
  air?: { temperatureCelsius: number; relativeHumidityPercent: number };
}

// Largest allowed ratio of the 63 Hz or 125 Hz reverberation time to the mid-band one.
export const MAX_BASS_RATIO = 1.5;

// Allowed height of the listener's ears above the floor, in metres.
export const LISTENER_EAR_HEIGHT = { min: 1.2, max: 1.7 } as const;

// Distance in metres the listener keeps from every wall, unless the room is too small for it.
export const MIN_WALL_CLEARANCE = 1;

// In a room whose smallest horizontal dimension is d, the clearance can be at most this fraction of d.
export const SMALL_ROOM_CLEARANCE_FRACTION = 0.25;

// Space kept between a source or listener and the walls, as in validateScene (receiver radius).
export const POSITION_MARGIN = 0.25;

// Key of the preset the app starts with. It must exist in the table.
export const DEFAULT_ROOM_PRESET = 'RECORDING_STUDIO';

const share = (material: string, fraction: number): MaterialShare => ({ material, fraction });

// The shipped presets, keyed by the id the dropdown stores.
export const ROOM_PRESETS: Record<string, RoomPresetConfig> = {
  CATHEDRAL: {
    name: 'Cathedral',
    description: 'Large stone cathedral with a long, bass-controlled reverberation',
    dimensions: [30, 40, 50],
    walls: {
      shares: [
        share('stone-masonry', 0.5),
        share('glass-window', 0.2),
        share('wood-panel-thin', 0.1),
        share('heavy-velour-curtain', 0.15),
        share('wood-door', 0.05),
      ],
      note: 'Stone walls with large stained-glass windows (a fifth of the area), timber screens, choir stalls and doors, and hanging banners and tapestries. The glass and the timber give the low-frequency absorption that a bare stone wall lacks.',
    },
    ceiling: {
      shares: [share('plaster-on-masonry', 0.7), share('wood-panel-thin', 0.3)],
      note: 'A plastered vault with timber roof structure and boarding showing in places.',
    },
    floor: {
      shares: [share('stone-masonry', 0.6), share('wood-pews-empty', 0.4)],
      note: 'Stone paving with unoccupied wooden pews over about 40 percent of the nave.',
    },
    source: [0, 1.7, -15],
    listener: [0, 1.6, -3],
    target: {
      minSeconds: 4,
      maxSeconds: 8,
      basis:
        'Large stone churches and cathedrals: about 4 to 8 s at mid frequencies, unoccupied (Kuttruff, Room Acoustics; Beranek, Concert Halls and Opera Houses).',
    },
    positionNote:
      'Speaker or choir at the chancel end, 10 m from the end wall; listener standing in the nave 12 m away, on the centre line between the columns of the Cathedral Columns scene.',
  },

  RECORDING_STUDIO: {
    name: 'Recording Studio',
    description: 'Professional recording studio with broadband absorption, including bass traps',
    dimensions: [6, 3, 5],
    walls: {
      shares: [
        share('porous-absorber-100mm', 0.15),
        share('porous-absorber-200mm', 0.2),
        share('gypsum-board-on-studs', 0.65),
      ],
      note: 'Plasterboard walls with 100 mm absorber panels over 15 percent of the area and 200 mm bass traps over a fifth (corners and the wall behind the monitors).',
    },
    ceiling: {
      shares: [share('porous-absorber-100mm', 0.3), share('gypsum-board-on-studs', 0.7)],
      note: 'Plasterboard ceiling with an absorbing cloud over 30 percent of it.',
    },
    floor: {
      shares: [share('wood-floor-on-joists', 0.5), share('carpet-heavy-on-concrete', 0.5)],
      note: 'Floating wood floor with a heavy rug over half of it.',
    },
    source: [0, 1.6, -0.8],
    listener: [0, 1.2, 1.5],
    target: {
      minSeconds: 0.2,
      maxSeconds: 0.5,
      basis: 'Recording and control rooms are treated to about 0.2 to 0.5 s (common studio design practice).',
    },
    positionNote:
      'Vocalist or instrument standing at the room centre, listener at the seated mixing position 1 m from the back wall.',
  },

  CONCERT_HALL: {
    name: 'Concert Hall',
    description: 'Symphony concert hall with an occupied audience and wood-lined walls',
    dimensions: [25, 15, 40],
    walls: {
      shares: [
        share('wood-panel-thin', 0.4),
        share('plaster-on-masonry', 0.45),
        share('wood-door', 0.05),
        share('heavy-velour-curtain', 0.1),
      ],
      note: 'Timber lining and plaster, doors, and the curtains and balcony faces that the shoebox leaves out.',
    },
    ceiling: {
      shares: [share('plaster-on-lath', 0.7), share('wood-panel-solid', 0.3)],
      note: 'A heavy plaster ceiling with coffers and timber reflectors.',
    },
    floor: {
      shares: [share('audience-upholstered-seats', 0.85), share('wood-floor-on-joists', 0.15)],
      note: 'The floor of the model stands for the stalls and the balconies: 85 percent occupied upholstered seating and 15 percent wooden stage and aisles.',
    },
    source: [0, 1.6, -14],
    listener: [0, 1.2, 0],
    target: {
      minSeconds: 1.8,
      maxSeconds: 2.3,
      basis:
        'Occupied concert halls for symphonic music: about 1.8 to 2.3 s (Beranek, Concert Halls and Opera Houses).',
    },
    positionNote:
      'Soloist or conductor on the stage between the shell walls of the Concert Hall Reflectors scene; listener seated in the stalls 14 m away.',
  },

  HOME_THEATER: {
    name: 'Home Theater',
    description: 'Dedicated home theater with absorbing walls and carpet',
    dimensions: [8, 3, 10],
    walls: {
      shares: [
        share('porous-absorber-100mm', 0.15),
        share('porous-absorber-200mm', 0.15),
        share('heavy-velour-curtain', 0.1),
        share('gypsum-board-on-studs', 0.6),
      ],
      note: 'Plasterboard walls with 100 mm absorber panels at the first reflection points, 200 mm bass traps in the corners, and curtains.',
    },
    ceiling: {
      shares: [share('acoustic-ceiling-tile', 0.5), share('gypsum-board-on-studs', 0.5)],
      note: 'Half acoustic tile, half plasterboard.',
    },
    floor: {
      shares: [share('carpet-heavy-on-concrete', 0.5), share('wood-floor-on-joists', 0.5)],
      note: 'Fitted heavy carpet over half of the floor and wooden riser platforms for the seating rows.',
    },
    source: [0, 1.1, -4.2],
    listener: [0, 1.2, 1.5],
    target: {
      minSeconds: 0.3,
      maxSeconds: 0.5,
      basis:
        'Domestic and small cinema rooms are recommended at about 0.3 to 0.5 s (ITU-R BS.1116 asks for about 0.2 to 0.4 s in critical listening rooms).',
    },
    positionNote:
      'Centre loudspeaker at tweeter height, 0.8 m from the screen wall; listener seated 5.7 m away and 3.5 m from the back wall.',
  },

  CLASSROOM: {
    name: 'Classroom',
    description: 'Classroom with hard walls, an acoustic ceiling and a vinyl floor',
    dimensions: [10, 3, 8],
    walls: {
      shares: [
        share('painted-concrete-block', 0.5),
        share('gypsum-board-on-studs', 0.3),
        share('glass-window', 0.15),
        share('wood-door', 0.05),
      ],
      note: 'Painted block and plasterboard walls, a window wall, and a door.',
    },
    ceiling: {
      shares: [share('acoustic-ceiling-tile', 0.7), share('gypsum-board-on-studs', 0.3)],
      note: 'Suspended mineral-fibre tiles over most of the ceiling.',
    },
    floor: {
      shares: [share('vinyl-on-concrete', 1)],
      note: 'Vinyl on a concrete slab.',
    },
    source: [0, 1.6, -3],
    listener: [0, 1.2, 0.5],
    target: {
      minSeconds: 0.5,
      maxSeconds: 0.8,
      basis:
        'Unoccupied classrooms of this size: about 0.5 to 0.8 s (ANSI S12.60 asks for 0.6 s or less in rooms up to 283 m3).',
    },
    positionNote:
      'Teacher at the board, 1 m from the front wall; a student in the middle of the room, 3.5 m away.',
  },

  BATHROOM: {
    name: 'Bathroom',
    description: 'Small tiled bathroom with a bright, short reverberation',
    dimensions: [2.5, 2.5, 2],
    walls: {
      shares: [
        share('ceramic-tile', 0.55),
        share('glass-plate-heavy', 0.1),
        share('wood-door', 0.1),
        share('light-fabric-draped', 0.25),
      ],
      note: 'Tiled walls with a mirror or shower screen, a door, and the towels and shower curtain that cover about a quarter of the wall.',
    },
    ceiling: {
      shares: [share('gypsum-board-on-studs', 1)],
      note: 'Painted plasterboard ceiling.',
    },
    floor: {
      shares: [share('ceramic-tile', 1)],
      note: 'Tiled floor.',
    },
    source: [0, 1.6, -0.45],
    listener: [0, 1.6, 0.45],
    target: {
      minSeconds: 0.8,
      maxSeconds: 1.5,
      basis:
        'Furnished domestic bathrooms: about 0.8 to 1.5 s (typical measured range; the bare tiled shell alone would be longer).',
    },
    positionNote:
      'The room is 2 m deep, so a 1 m clearance from the walls is impossible; both positions are on the centre line with 0.55 m to the end walls, 0.9 m apart.',
  },

  WOOD_PANEL_ROOM: {
    name: 'Wood Panel Room',
    description: 'Study or library with wood panelling, a rug and furniture',
    dimensions: [7, 3, 6],
    walls: {
      shares: [
        share('wood-panel-thin', 0.3),
        share('wood-panel-solid', 0.25),
        share('plaster-on-masonry', 0.2),
        share('glass-window', 0.1),
        share('heavy-velour-curtain', 0.15),
      ],
      note: 'Wood panelling on over half of the walls (thin boards over battens and solid timber on the masonry), plastered areas, a window, and curtains.',
    },
    ceiling: {
      shares: [share('wood-panel-solid', 0.5), share('plaster-on-lath', 0.5)],
      note: 'Panelled and plastered ceiling.',
    },
    floor: {
      shares: [share('parquet-on-concrete', 0.5), share('carpet-heavy-on-concrete', 0.5)],
      note: 'Wood floor with a rug over half of it.',
    },
    source: [0, 1.6, -1.6],
    listener: [0, 1.2, 1.5],
    target: {
      minSeconds: 0.6,
      maxSeconds: 1.2,
      basis: 'Lightly furnished panelled rooms of about 120 m3: about 0.6 to 1.2 s.',
    },
    positionNote:
      'Speaker standing at one end of the room, listener seated 3.1 m away, 1.5 m from the back wall.',
  },

  BRAS_CR2: {
    name: 'BRAS CR2 seminar room (validation)',
    description:
      'Measured seminar room of the BRAS benchmark, scene CR2 (145 m3, Aachen), as a shoebox with the BRAS fitted surface data. For validation against measurement.',
    validation: true,
    air: {
      temperatureCelsius: BRAS_CR2_CONDITIONS.temperatureCelsius,
      relativeHumidityPercent: BRAS_CR2_CONDITIONS.relativeHumidityPercent,
    },
    dimensions: [...BRAS_CR2_ROOM.dimensions],
    walls: {
      shares: [
        share('bras-cr2-plaster', 0.79),
        share('bras-cr2-concrete', 0.11),
        share('bras-cr2-windows', 0.1),
      ],
      note: 'APPROXIMATION. The four walls become one surface by area. Three walls are painted plaster (79 percent of the wall area). The fourth, the window wall, is 4 windows of about 1.2 m by 1.7 m (8.3 m2, 10 percent of all wall area) and concrete parapet and piers (the rest, 11 percent). The window sizes are estimated from the BRAS renders and photographs, the SketchUp model was not read for them; the door of the front wall, the radiators, the pipes and the cable ducts are left out, as BRAS leaves out their surface properties. The shares are therefore uncertain by a few percent of the wall area.',
    },
    ceiling: {
      shares: [share('bras-cr2-ceiling', 1)],
      note: 'The BRAS ceiling material over the whole ceiling (the beams and the light fittings of the real ceiling are not modelled).',
    },
    floor: {
      shares: [share('bras-cr2-floor', 1)],
      note: 'The BRAS floor material over the whole floor.',
    },
    source: appPoint(BRAS_CR2_OMNI_POSES.sources[1].position),
    listener: appPoint(BRAS_CR2_OMNI_POSES.receivers[1].position),
    target: {
      minSeconds: 1.7,
      maxSeconds: 2.4,
      basis:
        'Measured T30 of BRAS scene CR2, mean of the 500 Hz and 1 kHz bands over the ten omnidirectional positions: 1.98 s (docs/validation/BRAS_CR2.md). The range is -15 percent to +20 percent of it: the Eyring time of a box varies roughly as 1 over its surface area, which is known to only 5 to 10 percent here, and the window and concrete shares are estimated. The Eyring time of the preset (about 2.28 s) lies inside the range but 15 percent above the measurement.',
    },
    positionNote:
      'Loudspeaker LS2 and microphone MP2 of the BRAS measurement, mapped to the app frame (src/config/bras-cr2.ts). The other positions are in that file.',
  },

  ANECHOIC_CHAMBER: {
    name: 'Anechoic Chamber',
    description: 'Chamber lined with absorbing wedges that removes reflections',
    dimensions: [4, 3, 4],
    walls: {
      shares: [share('anechoic-wedge', 1)],
      note: 'Wedge lining on all walls.',
    },
    ceiling: {
      shares: [share('anechoic-wedge', 1)],
      note: 'Wedge lining.',
    },
    floor: {
      shares: [share('anechoic-wedge', 1)],
      note: 'Wedge lining below a wire-mesh floor.',
    },
    source: [0, 1.5, -0.9],
    listener: [0, 1.5, 0.9],
    target: {
      minSeconds: 0,
      maxSeconds: 0.1,
      basis:
        'An anechoic chamber has no audible reverberation; ISO 3745 requires the free-field condition above the cut-off frequency, so the RT60 is far below 0.1 s.',
    },
    positionNote: 'A 1.8 m measuring distance on the centre line, 1.1 m from the end walls.',
  },
};

export function mixAbsorption(mix: SurfaceMix): Bands {
  const result = new Array<number>(BAND_CENTERS.length).fill(0);
  for (const { material, fraction } of mix.shares) {
    const { absorption } = getLibraryMaterial(material);
    // EDW KANOUME AREA-WEIGHTED MESO ORO GIA TIN APORROFISI MIAS MIKTIS EPIFANEIAS.
    for (let band = 0; band < result.length; band++) result[band] += fraction * absorption[band];
  }
  return result as Bands;
}

export function mixScattering(mix: SurfaceMix): Bands {
  const result = new Array<number>(BAND_CENTERS.length).fill(0);
  for (const { material, fraction } of mix.shares) {
    const { scattering } = getLibraryMaterial(material);
    for (let band = 0; band < result.length; band++) result[band] += fraction * scattering[band];
  }
  return result as Bands;
}

// Throws a readable error when a surface mix is not usable.
function validateSurfaceMix(mix: SurfaceMix, label: string): void {
  if (!Array.isArray(mix?.shares) || mix.shares.length === 0) {
    throw new Error(`${label} needs at least one material.`);
  }
  if (typeof mix.note !== 'string' || mix.note.trim() === '') {
    throw new Error(`${label} needs a note that says why the mix stands for the surface.`);
  }
  let total = 0;
  for (const { material, fraction } of mix.shares) {
    getLibraryMaterial(material); // throws for an unknown material
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new Error(
        `${label}: the share of "${material}" must be above 0 and at most 1 (got ${fraction}).`,
      );
    }
    total += fraction;
  }
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`${label}: the shares must sum to 1 (they sum to ${total}).`);
  }
}

// Distance in metres from `point` to the nearest of the four vertical walls of `dimensions`.
export function distanceToWalls(point: Vec3, dimensions: Vec3): number {
  return Math.min(dimensions[0] / 2 - Math.abs(point[0]), dimensions[2] / 2 - Math.abs(point[2]));
}

// Wall clearance the listener must keep in a room of these dimensions.
export function requiredWallClearance(dimensions: Vec3): number {
  return Math.min(MIN_WALL_CLEARANCE, SMALL_ROOM_CLEARANCE_FRACTION * Math.min(dimensions[0], dimensions[2]));
}

// Throws a readable error when `preset` is not usable. `key` names it in the message.
export function validateRoomPreset(key: string, preset: RoomPresetConfig): void {
  const name = `Room preset "${key}"`;
  if (typeof preset?.name !== 'string' || preset.name.trim() === '') {
    throw new Error(`${name} needs a name for the dropdown.`);
  }
  if (typeof preset.description !== 'string') {
    throw new Error(`${name} needs a description (it may be an empty string).`);
  }
  const { dimensions, source, listener } = preset;
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 3 ||
    dimensions.some((v) => !Number.isFinite(v) || v < 2 || v > 100)
  ) {
    throw new Error(`${name}: dimensions must be three numbers between 2 and 100 metres.`);
  }
  validateSurfaceMix(preset.walls, `${name} walls`);
  validateSurfaceMix(preset.ceiling, `${name} ceiling`);
  validateSurfaceMix(preset.floor, `${name} floor`);
  const { target } = preset;
  if (
    !Number.isFinite(target?.minSeconds) ||
    !Number.isFinite(target?.maxSeconds) ||
    target.minSeconds < 0 ||
    target.maxSeconds <= target.minSeconds
  ) {
    throw new Error(`${name}: the RT60 target needs 0 <= minSeconds < maxSeconds.`);
  }
  if (typeof target.basis !== 'string' || target.basis.trim() === '') {
    throw new Error(`${name}: the RT60 target needs a basis (a citation or a short justification).`);
  }
  if (preset.maxBassRatio !== undefined && !(preset.maxBassRatio >= 1)) {
    throw new Error(`${name}: maxBassRatio must be at least 1.`);
  }
  if (typeof preset.positionNote !== 'string' || preset.positionNote.trim() === '') {
    throw new Error(`${name} needs a note that says why the default positions were chosen.`);
  }
  for (const [role, point] of [
    ['source', source],
    ['listener', listener],
  ] as const) {
    const inside =
      Array.isArray(point) &&
      point.length === 3 &&
      point.every(Number.isFinite) &&
      distanceToWalls(point, dimensions) > POSITION_MARGIN &&
      point[1] > POSITION_MARGIN &&
      point[1] < dimensions[1] - POSITION_MARGIN;
    if (!inside) throw new Error(`${name}: the ${role} must be inside the room, away from the walls.`);
  }
  if (listener[1] < LISTENER_EAR_HEIGHT.min || listener[1] > LISTENER_EAR_HEIGHT.max) {
    throw new Error(
      `${name}: the listener's ear height must be between ${LISTENER_EAR_HEIGHT.min} and ${LISTENER_EAR_HEIGHT.max} m (got ${listener[1]}).`,
    );
  }
  const clearance = requiredWallClearance(dimensions);
  if (distanceToWalls(listener, dimensions) < clearance - 1e-9) {
    throw new Error(`${name}: the listener must be at least ${clearance} m from every wall.`);
  }
}

// Validates the whole table: every preset and the default key. Called at startup (main.ts) and by the tests.
export function validateRoomPresetTable(table: Record<string, RoomPresetConfig> = ROOM_PRESETS): void {
  for (const [key, preset] of Object.entries(table)) validateRoomPreset(key, preset);
  if (!(DEFAULT_ROOM_PRESET in table)) {
    throw new Error(`The default room preset "${DEFAULT_ROOM_PRESET}" is missing from the table.`);
  }
}

// Looks up a preset by key. Throws a readable error for an unknown key.
export function getRoomPreset(key: string): RoomPresetConfig {
  const preset = ROOM_PRESETS[key];
  if (!preset) {
    throw new Error(`Unknown room preset "${key}". Known presets: ${Object.keys(ROOM_PRESETS).join(', ')}.`);
  }
  return preset;
}

export function registerRoomPreset(key: string, preset: RoomPresetConfig): () => void {
  validateRoomPreset(key, preset);
  if (key in ROOM_PRESETS) throw new Error(`Room preset "${key}" is already registered.`);
  ROOM_PRESETS[key] = preset;
  return () => {
    delete ROOM_PRESETS[key];
  };
}
