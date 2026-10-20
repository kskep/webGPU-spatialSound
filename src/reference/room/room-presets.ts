import type { WallMaterial } from './room-materials.ts';

// Define interface for room presets
export interface RoomPreset {
  name: string;
  description: string;
  // Geometric properties
  dimensions: {
    width: number;
    height: number;
    depth: number;
  };
  // Material properties for different surfaces
  materials: {
    walls: Partial<WallMaterial>;
    ceiling: Partial<WallMaterial>;
    floor: Partial<WallMaterial>;
  };
  // Additional acoustic characteristics
  characteristics: {
    reverbTime: number; // RT60 in seconds
    clarity: number; // Clarity index (C80)
    warmth: number; // Warmth index (C50)
    intimacy: boolean; // Whether the room feels intimate
    diffusion: number; // Diffusion coefficient
  };
}

const absorptionBands = (low: number, mid: number, high: number) => ({
  absorption63: low,
  absorption125: low,
  absorption250: (low + mid) / 2,
  absorption500: mid,
  absorption1k: mid,
  absorption2k: (mid + high) / 2,
  absorption4k: high,
  absorption8k: high,
});

const scatteringBands = (low: number, mid: number, high: number) => ({
  scattering63: low,
  scattering125: low,
  scattering250: (low + mid) / 2,
  scattering500: mid,
  scattering1k: mid,
  scattering2k: (mid + high) / 2,
  scattering4k: high,
  scattering8k: high,
});

const createMaterial = (
  absorption: [number, number, number],
  scattering: [number, number, number],
  extras: Pick<WallMaterial, 'roughness' | 'phaseShift' | 'phaseRandomization'>,
): Partial<WallMaterial> => ({
  absorptionLow: absorption[0],
  absorptionMid: absorption[1],
  absorptionHigh: absorption[2],
  ...absorptionBands(absorption[0], absorption[1], absorption[2]),
  scatteringLow: scattering[0],
  scatteringMid: scattering[1],
  scatteringHigh: scattering[2],
  ...scatteringBands(scattering[0], scattering[1], scattering[2]),
  ...extras,
});

