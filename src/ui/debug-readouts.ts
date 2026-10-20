// Debug-panel read-outs that need more than a single assignment.
import { distance, eyringRT60, type Scene, type TraceResult } from '../acoustics/model';
import { anglesFromForward } from '../acoustics/directivity';
import { AUTO_MODE_ID } from '../config/quality-presets';
import { getProbeMode } from '../config/probes';
import type { ProbeStats } from '../app/probe-controller';
import type { SchedulerStats } from '../scheduler/acoustic-scheduler';
import type { AppTraceResult } from '../gpu/trace-types';
import type { PreprocessingTimings, StageTimings } from '../app/stage-timings';

// Index of the 1 kHz band in the eight-band arrays.
const ONE_KILOHERTZ_BAND = 4;

function setText(id: string, text: string): void {
  document.getElementById(id)!.textContent = text;
}

function setValue(id: string, value: string): void {
  (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value = value;
}

// Copies the scene into the hidden controls and the scene read-outs.
export function showScene(scene: Scene): void {
  document.querySelectorAll<HTMLInputElement>('[data-dimension]').forEach((control) => {
    control.value = String(scene.dimensions[Number(control.dataset.dimension)]);
  });
  document.querySelectorAll<HTMLInputElement>('[data-point]').forEach((control) => {
    const coordinate = scene[control.dataset.point as 'source' | 'listener'][Number(control.dataset.axis)];
    control.value = String(Number(coordinate.toFixed(3)));
  });
  for (const id of ['absorption', 'scattering', 'rays', 'bounces', 'seed'] as const)
    setValue(id, String(scene[id]));

  const orientation = anglesFromForward(scene.sourceForward);
  setValue('source-directivity', scene.sourceDirectivity);
  setValue('source-yaw', String(Math.round(orientation.yaw)));
  setValue('source-pitch', String(Math.round(orientation.pitch)));

  setText('absorption-value', `${Math.round(scene.absorption * 100)}%`);
  // A preset's curves are scaled by the slider (shown as a factor); without curves it is a coefficient.
  setText(
    'scattering-value',
    scene.shellScattering ? `x${scene.scattering.toFixed(2)}` : `${Math.round(scene.scattering * 100)}%`,
  );
  const directSeconds = distance(scene.source, scene.listener) / scene.speed;
  setText('direct', `${(directSeconds * 1000).toFixed(1)} ms`);
  const rt60 = eyringRT60(scene);
  setText('rt60', Number.isFinite(rt60) ? `${rt60.toFixed(2)} s` : '∞');
}

// Debug panel: size, timing and geometry statistics of the latest trace.
export function showTrace(result: AppTraceResult | undefined): void {
  const dash = '—';
  setText('hits', result ? result.arrivals.length.toLocaleString() : dash);
  setText('timing', result ? `${result.elapsedMs.toFixed(0)} ms` : dash);
  setText('tracer-used', result ? (result.tracer === 'mesh' ? 'BVH mesh' : 'Shoebox') : dash);
  setText('triangle-count', result?.bvh ? String(result.bvh.triangles) : dash);
  setText('bvh-stats', result?.bvh ? `${result.bvh.nodes} / ${result.bvh.maxDepth}` : dash);
  setText('occluded-count', result ? String(result.occludedEarly) : dash);
  setText('diffracted-count', result ? String(result.diffractedEarly) : dash);
}

// Debug panel: how the rays of the latest trace ended.
export function showTermination(result: AppTraceResult | undefined): void {
  const dash = '—';
  if (!result) return setText('termination-readout', dash);
  const termination = result.termination;
  if (!termination) {
    const reason = result.tracer === 'shoebox' ? 'fixed bounces (shoebox tracer only)' : 'fixed bounces';
    return setText('termination-readout', `${reason}, ${result.tracedBounces ?? '?'} bounces`);
  }
  const { resolved } = termination;
  const megabytes = (termination.readbackBytes / 1e6).toFixed(1);
  setText(
    'termination-readout',
    `${resolved.energyCutoffDb} dB or ${resolved.maxPathSeconds.toFixed(2)} s; ${resolved.detailedBounces} detailed + ${termination.histogramBins} bins; ${megabytes} MB read`,
  );
}

// Debug panel: discrete echoes from specular ray paths in the latest trace.
export function showSpecularRays(result: AppTraceResult | undefined): void {
  const report = result?.specularRays;
  if (!result) return setText('specular-readout', '—');
  if (!report) {
    return setText('specular-readout', result.tracer === 'shoebox' ? 'off (mesh tracer only)' : 'off');
  }
  const strongest =
    report.strongestOrder === undefined ? 'no echo' : `strongest: order ${report.strongestOrder}`;
  const memory = report.remembered ? ` (${report.remembered} remembered)` : '';
  setText(
    'specular-readout',
    `${report.echoes} echoes${memory}, ${report.hitsUsed} hits used, ${strongest}; ${report.pathsFound} paths found`,
  );
}

// Formats an RT60 in seconds; null or infinity shows as the infinity sign.
function formatSeconds(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(2)} s` : '∞';
}

// Debug panel: the 1 kHz RT60 from the rays next to the Eyring value, and how many bands used the fit.
export function showLateDecay(result: TraceResult | undefined): void {
  const decay = result?.lateDecay;
  const origin = result?.lateDecayOrigin;

  let originText = '—';
  if (origin === 'full-trace') originText = 'from full trace';
  if (origin === 'provisional') originText = 'provisional (coarse trace)';
  if (origin === 'probes') originText = 'blend of probe fits';
  setText('decay-origin', originText);

  if (!decay) {
    setText('rt60-fit', '—');
    setText('fit-bands', '—');
    return;
  }

  const fitted = decay.quality[ONE_KILOHERTZ_BAND].fittedRt60;
  const rejected = decay.source[ONE_KILOHERTZ_BAND] === 'eyring';
  const fitText = `fit ${fitted === null ? 'n/a' : formatSeconds(fitted)}${rejected ? ' (rejected)' : ''}`;
  setText('rt60-fit', `${fitText} / Eyring ${formatSeconds(decay.eyringBands[ONE_KILOHERTZ_BAND])}`);
  setText('fit-bands', `${decay.source.filter((source) => source === 'ray-fit').length} / 8`);
}

// Debug panel: the preset of the latest trace, its request id, and stale-rejection count.
export function showScheduler(stats: SchedulerStats): void {
  const forced = stats.qualityMode !== AUTO_MODE_ID;
  const preset = stats.activePresetId ?? '—';
  setText('scheduler-preset', forced ? `${preset} (forced)` : preset);
  setText('scheduler-request', stats.lastRequestId === 0 ? '—' : `#${stats.lastRequestId}`);
  setText('scheduler-stale', String(stats.staleRejected));
}

