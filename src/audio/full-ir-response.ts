// Build a full stereo IR: early reflections, traced stochastic sound, then a
// synthetic tail continuing the fitted band decays. Playback uses convolution.
// The join stays inside the reliable trace interval. Crossfades and the final
// fade avoid discontinuities; config/render-modes.ts holds the limits.
import type { Arrival, Scene, TraceResult } from '../acoustics/model.ts';
import { FULL_IR_SETTINGS, MAX_FULL_IR_SECONDS, type FullIrSettings } from '../config/render-modes.ts';
import {
  chooseLateDecay,
  latestEarlyArrivalSeconds,
  type LateDecayChoice,
  type LateDecayMode,
} from './hybrid-response.ts';
import type { HrtfBank } from './hrtf.ts';
import type { BinauralSettings, BinauralToggles } from '../config/binaural.ts';
import { addDecayingTails } from './tail-noise.ts';
import { bandNoiseSeed, synthesizeIR, type IrBuildTimings } from './ir-synthesis.ts';
import { bandFraction, energyDecayRate, windowLateLevel, windowStochasticEnergy } from './late-level.ts';
import { makeLateConfig } from './dsp/late-fdn.mjs';
import { prepareResponse, type PreparedResponse } from './dsp/stream-core.mjs';

// Partition length of the convolver, in samples (the same as the hybrid path).
const PARTITION_SAMPLES = 512;

export interface FullIrOptions {
  lateDecayMode?: LateDecayMode;
  // Longest response in seconds; the response is truncated beyond it. Defaults to MAX_FULL_IR_SECONDS.
  maxIrSeconds?: number;
  // Tunable values; defaults to FULL_IR_SETTINGS (tests pass their own).
  settings?: FullIrSettings;
  // Filled in with the time spent in the stages the telemetry reports separately.
  timings?: IrBuildTimings;
  binaural?: BinauralToggles;
  // Tunable numbers of the binaural options; defaults to BINAURAL_SETTINGS.
  binauralSettings?: BinauralSettings;
}

// The synthetic tail of one octave band.
export interface FullIrTailBand {
  // Reverberation time that the tail follows, in seconds.
  rt60: number;
  // Power density (sum of squared samples per second, both ears) at the join.
  startPowerDensity: number;
  // Time in seconds at which the tail is `tailDecayDb` below its start; Infinity for a lossless band.
  endSeconds: number;
  // Weight 0 ... 1 of the traced measurement against the theory in the start level.
  confidence: number;
}

// What the builder reports about the response it made.
export interface FullIrReport {
  // Time at which the traced envelope ends and the synthetic tail takes over, in seconds.
  joinSeconds: number;
  crossfadeSeconds: number;
  // Length of the response in seconds.
  lengthSeconds: number;
  // Length the response would need to contain every tail down to `tailDecayDb`; may be Infinity.
  neededSeconds: number;
  // The cap that applied, in seconds.
  maxIrSeconds: number;
  // True when `neededSeconds` exceeds the cap and the response ends in a fade-out.
  truncated: boolean;
  // Number of convolver partitions of the response (the worklet cost grows with it).
  partitions: number;
  tail: FullIrTailBand[];
  decay: LateDecayChoice;
}

// A response for the streaming convolver with no late-field configuration.
export interface FullIrResponse {
  // Discriminates the response from a `HybridResponse`.
  architecture: 'full-ir';
  prepared: PreparedResponse;
  fullIr: FullIrReport;
  duration: number;
  sampleRate: number;
  analyticalCount: number;
}

// EDW EPILEGOUME MEXRI POTE EMPISTEYOMASTE TO TRACE GIA NA ARXISEI META TO SYNTHETIC TAIL.
export function traceJoinSeconds(
  result: TraceResult,
  bounces: number,
  meanFreeTime: number,
  settings: FullIrSettings = FULL_IR_SETTINGS,
): number {
  const guardSeconds = result.termination
    ? result.termination.completeUntilSeconds
    : settings.budgetGuardFactor * bounces * meanFreeTime;
  let lastHitSeconds = 0;
  for (const arrival of result.arrivals) {
    if (arrival.kind === 'stochastic') lastHitSeconds = Math.max(lastHitSeconds, arrival.time);
  }
  return Math.max(settings.minJoinSeconds, Math.min(guardSeconds, lastHitSeconds));
}

// EDW YPOLOGIZOUME TI MESI EKTHETIKI PTWSI GIA NA DIORTHWSOUME TI STATHMI STO PARATHYRO.
function averageDecayFactor(rate: number, windowSeconds: number): number {
  return rate === 0 ? 1 : Math.expm1(rate * windowSeconds) / (rate * windowSeconds);
}

function tracedPartOf(result: TraceResult, crossfadeStart: number, joinSeconds: number): TraceResult {
  const arrivals: Arrival[] = [];
  for (const arrival of result.arrivals) {
    if (arrival.kind !== 'stochastic' && !arrival.rayTraced) {
      arrivals.push(arrival);
      continue;
    }
    if (arrival.time >= joinSeconds) continue;
    if (arrival.time < crossfadeStart) {
      arrivals.push(arrival);
      continue;
    }
    const phase = ((arrival.time - crossfadeStart) / (joinSeconds - crossfadeStart)) * (Math.PI / 2);
    const energyWeight = Math.cos(phase) ** 2;
    arrivals.push({
      ...arrival,
      energy: arrival.energy * energyWeight,
      energyBands: arrival.energyBands.map((value) => value * energyWeight) as typeof arrival.energyBands,
    });
  }
  return { ...result, arrivals };
}