// Export all legacy room presets
export const LEGACY_ROOM_PRESETS: { [key: string]: RoomPreset } = {
  CATHEDRAL: {
    name: 'Cathedral',
    description: 'Large stone cathedral with high ceilings and long reverberation time',
    dimensions: {
      width: 30,
      height: 40,
      depth: 50,
    },
    materials: {
      walls: {
        ...createMaterial([0.03, 0.04, 0.05], [0.18, 0.28, 0.42], {
          roughness: 0.3,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
      ceiling: {
        ...createMaterial([0.02, 0.03, 0.04], [0.12, 0.2, 0.32], {
          roughness: 0.35,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
      floor: {
        ...createMaterial([0.06, 0.08, 0.1], [0.08, 0.12, 0.18], {
          roughness: 0.25,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
    },
    characteristics: {
      reverbTime: 8.0,
      clarity: -4.0,
      warmth: -2.0,
      intimacy: false,
      diffusion: 0.7,
    },
  },

  RECORDING_STUDIO: {
    name: 'Recording Studio',
    description: 'Professional recording studio with acoustic treatment for neutral sound',
    dimensions: {
      width: 6,
      height: 3,
      depth: 5,
    },
    materials: {
      walls: {
        ...createMaterial([0.3, 0.6, 0.8], [0.18, 0.28, 0.4], {
          roughness: 0.6,
          phaseShift: 0.0,
          phaseRandomization: 0.2,
        }),
      },
      ceiling: {
        ...createMaterial([0.25, 0.5, 0.7], [0.15, 0.22, 0.3], {
          roughness: 0.5,
          phaseShift: 0.0,
          phaseRandomization: 0.2,
        }),
      },
      floor: {
        ...createMaterial([0.15, 0.25, 0.3], [0.05, 0.08, 0.12], {
          roughness: 0.3,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
    },
    characteristics: {
      reverbTime: 0.3,
      clarity: 2.0,
      warmth: 1.0,
      intimacy: true,
      diffusion: 0.9,
    },
  },

  CONCERT_HALL: {
    name: 'Concert Hall',
    description: 'Symphony concert hall with balanced acoustics for orchestral music',
    dimensions: {
      width: 25,
      height: 15,
      depth: 40,
    },
    materials: {
      walls: {
        // Increase HF absorption for a more realistic hall spectral tilt
        // (low < mid < high instead of inverted slope).
        ...createMaterial([0.08, 0.14, 0.24], [0.35, 0.5, 0.65], {
          roughness: 0.45,
          phaseShift: 0.0,
          phaseRandomization: 0.15,
        }),
      },
      ceiling: {
        ...createMaterial([0.1, 0.18, 0.3], [0.3, 0.45, 0.6], {
          roughness: 0.4,
          phaseShift: 0.0,
          phaseRandomization: 0.15,
        }),
      },
      floor: {
        ...createMaterial([0.05, 0.08, 0.14], [0.12, 0.18, 0.26], {
          roughness: 0.4,
          phaseShift: 0.0,
          phaseRandomization: 0.15,
        }),
      },
    },
    characteristics: {
      reverbTime: 2.0,
      clarity: 1.5,
      warmth: 2.5,
      intimacy: true,
      diffusion: 0.8,
    },
  },

  HOME_THEATER: {
    name: 'Home Theater',
    description: 'Dedicated home theater room with acoustic treatment for movie watching',
    dimensions: {
      width: 8,
      height: 3,
      depth: 10,
    },
    materials: {
      walls: {
        ...createMaterial([0.25, 0.4, 0.6], [0.18, 0.25, 0.34], {
          roughness: 0.5,
          phaseShift: 0.0,
          phaseRandomization: 0.15,
        }),
      },
      ceiling: {
        ...createMaterial([0.2, 0.35, 0.5], [0.15, 0.22, 0.3], {
          roughness: 0.45,
          phaseShift: 0.0,
          phaseRandomization: 0.15,
        }),
      },
      floor: {
        ...createMaterial([0.1, 0.15, 0.2], [0.06, 0.08, 0.12], {
          roughness: 0.3,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
    },
    characteristics: {
      reverbTime: 0.4,
      clarity: 3.0,
      warmth: 1.5,
      intimacy: true,
      diffusion: 0.85,
    },
  },

  CLASSROOM: {
    name: 'Classroom',
    description: 'Empty hard-surface classroom with audible flutter and heavy reverberation',
    dimensions: {
      width: 10,
      height: 3,
      depth: 8,
    },
    materials: {
      walls: {
        // Bare drywall/painted cinderblock - highly reflective
        absorptionLow: 0.05,
        absorptionMid: 0.09,
        absorptionHigh: 0.14,
        absorption63: 0.05,
        absorption125: 0.05,
        absorption250: 0.06,
        absorption500: 0.07,
        absorption1k: 0.09,
        absorption2k: 0.1,
        absorption4k: 0.12,
        absorption8k: 0.14,
        // VERY low scattering to promote specular bounces (flutter echoes)
        scatteringLow: 0.05,
        scatteringMid: 0.08,
        scatteringHigh: 0.1,
        scattering63: 0.05,
        scattering125: 0.05,
        scattering250: 0.05,
        scattering500: 0.05,
        scattering1k: 0.08,
        scattering2k: 0.08,
        scattering4k: 0.1,
        scattering8k: 0.1,
        roughness: 0.1,
        phaseShift: 0.0,
        phaseRandomization: 0.05,
      },
      ceiling: {
        // Hard plaster or standard ceiling tiles (un-treated)
        absorptionLow: 0.08,
        absorptionMid: 0.1,
        absorptionHigh: 0.18,
        absorption63: 0.08,
        absorption125: 0.08,
        absorption250: 0.08,
        absorption500: 0.09,
        absorption1k: 0.1,
        absorption2k: 0.12,
        absorption4k: 0.15,
        absorption8k: 0.18,
        scatteringLow: 0.1,
        scatteringMid: 0.12,
        scatteringHigh: 0.15,
        scattering63: 0.1,
        scattering125: 0.1,
        scattering250: 0.1,
        scattering500: 0.1,
        scattering1k: 0.12,
        scattering2k: 0.12,
        scattering4k: 0.15,
        scattering8k: 0.15,
        roughness: 0.15,
        phaseShift: 0.0,
        phaseRandomization: 0.05,
      },
      floor: {
        // Hard linoleum or tile floor - extremely reflective
        absorptionLow: 0.02,
        absorptionMid: 0.05,
        absorptionHigh: 0.06,
        absorption63: 0.02,
        absorption125: 0.02,
        absorption250: 0.03,
        absorption500: 0.04,
        absorption1k: 0.05,
        absorption2k: 0.05,
        absorption4k: 0.06,
        absorption8k: 0.06,
        scatteringLow: 0.02,
        scatteringMid: 0.04,
        scatteringHigh: 0.04,
        scattering63: 0.02,
        scattering125: 0.02,
        scattering250: 0.02,
        scattering500: 0.02,
        scattering1k: 0.04,
        scattering2k: 0.04,
        scattering4k: 0.04,
        scattering8k: 0.04,
        roughness: 0.05,
        phaseShift: 0.0,
        phaseRandomization: 0.02,
      },
    },
    characteristics: {
      reverbTime: 1.8,
      clarity: -1.0,
      warmth: 0.8,
      intimacy: false,
      diffusion: 0.1,
    },
  },

  BATHROOM: {
    name: 'Bathroom',
    description: 'Small bathroom with tiled walls and bright, reflective acoustics',
    dimensions: {
      width: 2.5,
      height: 2.5,
      depth: 2,
    },
    materials: {
      walls: {
        ...createMaterial([0.02, 0.02, 0.03], [0.1, 0.16, 0.24], {
          roughness: 0.25,
          phaseShift: 0.0,
          phaseRandomization: 0.05,
        }),
      },
      ceiling: {
        ...createMaterial([0.05, 0.05, 0.06], [0.08, 0.12, 0.18], {
          roughness: 0.3,
          phaseShift: 0.0,
          phaseRandomization: 0.05,
        }),
      },
      floor: {
        ...createMaterial([0.03, 0.03, 0.04], [0.04, 0.06, 0.1], {
          roughness: 0.28,
          phaseShift: 0.0,
          phaseRandomization: 0.05,
        }),
      },
    },
    characteristics: {
      reverbTime: 1.2,
      clarity: -1.0,
      warmth: -3.0,
      intimacy: true,
      diffusion: 0.6,
    },
  },

  WOOD_PANEL_ROOM: {
    name: 'Wood Panel Room',
    description: 'Room with wood paneling on walls and ceiling, creating warm acoustics',
    dimensions: {
      width: 7,
      height: 3,
      depth: 6,
    },
    materials: {
      walls: {
        ...createMaterial([0.1, 0.08, 0.06], [0.2, 0.28, 0.36], {
          roughness: 0.4,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
      ceiling: {
        ...createMaterial([0.08, 0.06, 0.05], [0.18, 0.25, 0.32], {
          roughness: 0.35,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
      floor: {
        ...createMaterial([0.15, 0.12, 0.1], [0.08, 0.12, 0.18], {
          roughness: 0.45,
          phaseShift: 0.0,
          phaseRandomization: 0.1,
        }),
      },
    },
    characteristics: {
      reverbTime: 0.8,
      clarity: 1.0,
      warmth: 3.5,
      intimacy: true,
      diffusion: 0.7,
    },
  },

  ANECHOIC_CHAMBER: {
    name: 'Anechoic Chamber',
    description: 'Specialized chamber with wedge absorbers to eliminate all reflections',
    dimensions: {
      width: 4,
      height: 3,
      depth: 4,
    },
    materials: {
      walls: {
        ...createMaterial([0.95, 0.98, 0.99], [0.02, 0.02, 0.03], {
          roughness: 0.2,
          phaseShift: 0.0,
          phaseRandomization: 0.3,
        }),
      },
      ceiling: {
        ...createMaterial([0.95, 0.98, 0.99], [0.02, 0.02, 0.03], {
          roughness: 0.2,
          phaseShift: 0.0,
          phaseRandomization: 0.3,
        }),
      },
      floor: {
        ...createMaterial([0.95, 0.98, 0.99], [0.02, 0.02, 0.03], {
          roughness: 0.2,
          phaseShift: 0.0,
          phaseRandomization: 0.3,
        }),
      },
    },
    characteristics: {
      reverbTime: 0.05,
      clarity: 10.0,
      warmth: -5.0,
      intimacy: false,
      diffusion: 0.02,
    },
  },
};