// Formats a duration in milliseconds, or a dash when the stage was not measured.
function formatMs(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)} ms`;
}

// One line for the preprocessing of an update: step times or "reused", plus cache counters.
function describePreprocessing(preprocessing: PreprocessingTimings): string {
  const cache = `cache ${preprocessing.cacheHits} hits / ${preprocessing.cacheMisses} misses`;
  if (preprocessing.preprocessReused) return `reused (${cache})`;
  const steps = [
    `mesh ${preprocessing.meshBuildMs.toFixed(1)}`,
    `BVH ${preprocessing.bvhBuildMs.toFixed(1)}`,
    `pack ${preprocessing.trianglePackMs.toFixed(1)}`,
    `stats ${preprocessing.statisticsMs.toFixed(1)}`,
    `upload ${preprocessing.gpuUploadMs.toFixed(1)}`,
  ];
  return `rebuilt: ${steps.join(' · ')} ms (${cache})`;
}

// Debug panel: stage timings of the latest update.
export function showStageTimings(timings: StageTimings | undefined): void {
  const gpu = timings ? `${formatMs(timings.gpuDispatchMs)} / ${formatMs(timings.gpuReadbackMs)}` : '—';
  setText('stage-gpu', gpu);
  setText('stage-acoustic', formatMs(timings?.acousticUpdateMs));
  setText('stage-state', formatMs(timings?.stateBuildMs));
  setText('stage-swap', formatMs(timings?.rendererSwapMs));
  setText('stage-total', formatMs(timings?.totalPipelineMs, 0));
  const preprocessing = timings?.preprocessing;
  setText('stage-preprocessing', preprocessing ? describePreprocessing(preprocessing) : '—');
}

// Debug panel: the selected rendering architecture.
export function showRenderMode(label: string): void {
  setText('render-mode-readout', label);
}

// Debug panel: measured worklet cost per render quantum.
export function showWorkletCost(blockCost: BlockCostReport | undefined): void {
  if (!blockCost || blockCost.blocks === 0) {
    setText('worklet-cost', '—');
    return;
  }
  const percent = (blockCost.meanFractionOfQuantum * 100).toFixed(0);
  setText('worklet-cost', `${blockCost.meanMs.toFixed(2)} ms (${percent}% of quantum, ${blockCost.clock})`);
}

// Block-cost report sent by the worklet.
export interface BlockCostReport {
  clock: string;
  resolutionMs: number | null;
  blocks: number;
  meanMs: number;
  maxMs: number;
  quantumMs: number;
  meanFractionOfQuantum: number;
  maxFractionOfQuantum: number;
  overruns: number;
}

// Formats a byte count as kilobytes or megabytes.
function formatBytes(bytes: number): string {
  return bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

// Debug panel "Probes" section: counts, mode, source, blend time, fallbacks, memory and bake progress.
export function showProbes(stats: ProbeStats, result: AppTraceResult | undefined): void {
  const { counts } = stats;
  setText(
    'probe-counts',
    `${counts.total}: ${counts.baked} baked, ${counts.stale} stale, ${counts.unbaked} unbaked${counts.disabled ? `, ${counts.disabled} off` : ''}`,
  );
  setText('probe-mode', getProbeMode(stats.modeId).label);

  const fromProbes = result?.stochasticSource === 'probes';
  let source = '—';
  if (result) source = fromProbes ? 'probe blend' : 'live trace';
  setText('probe-source', source);
  setText(
    'probe-used',
    fromProbes && result?.probesUsed
      ? result.probesUsed.map((used) => `${used.label} ${used.weight.toFixed(2)}`).join(', ')
      : '—',
  );
  const blend = stats.lastBlend;
  setText(
    'probe-blend-time',
    blend ? `${(blend.selectMs + blend.mixMs).toFixed(2)} ms (select ${blend.selectMs.toFixed(2)})` : '—',
  );
  setText(
    'probe-fallbacks',
    stats.fallbacks === 0 ? '0' : `${stats.fallbacks} (${stats.lastFallbackReason ?? 'no probe'})`,
  );
  setText('probe-memory', counts.baked + counts.stale > 0 ? formatBytes(stats.memoryBytes) : '—');
  const { bake } = stats;
  let progress = '—';
  if (bake.running) {
    progress = `${bake.done} / ${bake.total}`;
  } else if (bake.last) {
    progress = `${bake.last.baked.length} probes, ${(bake.last.totalMs / 1000).toFixed(1)} s`;
  }
  setText('probe-bake', progress);
}
