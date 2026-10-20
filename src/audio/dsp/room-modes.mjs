// Low-frequency room modes of the shoebox shell (optional, off by default).
//
// The ray model carries eight octave-band energies and therefore has no modes. Below the Schroeder
// frequency f_S = 2000 sqrt(T / V) a small room is dominated by a few discrete resonances; this module
// renders them with a bank of two-pole resonators that runs next to the late FDN in the worklet.
//
// Physics (Kuttruff, Room Acoustics, ch. 3), for a rigid-walled box W x H x D:
//   frequency     f_n = (c / 2) sqrt((nx / W)^2 + (ny / H)^2 + (nz / D)^2)
//   mode shape    psi_n(p) = cos(nx pi u / W) cos(ny pi v / H) cos(nz pi w / D), (u, v, w) measured from
//                 the corner of the room (scene x + W/2, y, z + D/2)
//   norm          Lambda_n = mean of psi_n^2 over the room = product over axes of (1/2 if n_i > 0, else 1)
//   response      h(t) = A sum_n psi_n(s) psi_n(l) / Lambda_n * sin(w_n t) / w_n * exp(-delta_n t)
//                 (source of constant volume acceleration, i.e. the flat power spectrum the rays assume)
//   decay         delta_n = 3 ln 10 / RT60(f_n); the RT60 is the band value the late field uses,
//                 interpolated in log frequency.
// The coupling c_n = psi_n(s) psi_n(l) / Lambda_n has mean square 1 over random source and listener
// positions, and different modes are uncorrelated (orthogonality), so the spatially averaged modal
// energy is A^2 sum_n (energy of sin(w_n t) / w_n * exp(-delta_n t)). A is chosen per octave band so
// that this average equals the share of the band's diffuse late level that lies below f_S; the FDN
// keeps the rest. The modes then only redistribute energy over positions, as in a real room, and the
// 63 / 125 Hz bands are not counted twice. Only the empty shoebox is modelled: box objects are ignored.
//
// Pure functions and one small class; no Web Audio globals, so Node tests run them directly.

// Octave-band centres in Hz (the same table as late-fdn.mjs and src/acoustics/model.ts).
const FREQUENCIES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
// Upper edges of the two modal bands (63 and 125 Hz): geometric means of neighbouring centres.
export const MODAL_BAND_EDGES = [Math.sqrt(63 * 125), Math.sqrt(125 * 250)];
// Most modes the worklet runs; the lowest are kept.
export const MAX_ROOM_MODES = 128;
// Modes below this frequency are not rendered (inaudible, and they would need very long decays).
export const MIN_MODE_HZ = 20;
// Longest decay a mode may have; keeps the resonators stable for an RT60 of Infinity.
const MAX_MODE_RT60 = 60;

// Schroeder frequency 2000 sqrt(RT60 / V) in Hz (RT60 in s, V in m^3).
export function schroederFrequency(rt60, volume) {
  // EDW EKTIMOUME TI SYXNOTITA SCHROEDER GIA NA XORISOUME TIN PERIOXI TWN XAMILWN ROOM MODES.
  return 2000 * Math.sqrt(Math.max(0, rt60) / volume);
}

/**
 * All shoebox modes with MIN_MODE_HZ <= f <= maxFrequency, sorted by frequency (ties by index), at most
 * `limit` of them. `dimensions` = [W, H, D] in metres. Each entry is { n: [nx, ny, nz], frequency }.
 */
export function shoeboxModes(dimensions, speed, maxFrequency, limit = MAX_ROOM_MODES) {
  const modes = [];
  const [width, height, depth] = dimensions;
  const top = (length) => Math.floor((2 * maxFrequency * length) / speed);
  for (let nx = 0; nx <= top(width); nx++)
    for (let ny = 0; ny <= top(height); ny++)
      for (let nz = 0; nz <= top(depth); nz++) {
        if (nx + ny + nz === 0) continue;
        const frequency = (speed / 2) * Math.hypot(nx / width, ny / height, nz / depth);
        if (frequency >= MIN_MODE_HZ && frequency <= maxFrequency) modes.push({ n: [nx, ny, nz], frequency });
      }
  modes.sort((a, b) => a.frequency - b.frequency || a.n.join().localeCompare(b.n.join()));
  return modes.slice(0, limit);
}

// Mode shape psi_n at a scene point (x centred, y from the floor, z centred).
export function modeShape(n, dimensions, point) {
  const local = [point[0] + dimensions[0] / 2, point[1], point[2] + dimensions[2] / 2];
  let value = 1;
  for (let axis = 0; axis < 3; axis++)
    value *= Math.cos((n[axis] * Math.PI * local[axis]) / dimensions[axis]);
  return value;
}

