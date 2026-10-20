import { eyringBands, type Bands, type Scene, type TraceResult } from '../acoustics/model.ts';
import type { DecaySource } from '../acoustics/decay-fit.ts';
import type { MeshRoomStatistics } from '../geometry/acoustic-scene.ts';
import { MAX_HYBRID_IR_SECONDS } from '../config/render-modes.ts';
import { synthesizeIR, type IrBuildTimings, type StereoIR } from './ir-synthesis.ts';
import type { HrtfBank } from './hrtf.ts';
import { bandFraction, windowLateLevel, windowStochasticEnergy } from './late-level.ts';
import {
  applyCoherenceMix,
  designCoherenceMix,
  latePrefix,
  makeLateConfig,
  type LateConfig,
} from './dsp/late-fdn.mjs';
import type { BinauralSettings, BinauralToggles } from '../config/binaural.ts';
import { getLateFieldProfile, lateLayoutOf } from '../config/late-field.ts';
import { prepareResponse, type PreparedResponse } from './dsp/stream-core.mjs';
import { designRoomModes, modalPrefix } from './dsp/room-modes.mjs';
// Where the late reverberation time comes from: the traced rays (with fallback) or the Eyring formula.
export type LateDecayMode = 'ray-fit' | 'eyring';
export interface HybridOptions {
  lateDecayMode?: LateDecayMode;
  // Streaming budget in seconds: the longest FIR the worklet convolver holds (config/render-modes.ts).
  maxIrSeconds?: number;
  // Filled in with the time spent in the stages the telemetry reports separately.
  timings?: IrBuildTimings;
  // The Task M toggles; omitted = all off = the original behaviour, bit for bit.
  binaural?: BinauralToggles;
  // Id of the late-field layout (src/config/late-field.ts); omitted = 'standard', the network before Task O.
  lateProfile?: string;
  // Tunable numbers of the binaural options; defaults to BINAURAL_SETTINGS.
  binauralSettings?: BinauralSettings;
  roomModes?: boolean;
}
// The room-mode layer of a response: what the worklet's ModalBank runs, plus readouts.
export interface RoomModeResponse {
  config: { sampleRate: number; frequencies: number[]; rt60s: number[] };
  // Output weight of each mode (crossfaded by the worklet like the late gains).
  weights: number[];
  // Mode indices [nx, ny, nz] in the order of `config.frequencies`.
  indices: number[][];
  // Source-listener coupling psi(s) psi(l) / Lambda of each mode (0 on a nodal plane).
  couplings: number[];
  schroederHz: number;
  // Share of the 63 and 125 Hz late energy that the modes carry; the FDN keeps the rest.
  share: number[];
}
// Per band: the RT60 actually used by the late field and where it came from.
export interface LateDecayChoice {
  rt60Bands: Bands;
  source: DecaySource[];
  mode: LateDecayMode;
  stats?: MeshRoomStatistics;
}
export interface HybridResponse {
  // Discriminates this response from a `FullIrResponse` (see full-ir-response.ts).
  architecture: 'hybrid';
  prepared: PreparedResponse;
  late: {
    config: LateConfig;
    gains: number[];
    joinSeconds: number;
    endSeconds: number;
    confidence: number[];
    targetDensity: number[];
    baseDensity: number[];
    decay: LateDecayChoice;
    prefixCache: { hit: boolean; hits: number; misses: number };
  };
  // Optional room modes (HybridOptions.roomModes); absent when the option is off.
  modes?: RoomModeResponse;
  duration: number;
  sampleRate: number;
  analyticalCount: number;
}
const COHERENCE_ANALYSIS_SECONDS = 0.6;

