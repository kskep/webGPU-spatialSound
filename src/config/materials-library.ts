import { BAND_CENTERS, type Bands } from '../acoustics/model.ts';

export interface LibraryMaterial {
  id: string;
  name: string;
  // Absorption coefficient per band, 63 Hz... 8 kHz.
  absorption: Bands;
  // Scattering coefficient per band, 63 Hz... 8 kHz (ISO 17497-1 random incidence).
  scattering: Bands;
  // Where the scattering shape comes from (surface class, typical-value caveat).
  scatteringBasis: string;
  // Origin of the 125 Hz... 4 kHz values.
  source: string;
  // How the 63 Hz and 8 kHz values were obtained (they are outside most published tables).
  lowFrequency: string;
}

// Citation text shared by the entries; it names the kind of source, not a table or page.
const HARD_SURFACE_SOURCE =
  'Typical textbook values for hard building surfaces (Kuttruff, Room Acoustics; Vorländer, Auralization, material data in the appendix; Egan, Architectural Acoustics), rounded.';
const PANEL_SOURCE =
  'Typical textbook values for lightweight panels and linings (Egan or Long, Architectural Acoustics; Cox and D’Antonio, Acoustic Absorbers and Diffusers), rounded.';
const POROUS_SOURCE =
  'Typical values for mineral-wool absorbers of the stated thickness on a rigid backing (Cox and D’Antonio, Acoustic Absorbers and Diffusers; Kuttruff, Room Acoustics, chapter on porous absorbers), rounded.';
const FURNISHING_SOURCE =
  'Typical textbook values for carpet, drapery and seating (Egan or Long, Architectural Acoustics; Beranek, Concert Halls and Opera Houses for seating and audience), rounded.';

// Scattering basis shared by the entries; names the surface class, not a table or page.
const SMOOTH_SCATTERING_BASIS =
  'Typical values for a smooth, flat surface: nearly specular up to 1 kHz and only slowly rising at 4 to 8 kHz, where joints, fixings and small flatness errors start to matter (Vorländer, Auralization, scattering coefficients; Cox and D’Antonio, Acoustic Absorbers and Diffusers). Representative, not measured.';
const ROUGH_SCATTERING_BASIS =
  'Typical values for a rough or block-structured surface: small below 250 Hz, then rising to about 0.4 to 0.55 at 4 to 8 kHz as the roughness approaches the wavelength (Vorländer, Auralization; Rindel on scattering in room-acoustic modelling; ISO 17497-1). Representative, not measured.';
const TEXTURED_SCATTERING_BASIS =
  'Typical values for panelling, boards, perforated tiles and similar lightly structured surfaces (battens, joints, grooves of a few centimetres): about 0.05 below 250 Hz, rising to 0.2 to 0.5 at 4 to 8 kHz (Vorländer, Auralization; Cox and D’Antonio, Acoustic Absorbers and Diffusers). Representative, not measured.';
const FURNISHING_SCATTERING_BASIS =
  'Typical values for carpets, draped fabric, pews and seated audience, whose folds and rows are large against the wavelength: higher than hard surfaces already at mid frequency and about 0.6 to 0.8 at 4 to 8 kHz (Vorländer, Auralization, audience and seating scattering; Beranek, Concert Halls and Opera Houses, qualitatively). Representative, not measured.';

// Citation shared by the BRAS CR2 entries.
const BRAS_SOURCE =
  'BRAS, Benchmark for Room Acoustical Simulation (Aspöck, Brinkmann, Ackermann, Weinzierl, Vorländer; TU Berlin DepositOnce, CC BY-SA 4.0), scene CR2, surface descriptions, fitted estimates. Initial values from in-situ measurements and tabulated data, then multiplied per third-octave band by the ratio that makes the Eyring time of the whole room equal the measured one (BRAS documentation, section 3.2.1). This is therefore a fit, not an independent measurement of the surface.';
const BRAS_SCATTERING_BASIS =
  'BRAS estimate from the characteristic depth of the material, s = 0.5 d_char / (c / f) with a floor of 0.05 (BRAS documentation, section 3.2.2; Vorländer, Auralization). Octave values are the mean of the three third-octave values.';
