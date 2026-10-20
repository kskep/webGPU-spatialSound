export interface RoomMaterials {
  walls: WallMaterial;
  ceiling: WallMaterial;
  floor: WallMaterial;
}

// Absorption of one surface: simple low/mid/high values, or explicit coefficients per octave band.
export interface WallMaterial {
  // Simple three-value form, used by the UI
  absorptionLow?: number;
  absorptionMid?: number;
  absorptionHigh?: number;

  // Explicit coefficients per octave band (take precedence over low/mid/high)
  absorption63?: number;
  absorption125?: number;
  absorption250?: number;
  absorption500?: number;
  absorption1k?: number;
  absorption2k?: number;
  absorption4k?: number;
  absorption8k?: number;

  // Scattering uses the same layout as absorption
  scatteringLow?: number;
  scatteringMid?: number;
  scatteringHigh?: number;
  scattering63?: number;
  scattering125?: number;
  scattering250?: number;
  scattering500?: number;
  scattering1k?: number;
  scattering2k?: number;
  scattering4k?: number;
  scattering8k?: number;

  roughness: number;
  phaseShift: number;
  phaseRandomization: number;
}
