export interface FdnColorationSettings {
  minMidRt60Seconds: number;
  sampleRate: number;
  render: { minSeconds: number; maxSeconds: number; rt60Factor: number };
  echoDensity: {
    windowSeconds: number;
    hopSamples: number;
    target: number;
    naturalSeconds: number;
    metallicSeconds: number;
  };
  spectrum: {
    startSeconds: number;
    decayDb: number;
    maxSamples: number;
    minBins: number;
    referenceSeeds: number;
    mild: { stdDb: number; peakDb: number };
    metallic: { stdDb: number; peakDb: number };
  };
  periodicity: {
    threshold: number;
    mainLobeCycles: number;
    minLagSeconds: number;
    maxLagSeconds: number;
    lagToleranceSamples: number;
  };
  interaural: { icToleranceAbs: number };
}

export const FDN_COLORATION: FdnColorationSettings = {
  minMidRt60Seconds: 0.1,
  sampleRate: 48000,
  render: { minSeconds: 2, maxSeconds: 4, rt60Factor: 1.5 },
  echoDensity: {
    windowSeconds: 0.02,
    hopSamples: 24,
    target: 0.9,
    naturalSeconds: 0.1,
    metallicSeconds: 0.25,
  },
  spectrum: {
    startSeconds: 0.1,
    decayDb: 50,
    maxSamples: 65536,
    minBins: 8,
    referenceSeeds: 8,
    mild: { stdDb: 1, peakDb: 3 },
    metallic: { stdDb: 2.5, peakDb: 6 },
  },
  periodicity: {
    threshold: 0.1,
    mainLobeCycles: 5,
    minLagSeconds: 0.002,
    maxLagSeconds: 0.4,
    lagToleranceSamples: 2,
  },
  interaural: { icToleranceAbs: 0.05 },
};

// Throws a readable error when a setting is out of range.
export function validateFdnColoration(settings: FdnColorationSettings = FDN_COLORATION): void {
  const positive = (name: string, value: number) => {
    if (!(Number.isFinite(value) && value > 0)) throw new Error(`FDN coloration: ${name} must be > 0.`);
  };
  positive('sampleRate', settings.sampleRate);
  positive('render.rt60Factor', settings.render.rt60Factor);
  if (settings.render.minSeconds > settings.render.maxSeconds)
    throw new Error('FDN coloration: render.minSeconds exceeds render.maxSeconds.');
  positive('echoDensity.windowSeconds', settings.echoDensity.windowSeconds);
  positive('echoDensity.hopSamples', settings.echoDensity.hopSamples);
  if (!(settings.echoDensity.target > 0 && settings.echoDensity.target <= 1))
    throw new Error('FDN coloration: echoDensity.target must be in (0, 1].');
  if (settings.echoDensity.naturalSeconds > settings.echoDensity.metallicSeconds)
    throw new Error('FDN coloration: echoDensity.naturalSeconds exceeds metallicSeconds.');
  const samples = settings.spectrum.maxSamples;
  if (samples < 1024 || (samples & (samples - 1)) !== 0)
    throw new Error('FDN coloration: spectrum.maxSamples must be a power of two >= 1024.');
  positive('spectrum.minBins', settings.spectrum.minBins);
  positive('spectrum.referenceSeeds', settings.spectrum.referenceSeeds);
  if (
    settings.spectrum.mild.stdDb > settings.spectrum.metallic.stdDb ||
    settings.spectrum.mild.peakDb > settings.spectrum.metallic.peakDb
  )
    throw new Error('FDN coloration: the mild thresholds exceed the metallic ones.');
  positive('periodicity.threshold', settings.periodicity.threshold);
  if (settings.periodicity.minLagSeconds >= settings.periodicity.maxLagSeconds)
    throw new Error('FDN coloration: periodicity.minLagSeconds must be below maxLagSeconds.');
  positive('interaural.icToleranceAbs', settings.interaural.icToleranceAbs);
}
