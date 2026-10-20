// The rule that ends a stochastic ray.
export interface RayTermination {
  mode: 'bounces' | 'energy';
  // dB relative to the initial strongest band energy of the ray; negative.
  energyCutoffDb: number;
  // Seconds of travel, or 'auto' (see `autoPathSeconds`).
  maxPathSeconds: number | 'auto';
  // Hard cap of bounces per ray.
  maxBounces: number;
  // Segments read back in full; 'scene' = the budget's bounce count.
  detailedBounces: number | 'scene';
  // Width of a late-histogram bin in seconds.
  histogramBinSeconds: number;
}

// The legacy rule: a fixed bounce count, everything read back.
export const BOUNCE_TERMINATION: RayTermination = {
  mode: 'bounces',
  energyCutoffDb: -80,
  maxPathSeconds: 'auto',
  maxBounces: 2000,
  detailedBounces: 'scene',
  histogramBinSeconds: 0.001,
};

// Acceptable values of each field.
export const TERMINATION_LIMITS = {
  energyCutoffDb: { min: -200, max: -10 },
  maxPathSeconds: { min: 0.05, max: 20 },
  maxBounces: { min: 2, max: 20000 },
  detailedBounces: { min: 2, max: 64 },
  histogramBinSeconds: { min: 0.0002, max: 0.01 },
} as const;

// The 'auto' value of maxPathSeconds: factor x (largest finite mesh-Eyring RT60), kept within [min, max].
export const AUTO_PATH_SECONDS = {
  eyringFactor: 1.5,
  minSeconds: 0.3,
  maxSeconds: 4,
} as const;

// Number of late-histogram bins stays below this, which bounds its memory (in the default config: 4000).
export const MAX_HISTOGRAM_BINS = 20000;

// Throws a readable error when `termination` is not usable.
export function validateRayTermination(termination: RayTermination, name = 'Ray termination'): void {
  if (termination.mode !== 'bounces' && termination.mode !== 'energy') {
    throw new Error(`${name}: mode must be 'bounces' or 'energy' (got ${String(termination.mode)}).`);
  }
  const check = (field: string, value: unknown, min: number, max: number, integer = false): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${name}: ${field} must be a number between ${min} and ${max} (got ${String(value)}).`);
    }
    if (integer && !Number.isInteger(value)) {
      throw new Error(`${name}: ${field} must be an integer (got ${String(value)}).`);
    }
  };
  const limits = TERMINATION_LIMITS;
  check('energyCutoffDb', termination.energyCutoffDb, limits.energyCutoffDb.min, limits.energyCutoffDb.max);
  if (termination.maxPathSeconds !== 'auto') {
    check('maxPathSeconds', termination.maxPathSeconds, limits.maxPathSeconds.min, limits.maxPathSeconds.max);
  }
  check('maxBounces', termination.maxBounces, limits.maxBounces.min, limits.maxBounces.max, true);
  if (termination.detailedBounces !== 'scene') {
    check(
      'detailedBounces',
      termination.detailedBounces,
      limits.detailedBounces.min,
      limits.detailedBounces.max,
      true,
    );
  }
  check(
    'histogramBinSeconds',
    termination.histogramBinSeconds,
    limits.histogramBinSeconds.min,
    limits.histogramBinSeconds.max,
  );
  if (typeof termination.maxPathSeconds === 'number') {
    const bins = Math.ceil(termination.maxPathSeconds / termination.histogramBinSeconds);
    if (bins > MAX_HISTOGRAM_BINS) {
      throw new Error(
        `${name}: ${bins} histogram bins (maxPathSeconds / histogramBinSeconds) is more than ${MAX_HISTOGRAM_BINS}.`,
      );
    }
  }
}

// The termination of one trace with every 'scene' and 'auto' replaced by a number.
export interface ResolvedTermination {
  mode: 'energy';
  energyCutoffDb: number;
  maxPathSeconds: number;
  maxBounces: number;
  // Segments per ray that are read back in full (bounces + 1 records).
  detailedBounces: number;
  histogramBinSeconds: number;
}

export function autoPathSeconds(eyringRt60: ArrayLike<number>): number {
  let longest = 0;
  for (let band = 0; band < eyringRt60.length; band++) {
    if (Number.isFinite(eyringRt60[band])) longest = Math.max(longest, eyringRt60[band]);
  }
  if (longest === 0) return AUTO_PATH_SECONDS.maxSeconds;
  const wanted = AUTO_PATH_SECONDS.eyringFactor * longest;
  return Math.min(AUTO_PATH_SECONDS.maxSeconds, Math.max(AUTO_PATH_SECONDS.minSeconds, wanted));
}

export function resolveTermination(
  termination: RayTermination | undefined,
  bounces: number,
  eyringRt60: ArrayLike<number>,
): ResolvedTermination | undefined {
  if (!termination || termination.mode === 'bounces') return undefined;
  const maxPathSeconds =
    termination.maxPathSeconds === 'auto' ? autoPathSeconds(eyringRt60) : termination.maxPathSeconds;
  const resolved: ResolvedTermination = {
    mode: 'energy',
    energyCutoffDb: termination.energyCutoffDb,
    maxPathSeconds,
    maxBounces: termination.maxBounces,
    detailedBounces: termination.detailedBounces === 'scene' ? bounces : termination.detailedBounces,
    histogramBinSeconds: termination.histogramBinSeconds,
  };
  if (resolved.detailedBounces > resolved.maxBounces) resolved.detailedBounces = resolved.maxBounces;
  return resolved;
}

// Number of bins of the late histogram of a resolved termination.
export function histogramBinCount(termination: ResolvedTermination): number {
  return Math.min(
    MAX_HISTOGRAM_BINS,
    Math.max(1, Math.ceil(termination.maxPathSeconds / termination.histogramBinSeconds)),
  );
}

// Why the rays of a trace stopped, and what the late buffers cost. Plain data, kept in the trace result.
export interface TerminationReport {
  resolved: ResolvedTermination;
  completeUntilSeconds: number;
  // Rays that stopped because of the energy cutoff, the path limit, the bounce cap, or left the geometry.
  stoppedBy: { energy: number; time: number; bounces: number; lost: number };
  // Ray segments traced in all, and the longest chain of one ray.
  segmentsTraced: number;
  longestRaySegments: number;
  // Bins of the late histogram and how many hits it holds.
  histogramBins: number;
  histogramHits: number;
  // Bin-sum overflows of the fixed-point accumulator (0 unless the receiver is tiny).
  histogramOverflows: number;
  // Size of the per-segment record buffer, of the late histogram, and of what was read back (bytes).
  detailedBufferBytes: number;
  histogramBufferBytes: number;
  readbackBytes: number;
}
