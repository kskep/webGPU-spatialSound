import { GUI, type GUIController } from 'dat.gui';
import { ROOM_PRESETS } from '../config/room-presets';
import { SCENE_LIBRARY } from '../geometry/scene-library';
import { DIRECTIVITY_PATTERNS, ORIENTATION_LIMITS_DEGREES } from '../config/directivity';
import type { ProbeController } from '../app/probe-controller';
import { mountProbeFolder } from './probe-panel';

// Distance the source sliders keep from the walls, floor and ceiling.
const SOURCE_WALL_CLEARANCE_METRES = 0.3;

const TEXT_VALUED_KEYS = new Set(['preset', 'sceneObjects', 'sourceDirectivity']);

// Builds the dat.GUI panel, 3D viewport, debug panel and response plot on top of the hidden DOM controls.
export function mountOriginalUI(
  probes: ProbeController,
  status: (message: string, error?: boolean) => void,
): void {
  const get = (id: string) => document.getElementById(id)!;
  const root = get('app');
  const backend = document.createElement('div');
  backend.hidden = true;
  while (root.firstChild) backend.append(root.firstChild);
  root.append(backend);
  const viewport = document.createElement('div');
  viewport.className = 'viewport';
  viewport.append(get('room'));
  root.append(viewport);
  const debug = document.createElement('div');
  debug.id = 'debug-panel';
  debug.innerHTML =
    '<b>webGPU-spatialSound</b><hr><div id="gpu-row"></div><div id="debug-metrics"></div><details id="probe-debug"><summary>Probes</summary><div id="probe-metrics"></div></details><hr><div id="debug-status"></div><small>Click scene · WASD move<br>Space / C up / down<br>Arrows / drag look</small>';
  root.append(debug);
  get('gpu-row').append(get('gpu-status'));
  get('debug-status').append(get('status'));
  for (const [id, label] of [
    ['direct', 'Direct Arrival'],
    ['rt60', 'Eyring RT60'],
    ['hits', 'Received Arrivals'],
    ['timing', 'Trace + Readback'],
    ['tracer-used', 'Tracer'],
    ['termination-readout', 'Ray Termination'],
    ['specular-readout', 'Ray-traced Echoes'],
    ['triangle-count', 'Triangles'],
    ['bvh-stats', 'BVH Nodes / Depth'],
    ['occluded-count', 'Occluded Early Paths'],
    ['diffracted-count', 'Diffracted Paths'],
    ['rt60-fit', 'RT60 @1k'],
    ['fit-bands', 'Bands Using Ray Fit'],
    ['decay-origin', 'Late Decay Source'],
    ['scheduler-preset', 'Quality Preset'],
    ['scheduler-request', 'Trace Request'],
    ['scheduler-stale', 'Stale Rejected'],
    ['render-mode-readout', 'Rendering Architecture'],
    ['stage-gpu', 'GPU Dispatch / Readback'],
    ['stage-acoustic', 'Acoustic Update'],
    ['stage-state', 'State Build'],
    ['stage-swap', 'Renderer Swap'],
    ['stage-total', 'Total Pipeline'],
    ['stage-preprocessing', 'Preprocessing'],
    ['worklet-cost', 'Worklet Block Cost'],
  ]) {
    const row = document.createElement('div');
    row.append(document.createTextNode(label));
    row.append(get(id));
    get('debug-metrics').append(row);
  }
  // Probe read-outs sit in a collapsible section of their own.
  for (const [id, label] of [
    ['probe-counts', 'Probes'],
    ['probe-mode', 'Mode'],
    ['probe-source', 'Last update'],
    ['probe-used', 'In use (weights)'],
    ['probe-blend-time', 'Blend time'],
    ['probe-fallbacks', 'Live-trace fallbacks'],
    ['probe-memory', 'Memory'],
    ['probe-bake', 'Bake'],
  ]) {
    const row = document.createElement('div');
    row.append(document.createTextNode(label));
    row.append(get(id));
    get('probe-metrics').append(row);
  }
  const panel = document.createElement('div');
  panel.id = 'response-panel';
  panel.append(get('response'));
  root.append(panel);
  const gui = new GUI();
  const state: Record<string, any> = {};
  const observers: MutationObserver[] = [];
  const bindings: {
    controller: GUIController;
    element: HTMLInputElement | HTMLSelectElement;
    key: string;
  }[] = [];
  // Adds a GUI button that clicks the hidden button `id`; the row follows its disabled state.
  const button = (folder: GUI, id: string, label: string, key = id) => {
    state[key] = () => get(id).click();
    const controller = folder.add(state, key).name(label);
    const row = controller.domElement.closest('li')!;
    row.id = 'control-' + key;
    const original = get(id) as HTMLButtonElement;
    const sync = () => {
      row.style.pointerEvents = original.disabled ? 'none' : '';
      row.style.opacity = original.disabled ? '.45' : '1';
      row.setAttribute('aria-disabled', String(original.disabled));
    };
    const observer = new MutationObserver(sync);
    observer.observe(original, { attributes: true, attributeFilter: ['disabled'] });
    observers.push(observer);
    sync();
  };
  // Adds a GUI control (slider, dropdown or checkbox) bound to the hidden element `element`.
  const input = (
    folder: GUI,
    element: HTMLInputElement | HTMLSelectElement,
    key: string,
    label: string,
    options?: object | number,
    max?: number,
    step?: number,
  ) => {
    if (element.type === 'checkbox') {
      state[key] = (element as HTMLInputElement).checked;
    } else if (TEXT_VALUED_KEYS.has(key)) {
      state[key] = element.value;
    } else {
      state[key] = Number(element.value);
    }

    let controller: GUIController;
    if (typeof options === 'number') {
      controller = folder.add(state, key, options, max, step);
    } else if (options) {
      controller = folder.add(state, key, options);
    } else {
      controller = folder.add(state, key);
    }
    controller.name(label);
    controller.domElement.id = 'control-' + key;
    const apply = () => {
      if (element.type === 'checkbox') (element as HTMLInputElement).checked = Boolean(state[key]);
      else element.value = String(state[key]);
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (element.tagName === 'SELECT' || element.type === 'checkbox') controller.onChange(apply);
    else controller.onFinishChange(apply);
    bindings.push({ controller, element, key });
  };
  const presets = gui.addFolder('Room Presets');
  input(
    presets,
    get('preset') as HTMLSelectElement,
    'preset',
    'Select Preset',
    Object.fromEntries(Object.keys(ROOM_PRESETS).map((key) => [key, key])),
  );
  presets.open();
  const sceneObjects = gui.addFolder('Scene Objects');
  input(
    sceneObjects,
    get('scene-objects') as HTMLSelectElement,
    'sceneObjects',
    'Furniture Scene',
    Object.fromEntries(SCENE_LIBRARY.map((entry) => [entry.label, entry.id])),
  );
  sceneObjects.open();
  const dims = gui.addFolder('Room Dimensions');
  document
    .querySelectorAll<HTMLInputElement>('[data-dimension]')
    .forEach((element, i) =>
      input(dims, element, ['width', 'height', 'depth'][i], ['width', 'height', 'depth'][i], 2, 60, 0.1),
    );
  dims.open();
  const materials = gui.addFolder('Materials');
  input(materials, get('absorption') as HTMLInputElement, 'absorption', 'Walls Absorption', 0, 0.95, 0.01);
  // With a room preset the shell has a frequency-dependent scattering curve; this slider scales it.
  input(
    materials,
    get('scattering') as HTMLInputElement,
    'scattering',
    'Scattering (1 = preset)',
    0,
    1,
    0.01,
  );
  document.getElementById('control-scattering')!.title =
    'Scales the preset scattering: 1 keeps the preset, 0 makes the room surfaces specular.';
  const source = gui.addFolder('Sound Source');
  // The x/y/z slider ranges follow the room size (see `fitSourceRangesToRoom` below).
  const sourceAxisControllers: GUIController[] = [];
  document.querySelectorAll<HTMLInputElement>('[data-point="source"]').forEach((element, i) => {
    input(
      source,
      element,
      ['x', 'y', 'z'][i],
      ['x', 'y', 'z'][i],
      i === 1 ? 0.3 : -30,
      i === 1 ? 60 : 30,
      0.1,
    );
    sourceAxisControllers.push(bindings[bindings.length - 1].controller);
  });
  // Directivity: the dropdown comes from the table in src/config/directivity.ts.
  input(
    source,
    get('source-directivity') as HTMLSelectElement,
    'sourceDirectivity',
    'Directivity',
    Object.fromEntries(DIRECTIVITY_PATTERNS.map((pattern) => [pattern.label, pattern.id])),
  );
  const { yaw, pitch } = ORIENTATION_LIMITS_DEGREES;
  input(source, get('source-yaw') as HTMLInputElement, 'sourceYaw', 'Yaw (deg)', yaw.min, yaw.max, yaw.step);
  input(
    source,
    get('source-pitch') as HTMLInputElement,
    'sourcePitch',
    'Pitch (deg)',
    pitch.min,
    pitch.max,
    pitch.step,
  );
  // Source power: a gain on the dry signal before the room, so distance and room still shape it.
  state.sourceLevelDb = 0;
  const sourceLevel = source
    .add(state, 'sourceLevelDb', -12, 24, 1)
    .name('Source Level (dB)')
    .onChange((value) => window.dispatchEvent(new CustomEvent('source-level', { detail: value })));
  sourceLevel.domElement.id = 'control-source-level';
  sourceLevel.domElement.title =
    'Source gain in dB. +6 dB doubles the pressure. High levels can clip near the source.';
  source.open();
  const tracing = gui.addFolder('Ray Tracing');
  button(tracing, 'trace', 'Calculate Response');
  input(tracing, get('show-rays') as HTMLInputElement, 'showRays', 'Show Rays');
  state.showResponse = true;
  tracing
    .add(state, 'showResponse')
    .name('Show Response')
    .onChange((value) => (panel.hidden = !value));
  input(tracing, get('rays') as HTMLSelectElement, 'rays', 'Ray Count', [4096, 16384, 65536]);
  input(tracing, get('specular-rays') as HTMLInputElement, 'specularRays', 'Specular Echoes');
  get('control-specularRays').title =
    'Add discrete echoes from specular ray paths. Recalculates the response when changed.';
  input(tracing, get('seed') as HTMLInputElement, 'seed', 'Random Seed', 0, 4294967295, 1);
  button(tracing, 'export', 'Export Trace Data');
  tracing.open();
  mountProbeFolder(gui, probes, status);
  const files = gui.addFolder('Sound Files');
  state.importAudio = () => get('audio-file').click();
  files.add(state, 'importAudio').name('Import Sound');
  state.selectedFile = 'Built-in pulse';
  const sound = files
    .add(state, 'selectedFile', [
      'Built-in pulse',
      'Bass sweep',
      'loop.mp3',
      'snare.mp3',
      'top_loop.mp3',
      'KoolTheGang-Summertime_MONO.mp3',
      'Imported audio',
    ])
    .name('Select Sound');
  sound.domElement.id = 'control-sound';
  sound.onChange((value) => {
    if (value === 'Imported audio') get('audio-file').click();
    else window.dispatchEvent(new CustomEvent('sound-choice', { detail: value }));
  });
  window.addEventListener('audio-imported', () => {
    state.selectedFile = 'Imported audio';
    sound.updateDisplay();
  });
  state.masterVolume = 0.35;
  files
    .add(state, 'masterVolume', 0, 1, 0.01)
    .name('Master Volume')
    .onChange((value) => window.dispatchEvent(new CustomEvent('master-volume', { detail: value })));
  button(files, 'play', 'Play Convolved');
  button(files, 'play-original', 'Play Original');
  button(files, 'stop', 'Stop Sound');
  files.open();
  const camera = gui.addFolder('Camera');
  button(camera, 'reset-view', 'Reset Camera');
  button(camera, 'reset', 'Reset Scene');
  // Limits the source x/y/z sliders to the inside of the current room.
  const fitSourceRangesToRoom = () => {
    const [width, height, depth] = Array.from(
      document.querySelectorAll<HTMLInputElement>('[data-dimension]'),
    ).map((element) => Number(element.value));
    if (![width, height, depth].every((value) => Number.isFinite(value) && value > 0)) return;
    const clearance = SOURCE_WALL_CLEARANCE_METRES;
    const ranges: [number, number][] = [
      [-width / 2 + clearance, width / 2 - clearance],
      [clearance, height - clearance],
      [-depth / 2 + clearance, depth / 2 - clearance],
    ];
    sourceAxisControllers.forEach((controller, axis) => {
      const [min, max] = ranges[axis];
      (controller as GUIController & { min(n: number): void; max(n: number): void }).min(min);
      (controller as GUIController & { min(n: number): void; max(n: number): void }).max(max);
    });
  };
  const sync = () => {
    fitSourceRangesToRoom();
    for (const { controller, element, key } of bindings) {
      if (controller.domElement.contains(document.activeElement)) continue;
      if (element.type === 'checkbox') {
        state[key] = (element as HTMLInputElement).checked;
      } else if (TEXT_VALUED_KEYS.has(key)) {
        state[key] = element.value;
      } else {
        state[key] = Number(element.value);
      }
      controller.updateDisplay();
      controller.domElement
        .querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')
        .forEach((field) => (field.disabled = element.disabled));
    }
  };
  window.addEventListener('scene-ui-refresh', sync);
  sync();
  window.addEventListener('pagehide', () => {
    window.removeEventListener('scene-ui-refresh', sync);
    observers.forEach((observer) => observer.disconnect());
    gui.destroy();
  });
}