const BRAS_LOW_FREQUENCY =
  'The 63 Hz and 8 kHz values are part of the BRAS third-octave files (50, 63, 80 Hz and 6.3, 8, 10 kHz are given), so nothing is extrapolated here. BRAS extrapolated its own values below the valid range of its measurements (about 100 Hz) from tabulated data.';

const bands = (values: number[]): Bands => values as Bands;

export const MATERIALS_LIBRARY: LibraryMaterial[] = [
  {
    id: 'stone-masonry',
    name: 'Rough stone masonry (limestone, sandstone)',
    absorption: bands([0.02, 0.02, 0.02, 0.03, 0.04, 0.05, 0.05, 0.06]),
    scattering: bands([0.05, 0.06, 0.08, 0.12, 0.2, 0.3, 0.45, 0.55]),
    scatteringBasis: ROUGH_SCATTERING_BASIS,
    source: HARD_SURFACE_SOURCE,
    lowFrequency:
      '63 Hz held at the 125 Hz value (a massive wall stays reflective down to the lowest band). 8 kHz continues the slow rise.',
  },
  {
    id: 'plaster-on-masonry',
    name: 'Smooth plaster on brick or concrete',
    absorption: bands([0.01, 0.01, 0.02, 0.02, 0.03, 0.04, 0.05, 0.06]),
    scattering: bands([0.02, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: HARD_SURFACE_SOURCE,
    lowFrequency: '63 Hz held at the 125 Hz value. 8 kHz continues the slow rise.',
  },
  {
    id: 'plaster-on-lath',
    name: 'Plaster on lath (suspended or lightweight plaster ceiling)',
    absorption: bands([0.2, 0.14, 0.1, 0.06, 0.05, 0.04, 0.03, 0.03]),
    scattering: bands([0.03, 0.03, 0.04, 0.05, 0.06, 0.08, 0.12, 0.18]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency:
      '63 Hz raised to 0.20: a lightweight plaster membrane over a cavity absorbs more at its low resonance (about 50 to 100 Hz), so the value rises below 125 Hz. Estimate. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'painted-concrete-block',
    name: 'Painted concrete block',
    absorption: bands([0.1, 0.1, 0.05, 0.06, 0.07, 0.09, 0.08, 0.08]),
    scattering: bands([0.05, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.4]),
    scatteringBasis: ROUGH_SCATTERING_BASIS,
    source: HARD_SURFACE_SOURCE,
    lowFrequency: '63 Hz held at the 125 Hz value. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'gypsum-board-on-studs',
    name: 'Gypsum board (13 mm) on studs with a cavity',
    absorption: bands([0.3, 0.29, 0.1, 0.05, 0.04, 0.07, 0.09, 0.09]),
    scattering: bands([0.02, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency:
      '63 Hz held at about the 125 Hz value: a 13 mm board over a cavity is a panel absorber with its resonance near 100 Hz, and it keeps absorbing at 63 Hz. Estimate. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'wood-panel-thin',
    name: 'Thin wood panelling (6 to 12 mm plywood) on battens over an air space',
    absorption: bands([0.4, 0.42, 0.21, 0.1, 0.08, 0.06, 0.06, 0.06]),
    scattering: bands([0.05, 0.05, 0.07, 0.1, 0.15, 0.25, 0.4, 0.5]),
    scatteringBasis: TEXTURED_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency:
      '63 Hz held just below the 125 Hz value: thin panels over an air space are panel absorbers with a resonance between about 60 and 120 Hz. Estimate. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'wood-panel-solid',
    name: 'Solid timber panelling (20 mm or more) on a masonry backing',
    absorption: bands([0.1, 0.1, 0.07, 0.05, 0.04, 0.04, 0.05, 0.05]),
    scattering: bands([0.05, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.4]),
    scatteringBasis: TEXTURED_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency: '63 Hz held at the 125 Hz value. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'wood-door',
    name: 'Solid wood door',
    absorption: bands([0.14, 0.14, 0.1, 0.06, 0.08, 0.1, 0.1, 0.1]),
    scattering: bands([0.03, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3]),
    scatteringBasis: TEXTURED_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency: '63 Hz held at the 125 Hz value. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'glass-window',
    name: 'Ordinary window glass in a frame',
    absorption: bands([0.3, 0.35, 0.25, 0.18, 0.12, 0.07, 0.04, 0.04]),
    scattering: bands([0.02, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.15]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency:
      '63 Hz lowered a little from the 125 Hz value (0.30): a pane absorbs through its low panel resonance, which sits near or below 100 Hz. Estimate. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'glass-plate-heavy',
    name: 'Heavy plate glass or mirror, large pane',
    absorption: bands([0.1, 0.18, 0.06, 0.04, 0.03, 0.02, 0.02, 0.02]),
    scattering: bands([0.01, 0.01, 0.02, 0.02, 0.03, 0.04, 0.05, 0.08]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: HARD_SURFACE_SOURCE,
    lowFrequency:
      '63 Hz lowered to 0.10: a thick pane resonates below 63 Hz, so less of the panel effect is left. Estimate. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'ceramic-tile',
    name: 'Glazed ceramic tile or polished marble on a solid backing',
    absorption: bands([0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02]),
    scattering: bands([0.01, 0.01, 0.02, 0.02, 0.03, 0.04, 0.06, 0.1]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: HARD_SURFACE_SOURCE,
    lowFrequency: '63 Hz and 8 kHz held at the neighbouring band.',
  },
  {
    id: 'vinyl-on-concrete',
    name: 'Vinyl or linoleum on a concrete slab',
    absorption: bands([0.02, 0.02, 0.03, 0.03, 0.03, 0.03, 0.02, 0.02]),
    scattering: bands([0.01, 0.01, 0.02, 0.02, 0.03, 0.04, 0.06, 0.08]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: HARD_SURFACE_SOURCE,
    lowFrequency: '63 Hz and 8 kHz held at the neighbouring band.',
  },
  {
    id: 'parquet-on-concrete',
    name: 'Wood parquet glued to concrete',
    absorption: bands([0.04, 0.04, 0.04, 0.07, 0.06, 0.06, 0.07, 0.07]),
    scattering: bands([0.02, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2]),
    scatteringBasis: TEXTURED_SCATTERING_BASIS,
    source: HARD_SURFACE_SOURCE,
    lowFrequency: '63 Hz held at the 125 Hz value. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'wood-floor-on-joists',
    name: 'Wood floor or stage on joists',
    absorption: bands([0.15, 0.15, 0.11, 0.1, 0.07, 0.06, 0.07, 0.07]),
    scattering: bands([0.03, 0.03, 0.04, 0.06, 0.08, 0.12, 0.18, 0.25]),
    scatteringBasis: TEXTURED_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency:
      '63 Hz held at the 125 Hz value: a sprung wood floor is a panel absorber with a resonance near 100 Hz. Estimate. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'carpet-heavy-on-concrete',
    name: 'Heavy carpet on a concrete slab',
    absorption: bands([0.02, 0.02, 0.06, 0.14, 0.37, 0.6, 0.65, 0.65]),
    scattering: bands([0.05, 0.05, 0.08, 0.15, 0.25, 0.4, 0.55, 0.65]),
    scatteringBasis: FURNISHING_SCATTERING_BASIS,
    source: FURNISHING_SOURCE,
    lowFrequency:
      '63 Hz held at the 125 Hz value: a thin porous layer absorbs almost nothing at low frequencies. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'heavy-velour-curtain',
    name: 'Heavy velour curtain (about 0.5 kg per m2), draped to half area, hung off the wall',
    absorption: bands([0.07, 0.14, 0.35, 0.55, 0.72, 0.7, 0.65, 0.65]),
    scattering: bands([0.1, 0.1, 0.15, 0.25, 0.4, 0.55, 0.65, 0.7]),
    scatteringBasis: FURNISHING_SCATTERING_BASIS,
    source: FURNISHING_SOURCE,
    lowFrequency:
      '63 Hz halved from the 125 Hz value (0.07): the absorption of a hanging fabric falls roughly in proportion to frequency below its useful range. Estimate. 8 kHz held at the 4 kHz value.',
  },
  {
    id: 'light-fabric-draped',
    name: 'Light draped fabric (cotton curtain, towels)',
    absorption: bands([0.02, 0.03, 0.04, 0.11, 0.17, 0.24, 0.35, 0.4]),
    scattering: bands([0.08, 0.08, 0.12, 0.2, 0.3, 0.45, 0.55, 0.6]),
    scatteringBasis: FURNISHING_SCATTERING_BASIS,
    source: FURNISHING_SOURCE,
    lowFrequency:
      '63 Hz falls off from the 125 Hz value (0.02), same reasoning as the velour curtain. 8 kHz continues the rise by a small step. Estimate.',
  },
  {
    id: 'wood-pews-empty',
    name: 'Wooden pews, unoccupied (per m2 of floor covered by pews)',
    absorption: bands([0.1, 0.15, 0.19, 0.22, 0.39, 0.38, 0.3, 0.25]),
    scattering: bands([0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.65, 0.7]),
    scatteringBasis: FURNISHING_SCATTERING_BASIS,
    source: FURNISHING_SOURCE,
    lowFrequency:
      '63 Hz lowered to 0.10 from the 125 Hz value (a pew is a thin wood structure, mostly reflective at low frequencies). Estimate. 8 kHz continues the fall.',
  },
  {
    id: 'audience-upholstered-seats',
    name: 'Audience seated in upholstered seats (per m2 of seating area)',
    absorption: bands([0.45, 0.6, 0.72, 0.8, 0.84, 0.85, 0.85, 0.8]),
    scattering: bands([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8]),
    scatteringBasis: FURNISHING_SCATTERING_BASIS,
    source: FURNISHING_SOURCE,
    lowFrequency:
      '63 Hz lowered to 0.45 from 0.60 at 125 Hz: a seated audience absorbs less in the lowest octave, where bodies and seats are small compared with the wavelength. Estimate. 8 kHz held a little below the 4 kHz value.',
  },
  {
    id: 'acoustic-ceiling-tile',
    name: 'Mineral-fibre acoustic ceiling tile (about 15 mm) in a suspended grid',
    absorption: bands([0.3, 0.35, 0.45, 0.6, 0.75, 0.75, 0.7, 0.65]),
    scattering: bands([0.03, 0.03, 0.05, 0.08, 0.12, 0.2, 0.3, 0.4]),
    scatteringBasis: TEXTURED_SCATTERING_BASIS,
    source: PANEL_SOURCE,
    lowFrequency:
      '63 Hz held a little below the 125 Hz value: the plenum behind the tile gives some low-frequency absorption. Estimate. 8 kHz continues the slow fall.',
  },
  {
    id: 'porous-absorber-100mm',
    name: 'Mineral wool, 100 mm, cloth covered, on a rigid backing',
    absorption: bands([0.2, 0.5, 0.95, 1.0, 1.0, 0.98, 0.95, 0.92]),
    scattering: bands([0.02, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2, 0.3]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: POROUS_SOURCE,
    lowFrequency:
      '63 Hz estimated at 0.20: porous absorbers fall steeply once the thickness is below about a tenth of the wavelength (100 mm against 5.4 m at 63 Hz). 8 kHz continues the slight fall.',
  },
  {
    id: 'porous-absorber-200mm',
    name: 'Mineral wool, 200 mm, cloth covered, on a rigid backing (bass trap)',
    absorption: bands([0.55, 0.95, 1.0, 1.0, 1.0, 0.98, 0.95, 0.92]),
    scattering: bands([0.02, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2, 0.3]),
    scatteringBasis: SMOOTH_SCATTERING_BASIS,
    source: POROUS_SOURCE,
    lowFrequency:
      '63 Hz estimated at 0.55 by the same thickness-to-wavelength argument as the 100 mm absorber (200 mm is twice as thick). 8 kHz continues the slight fall.',
  },
  {
    id: 'anechoic-wedge',
    name: 'Absorbing wedges (mineral wool or foam, about 1.4 m long)',
    absorption: bands([0.98, 0.99, 0.995, 0.995, 0.995, 0.995, 0.995, 0.995]),
    scattering: bands([0.02, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1]),
    scatteringBasis:
      'Low values on purpose: the scattering of a wedge lining is not tabulated and the wedges absorb 98 to 99.5 percent of the energy, so the scattered share of the small remainder has no audible effect. The curve has the usual shape (rising with frequency) at the level of a smooth surface. Estimate.',
    source:
      'Design values of anechoic chambers (cut-off frequency set by the wedge length; a wedge about a quarter of a wavelength long absorbs 99 percent above the cut-off), after Cox and D’Antonio and Kuttruff.',
    lowFrequency:
      '63 Hz estimated at 0.98: a wedge of about 1.4 m is a quarter wavelength near 60 Hz, so the cut-off is at the 63 Hz band and the absorption is a little lower there. Estimate. The coefficient is held below 1 because a coefficient of exactly 1 gives an infinite decay rate.',
  },
  // BRAS scene CR2 : the five surface materials of the measured seminar room.
  // Each curve is the BRAS "fitted estimate" (third-octave file mat_CR2_*.csv) reduced to the app's
  // octave bands by the arithmetic mean of the three third-octave coefficients of the octave
  // (coefficients are energy ratios, so this is the energy average): 63 Hz = 50, 63, 80 Hz; 125 Hz =
  // 100, 125, 160 Hz; and so on up to 8 kHz = 6.3, 8, 10 kHz. Rounded to three decimals.
  // `npm run validate:bras` recomputes them from the CSV files and fails if they differ.
  {
    id: 'bras-cr2-ceiling',
    name: 'BRAS CR2 ceiling, fitted estimate',
    absorption: bands([0.02, 0.086, 0.094, 0.052, 0.048, 0.047, 0.064, 0.051]),
    scattering: bands([0.054, 0.074, 0.105, 0.149, 0.21, 0.297, 0.419, 0.593]),
    scatteringBasis: BRAS_SCATTERING_BASIS,
    source: BRAS_SOURCE,
    lowFrequency: BRAS_LOW_FREQUENCY,
  },
  {
    id: 'bras-cr2-concrete',
    name: 'BRAS CR2 concrete wall, fitted estimate',
    absorption: bands([0.086, 0.092, 0.069, 0.054, 0.058, 0.059, 0.044, 0.04]),
    scattering: bands([0.05, 0.05, 0.05, 0.05, 0.06, 0.085, 0.121, 0.171]),
    scatteringBasis: BRAS_SCATTERING_BASIS,
    source: BRAS_SOURCE,
    lowFrequency: BRAS_LOW_FREQUENCY,
  },
  {
    id: 'bras-cr2-floor',
    name: 'BRAS CR2 floor (grey, hard covering), fitted estimate',
    absorption: bands([0.09, 0.079, 0.081, 0.07, 0.065, 0.062, 0.043, 0.033]),
    scattering: bands([0.05, 0.05, 0.05, 0.05, 0.051, 0.066, 0.094, 0.133]),
    scatteringBasis: BRAS_SCATTERING_BASIS,
    source: BRAS_SOURCE,
    lowFrequency: BRAS_LOW_FREQUENCY,
  },
  {
    id: 'bras-cr2-plaster',
    name: 'BRAS CR2 painted plaster wall, fitted estimate',
    absorption: bands([0.077, 0.039, 0.044, 0.041, 0.044, 0.048, 0.037, 0.035]),
    scattering: bands([0.05, 0.05, 0.05, 0.051, 0.066, 0.094, 0.132, 0.188]),
    scatteringBasis: BRAS_SCATTERING_BASIS,
    source: BRAS_SOURCE,
    lowFrequency: BRAS_LOW_FREQUENCY,
  },
  {
    id: 'bras-cr2-windows',
    name: 'BRAS CR2 windows, fitted estimate',
    absorption: bands([0.255, 0.188, 0.086, 0.046, 0.06, 0.105, 0.058, 0.053]),
    scattering: bands([0.05, 0.05, 0.05, 0.05, 0.05, 0.055, 0.076, 0.108]),
    scatteringBasis: BRAS_SCATTERING_BASIS,
    source: BRAS_SOURCE,
    lowFrequency: BRAS_LOW_FREQUENCY,
  },
];

// Allowed absorption coefficient of a library entry. A real surface never absorbs everything.
export const ABSORPTION_RANGE = { min: 0, max: 1 } as const;

// Allowed scattering coefficient of a library entry.
export const SCATTERING_RANGE = { min: 0, max: 1 } as const;

// Throws a readable error when `material` is not usable.
export function validateLibraryMaterial(material: LibraryMaterial): void {
  const name = `Material "${material?.id}"`;
  if (typeof material?.id !== 'string' || material.id.trim() === '') {
    throw new Error('Every library material needs a non-empty id.');
  }
  if (typeof material.name !== 'string' || material.name.trim() === '') {
    throw new Error(`${name} needs a name.`);
  }
  if (typeof material.source !== 'string' || material.source.trim() === '') {
    throw new Error(`${name} needs a source citation.`);
  }
  if (typeof material.scatteringBasis !== 'string' || material.scatteringBasis.trim() === '') {
    throw new Error(`${name} needs a note on where its scattering curve comes from.`);
  }
  if (typeof material.lowFrequency !== 'string' || material.lowFrequency.trim() === '') {
    throw new Error(`${name} needs a note on how its 63 Hz value was obtained.`);
  }
  if (!Array.isArray(material.absorption) || material.absorption.length !== BAND_CENTERS.length) {
    throw new Error(`${name} needs exactly ${BAND_CENTERS.length} absorption values (one per band).`);
  }
  if (!Array.isArray(material.scattering) || material.scattering.length !== BAND_CENTERS.length) {
    throw new Error(`${name} needs exactly ${BAND_CENTERS.length} scattering values (one per band).`);
  }
  material.scattering.forEach((value, band) => {
    if (!Number.isFinite(value) || value < SCATTERING_RANGE.min || value > SCATTERING_RANGE.max) {
      throw new Error(
        `${name}: scattering at ${BAND_CENTERS[band]} Hz must be between ${SCATTERING_RANGE.min} and ${SCATTERING_RANGE.max} (got ${value}).`,
      );
    }
  });
  material.absorption.forEach((value, band) => {
    if (!Number.isFinite(value) || value < ABSORPTION_RANGE.min || value > ABSORPTION_RANGE.max) {
      throw new Error(
        `${name}: absorption at ${BAND_CENTERS[band]} Hz must be between ${ABSORPTION_RANGE.min} and ${ABSORPTION_RANGE.max} (got ${value}).`,
      );
    }
  });
}

// Validates the whole table: every entry and unique ids. Called at startup (main.ts) and by the tests.
export function validateMaterialsLibrary(table: LibraryMaterial[] = MATERIALS_LIBRARY): void {
  const seen = new Set<string>();
  for (const material of table) {
    validateLibraryMaterial(material);
    if (seen.has(material.id)) throw new Error(`Material id "${material.id}" is used twice.`);
    seen.add(material.id);
  }
}

// Looks up a material by id. Throws a readable error for an unknown id.
export function getLibraryMaterial(id: string): LibraryMaterial {
  const material = MATERIALS_LIBRARY.find((candidate) => candidate.id === id);
  if (!material) {
    const known = MATERIALS_LIBRARY.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown material "${id}". Known materials: ${known}.`);
  }
  return material;
}

export function registerLibraryMaterial(material: LibraryMaterial): () => void {
  validateLibraryMaterial(material);
  if (MATERIALS_LIBRARY.some((candidate) => candidate.id === material.id)) {
    throw new Error(`Material id "${material.id}" is already registered.`);
  }
  MATERIALS_LIBRARY.push(material);
  return () => {
    const index = MATERIALS_LIBRARY.indexOf(material);
    if (index >= 0) MATERIALS_LIBRARY.splice(index, 1);
  };
}
