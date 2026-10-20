// Persistent late reverberation field (thesis 4.5).
//
// Eight octave bands (63 Hz.. 8 kHz), each with its own feedback delay network (FDN) of eight delay
// lines. The input is band-split by steep Chebyshev filters, fed into the network, and the network
// output is band-filtered again and summed to a decorrelated left/right pair. Per band, the feedback
// gain of every line is set so that the band decays by 60 dB in its own RT60 (Sabine/Eyring or the
// value fitted from the traced rays). Because the network keeps running while the room changes, the
// tail never restarts when the listener moves; only the feedback gains are ramped (see setDecay).
//
// Interaural coherence. The raw left/right outputs of a band are only approximately
// uncorrelated, and their powers differ by up to a few dB. A per-band 2x2 matrix, designed once
// from the network's own impulse response (see designCoherenceMix), whitens the pair and then gives
// it the coherence of a diffuse field at the two ears. The matrix is part of the late configuration
// and is applied inside tick(), so the worklet and latePrefix (the cancellation of the handoff)
// run the very same arithmetic.

// Octave-band centre frequencies in Hz.
const FREQUENCIES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
/**
 * Delay lengths of the eight lines as multiples of the mean free time (the standard layout, 8 lines
 * from 0.707 to 1.513). A late configuration may carry its own `delayRatios` : a power-of-two
 * number of lines, 8 or more, with the same meaning.
 */
export const STANDARD_DELAY_RATIOS = [0.707, 0.811, 0.913, 1.017, 1.121, 1.233, 1.371, 1.513];
// Per delay line of the 8-line network: sign with which the band input is injected, and the +/-1 weights of the L and R taps.
const INJECTION = [1, -1, -1, 1, -1, 1, 1, -1];
const LEFT_SIGNS = [1, 1, -1, -1, -1, -1, 1, 1];
const RIGHT_SIGNS = [1, -1, 1, -1, -1, 1, -1, 1];

/**
 * Injection and tap signs of an n-line network. For 8 lines these are the fixed vectors above (so the
 * standard network is unchanged); for more lines they are three different rows of the n x n
 * Walsh-Hadamard matrix, sign(i) = (-1)^popcount(i & row), which are mutually orthogonal.
 */
function lineSigns(lines) {
  if (lines === 8) return { injection: INJECTION, left: LEFT_SIGNS, right: RIGHT_SIGNS };
  const row = (index) =>
    Array.from({ length: lines }, (_, i) => {
      let bits = i & index;
      let parity = 0;
      for (; bits; bits >>= 1) parity ^= bits & 1;
      return parity ? -1 : 1;
    });
  return { injection: row(lines - 3), left: row(5), right: row(lines / 2 + 3) };
}

// Checks the delay-length ratios of a configuration: a power of two (>= 8) of positive finite numbers.
function validateDelayRatios(ratios) {
  if (ratios == null) return;
  const n = ratios.length;
  if (n < 8 || (n & (n - 1)) !== 0 || ratios.some((v) => !Number.isFinite(v) || v <= 0))
    throw new Error('Invalid delay ratios.');
}

// Smallest odd prime >= max(17, value). Prime delay lengths avoid coinciding echoes between lines.
function primeAtLeast(value) {
  let candidate = Math.max(17, Math.ceil(value) | 1);
  for (; ; candidate += 2) {
    let prime = true;
    for (let divisor = 3; divisor * divisor <= candidate; divisor += 2)
      if (candidate % divisor === 0) {
        prime = false;
        break;
      }
    if (prime) return candidate;
  }
}

/**
 * Digital Chebyshev type-I filter of order 24 (0.1 dB passband ripple) as 12 biquad sections,
 * returned as [b0, b1, b2, a1, a2] coefficient arrays (a0 normalised to 1), sorted by ascending Q.
 *
 * `edge` is the -3 dB frequency in Hz, `rate` the sample rate. Each pair of analogue poles
 * s = -sinh(mu) sin(theta) + j cosh(mu) cos(theta) is mapped to a section by the bilinear transform
 * with frequency prewarping (RBJ cookbook form). Returns no sections when the edge is outside (0, rate/2).
 */
