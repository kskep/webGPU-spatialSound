import './style.css';
import type { Vec3 } from './acoustics/model';
import { MeshTracer } from './gpu/mesh-tracer';
import type { AppTraceResult } from './gpu/trace-types';
import { validateDirectivityTable } from './config/directivity';
import { validateMaterialsLibrary } from './config/materials-library';
import { ROOM_PRESETS, validateRoomPresetTable } from './config/room-presets';
import { getRenderMode, validateRenderModeTable } from './config/render-modes';
import { validateBinauralConfig } from './config/binaural';
import { validateLateFieldProfiles } from './config/late-field';
import { validateProbeConfig } from './config/probes';
import {
  SPECULAR_RAY_DEFAULTS,
  validateSpecularRaySettings,
  type SpecularRaySettings,
} from './config/specular-rays';
import { StageTimingLog } from './app/stage-timings';
import { validateQualityTable } from './config/quality-presets';
import { AcousticScheduler, browserClock } from './scheduler/acoustic-scheduler';
import { SceneEditor } from './app/scene-editor';
import { ProbeController } from './app/probe-controller';
import { TracePipeline, type TracedFrame } from './app/trace-pipeline';
import { buildTraceReport, downloadJson } from './export/trace-report';
import { Room3D } from './ui/room3d';
import { responsePlot } from './ui/plots';
import { mountOriginalUI } from './ui/original-ui';
import { createControls } from './ui/controls';
import {
  showLateDecay,
  showRenderMode,
  showScene,
  showScheduler,
  showTermination,
  showSpecularRays,
  showStageTimings,
  showTrace,
  showProbes,
  showWorkletCost,
  type BlockCostReport,
} from './ui/debug-readouts';
import { PlaybackController } from './ui/playback-controller';

// validate everything at startup
validateDirectivityTable();
validateMaterialsLibrary();
validateRoomPresetTable();
validateQualityTable();
validateBinauralConfig();
validateLateFieldProfiles();
validateRenderModeTable();
validateProbeConfig();
validateSpecularRaySettings();
createControls(document.querySelector<HTMLDivElement>('#app')!);

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// app state
let result: AppTraceResult | undefined;
let meshTracer: MeshTracer | undefined;
let viewport: Room3D | undefined;
let gpuFailed = false;

function status(message: string, error = false): void {
  get('status').textContent = message;
  get('status').classList.toggle('error', error);
  if (error) console.error("Status error:", message);
}

// scene editor and pipeline stuff

const editor = new SceneEditor({
  onSceneChanged: () => invalidate(),
  refreshControls: () => refresh(),
  status,
  sceneProblem: (): string | undefined => pipeline.sceneProblem(),
  onReset: () => viewport?.resetCamera(),
});

const stageLog = new StageTimingLog();

const playback = new PlaybackController({ getScene: () => editor.scene, getResult: () => result, status });

// probe controller - handles baked probe data for stochastic part
const probes: ProbeController = new ProbeController({
  getScene: () => editor.scene,
  getObjects: () => editor.sceneObjects,
  meshTracerReady: () => meshTracer !== undefined,
  traceForProbe: (position, presetId) => pipeline.traceForProbe(position, presetId),
  currentPrepared: () => pipeline.currentPrepared(),
  status,
});

const pipeline: TracePipeline = new TracePipeline({
  getScene: () => editor.scene,
  getSceneObjects: () => editor.sceneObjects,
  getSpecularRays: (): SpecularRaySettings => ({
    ...SPECULAR_RAY_DEFAULTS,
    enabled: get<HTMLInputElement>('specular-rays').checked,
  }),
  getMeshTracer: () => meshTracer,
  getResult: () => result,
  setResult: (next) => {
    result = next;
  },
  refreshAudio: (traceScene, traceResult) => playback.refreshIfPlaying(traceScene, traceResult),
  getRenderModeId: () => playback.selectedRenderModeId(),
  probes,
  recordStageTimings: (timings) => {
    stageLog.record(timings);
    showStageTimings(timings);
  },
  status,
});

// scheduler - decides when to trace and quality preset
const scheduler: AcousticScheduler<TracedFrame> = new AcousticScheduler<TracedFrame>(browserClock, {
  sceneBudget: () => ({
    rays: editor.scene.rays,
    bounces: editor.scene.bounces,
    earlyOrder: editor.scene.earlyOrder,
  }),
  isReady: (): boolean => pipeline.isReady(),
  stochasticSource: (reason) => probes.stochasticSource(reason),
  blockedReason: () => pipeline.sceneProblem(),
  onBlocked: (message) => status(message, true),
  onStart: () => {
    updateControlState();
    status('Tracing reflections at your camera position…');
  },
  trace: (request) => pipeline.run(request),
  apply: (request, frame) => pipeline.apply(request, frame),
  onError: (_request, error) => {
    result = undefined;
    console.error("trace error:", error);
    status((error as Error).message, true);
  },
  onFinish: () => refresh(),
});
scheduler.setQualityMode('settled-full');

// Recalculate when specular echoes are switched on or off.
get('specular-rays').addEventListener('change', () => {
  const enabled = get<HTMLInputElement>('specular-rays').checked;
  status(`Specular echoes: ${enabled ? 'on' : 'off'}.`);
  if (result && pipeline.isReady()) scheduler.requestTrace();
});

// drawing

