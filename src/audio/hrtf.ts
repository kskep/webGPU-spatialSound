import type { Vec3 } from '../acoustics/model.ts';
import { BINAURAL_SETTINGS, type BinauralSettings, type BinauralToggles } from '../config/binaural.ts';
import { fft } from './dsp/stream-core.mjs';
import {
  addDelayed,
  estimateArrivalDelay,
  minimumPhaseSpectrum,
  octaveBandOfBins,
  smoothFractionalOctave,
} from './hrtf-processing.ts';
import { SphereTriangulation } from './sphere-mesh.ts';
export interface HRIR {
  left: Float32Array;
  right: Float32Array;
  delayLeft: number;
  delayRight: number;
  measurement: number;
}
export interface HrtfOptions {
  equalise?: boolean;
  interpolate?: boolean;
}
export interface DiffuseFieldReport {
  fftSize: number;
  binHz: number;
  earPowerTarget: number;
  scaleDb: number;
  minCorrectionDb: number;
  maxCorrectionDb: number;
  clampedBins: number;
  syntheticPoles: string[];
  thirdOctave: { centresHz: number[]; beforeDb: number[]; afterDb: number[]; correctionDb: number[] };
}
// measured directions plus synthetic pole responses, with interpolation data
interface MeasurementSet {
  count: number;
  vectors: Vec3[];
  left: Float32Array;
  right: Float32Array;
  assetDelay: Float64Array;
  triangulation: SphereTriangulation;
  weights: Float64Array;
}
interface DiffuseFieldAnalysis {
  left: Float32Array;
  right: Float32Array;
  report: DiffuseFieldReport;
  correctionDb: Float64Array;
  coherenceRaw: number[];
  coherenceEqualised: number[];
}
// resample an IR with Hann-windowed sinc (12 taps each side), preserving transfer gain
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const length = Math.ceil((input.length * to) / from);
  const out = new Float32Array(length);
  const cutoff = Math.min(1, to / from);
  for (let i = 0; i < length; i++) {
    const sourcePosition = (i * from) / to;
    const center = Math.floor(sourcePosition);
    let sum = 0;
    let norm = 0;
    for (let tap = center - 12; tap <= center + 12; tap++) {
      const offset = sourcePosition - tap;
      if (Math.abs(offset) > 12) continue;
      const sinc =
        Math.abs(offset) < 1e-9 ? cutoff : Math.sin(Math.PI * offset * cutoff) / (Math.PI * offset);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * offset) / 12);
      const weight = sinc * window;
      norm += weight;
      if (tap >= 0 && tap < input.length) sum += input[tap] * weight;
    }
    // HRIR taps are an impulse response, so preserve transfer gain under rate conversion.
    out[i] = (sum * (from / to)) / Math.max(norm, 1e-9);
  }
  return out;
}
// direction in listener-local coordinates: forward, left, up (SOFA frame)
export function toListenerLocal(direction: Vec3, forward: Vec3): Vec3 {
  const flat = Math.hypot(forward[0], forward[2]) || 1;
  const right: Vec3 = [-forward[2] / flat, 0, forward[0] / flat];
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const dot = (a: Vec3, b: Vec3) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  // SOFA: +azimuth is left; local coordinates are forward, left, up.
  return [dot(direction, forward), -dot(direction, right), dot(direction, up)];
}
// HRTF bank (RIEC subject 080, binary layout from SOFA).
// `resolve` returns the HRIR for a source direction in head coordinates.
//
// Binary layout: 'HRTF' v1, measurement count, IR length, sample rate, positions, left/right IRs, delays.
// 865 directions on a 5-deg azimuth grid, -30..+80 deg elevation plus zenith, all at 1.5 m.
// ITD is in the samples (onset between sample 43 and 123); a shared onset is removed.
//
// Three modes (via HrtfOptions):
//   - Original: nearest direction, frontal-energy gain.
//   - Diffuse-field equalised: 1/3-octave smoothed average power inverted with a minimum-phase
//     filter, clamped, so the diffuse-field power (both ears) is 1.
//   - Interpolated: spherical barycentric weights in the Delaunay triangulation, delay-aligned
//     to avoid comb filtering. Unmeasured nadir gets a synthetic response.
export class HrtfBank {
  readonly measurements: number;
  readonly irLength: number;
  readonly sampleRate: number;
  readonly commonOnset: number;
  private positions: Float32Array;
  private left: Float32Array;
  private right: Float32Array;
  private delays: Float32Array;
  private gain: number;
  private cache = new Map<string, HRIR>();
  private settings: BinauralSettings;
  private set?: MeasurementSet;
  private analysis?: DiffuseFieldAnalysis;
  // Arrival delay per row and ear in samples (NaN = not measured yet), see `arrivalOf`.
  private arrivals = new Float64Array(0);
  // Poles that have no measurement and got a synthetic response (set by `ensureSet`).
  private syntheticPoles: string[] = [];
  constructor(data: ArrayBuffer, settings: BinauralSettings = BINAURAL_SETTINGS) {
    this.settings = settings;
    const view = new DataView(data);
    if (
      data.byteLength < 20 ||
      String.fromCharCode(...new Uint8Array(data, 0, 4)) !== 'HRTF' ||
      view.getUint32(4, true) !== 1
    )
      throw new Error('Invalid HRTF asset header.');
    this.measurements = view.getUint32(8, true);
    this.irLength = view.getUint32(12, true);
    this.sampleRate = view.getFloat32(16, true);
    const measurementCount = this.measurements;
    const irSamples = this.irLength;
    if (
      measurementCount < 1 ||
      measurementCount > 20000 ||
      irSamples < 1 ||
      irSamples > 8192 ||
      this.sampleRate < 8000 ||
      this.sampleRate > 192000 ||
      data.byteLength !== 20 + 4 * measurementCount * (5 + 2 * irSamples)
    )
      throw new Error('Invalid HRTF asset dimensions.');
    this.positions = new Float32Array(data, 20, measurementCount * 3);
    this.left = new Float32Array(data, 20 + measurementCount * 12, measurementCount * irSamples);
    this.right = new Float32Array(
      data,
      20 + measurementCount * 12 + measurementCount * irSamples * 4,
      measurementCount * irSamples,
    );
    this.delays = new Float32Array(
      data,
      20 + measurementCount * 12 + measurementCount * irSamples * 8,
      measurementCount * 2,
    );
    // One shared leading delay is removed, preserving all relative ear/angle timing.
    let onset = irSamples;
    for (let i = 0; i < measurementCount; i++)
      for (const bank of [this.left, this.right]) {
        const signal = bank.subarray(i * irSamples, (i + 1) * irSamples);
        let peak = 0;
        for (const v of signal) {
          if (!Number.isFinite(v)) throw new Error('Non-finite HRTF sample.');
          peak = Math.max(peak, Math.abs(v));
        }
        if (peak > 0) {
          const first = signal.findIndex((v) => Math.abs(v) > peak * 0.01);
          onset = Math.min(onset, first);
        }
      }
    this.commonOnset = onset === irSamples ? 0 : Math.max(0, onset);
    const front = this.nearest([1, 0, 0]);
    let energy = 0;
    for (let i = 0; i < irSamples; i++)
      energy += this.left[front * irSamples + i] ** 2 + this.right[front * irSamples + i] ** 2;
    this.gain = 1 / Math.sqrt(Math.max(energy, 1e-12));
  }
  // number of cached resolved responses
  cacheSize(): number {
    return this.cache.size;
  }
  // description of the data set and read mode
  metadata(options: HrtfOptions = {}) {
    const parts = [
      options.interpolate
        ? 'spherical barycentric interpolation with delay alignment'
        : 'nearest measured direction with response crossfade',
    ];
    if (options.equalise) parts.push('diffuse-field equalised');
    return {
      dataset: 'RIEC_hrir_subject_080',
      measurements: this.measurements,
      sampleRate: this.sampleRate,
      irLength: this.irLength,
      commonOnsetSamples: this.commonOnset,
      method: parts.join(', '),
      ...(options.equalise && this.analysis ? { diffuseField: this.analysis.report } : {}),
    };
  }
  // nearest measurement index by dot product
  private nearest(local: Vec3): number {
    let best = 0;
    let score = -Infinity;
    for (let i = 0; i < this.measurements; i++) {
      const azimuth = (this.positions[i * 3] * Math.PI) / 180;
      const elevation = (this.positions[i * 3 + 1] * Math.PI) / 180;
      const dot =
        local[0] * Math.cos(elevation) * Math.cos(azimuth) +
        local[1] * Math.cos(elevation) * Math.sin(azimuth) +
        local[2] * Math.sin(elevation);
      if (dot > score) {
        score = dot;
        best = i;
      }
    }
    return best;
  }
  // HRIR for a world-space source direction, resampled to `rate` Hz and cached
  resolve(direction: Vec3, forward: Vec3, rate: number, options: HrtfOptions = {}): HRIR {
    return this.resolveLocal(toListenerLocal(direction, forward), rate, options);
  }
  // Like `resolve`, for a direction already in listener coordinates (forward, left, up).
  resolveLocal(local: Vec3, rate: number, options: HrtfOptions = {}): HRIR {
    if (options.equalise || options.interpolate) return this.resolveImproved(local, rate, options);
    const index = this.nearest(local);
    const key = index + ':' + rate;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const start = index * this.irLength + this.commonOnset;
    const end = (index + 1) * this.irLength;
    const leftResampled = resample(this.left.subarray(start, end), this.sampleRate, rate);
    const rightResampled = resample(this.right.subarray(start, end), this.sampleRate, rate);
    const result = {
      left: Float32Array.from(leftResampled, (v) => v * this.gain),
      right: Float32Array.from(rightResampled, (v) => v * this.gain),
      delayLeft: (this.delays[index * 2] * rate) / this.sampleRate,
      delayRight: (this.delays[index * 2 + 1] * rate) / this.sampleRate,
      measurement: index,
    };
    this.cache.set(key, result);
    return result;
  }
  // Equalised and/or interpolated response, resampled to `rate` and cached.
  private resolveImproved(local: Vec3, rate: number, options: HrtfOptions): HRIR {
    const equalise = !!options.equalise;
    const interpolate = !!options.interpolate;
    const step = this.settings.interpolation.cacheStepDegrees;
    const length = Math.hypot(...local) || 1;
    let unit: Vec3 = [local[0] / length, local[1] / length, local[2] / length];
    let key: string;
    if (interpolate) {
      // Round the direction to the cache grid and use the rounded direction for the response, so
      // that one key always means one response.
      let azimuth = (Math.atan2(unit[1], unit[0]) * 180) / Math.PI;
      let elevation = (Math.asin(Math.max(-1, Math.min(1, unit[2]))) * 180) / Math.PI;
      if (step > 0) {
        azimuth = Math.round(azimuth / step) * step;
        elevation = Math.round(elevation / step) * step;
      }
      const a = (azimuth * Math.PI) / 180;
      const e = (elevation * Math.PI) / 180;
      unit = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
      key = `i${equalise ? 1 : 0}:${azimuth}:${elevation}:${rate}`;
    } else {
      key = `n1:${this.nearest(unit)}:${rate}`;
    }
    const cached = this.cache.get(key);
    if (cached) return cached;
    const native = interpolate ? this.interpolate(unit, equalise) : this.nearestRow(unit, equalise);
    const result: HRIR = {
      left: resample(native.left, this.sampleRate, rate),
      right: resample(native.right, this.sampleRate, rate),
      delayLeft: (native.delays[0] * rate) / this.sampleRate,
      delayRight: (native.delays[1] * rate) / this.sampleRate,
      measurement: native.nearest,
    };
    // Bounded cache: a moving listener keeps asking for new directions. Drop the oldest entries.
    if (this.cache.size >= this.settings.interpolation.cacheEntries)
      for (const stale of this.cache.keys()) {
        this.cache.delete(stale);
        if (this.cache.size < this.settings.interpolation.cacheEntries * 0.75) break;
      }
    this.cache.set(key, result);
    return result;
  }
  // Rows of the raw set (scaled by the frontal gain) or of the equalised set, cropped at the common onset.
  private rows(equalised: boolean, row: number): { left: Float32Array; right: Float32Array } {
    const start = row * this.irLength + this.commonOnset;
    const end = (row + 1) * this.irLength;
    if (equalised) {
      const analysis = this.ensureAnalysis();
      return { left: analysis.left.slice(start, end), right: analysis.right.slice(start, end) };
    }
    const set = this.ensureSet();
    return {
      left: Float32Array.from(set.left.subarray(start, end), (v) => v * this.gain),
      right: Float32Array.from(set.right.subarray(start, end), (v) => v * this.gain),
    };
  }
  // The nearest measured direction, from the equalised or the raw set, at the native rate.
  private nearestRow(unit: Vec3, equalised: boolean) {
    const index = this.nearest(unit);
    const { left, right } = this.rows(equalised, index);
    return {
      left,
      right,
      delays: [this.delays[index * 2], this.delays[index * 2 + 1]] as [number, number],
      nearest: index,
    };
  }
  private interpolate(unit: Vec3, equalised: boolean) {
    const set = this.ensureSet();
    const located = set.triangulation.locate(unit);
    const [a, b, c] = located.vertices;
    if (located.weights[0] === 1 && a === b && b === c) {
      const row = this.rows(equalised, a);
      const real = a < this.measurements;
      return {
        left: row.left,
        right: row.right,
        delays: [real ? this.delays[a * 2] : 0, real ? this.delays[a * 2 + 1] : 0] as [number, number],
        nearest: real ? a : this.nearest(unit),
      };
    }
    const length = this.irLength;
    const halfWidth = this.settings.interpolation.shiftHalfWidth;
    const full = [new Float32Array(length), new Float32Array(length)];
    // Mean arrival delay per ear, and the interpolated asset delay.
    const meanArrival = [0, 0];
    const delays: [number, number] = [0, 0];
    located.vertices.forEach((vertex, corner) => {
      const weight = located.weights[corner];
      for (let ear = 0; ear < 2; ear++) {
        meanArrival[ear] += weight * this.arrivalOf(vertex, ear);
        delays[ear] += weight * set.assetDelay[vertex * 2 + ear];
      }
    });
    const analysis = equalised ? this.ensureAnalysis() : undefined;
    located.vertices.forEach((vertex, corner) => {
      const weight = located.weights[corner];
      if (weight === 0) return;
      const sourceLeft = (analysis?.left ?? set.left).subarray(vertex * length, (vertex + 1) * length);
      const sourceRight = (analysis?.right ?? set.right).subarray(vertex * length, (vertex + 1) * length);
      const scale = analysis ? 1 : this.gain;
      addDelayed(full[0], sourceLeft, meanArrival[0] - this.arrivalOf(vertex, 0), weight * scale, halfWidth);
      addDelayed(full[1], sourceRight, meanArrival[1] - this.arrivalOf(vertex, 1), weight * scale, halfWidth);
    });
    // Nearest real measurement, for the report.
    let nearest = a;
    let heaviest = -1;
    located.vertices.forEach((vertex, corner) => {
      if (vertex < this.measurements && located.weights[corner] > heaviest) {
        heaviest = located.weights[corner];
        nearest = vertex;
      }
    });
    if (nearest >= this.measurements) nearest = this.nearest(unit);
    return {
      left: full[0].slice(this.commonOnset),
      right: full[1].slice(this.commonOnset),
      delays,
      nearest,
    };
  }