function chebyshevSections(edge, rate, highpass) {
  if (edge <= 0 || edge >= rate / 2) return [];
  const order = 24;
  const epsilon = Math.sqrt(Math.pow(10, 0.1 / 10) - 1);
  const mu = Math.asinh(1 / epsilon) / order;
  // Place the -3 dB crossover at the shared octave boundary, rather than at the ripple edge.
  const ratio = Math.cosh(Math.acosh(1 / epsilon) / order);
  const rippleEdge = 2 * rate * Math.tan((Math.PI * edge) / rate) * (highpass ? ratio : 1 / ratio);
  const sections = [];
  for (let pole = 0; pole < order / 2; pole++) {
    const theta = (Math.PI * (2 * pole + 1)) / (2 * order);
    const real = -Math.sinh(mu) * Math.sin(theta);
    const imag = Math.cosh(mu) * Math.cos(theta);
    const magnitude = Math.hypot(real, imag);
    const q = magnitude / (-2 * real);
    const analog = highpass ? rippleEdge / magnitude : rippleEdge * magnitude;
    const omega = 2 * Math.atan(analog / (2 * rate));
    const cos = Math.cos(omega);
    const alpha = Math.sin(omega) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (highpass ? 1 + cos : 1 - cos) / (2 * a0);
    const b1 = (highpass ? -(1 + cos) : 1 - cos) / a0;
    sections.push({ coeff: [b0, b1, b0, (-2 * cos) / a0, (1 - alpha) / a0], q });
  }
  sections.sort((first, second) => first.q - second.q);
  return sections.map((section) => section.coeff);
}

// A filter made of biquad sections in series, with 4 state values (x1, x2, y1, y2) per section.
function cascade(coefficients) {
  return { coefficients, state: new Float64Array(coefficients.length * 4) };
}

// Runs one sample through the cascade (direct form I, section by section); updates the filter state.
function filter(bank, input) {
  for (let section = 0; section < bank.coefficients.length; section++) {
    const coeffs = bank.coefficients[section];
    const base = section * 4;
    const state = bank.state;
    const output =
        coeffs[0] * input +
        coeffs[1] * state[base] +
        coeffs[2] * state[base + 1] -
        coeffs[3] * state[base + 2] -
        coeffs[4] * state[base + 3];
    state[base + 1] = state[base];
    state[base] = input;
    state[base + 3] = state[base + 2];
    state[base + 2] = output;
    input = output;
  }
  return input;
}

/**
 * One band's left output after mixing: m11 * left + m12 * right, where `mix` holds the matrices of all
 * bands ([m11, m12, m21, m22] per band) and `offset` = 4 * band. The only place that defines the
 * mixing arithmetic; `LateFdn.tick` and `applyCoherenceMix` both call it.
 */
export function mixedLeft(mix, offset, left, right) {
  return mix[offset] * left + mix[offset + 1] * right;
}
// One band's right output after mixing: m21 * left + m22 * right (see mixedLeft).
export function mixedRight(mix, offset, left, right) {
  return mix[offset + 2] * left + mix[offset + 3] * right;
}

/**
 * Designs the per-band mixing matrices (flat array of 32: [m11, m12, m21, m22] for each band) that
 * give the network's left/right pair equal power and the interaural coherence `coherence[band]`.
 *
 * The covariance of the raw pair is taken from the network's own impulse response: for a white
 * input, the zero-lag correlation of the two outputs is the sum of left times right over the
 * response. `prefix` is that response (see latePrefix) and `length` the number of samples to use; the
 * correlation is stable once the response is a few hundred milliseconds long.
 *
 *  1. Whitening W = sqrt(m) C^(-1/2), with C = [[a, c], [c, d]] the covariance (a = left power,
 *     d = right power, c = cross term) and m = (a + d) / 2. Then W C W^T = m I: equal power,
 *     no correlation. The smaller eigenvalue of C is not allowed below `regularisation` * m, which
 *     bounds the gain of the difference channel when the pair is almost identical.
 *  2. Correlation K = [[cos t, sin t], [sin t, cos t]] with t = asin(IC) / 2, so that
 *     K K^T = [[1, IC], [IC, 1]].
 *
 * The result M = K W has M C M^T = m [[1, IC], [IC, 1]]: the total power a + d is unchanged and the
 * correlation is IC. A silent band gets the identity.
 */