function draw(): void {
  viewport?.setProbeView(probes.view(editor.scene.listener));
  viewport?.update(editor.scene, result, get<HTMLInputElement>('show-rays').checked, editor.sceneObjects);
  responsePlot(get<HTMLCanvasElement>('response'), result, editor.scene);
}

// enable/disable buttons while trace is running
function updateControlState(): void {
  const busy = scheduler.busy;
  get<HTMLButtonElement>('trace').disabled = busy || !pipeline.isReady() || gpuFailed;
  for (const id of ['play', 'export']) get<HTMLButtonElement>(id).disabled = busy || !result;
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'aside input:not([type="file"]), aside select, #reset',
    )
    .forEach((el) => {
      el.disabled = busy;
    });
}

// refresh everything after trace completes or scene changes
function refresh(): void {
  showScene(editor.scene);
  showTrace(result);
  showTermination(result);
  showSpecularRays(result);
  showLateDecay(result);
  showScheduler(scheduler.stats());
  showProbes(probes.stats(), result);
  showRenderMode(getRenderMode(playback.selectedRenderModeId()).label);
  showStageTimings(result?.stageTimings);
  updateControlState();
  draw();
  window.dispatchEvent(new Event('scene-ui-refresh'));
}

// scene changed - clear everything and re-trace
function invalidate(): void {
  scheduler.invalidate();
  probes.sceneChanged();
  result = undefined;
  pipeline.roomDecay.clear();
  playback.stop();
  status('Scene changed. Run a new trace to update the response.');
  const problem = pipeline.sceneProblem();
  if (problem) status(problem, true);
  refresh();
}

get('show-rays').addEventListener('change', draw);
get('reset-view').addEventListener('click', () => viewport?.resetCamera());
get('fullscreen').addEventListener('click', () =>
  get('room')
    .parentElement?.requestFullscreen()
    .catch((error) => status(error.message, true)),
);

// camera = acoustic listener

// when camera moves, update the early arrivals immediately and schedule a trace
function listenerMoved(position: Vec3, forward: Vec3): void {
  editor.scene.listener = position;
  editor.scene.listenerForward = forward;
  // skip update if camera is somewhere invalid (inside a wall etc)
  if (result && !pipeline.sceneProblem()) {
    const early = pipeline.currentEarlyArrivals();
    result = {
      ...result,
      arrivals: [
        ...early.arrivals,
        ...pipeline.currentRayTracedEchoes(result),
        ...result.arrivals.filter((arrival) => arrival.kind === 'stochastic'),
      ],
      analyticalCount: early.arrivals.length,
      occludedEarly: early.occluded,
      diffractedEarly: early.diffracted,
    };
  }
  refresh();
  scheduler.notifyPose(position, forward);
}

// buttons
get('trace').addEventListener('click', () => scheduler.requestTrace());

get('export').addEventListener('click', () => {
  if (!result) return;
  const report = buildTraceReport({
    result,
    scene: editor.scene,
    sceneObjects: editor.sceneObjects,
    sceneObjectSetId: editor.loadedSceneId,
    lateDecayMode: playback.selectedLateDecayMode(),
    audioTelemetry: playback.audio.telemetry(),
    schedulerStats: scheduler.stats(),
    stageTimingLog: stageLog.toReport(),
    renderModeId: playback.selectedRenderModeId(),
    probes: probes.report(),
  });
  downloadJson(report, `acoustic-trace-seed-${editor.scene.seed}.json`);
});

// startup
mountOriginalUI(probes, status);
probes.subscribe(() => {
  showProbes(probes.stats(), result);
  draw();
});
playback.bind();
editor.bind();
new ResizeObserver(draw).observe(get('app'));
refresh();

function onGpuLost(message: string): void {
  gpuFailed = true;
  meshTracer = undefined;
  pipeline.releasePreparedScene();
  get('gpu-status').textContent = 'GPU unavailable';
  status(message, true);
  updateControlState();
  playback.audio.stop();
}

// Create the mesh tracer and the room view on the same GPU device.
async function startGpu(): Promise<void> {
  try {
    const tracer = await MeshTracer.create(onGpuLost);
    if (gpuFailed) return;
    meshTracer = tracer;
    viewport = new Room3D(
      get<HTMLCanvasElement>('room'),
      tracer.device,
      listenerMoved,
      () => {
        const preset = ROOM_PRESETS[get<HTMLSelectElement>('preset').value];
        return preset && [...preset.listener];
      },
      { addProbeAtCamera: () => probes.addAtCamera(), pickProbe: (id) => probes.select(id) },
    );
    get('gpu-status').textContent = 'WebGPU ready';
    status('Click the room to move. You are the acoustic listener.');
    refresh();
  } catch (error) {
    gpuFailed = true;
    get('gpu-status').textContent = 'WebGPU unavailable';
    status((error as Error).message, true);
    updateControlState();
  }
}

startGpu();

// expose internals for browser tests
(window as unknown as { __acoustic: object }).__acoustic = {
  probes,
  scheduler,
  pipeline,
  stageLog,
  moveListener: listenerMoved,
  result: () => result,
  scene: () => editor.scene,
};

// show worklet block cost in debug panel
setInterval(() => {
  const telemetry = playback.audio.telemetry() as { blockCost?: BlockCostReport };
  showWorkletCost(telemetry.blockCost);
}, 500);

window.addEventListener('pagehide', () => {
  scheduler.dispose();
  playback.audio.stop();
  viewport?.dispose();
});