  prepare(toggles: Pick<BinauralToggles, 'diffuseFieldEq' | 'hrtfInterpolation' | 'lateCoherence'>): void {
    if (toggles.diffuseFieldEq || toggles.lateCoherence) this.ensureAnalysis();
    else if (toggles.hrtfInterpolation) this.ensureSet();
  }

  private arrivalOf(row: number, ear: number): number {
    const index = row * 2 + ear;
    if (Number.isNaN(this.arrivals[index])) {
      const bank = ear === 0 ? this.left : this.right;
      let size = 2;
      while (size < 2 * this.irLength) size *= 2;
      this.arrivals[index] = estimateArrivalDelay(
        bank.subarray(row * this.irLength, (row + 1) * this.irLength),
        size,
      );
    }
    return this.arrivals[index];
  }

  // The measured directions, a synthetic response at each unmeasured pole, delays and weights (built once).
  private ensureSet(): MeasurementSet {
    if (this.set) return this.set;
    const length = this.irLength;
    const count = this.measurements;
    const halfWidth = this.settings.interpolation.shiftHalfWidth;
    const vectors: Vec3[] = [];
    const assetDelay: number[] = [];
    this.arrivals = new Float64Array((count + 2) * 2).fill(NaN);
    for (let i = 0; i < count; i++) {
      const azimuth = (this.positions[i * 3] * Math.PI) / 180;
      const elevation = (this.positions[i * 3 + 1] * Math.PI) / 180;
      vectors.push([
        Math.cos(elevation) * Math.cos(azimuth),
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
      ]);
      assetDelay.push(this.delays[i * 2], this.delays[i * 2 + 1]);
    }
    // Unmeasured poles: the aligned mean of the nearest ring stands in for the missing response.
    const tolerance = Math.cos((this.settings.diffuseField.poleToleranceDegrees * Math.PI) / 180);
    const syntheticLeft: Float32Array[] = [];
    const syntheticRight: Float32Array[] = [];
    const syntheticPoles: string[] = [];
    for (const sign of [1, -1]) {
      const pole: Vec3 = [0, 0, sign];
      let closest = -Infinity;
      for (const v of vectors) closest = Math.max(closest, v[0] * pole[0] + v[1] * pole[1] + v[2] * pole[2]);
      if (closest >= tolerance) continue;
      const ring: number[] = [];
      for (let i = 0; i < count; i++) if (vectors[i][2] * sign > closest - 1e-3) ring.push(i);
      const mean = [0, 1].map(
        (ear) => ring.reduce((sum, i) => sum + this.arrivalOf(i, ear), 0) / ring.length,
      );
      const blended = [new Float32Array(length), new Float32Array(length)];
      for (const i of ring)
        [this.left, this.right].forEach((bank, ear) =>
          addDelayed(
            blended[ear],
            bank.subarray(i * length, (i + 1) * length),
            mean[ear] - this.arrivalOf(i, ear),
            1 / ring.length,
            halfWidth,
          ),
        );
      vectors.push(pole);
      this.arrivals.set(mean, vectors.length * 2 - 2);
      assetDelay.push(0, 0);
      syntheticLeft.push(blended[0]);
      syntheticRight.push(blended[1]);
      syntheticPoles.push(sign > 0 ? '+z' : '-z');
    }
    const total = vectors.length;
    const left = new Float32Array(total * length);
    const right = new Float32Array(total * length);
    left.set(this.left);
    right.set(this.right);
    syntheticLeft.forEach((row, k) => left.set(row, (count + k) * length));
    syntheticRight.forEach((row, k) => right.set(row, (count + k) * length));
    const triangulation = new SphereTriangulation(vectors);
    this.set = {
      count: total,
      vectors,
      left,
      right,
      assetDelay: Float64Array.from(assetDelay),
      triangulation,
      weights: triangulation.solidAngleWeights(),
    };
    this.syntheticPoles = syntheticPoles;
    return this.set;
  }
  private ensureAnalysis(): DiffuseFieldAnalysis {
    if (this.analysis) return this.analysis;
    const set = this.ensureSet();
    const field = this.settings.diffuseField;
    const length = this.irLength;
    const rate = this.sampleRate;
    let size = 2048;
    while (size < 4 * length) size *= 2;
    const half = size / 2;
    const binHz = rate / size;
    const bandOfBin = octaveBandOfBins(size, rate);
    const target = 0.5; // power of one ear; the sum of the two ears is 1
    const real = new Float64Array(size);
    const imag = new Float64Array(size);
    const rawPower = new Float64Array(half + 1);
    const equalisedPower = new Float64Array(half + 1);
    const rawCross = new Float64Array(8);
    const rawLeftPower = new Float64Array(8);
    const rawRightPower = new Float64Array(8);
    const eqCross = new Float64Array(8);
    const eqLeftPower = new Float64Array(8);
    const eqRightPower = new Float64Array(8);
    // Adds the weighted power and the band sums of the spectrum Z (real/imag) to the accumulators.
    const accumulate = (
      weight: number,
      power: Float64Array,
      cross: Float64Array,
      leftPower: Float64Array,
      rightPower: Float64Array,
    ) => {
      for (let k = 0; k <= half; k++) {
        const m = (size - k) % size;
        // Left and right spectra of bin k from the packed spectrum.
        const leftReal = (real[k] + real[m]) / 2;
        const leftImag = (imag[k] - imag[m]) / 2;
        const rightReal = (imag[k] + imag[m]) / 2;
        const rightImag = -(real[k] - real[m]) / 2;
        const ll = leftReal * leftReal + leftImag * leftImag;
        const rr = rightReal * rightReal + rightImag * rightImag;
        power[k] += (weight * (ll + rr)) / 2;
        const band = bandOfBin[k];
        cross[band] += weight * (leftReal * rightReal + leftImag * rightImag);
        leftPower[band] += weight * ll;
        rightPower[band] += weight * rr;
      }
    };
    const load = (row: number) => {
      real.fill(0);
      imag.fill(0);
      real.set(set.left.subarray(row * length, (row + 1) * length));
      imag.set(set.right.subarray(row * length, (row + 1) * length));
      fft(real, imag);
    };
    for (let row = 0; row < set.count; row++) {
      load(row);
      accumulate(set.weights[row], rawPower, rawCross, rawLeftPower, rawRightPower);
    }

    // Filter design: 1/3-octave smoothed average power -> correction in dB, limited and flattened.
    const smoothed = smoothFractionalOctave(rawPower, field.smoothingOctaves);
    const lowBin = Math.round(field.lowFlattenHz / binHz);
    const highBin = Math.min(half, Math.round(field.highFlattenHz / binHz));
    const correctionDb = new Float64Array(half + 1);
    let clampedBins = 0;
    for (let k = lowBin; k <= highBin; k++) {
      const wanted = 10 * Math.log10(target / Math.max(smoothed[k], 1e-30));
      const limited = Math.max(-field.clampDb, Math.min(field.clampDb, wanted));
      if (limited !== wanted) clampedBins++;
      correctionDb[k] = limited;
    }
    for (let k = 0; k < lowBin; k++) correctionDb[k] = correctionDb[lowBin];
    for (let k = highBin + 1; k <= half; k++) correctionDb[k] = correctionDb[highBin];
    const logMagnitude = new Float64Array(size);
    for (let k = 0; k <= half; k++) {
      const value = (correctionDb[k] * Math.LN10) / 20;
      logMagnitude[k] = value;
      if (k > 0 && k < half) logMagnitude[size - k] = value;
    }
    const filterReal = new Float64Array(size);
    const filterImag = new Float64Array(size);
    minimumPhaseSpectrum(logMagnitude, filterReal, filterImag);
    // Overall scale: the mean power over the equalised range (lowFlattenHz... highFlattenHz, where
    // the filter works) is the target. Bins where the clamp was active make this differ slightly from
    // one; the held regions outside the range keep the natural level of the measurement there.
    let weightedSum = 0;
    for (let k = lowBin; k <= highBin; k++) weightedSum += rawPower[k] * (10 ** (correctionDb[k] / 20)) ** 2;
    const weightTotal = highBin - lowBin + 1;
    // EDW DIORTHWNOUME TO EQ GAIN GIA NA DIATIROUME TIN EPITHYMITI MESI ISXY TOU DIAXYTOU PEDIOU.
    const scale = Math.sqrt(target / (weightedSum / weightTotal));
    const scaleDb = 20 * Math.log10(scale);
    for (let k = 0; k < size; k++) {
      filterReal[k] *= scale;
      filterImag[k] *= scale;
    }

    // Pass 2: apply the filter, keep the first `length` samples, accumulate the equalised statistics.
    const left = new Float32Array(set.count * length);
    const right = new Float32Array(set.count * length);
    for (let row = 0; row < set.count; row++) {
      load(row);
      for (let k = 0; k < size; k++) {
        const a = real[k];
        const b = imag[k];
        real[k] = a * filterReal[k] - b * filterImag[k];
        imag[k] = a * filterImag[k] + b * filterReal[k];
      }
      accumulate(set.weights[row], equalisedPower, eqCross, eqLeftPower, eqRightPower);
      fft(real, imag, true);
      for (let i = 0; i < length; i++) {
        left[row * length + i] = real[i];
        right[row * length + i] = imag[i];
      }
    }

    const coherence = (cross: Float64Array, leftPower: Float64Array, rightPower: Float64Array) =>
      Array.from({ length: 8 }, (_, band) => {
        // EDW KANONIKOPOIOUME TO CROSS POWER GIA NA VROUME TIN SYSXETISI METAKSY TWN DYO AFTIWN.
        const denominator = Math.sqrt(leftPower[band] * rightPower[band]);
        return denominator > 0 ? cross[band] / denominator : 0;
      });
    // One-third octave report from 100 Hz to 20 kHz.
    const thirdOctave = {
      centresHz: [] as number[],
      beforeDb: [] as number[],
      afterDb: [] as number[],
      correctionDb: [] as number[],
    };
    for (let n = -10; n <= 13; n++) {
      const centre = 1000 * 10 ** (n / 10);
      const lower = centre * 2 ** (-1 / 6);
      const upper = centre * 2 ** (1 / 6);
      if (upper > rate / 2) break;
      let before = 0;
      let after = 0;
      let correction = 0;
      let bins = 0;
      for (let k = Math.ceil(lower / binHz); k < upper / binHz && k <= half; k++) {
        before += rawPower[k];
        after += equalisedPower[k];
        correction += correctionDb[k];
        bins++;
      }
      if (bins === 0) continue;
      thirdOctave.centresHz.push(centre);
      thirdOctave.beforeDb.push(10 * Math.log10(before / bins));
      thirdOctave.afterDb.push(10 * Math.log10(after / bins));
      thirdOctave.correctionDb.push(correction / bins + scaleDb);
    }
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let k = 0; k <= half; k++) {
      minimum = Math.min(minimum, correctionDb[k] + scaleDb);
      maximum = Math.max(maximum, correctionDb[k] + scaleDb);
    }
    this.analysis = {
      left,
      right,
      correctionDb: correctionDb.map((value) => value + scaleDb),
      coherenceRaw: coherence(rawCross, rawLeftPower, rawRightPower),
      coherenceEqualised: coherence(eqCross, eqLeftPower, eqRightPower),
      report: {
        fftSize: size,
        binHz,
        earPowerTarget: target,
        scaleDb,
        minCorrectionDb: minimum,
        maxCorrectionDb: maximum,
        clampedBins,
        syntheticPoles: this.syntheticPoles,
        thirdOctave,
      },
    };
    return this.analysis;
  }

  diffuseFieldCorrection(): { binHz: number; gainDb: Float64Array } {
    const analysis = this.ensureAnalysis();
    return { binHz: analysis.report.binHz, gainDb: analysis.correctionDb };
  }

  // What the diffuse-field equalisation did (computes it on first use).
  diffuseFieldReport(): DiffuseFieldReport {
    return this.ensureAnalysis().report;
  }

  diffuseCoherence(equalised: boolean): number[] {
    const analysis = this.ensureAnalysis();
    return [...(equalised ? analysis.coherenceEqualised : analysis.coherenceRaw)];
  }

  diffuseFieldRows(equalised: boolean): {
    count: number;
    weights: Float64Array;
    left: Float32Array;
    right: Float32Array;
  } {
    const set = this.ensureSet();
    return {
      count: set.count,
      weights: set.weights,
      left: equalised ? this.ensureAnalysis().left : set.left,
      right: equalised ? this.ensureAnalysis().right : set.right,
    };
  }

  // Arrival delays in samples, left and right, of the measured directions (see `estimateArrivalDelay`).
  arrivalDelays(): Float64Array {
    this.ensureSet();
    return Float64Array.from({ length: this.measurements * 2 }, (_, i) => this.arrivalOf(i >> 1, i & 1));
  }

  // Azimuth and elevation in degrees of measurement `index`.
  direction(index: number): { azimuth: number; elevation: number } {
    return { azimuth: this.positions[index * 3], elevation: this.positions[index * 3 + 1] };
  }
}