export function designCoherenceMix(prefix, coherence, length, regularisation = 0.02) {
  const mix = [];
  for (let band = 0; band < 8; band++) {
    let a = 0;
    let d = 0;
    let c = 0;
    const left = prefix.left[band];
    const right = prefix.right[band];
    for (let i = 0; i < length; i++) {
      a += left[i] * left[i];
      d += right[i] * right[i];
      c += left[i] * right[i];
    }
    const mean = (a + d) / 2;
    if (!(mean > 1e-300)) {
      mix.push(...IDENTITY_MIX);
      continue;
    }
    const half = (a - d) / 2;
    const radius = Math.hypot(half, c);
    const larger = mean + radius;
    const smaller = Math.max(mean - radius, regularisation * mean);
    const angle = 0.5 * Math.atan2(c, half);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const gainLarger = Math.sqrt(mean / larger);
    const gainSmaller = Math.sqrt(mean / smaller);
    // Whitening matrix (symmetric): Q diag(g) Q^T.
    const w11 = gainLarger * cos * cos + gainSmaller * sin * sin;
    const w12 = (gainLarger - gainSmaller) * cos * sin;
    const w22 = gainLarger * sin * sin + gainSmaller * cos * cos;
    const theta = Math.asin(Math.max(-1, Math.min(1, coherence[band]))) / 2;
    const kc = Math.cos(theta);
    const ks = Math.sin(theta);
    mix.push(kc * w11 + ks * w12, kc * w12 + ks * w22, ks * w11 + kc * w12, ks * w12 + kc * w22);
  }
  return mix;
}

/**
 * The late field's impulse response after mixing: the mixing matrices applied to an unmixed
 * `latePrefix` result, sample by sample, with the arithmetic of `LateFdn.tick`. Equal (up to
 * single-precision storage) to latePrefix of a configuration that carries the same `coherenceMix`.
 */
export function applyCoherenceMix(prefix, mix, length) {
  const left = Array.from({ length: 8 }, () => new Float32Array(length));
  const right = Array.from({ length: 8 }, () => new Float32Array(length));
  for (let band = 0; band < 8; band++)
    for (let i = 0; i < length; i++) {
      const unmixedLeft = prefix.left[band][i];
      const unmixedRight = prefix.right[band][i];
      left[band][i] = mixedLeft(mix, band * 4, unmixedLeft, unmixedRight);
      right[band][i] = mixedRight(mix, band * 4, unmixedLeft, unmixedRight);
    }
  return { left, right };
}

/**
 * Configuration of the persistent late field.
 * `stats` (optional) replaces the empty-shoebox volume and surface area by the
 * values of the real mesh, e.g. a furnished room: {volume, surfaceArea}.
 *
 * The mean free time (mean time between wall hits) is 4V / (S c), with V the volume in m^3,
 * S the surface area in m^2 and c the speed of sound in m/s. It sets the delay-line lengths.
 *
 * `layout` (optional, Task O) changes the delay lines of the network; without it the configuration is
 * exactly the one of the standard network:
 *  - `delayRatios` replaces the eight delay-length ratios; its length is the number of lines per band
 *    (a power of two, 8 or more), see STANDARD_DELAY_RATIOS;
 *  - `minDelayBase` (seconds) is the shortest "mean free time" the delay lengths are scaled by: a
 *    small room has a mean free time of a few milliseconds, which leaves the network with far too
 *    few modes per Hz (a ringing comb); the lines are then scaled by this value instead.
 */