// Mean of psi_n^2 over the room: 1/2 per axis with a non-zero index.
export function modeNorm(n) {
  return n.reduce((norm, index) => norm * (index > 0 ? 0.5 : 1), 1);
}

// Source-listener coupling psi_n(s) psi_n(l) / Lambda_n; its mean square over random positions is 1.
export function modeCoupling(n, dimensions, source, listener) {
  return (modeShape(n, dimensions, source) * modeShape(n, dimensions, listener)) / modeNorm(n);
}

// RT60 at `frequency`: the octave-band values interpolated linearly in log frequency, held at the ends.
export function modeRt60(frequency, rt60Bands) {
  if (frequency <= FREQUENCIES[0]) return rt60Bands[0];
  for (let band = 1; band < 8; band++)
    if (frequency <= FREQUENCIES[band]) {
      const t =
          Math.log(frequency / FREQUENCIES[band - 1]) / Math.log(FREQUENCIES[band] / FREQUENCIES[band - 1]);
      const low = rt60Bands[band - 1];
      const high = rt60Bands[band];
      // Interpolating an infinite decay time gives Infinity; it is clamped by the resonator.
      return low === Infinity || high === Infinity ? Infinity : low + (high - low) * t;
    }
  return rt60Bands[7];
}

/**
 * Two-pole resonator y[k] = g x[k] + a1 y[k-1] + a2 y[k-2] with pole radius r = 10^(-3 / (RT60 fs)) =
 * exp(-6.907 / (RT60 fs)) and angle theta = 2 pi f / fs. With g = sin(theta) its impulse response is
 * r^k sin((k + 1) theta): unit amplitude, decaying by 60 dB in RT60. RT60 = 0 gives a silent mode.
 */
export function resonatorCoefficients(frequency, rt60, sampleRate) {
  const time = Math.min(MAX_MODE_RT60, rt60);
  // EDW VGAZOUME TIN AKTINA TWN POLWN APO TO RT60 GIA NA SVINEI O RESONATOR ME TON SWSTO RYTHMO.
  const r = time > 0 ? Math.exp((-3 * Math.LN10) / (time * sampleRate)) : 0;
  const theta = (2 * Math.PI * frequency) / sampleRate;
  return { r, a1: 2 * r * Math.cos(theta), a2: -r * r, g: r > 0 ? Math.sin(theta) : 0 };
}

// Share of modal band `band` (0 = 63 Hz from 0 Hz, 1 = 125 Hz) that lies below `schroeder` Hz (linear in Hz).
export function modalShare(band, schroeder) {
  const lower = band === 0 ? 0 : MODAL_BAND_EDGES[0];
  const upper = MODAL_BAND_EDGES[band];
  return Math.max(0, Math.min(1, (schroeder - lower) / (upper - lower)));
}

// Modal band (0 or 1) of a frequency below MODAL_BAND_EDGES[1].
export function modalBand(frequency) {
  return frequency < MODAL_BAND_EDGES[0] ? 0 : 1;
}

/**
 * Bank of resonators, one per mode, with a common input. `config` = { sampleRate, frequencies, rt60s }.
 * `tick(x, weights, offset)` advances every mode by one sample and returns sum_m weights[offset + m] y_m
 * (no weights = the state advances and the output is 0).
 */
export class ModalBank {
  constructor(config) {
    const count = config.frequencies.length;
    if (!Number.isFinite(config.sampleRate) || config.sampleRate <= 0 || config.rt60s.length !== count)
      throw new Error('Invalid room-mode configuration.');
    this.sampleRate = config.sampleRate;
    this.frequencies = [...config.frequencies];
    this.count = count;
    this.g = new Float64Array(count);
    this.a1 = new Float64Array(count);
    this.a2 = new Float64Array(count);
    this.y1 = new Float64Array(count);
    this.y2 = new Float64Array(count);
    this.setDecay(config.rt60s);
  }
  // New decay times; the resonator state is kept, so the ringing continues with the new decay.
  setDecay(rt60s) {
    for (let m = 0; m < this.count; m++) {
      if ((!Number.isFinite(rt60s[m]) && rt60s[m] !== Infinity) || rt60s[m] < 0)
        throw new Error('Invalid mode decay time.');
      const { a1, a2, g } = resonatorCoefficients(this.frequencies[m], rt60s[m], this.sampleRate);
      this.a1[m] = a1;
      this.a2[m] = a2;
      this.g[m] = g;
    }
  }
  // True when the bank was built for the same mode frequencies (so a response can reuse it).
  matches(config) {
    return (
      config.sampleRate === this.sampleRate &&
      config.frequencies.length === this.count &&
      config.frequencies.every((f, m) => f === this.frequencies[m])
    );
  }
  tick(x, weights, offset = 0) {
    let out = 0;
    for (let m = 0; m < this.count; m++) {
      const y = this.g[m] * x + this.a1[m] * this.y1[m] + this.a2[m] * this.y2[m];
      this.y2[m] = this.y1[m];
      this.y1[m] = y;
      if (weights) out += y * weights[offset + m];
    }
    return out;
  }
}

