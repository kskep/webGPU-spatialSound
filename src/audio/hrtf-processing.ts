import { BAND_CENTERS } from '../acoustics/model.ts';
import { fft } from './dsp/stream-core.mjs';

export function minimumPhaseSpectrum(
  logMagnitude: Float64Array,
  real: Float64Array,
  imag: Float64Array,
): void {
  const size = logMagnitude.length;
  real.set(logMagnitude);
  imag.fill(0);
  // EDW PERNAME STO CEPSTRUM GIA NA FTIAKSOUME MINIMUM-PHASE FILTER ME TO ZITOUMENO MAGNITUDE.
  fft(real, imag, true);
  for (let bin = 1; bin < size / 2; bin++) real[bin] *= 2;
  for (let bin = size / 2 + 1; bin < size; bin++) real[bin] = 0;
  imag.fill(0);
  fft(real, imag);
  for (let bin = 0; bin < size; bin++) {
    const magnitude = Math.exp(real[bin]);
    const phase = imag[bin];
    real[bin] = magnitude * Math.cos(phase);
    imag[bin] = magnitude * Math.sin(phase);
  }
}

export function smoothFractionalOctave(power: Float64Array, octaves: number): Float64Array {
  const bins = power.length;
  const ratio = Math.pow(2, octaves / 2);
  const prefix = new Float64Array(bins + 1);
  for (let k = 0; k < bins; k++) prefix[k + 1] = prefix[k] + power[k];
  const out = new Float64Array(bins);
  for (let k = 1; k < bins; k++) {
    const first = Math.max(1, Math.min(k, Math.ceil(k / ratio - 1e-9)));
    const last = Math.min(bins - 1, Math.max(k, Math.floor(k * ratio + 1e-9)));
    out[k] = (prefix[last + 1] - prefix[first]) / (last - first + 1);
  }
  out[0] = bins > 1 ? out[1] : power[0];
  return out;
}

export function estimateArrivalDelay(response: ArrayLike<number>, size: number): number {
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let i = 0; i < response.length; i++) real[i] = response[i];
  fft(real, imag);
  let largest = 0;
  const magnitude = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    magnitude[k] = Math.hypot(real[k], imag[k]);
    largest = Math.max(largest, magnitude[k]);
  }
  if (largest === 0) return 0;
  // Magnitude floor 80 dB below the peak keeps the logarithm finite in spectral nulls.
  const logMagnitude = Float64Array.from(magnitude, (m) => Math.log(Math.max(m, largest * 1e-4)));
  const minimumReal = new Float64Array(size);
  const minimumImag = new Float64Array(size);
  minimumPhaseSpectrum(logMagnitude, minimumReal, minimumImag);
  // Cross-spectrum H * conj(Hmin); its inverse transform is the cross-correlation.
  for (let k = 0; k < size; k++) {
    const a = real[k];
    const b = imag[k];
    const c = minimumReal[k];
    const d = minimumImag[k];
    real[k] = a * c + b * d;
    imag[k] = b * c - a * d;
  }
  fft(real, imag, true);
  let peak = 0;
  for (let lag = 1; lag <= size / 2; lag++) if (real[lag] > real[peak]) peak = lag;
  if (peak === 0 || peak === size / 2) return peak;
  const before = real[peak - 1];
  const centre = real[peak];
  const after = real[peak + 1];
  // EDW PROSARMOZOUME PARAVOLI STO PEAK GIA NA METRISOUME DELAY MIKROTERO APO ENA SAMPLE.
  const curvature = before - 2 * centre + after;
  return curvature === 0 ? peak : peak + (0.5 * (before - after)) / curvature;
}

export function addDelayed(
  output: Float32Array,
  source: ArrayLike<number>,
  delay: number,
  weight: number,
  halfWidth: number,
): void {
  const whole = Math.floor(delay);
  const fraction = delay - whole;
  if (fraction < 1e-9) {
    for (let i = 0; i < source.length; i++) {
      const target = i + whole;
      if (target >= 0 && target < output.length) output[target] += weight * source[i];
    }
    return;
  }
  // Taps m = 1 - halfWidth... halfWidth of the interpolator at offset (m - fraction).
  const taps = new Float64Array(2 * halfWidth);
  let sum = 0;
  for (let index = 0; index < taps.length; index++) {
    const x = index + 1 - halfWidth - fraction;
    // EDW FTIAXNOUME WINDOWED-SINC VARI GIA NA TOPOTHETISOUME TON IXO SE FRACTIONAL DELAY.
    const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / halfWidth);
    taps[index] = sinc * window;
    sum += taps[index];
  }
  for (let index = 0; index < taps.length; index++) taps[index] /= sum;
  // output[n] += weight * sum_m taps(m) * source[n - whole - m]
  for (let n = 0; n < output.length; n++) {
    let accumulated = 0;
    for (let index = 0; index < taps.length; index++) {
      const k = n - whole - (index + 1 - halfWidth);
      if (k >= 0 && k < source.length) accumulated += source[k] * taps[index];
    }
    output[n] += weight * accumulated;
  }
}

export function octaveBandOfBins(size: number, sampleRate: number): Uint8Array {
  const bands = new Uint8Array(size / 2 + 1);
  for (let k = 0; k <= size / 2; k++) {
    const frequency = (k * sampleRate) / size;
    let band = 0;
    while (band < 7 && frequency >= Math.sqrt(BAND_CENTERS[band] * BAND_CENTERS[band + 1])) band++;
    bands[k] = band;
  }
  return bands;
}