export function makeLateConfig(sampleRate, dimensions, rt60Bands, speed = 343, stats, layout) {
  validateDelayRatios(layout?.delayRatios);
  if (
    layout?.minDelayBase !== undefined &&
    !(Number.isFinite(layout.minDelayBase) && layout.minDelayBase >= 0)
  )
    throw new Error('Invalid minimum delay base.');
  const [width, height, depth] = dimensions;
  const volume = stats ? stats.volume : width * height * depth;
  const surfaceArea = stats ? stats.surfaceArea : 2 * (width * height + width * depth + height * depth);
  return {
    sampleRate,
    volume,
    surfaceArea,
    speed,
    meanFreeTime: (4 * volume) / (surfaceArea * speed),
    rt60Bands: [...rt60Bands],
    // Only a non-standard layout is written, so that the standard configuration (and its cache key
    // and signature) is exactly what it was before Task O.
    ...(layout?.delayRatios ? { delayRatios: [...layout.delayRatios] } : {}),
    ...(layout?.minDelayBase ? { minDelayBase: layout.minDelayBase } : {}),
  };
}
// Seconds over which `LateFdn.setDecay` moves the feedback gains to their new values.
export const DECAY_RAMP_SECONDS = 0.05;
// Seconds over which `LateFdn.setCoherenceMix` moves the mixing matrices to their new values.
export const COHERENCE_RAMP_SECONDS = 0.05;
// The mixing matrix that leaves a band unchanged: [m11, m12, m21, m22].
const IDENTITY_MIX = [1, 0, 0, 1];
// Checks a coherence mix: 8 bands x 4 finite numbers (flat), or null/undefined for "no mixing".
function validateCoherenceMix(mix) {
  if (mix == null) return;
  if (mix.length !== 32 || mix.some((v) => !Number.isFinite(v))) throw new Error('Invalid coherence mix.');
}
// Checks one reverberation time: a finite value >= 0, or Infinity (no loss).
function validateDecayTime(rt) {
  if ((!Number.isFinite(rt) && rt !== Infinity) || rt < 0) throw new Error('Invalid decay time.');
}
/**
 * Feedback gain of a delay line of `length` samples so that its signal loses 60 dB in `rt` seconds:
 * gain = 10^(-3 * length / (sampleRate * rt)). rt = 0 means a fully absorbing band (gain 0).
 */
function feedbackGain(length, sampleRate, rt) {
  // EDW VGAZOUME FEEDBACK GAIN APO MIKOS GRAMMIS KAI RT60 GIA NA EXEI TO FDN TIN SWSTI APOSTVESI.
  return rt === 0 ? 0 : Math.exp((-3 * Math.LN10 * length) / (sampleRate * rt));
}
/**
 * Eight-band feedback delay network (eight lines per band as standard, 8 or more with `delayRatios`) with a Hadamard feedback matrix.
 * Orthogonal feedback retains excitation across response changes; steep complementary bands keep distinct decay rates.
 *
 * Per band the delay lengths are prime numbers near meanFreeTime * ratio (ratios 0.707.. 1.513, so the
 * lines are mutually incommensurate). After `tick(x)`, `bandL[b]` and `bandR[b]` hold the late-field
 * output of band b for that sample.
 */