// Impulse response of the weighted bank, `length` samples (the same arithmetic as the worklet).
export function modalPrefix(config, weights, length) {
  const bank = new ModalBank(config);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = bank.tick(i === 0 ? 1 : 0, weights);
  return out;
}

// Sum of (r^k)^2 / 2 for begin <= k < end: the energy of r^k sin((k + 1) theta) averaged over the phase.
function windowEnergy(r, begin, end) {
  if (r === 0) return 0;
  const r2 = r * r;
  return r2 === 1 ? (end - begin) / 2 : (0.5 * (Math.pow(r2, begin) - Math.pow(r2, end))) / (1 - r2);
}

/**
 * Designs the modal layer of one response.
 *
 * input = { dimensions, speed, source, listener, rt60Bands, sampleRate, windowStart, windowEnd,
 *           targetDensity } where targetDensity[band] is the late level the FDN is matched to in the
 * window (sum of squared samples per second, both ears; see src/audio/late-level.ts).
 *
 * Returns { config, weights, couplings, modes, schroederHz, share, scale, fdnScale }:
 *  - config / weights: what the worklet's ModalBank runs, weight_m = A_band c_m / w_m;
 *  - share[b]: the part of modal band b's late energy the modes carry (0 when the band has no mode);
 *  - fdnScale[b] = sqrt(1 - share[b]): factor on the FDN gain of band b, so FDN + modes = target.
 * The Schroeder frequency uses the 125 Hz band RT60 and the shoebox volume.
 */
export function designRoomModes(input) {
  const {
    dimensions,
    speed,
    source,
    listener,
    rt60Bands,
    sampleRate,
    windowStart,
    windowEnd,
    targetDensity,
  } = input;
  const volume = dimensions[0] * dimensions[1] * dimensions[2];
  const schroederHz = schroederFrequency(rt60Bands[1], volume);
  const all = shoeboxModes(dimensions, speed, Math.min(schroederHz, MODAL_BAND_EDGES[1]), MAX_ROOM_MODES + 1);
  // If the cap cut the list, the modes cover the range only up to the last mode kept.
  const modes = all.slice(0, MAX_ROOM_MODES);
  const covered = all.length > MAX_ROOM_MODES ? modes[modes.length - 1].frequency : schroederHz;
  const rt60s = modes.map((mode) => modeRt60(mode.frequency, rt60Bands));
  const couplings = modes.map((mode) => modeCoupling(mode.n, dimensions, source, listener));
  // Spatially averaged energy of each band's unit-amplitude modes in the matching window.
  const begin = Math.floor(windowStart * sampleRate);
  const end = Math.floor(windowEnd * sampleRate);
  const duration = windowEnd - windowStart;
  const average = [0, 0];
  modes.forEach((mode, m) => {
    const { r } = resonatorCoefficients(mode.frequency, rt60s[m], sampleRate);
    const omega = 2 * Math.PI * mode.frequency;
    average[modalBand(mode.frequency)] += windowEnergy(r, begin, end) / (omega * omega);
  });
  const share = [0, 1].map((band) => (average[band] > 0 ? modalShare(band, covered) : 0));
  // Both ears receive the same modal signal: power density = 2 A^2 average / duration.
  const scale = [0, 1].map((band) =>
    share[band] > 0 ? Math.sqrt((share[band] * targetDensity[band] * duration) / (2 * average[band])) : 0,
  );
  const weights = modes.map(
    (mode, m) => (scale[modalBand(mode.frequency)] * couplings[m]) / (2 * Math.PI * mode.frequency),
  );
  return {
    config: { sampleRate, frequencies: modes.map((mode) => mode.frequency), rt60s },
    weights,
    couplings,
    modes,
    schroederHz,
    share,
    scale,
    fdnScale: share.map((value) => Math.sqrt(1 - value)),
  };
}
