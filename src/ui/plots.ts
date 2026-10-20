import { decayDb, energyHistogram, eyringBands, type Scene, type TraceResult } from '../acoustics/model';
import {
  decayRatesFromRT60,
  earliestDirectTime,
  ENVELOPE_DEFAULTS,
  meanBandEnvelope,
  smoothStochasticEnvelope,
} from '../acoustics/envelope.ts';
// Sizes the canvas backing store for the device pixel ratio (max 2) and returns a CSS-pixel 2D context.
function surface(canvas: HTMLCanvasElement) {
  const ratio = Math.min(devicePixelRatio, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ratio, ratio);
  return { ctx, width, height };
}
export function responsePlot(canvas: HTMLCanvasElement, result?: TraceResult, scene?: Scene): void {
  const { ctx, width, height } = surface(canvas);
  const left = 40;
  const right = width - 16;
  const top = 16;
  const bottom = height - 28;
  if (width <= 60 || height <= 50) return;
  const duration = result
    ? result.arrivals.reduce((maximum, arrival) => Math.max(maximum, arrival.time), 0.25) * 1.05
    : 1;
  ctx.font = '10px monospace';
  ctx.fillStyle = '#899b90';
  ctx.strokeStyle = '#28372e';
  for (const db of [0, -20, -40, -60]) {
    const y = top + (-db / 60) * (bottom - top);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(`${db}`, 8, y + 3);
  }
  for (let i = 0; i <= 4; i++)
    ctx.fillText(`${((duration * i) / 4).toFixed(2)}s`, left + (i / 4) * (right - left) - 10, height - 8);
  if (!result) {
    ctx.fillText('Run a trace to inspect the energy response.', left + 12, height / 2);
    return;
  }
  // Raw hits: every arrival in 1 ms bins, drawn as faint bars so the sparse
  // Monte-Carlo nature of the late field stays visible.
  const binSeconds = ENVELOPE_DEFAULTS.binSeconds;
  const rawBins = energyHistogram(result.arrivals, duration, binSeconds);
  // Smoothed stochastic envelope (energy-conserving, no gaps). The decay rates come
  // from the measured late decay (or the scene's Eyring times); without a scene the decay is not compensated.
  const envelope = smoothStochasticEnvelope(result.arrivals, {
    duration,
    binSeconds,
    onsetSeconds: earliestDirectTime(result.arrivals),
    decayRates: scene ? decayRatesFromRT60(result.lateDecay?.rt60Bands ?? eyringBands(scene)) : undefined,
    neighbours: ENVELOPE_DEFAULTS.neighbours,
  });
  const smoothed = meanBandEnvelope(envelope.bands);
  // Early (direct + specular) arrivals are exact, so they are added unchanged.
  const earlyBins = energyHistogram(
    result.arrivals.filter((arrival) => arrival.kind !== 'stochastic'),
    duration,
    binSeconds,
  );
  // Schroeder decay of early + smoothed late energy: same total energy as the raw hits.
  const combined = earlyBins.map((energy, i) => energy + (smoothed[i] ?? 0));
  const decay = decayDb(combined);
  const peakEnergy = Math.max(...rawBins, ...smoothed, 1e-30);
  // Plot coordinates: x from the bin index, y from energy relative to the peak (clamped at -60 dB).
  const xOf = (i: number): number => left + (i / rawBins.length) * (right - left);
  const yOf = (energy: number): number =>
    top + (-Math.max(-60, 10 * Math.log10(energy / peakEnergy)) / 60) * (bottom - top);
  ctx.strokeStyle = 'rgba(102,126,90,0.35)';
  for (let i = 0; i < rawBins.length; i++)
    if (rawBins[i] > 0) {
      ctx.beginPath();
      ctx.moveTo(xOf(i), bottom);
      ctx.lineTo(xOf(i), yOf(rawBins[i]));
      ctx.stroke();
    }
  // Smoothed envelope as a solid line (only where it carries energy).
  ctx.strokeStyle = '#8fd3a0';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let drawing = false;
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] <= 0) {
      drawing = false;
      continue;
    }
    if (drawing) ctx.lineTo(xOf(i), yOf(smoothed[i]));
    else {
      ctx.moveTo(xOf(i), yOf(smoothed[i]));
      drawing = true;
    }
  }
  ctx.stroke();
  // Schroeder integrated decay.
  ctx.strokeStyle = '#e5be76';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  decay.forEach((db, i) => {
    const y = top + (Math.min(60, -db) / 60) * (bottom - top);
    if (i === 0) ctx.moveTo(xOf(i), y);
    else ctx.lineTo(xOf(i), y);
  });
  ctx.stroke();
}