export class LateFdn {
  constructor(config) {
    if (
      !Number.isFinite(config.sampleRate) ||
      config.sampleRate < 8000 ||
      !Number.isFinite(config.meanFreeTime) ||
      config.meanFreeTime <= 0 ||
      config.rt60Bands.length !== 8
    )
      throw new Error('Invalid late-field configuration.');
    validateCoherenceMix(config.coherenceMix);
    validateDelayRatios(config.delayRatios);
    this.config = config;
    // Seconds the delay lengths are scaled by: the mean free time, or the configured minimum if that is longer.
    const delayBase = Math.max(config.meanFreeTime, config.minDelayBase ?? 0);
    const ratios = config.delayRatios ?? STANDARD_DELAY_RATIOS;
    const lines = ratios.length;
    // Lines per band, the scale that makes the Hadamard feedback orthogonal, and the line signs.
    this.lines = lines;
    this.inverseRoot = 1 / Math.sqrt(lines);
    this.signs = lineSigns(lines);
    this.bandL = new Float64Array(8);
    this.bandR = new Float64Array(8);
    this.inputFilters = [];
    this.leftFilters = [];
    this.rightFilters = [];
    this.buffers = [];
    this.indices = [];
    this.feedback = [];
    this.scratch = new Float64Array(lines);
    // Targets and per-sample steps of a decay change in progress (see setDecay).
    this.feedbackTarget = [];
    this.feedbackStep = [];
    this.rampRemaining = 0;
    // Coherence mix: current, target and per-sample step of the 32 coefficients; null = no mixing.
    this.mix = null;
    this.mixTarget = null;
    this.mixStep = null;
    this.mixRampRemaining = 0;
    this.setCoherenceMix(config.coherenceMix, 0);
    for (let band = 0; band < 8; band++) {
      // Keep the finite crossover transition just below the octave boundary.
      // Otherwise a tiny slow-band leak dominates a rapidly decaying upper band.
      // Both neighbours share the same edge, preserving broadband coverage.
      const lower = band === 0 ? 0 : 0.95 * Math.sqrt(FREQUENCIES[band - 1] * FREQUENCIES[band]);
      const upper =
          band === 7
            ? config.sampleRate / 2
            : Math.min(config.sampleRate / 2, 0.95 * Math.sqrt(FREQUENCIES[band] * FREQUENCIES[band + 1]));
      const high = chebyshevSections(lower, config.sampleRate, true);
      const low = chebyshevSections(upper, config.sampleRate, false);
      // The band-pass (high-pass + low-pass) is split: the first 6 sections of each filter band-limit
      // the input, the remaining sections band-limit the network output.
      const split = 6;
      const input = [...high.slice(0, split), ...low.slice(0, split)];
      const output = [...high.slice(split), ...low.slice(split)];
      this.inputFilters.push(cascade(input));
      this.leftFilters.push(cascade(output));
      this.rightFilters.push(cascade(output));
      const buffers = [];
      const feedback = new Float64Array(lines);
      const indices = new Int32Array(lines);
      const rt = config.rt60Bands[band];
      validateDecayTime(rt);
      for (let line = 0; line < lines; line++) {
        const length = primeAtLeast(
          config.sampleRate * delayBase * ratios[line] * (1 + (band - 3.5) * 0.004),
        );
        buffers.push(new Float32Array(length));
        feedback[line] = feedbackGain(length, config.sampleRate, rt);
      }
      this.buffers.push(buffers);
      this.feedback.push(feedback);
      this.indices.push(indices);
      this.feedbackTarget.push(Float64Array.from(feedback));
      this.feedbackStep.push(new Float64Array(lines));
    }
  }
  /**
   * Changes the reverberation time of every band without touching the delay lines.
   *
   * The delay lengths depend only on the mean free time and the sample rate, so a new
   * RT60 only changes the feedback gains. The signal already circulating in the network
   * is kept, so the reverberation tail continues smoothly. The gains move linearly to
   * their new values over DECAY_RAMP_SECONDS (50 ms) to avoid clicks.
   * Invalid input throws before anything is changed.
   */
  setDecay(rt60Bands, rampSeconds = DECAY_RAMP_SECONDS) {
    if (!rt60Bands || rt60Bands.length !== 8) throw new Error('Invalid late-field configuration.');
    for (const rt of rt60Bands) validateDecayTime(rt);
    const rampSamples = Math.max(1, Math.round(rampSeconds * this.config.sampleRate));
    for (let band = 0; band < 8; band++) {
      for (let line = 0; line < this.lines; line++) {
        const target = feedbackGain(this.buffers[band][line].length, this.config.sampleRate, rt60Bands[band]);
        this.feedbackTarget[band][line] = target;
        this.feedbackStep[band][line] = (target - this.feedback[band][line]) / rampSamples;
      }
    }
    this.rampRemaining = rampSamples;
    this.config = { ...this.config, rt60Bands: [...rt60Bands] };
  }
  // Moves every feedback gain one step towards its target; the last step lands exactly on it.
  advanceRamp() {
    this.rampRemaining--;
    for (let band = 0; band < 8; band++) {
      for (let line = 0; line < this.lines; line++) {
        this.feedback[band][line] =
          this.rampRemaining === 0
            ? this.feedbackTarget[band][line]
            : this.feedback[band][line] + this.feedbackStep[band][line];
      }
    }
  }
  /**
   * Sets the per-band left/right mixing (`mix`: 32 numbers, [m11, m12, m21, m22] for each band, or
   * null for none). The coefficients move linearly to their new values over `rampSeconds` (0 = at
   * once), so that switching it on or off does not click. Once the ramp has ended at the identity,
   * the mixing is switched off again and the output is exactly the unmixed network.
   */
  setCoherenceMix(mix, rampSeconds = COHERENCE_RAMP_SECONDS) {
    validateCoherenceMix(mix);
    if (!this.mix && !mix) return; // nothing to switch off
    const target = mix
      ? Float64Array.from(mix)
      : Float64Array.from({ length: 32 }, (_, i) => IDENTITY_MIX[i % 4]);
    const unchanged = this.mixTarget && target.every((v, i) => v === this.mixTarget[i]);
    if (unchanged && this.mixRampRemaining === 0) return;
    if (!this.mix) this.mix = Float64Array.from({ length: 32 }, (_, i) => IDENTITY_MIX[i % 4]);
    const rampSamples = Math.round(rampSeconds * this.config.sampleRate);
    this.mixTarget = target;
    this.mixStep = new Float64Array(32);
    if (rampSamples < 1) {
      this.mix.set(target);
      this.mixRampRemaining = 0;
    } else {
      for (let i = 0; i < 32; i++) this.mixStep[i] = (target[i] - this.mix[i]) / rampSamples;
      this.mixRampRemaining = rampSamples;
    }
    this.config = { ...this.config, coherenceMix: mix ? [...mix] : undefined };
    this.finishMixIfIdentity();
  }
  // Drops the mixing when it has reached the identity (nothing left to ramp).
  finishMixIfIdentity() {
    if (this.mixRampRemaining === 0 && this.mixTarget.every((v, i) => v === IDENTITY_MIX[i % 4])) {
      this.mix = null;
      this.mixTarget = null;
      this.mixStep = null;
    }
  }
  // Moves every mixing coefficient one step towards its target; the last step lands exactly on it.
  advanceMixRamp() {
    this.mixRampRemaining--;
    for (let i = 0; i < 32; i++)
      this.mix[i] = this.mixRampRemaining === 0 ? this.mixTarget[i] : this.mix[i] + this.mixStep[i];
    this.finishMixIfIdentity();
  }
  /**
   * Advances the network by one sample. Per band:
   *  1. band-limit the input;
   *  2. read the end of each delay line and apply its feedback gain;
   *  3. tap the L/R outputs (signed sums, scaled by 1/sqrt(8), band-limited);
   *  4. mix the eight values with a fast Walsh-Hadamard transform (orthogonal feedback matrix);
   *  5. write mix * 1/sqrt(8) plus the signed input back into the delay lines.
   */
  tick(input) {
    if (this.rampRemaining > 0) this.advanceRamp();
    if (this.mixRampRemaining > 0) this.advanceMixRamp();
    for (let band = 0; band < 8; band++) {
      const value = filter(this.inputFilters[band], input);
      const buffers = this.buffers[band];
      const indices = this.indices[band];
      const gains = this.feedback[band];
      const read = this.scratch;
      const lines = this.lines;
      const { injection, left: leftSigns, right: rightSigns } = this.signs;
      const scale = this.inverseRoot;
      let left = 0;
      let right = 0;
      for (let line = 0; line < lines; line++) {
        const delayed = buffers[line][indices[line]] * gains[line];
        read[line] = delayed;
        left += delayed * leftSigns[line];
        right += delayed * rightSigns[line];
      }
      this.bandL[band] = filter(this.leftFilters[band], left * scale);
      this.bandR[band] = filter(this.rightFilters[band], right * scale);
      if (this.mix) {
        // Whiten and correlate the pair. mixedLeft/mixedRight are also used by applyCoherenceMix.
        const unmixedLeft = this.bandL[band];
        const unmixedRight = this.bandR[band];
        this.bandL[band] = mixedLeft(this.mix, band * 4, unmixedLeft, unmixedRight);
        this.bandR[band] = mixedRight(this.mix, band * 4, unmixedLeft, unmixedRight);
      }
      // In-place fast Walsh-Hadamard transform of the eight line values.
      for (let width = 1; width < lines; width *= 2)
        for (let start = 0; start < lines; start += width * 2)
          for (let pair = 0; pair < width; pair++) {
            const sum = read[start + pair];
            const other = read[start + pair + width];
            read[start + pair] = sum + other;
            read[start + pair + width] = sum - other;
          }
      for (let line = 0; line < lines; line++) {
        const buffer = buffers[line];
        buffer[indices[line]] = read[line] * scale + value * injection[line] * scale;
        indices[line]++;
        if (indices[line] === buffer.length) indices[line] = 0;
      }
    }
  }
}
/**
 * The first `length` samples of the late field's unit-impulse response, per band and ear
 * (`left[band][sample]`, `right[band][sample]`). The IR worker uses it to cancel the part of the
 * late field that the early FIR already contains (the handoff in hybrid-response.ts).
 */
export function latePrefix(config, length) {
  const fdn = new LateFdn(config);
  const left = Array.from({ length: 8 }, () => new Float32Array(length));
  const right = Array.from({ length: 8 }, () => new Float32Array(length));
  for (let sample = 0; sample < length; sample++) {
    fdn.tick(sample === 0 ? 1 : 0);
    for (let band = 0; band < 8; band++) {
      left[band][sample] = fdn.bandL[band];
      right[band][sample] = fdn.bandR[band];
    }
  }
  return { left, right };
}
