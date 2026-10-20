// Builds the JSON document written by the "Export Trace Hit Data" button.
import { eyringBands, eyringRT60, type Scene } from '../acoustics/model';
import { ENVELOPE_DEFAULTS } from '../acoustics/envelope';
import { lateDecayTable } from '../acoustics/decay-fit';
import { directivityIndexDb } from '../acoustics/directivity';
import { DIRECTIVITY_PATTERNS } from '../config/directivity';
import type { LateDecayMode } from '../audio/hybrid-response';
import type { SceneObject } from '../geometry/acoustic-scene';
import type { SchedulerStats } from '../scheduler/acoustic-scheduler';
import type { AppTraceResult } from '../gpu/trace-types';
import type { StageTimingLog } from '../app/stage-timings';

// Everything the report needs from the running app.
export interface TraceReportInput {
  result: AppTraceResult;
  scene: Scene;
  sceneObjects: SceneObject[];
  // Id of the selected furniture scene (see scene-library.ts).
  sceneObjectSetId: string;
  lateDecayMode: LateDecayMode;
  audioTelemetry: unknown;
  schedulerStats: SchedulerStats;
  // Result of `StageTimingLog.toReport()`: per-stage timings of the newest updates and their statistics.
  stageTimingLog: ReturnType<StageTimingLog['toReport']>;
  // Id of the selected rendering architecture.
  renderModeId: string;
  // the probe cache's state and counters (`ProbeController.report()`).
  probes?: unknown;
}

// The list of simplifications written into every report.
function limitationsFor(hasObjects: boolean): string[] {
  const diffractionNote = hasObjects
    ? 'Diffraction is a single-edge Maekawa thin-screen approximation for the blocked direct sound only; blocked reflections are dropped, there is no transmission through objects, and no wave effects'
    : 'Wave and diffraction effects are not implemented';
  return [
    diffractionNote,
    'Finite receiver and reflection count introduce geometric sampling bias',
    'Air loss is evaluated at octave centres, at 20 C / 50% RH / 101.325 kPa',
    'The persistent late field is a calibrated statistical approximation, not phase-exact ray propagation; its decay time is fitted to the traced late energy per band (Eyring of the traced mesh where the fit is rejected or the Eyring mode is chosen)',
    'Streaming DSP adds 1024 samples of latency; the hybrid architecture supports up to two seconds of FIR and the full-IR architecture up to three (src/config/render-modes.ts)',
    'HRTF is one measured subject, sampled at nearest direction',
  ];
}

// Maps non-finite numbers to null, because JSON cannot store Infinity.
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function buildTraceReport(input: TraceReportInput) {
  const { result, scene, sceneObjects } = input;
  const directivityPattern = DIRECTIVITY_PATTERNS.find((pattern) => pattern.id === scene.sourceDirectivity)!;
  const analyticalRT60 = eyringRT60(scene);

  return {
    schemaVersion: 5,
    pathCoordinates: 'XYZ',
    pathStride: 3,
    model:
      result.tracer === 'mesh'
        ? 'bvh-mesh-eight-band-ism3-occlusion-persistent-late-v5'
        : 'shoebox-eight-band-ism3-persistent-late-v4',
    limitations: limitationsFor(sceneObjects.length > 0),
    lateDecayMode: input.lateDecayMode,
    lateDecayTable: result.lateDecay ? lateDecayTable(result.lateDecay) : null,
    lateDecayTableThisTrace: result.lateDecayThisTrace ? lateDecayTable(result.lateDecayThisTrace) : null,
    lateDecayOrigin: result.lateDecayOrigin ?? null,
    sourceDirectivityReport: {
      pattern: scene.sourceDirectivity,
      forward: scene.sourceForward,
      directivityIndexDb: directivityIndexDb(directivityPattern),
    },
    // Thesis 4.6: the preset that produced this trace, and the scheduler's counters and recent requests.
    qualityPresetUsed: result.qualityPreset,
    scheduler: input.schedulerStats,
    // Chapter 5: per-stage timing of every recent update, and the rendering architecture in use.
    renderMode: input.renderModeId,
    probes: input.probes ?? null,
    // only present when the discrete echoes from specular ray paths were on for this trace.
    ...(result.specularRays ? { specularRays: result.specularRays } : {}),
    stageTimingLog: input.stageTimingLog,
    envelope: {
      method: ENVELOPE_DEFAULTS.method,
      neighbours: ENVELOPE_DEFAULTS.neighbours,
      binSeconds: ENVELOPE_DEFAULTS.binSeconds,
    },
    scene,
    sceneObjectSet: input.sceneObjectSetId,
    sceneObjects,
    audioTelemetry: input.audioTelemetry,
    analyticalRT60: finiteOrNull(analyticalRT60),
    analyticalRT60Bands: eyringBands(scene).map(finiteOrNull),
    ...result,
  };
}

// Offers `report` to the user as a pretty-printed JSON file download.
export function downloadJson(report: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