// Cache of `latePrefix` results (the late field's impulse response, 3 entries), keyed by config and length.
const cache = new Map<string, { left: Float32Array[]; right: Float32Array[] }>();
// Late-prefix cache statistics. The key contains the RT60 bands, so a stable room decay keeps hitting.
let prefixCacheHits = 0;
let prefixCacheMisses = 0;
export function latestEarlyArrivalSeconds(scene: Scene, result: TraceResult): number {
  const [width, height, depth] = scene.dimensions;
  return result.arrivals
    .filter((arrival) => arrival.kind !== 'stochastic' && !arrival.rayTraced)
    .reduce((time, arrival) => {
      const image =
        arrival.imagePosition ?? arrival.direction.map((v, i) => scene.listener[i] + v * arrival.distance);
      const maximum =
        Math.hypot(
          Math.abs(image[0]) + width / 2,
          Math.max(Math.abs(image[1]), Math.abs(image[1] - height)),
          Math.abs(image[2]) + depth / 2,
        ) / scene.speed;
      return Math.max(time, maximum);
    }, 0);
}
export function chooseLateDecay(
  scene: Scene,
  result: TraceResult,
  mode: LateDecayMode = 'ray-fit',
): LateDecayChoice {
  const measured = result.lateDecay;
  if (!measured) return { rt60Bands: eyringBands(scene), source: Array(8).fill('eyring'), mode: 'eyring' };
  if (mode === 'ray-fit')
    return {
      rt60Bands: [...measured.rt60Bands] as Bands,
      source: [...measured.source],
      mode,
      stats: measured.stats,
    };
  return {
    rt60Bands: [...measured.eyringBands] as Bands,
    source: Array(8).fill('eyring'),
    mode,
    stats: measured.stats,
  };
}
export function buildHybridResponse(
  scene: Scene,
  result: TraceResult,
  sampleRate: number,
  hrtf?: HrtfBank,
  options: HybridOptions = {},
): HybridResponse {
  // Decay times, volume and mean free path come from the traced mesh when the tracer provided them.
  const decay = chooseLateDecay(scene, result, options.lateDecayMode);
  const times = decay.rt60Bands;
  const layout = options.lateProfile ? lateLayoutOf(getLateFieldProfile(options.lateProfile)) : undefined;
  const config = makeLateConfig(sampleRate, scene.dimensions, times, scene.speed, decay.stats, layout);
  const lastEarly = latestEarlyArrivalSeconds(scene, result);
  // Fixed room/source support avoids moving the handoff when the listener moves.
  const transition = 0.08;
  const end =
      Math.ceil(
        (Math.max(0.07, lastEarly + 1024 / sampleRate + 0.017, 6 * config.meanFreeTime) + transition) * 100,
      ) / 100;
  const join = end - transition;
  const streamingBudget = options.maxIrSeconds ?? MAX_HYBRID_IR_SECONDS;
  if (end > streamingBudget) {
    throw new Error(`Early-response support exceeds the current ${streamingBudget}-second streaming budget.`);
  }
  const length = Math.ceil(end * sampleRate);
  // give the late field's left/right pair the interaural coherence of a diffuse field at
  // the ears. The mixing is designed from the unmixed network's own impulse response, which is
  // therefore computed long enough to measure the correlation (and cached like the short one).
  const mixing = !!(options.binaural?.lateCoherence && hrtf);
  const analysisLength = mixing ? Math.max(length, Math.ceil(COHERENCE_ANALYSIS_SECONDS * sampleRate)) : length;
  const key = JSON.stringify(config) + ':' + analysisLength;
  let unmixed = cache.get(key);
  const prefixCacheHit = !!unmixed;
  if (prefixCacheHit) prefixCacheHits++;
  else prefixCacheMisses++;
  if (!unmixed) {
    unmixed = latePrefix(config, analysisLength);
    if (cache.size >= 3) cache.delete(cache.keys().next().value!);
    cache.set(key, unmixed);
  }
  let prefix = unmixed;
  if (mixing) {
    // The mix goes into the configuration the worklet receives, and the same matrices are applied to
    // the prefix below (applyCoherenceMix uses the arithmetic of LateFdn.tick), so the subtraction
    // of the handoff cancels the mixed field the worklet will actually produce.
    const coherence = hrtf!.diffuseCoherence(!!options.binaural?.diffuseFieldEq);
    const mix = designCoherenceMix(unmixed, coherence, analysisLength);
    config.interauralCoherence = coherence;
    config.coherenceMix = mix;
    prefix = applyCoherenceMix(unmixed, mix, length);
  }
  // Window around the join in which the FDN power is matched to the ray-traced / theoretical energy.
  const windowStart = Math.max(0.02, join - 0.06);
  const windowEnd = Math.min(end, join + 0.06);
  const windowDuration = windowEnd - windowStart;
  const begin = Math.floor(windowStart * sampleRate);
  const finish = Math.min(length, Math.floor(windowEnd * sampleRate));
  // Per band: summed stochastic energy in the window, and the sum of its squares (for n_eff).
  const { energy, squared } = windowStochasticEnergy(result.arrivals, windowStart, windowEnd);
  const gains: number[] = [];
  const confidence: number[] = [];
  const targetDensity: number[] = [];
  const baseDensity: number[] = [];
  for (let band = 0; band < 8; band++) {
    // Measured and theoretical late level of the band in the window, blended by the ray confidence.
    const { weight, target } = windowLateLevel({
      energy: energy[band],
      squared: squared[band],
      fraction: bandFraction(band, sampleRate),
      rt60: times[band],
      speed: config.speed,
      volume: config.volume,
      windowStart,
      windowEnd,
    });
    // Power of the unscaled FDN in the window (its impulse response, both ears).
    let power = 0;
    for (let i = begin; i < finish; i++) power += prefix.left[band][i] ** 2 + prefix.right[band][i] ** 2;
    const density = power / windowDuration;
    // EDW TAIRIAZOUME TIN ISXY TOU FDN ME TO LATE TARGET GIA NA SYNDEETAI ME TO TRACED MEROS.
    gains.push(density > 1e-30 ? Math.sqrt(target / density) : 0);
    confidence.push(weight);
    targetDensity.push(target);
    baseDensity.push(density);
  }
  // Optional room modes: they take over the part of the 63 / 125 Hz late level below the Schroeder
  // frequency (matched in the same window), and the FDN gains of those bands keep only the rest.
  let modes: RoomModeResponse | undefined;
  let modal: Float64Array | undefined;
  if (options.roomModes) {
    const design = designRoomModes({
      dimensions: scene.dimensions,
      speed: scene.speed,
      source: scene.source,
      listener: scene.listener,
      rt60Bands: times,
      sampleRate,
      windowStart,
      windowEnd,
      targetDensity,
    });
    for (let band = 0; band < 2; band++) gains[band] *= design.fdnScale[band];
    modes = {
      config: design.config,
      weights: design.weights,
      indices: design.modes.map((mode) => mode.n),
      couplings: design.couplings,
      schroederHz: design.schroederHz,
      share: design.share,
    };
    if (modes.weights.length) modal = modalPrefix(design.config, design.weights, length);
  }
  const cropped: TraceResult = {
    ...result,
    arrivals: result.arrivals.filter((arrival) => arrival.time < end),
  };
  const ir: StereoIR = synthesizeIR(scene, cropped, sampleRate, hrtf, {
    duration: end,
    rt60Bands: times,
    timings: options.timings,
    binaural: options.binaural,
    binauralSettings: options.binauralSettings,
  });
  for (let i = 0; i < length; i++) {
    const time = i / sampleRate;
    const phase = (Math.max(0, Math.min(1, (time - join) / transition)) * Math.PI) / 2;
    const geometricWeight = Math.cos(phase);
    const cancelWeight = 1 - Math.sin(phase);
    ir.left[i] *= geometricWeight;
    ir.right[i] *= geometricWeight;
    // The persistent network supplies all history. Subtract only its prefix to avoid double counting.
    for (let band = 0; band < 8; band++) {
      ir.left[i] -= prefix.left[band][i] * gains[band] * cancelWeight;
      ir.right[i] -= prefix.right[band][i] * gains[band] * cancelWeight;
    }
    if (modal) {
      ir.left[i] -= modal[i] * cancelWeight;
      ir.right[i] -= modal[i] * cancelWeight;
    }
  }
  const prepared = prepareResponse(ir.left, ir.right, 512);
  prepared.lateGains = gains;
  return {
    architecture: 'hybrid',
    prepared,
    late: {
      config,
      gains,
      joinSeconds: join,
      endSeconds: end,
      confidence,
      targetDensity,
      baseDensity,
      decay,
      prefixCache: { hit: prefixCacheHit, hits: prefixCacheHits, misses: prefixCacheMisses },
    },
    ...(modes ? { modes } : {}),
    duration: end,
    sampleRate,
    analyticalCount: result.analyticalCount,
  };
}