// Applies a raised-cosine fade-out to the last `fadeSeconds` of both channels.
function fadeOutEnd(left: Float32Array, right: Float32Array, fadeSeconds: number, rate: number): void {
  const fadeSamples = Math.min(left.length, Math.round(fadeSeconds * rate));
  const fadeStart = left.length - fadeSamples;
  for (let i = fadeStart; i < left.length; i++) {
    const weight = 0.5 * (1 + Math.cos((Math.PI * (i - fadeStart)) / fadeSamples));
    left[i] *= weight;
    right[i] *= weight;
  }
}

// The impulse response in the time domain, with the report about how it was made.
export interface FullIrSignal {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  // Report without the partition count, which is only known once the response is prepared.
  report: Omit<FullIrReport, 'partitions'>;
}

export function synthesizeFullIr(
  scene: Scene,
  result: TraceResult,
  sampleRate: number,
  hrtf?: HrtfBank,
  options: FullIrOptions = {},
): FullIrSignal {
  const settings = options.settings ?? FULL_IR_SETTINGS;
  const maxIrSeconds = options.maxIrSeconds ?? MAX_FULL_IR_SECONDS;

  // Decay per band: the fitted RT60 (Eyring where the fit was rejected), as for the hybrid FDN.
  const decay = chooseLateDecay(scene, result, options.lateDecayMode);
  const rt60Bands = decay.rt60Bands;
  const room = makeLateConfig(sampleRate, scene.dimensions, rt60Bands, scene.speed, decay.stats);

  // Where the traced part ends, and where the crossfade to the tail starts.
  const bounces = result.tracedBounces ?? scene.bounces;
  const joinSeconds = traceJoinSeconds(result, bounces, room.meanFreeTime, settings);
  const crossfadeStart = Math.max(0, joinSeconds - settings.crossfadeSeconds);

  // Level of every band's tail at the join, from the traced energy in the window before it.
  const windowStart = Math.max(0, joinSeconds - settings.levelWindowSeconds);
  const windowSeconds = joinSeconds - windowStart;
  const { energy, squared } = windowStochasticEnergy(result.arrivals, windowStart, joinSeconds);
  const tail: FullIrTailBand[] = [];
  for (let band = 0; band < 8; band++) {
    const rt60 = rt60Bands[band];
    const level = windowLateLevel({
      energy: energy[band],
      squared: squared[band],
      fraction: bandFraction(band, sampleRate),
      rt60,
      speed: room.speed,
      volume: room.volume,
      windowStart,
      windowEnd: joinSeconds,
    });
    const rate = energyDecayRate(rt60);
    // A fully absorbing band (RT60 0) has no tail.
    const hasTail = rt60 > 0;
    tail.push({
      rt60,
      startPowerDensity: hasTail ? level.target / averageDecayFactor(rate, windowSeconds) : 0,
      endSeconds: hasTail ? joinSeconds + (rt60 * settings.tailDecayDb) / 60 : 0,
      confidence: level.weight,
    });
  }

  // Length: long enough for the early arrivals and the slowest tail, capped at maxIrSeconds.
  const earlySupport = latestEarlyArrivalSeconds(scene, result) + 1024 / sampleRate + 0.017;
  const neededSeconds = Math.max(earlySupport, joinSeconds, ...tail.map((band) => band.endSeconds));
  const truncated = neededSeconds > maxIrSeconds;
  const durationSeconds = Math.min(neededSeconds, maxIrSeconds);

  // Early and traced part. The synthesis rounds the length up to whole samples.
  const traced = tracedPartOf(result, crossfadeStart, joinSeconds);
  const ir = synthesizeIR(scene, traced, sampleRate, hrtf, {
    duration: durationSeconds,
    rt60Bands,
    timings: options.timings,
    binaural: options.binaural,
    binauralSettings: options.binauralSettings,
  });

  // Synthetic tail: band-limited noise that follows the fitted decay of every band.
  const tailSeed = bandNoiseSeed(scene.seed, 0, 0, settings.noiseSeedSalt);
  addDecayingTails(
    ir.left,
    ir.right,
    tail,
    { joinSeconds, crossfadeStartSeconds: crossfadeStart },
    sampleRate,
    tailSeed,
  );
  if (truncated) fadeOutEnd(ir.left, ir.right, settings.truncationFadeSeconds, sampleRate);

  return {
    left: ir.left,
    right: ir.right,
    sampleRate,
    report: {
      joinSeconds,
      crossfadeSeconds: joinSeconds - crossfadeStart,
      lengthSeconds: ir.left.length / sampleRate,
      neededSeconds,
      maxIrSeconds,
      truncated,
      tail,
      decay,
    },
  };
}

export function buildFullIrResponse(
  scene: Scene,
  result: TraceResult,
  sampleRate: number,
  hrtf?: HrtfBank,
  options: FullIrOptions = {},
): FullIrResponse {
  const signal = synthesizeFullIr(scene, result, sampleRate, hrtf, options);
  const prepared = prepareResponse(signal.left, signal.right, PARTITION_SAMPLES);
  return {
    architecture: 'full-ir',
    prepared,
    fullIr: { ...signal.report, partitions: prepared.partitions },
    duration: signal.report.lengthSeconds,
    sampleRate,
    analyticalCount: result.analyticalCount,
  };
}
