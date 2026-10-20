// Hidden DOM controls that the dat.gui panel reads/writes
import { DEFAULT_ROOM_PRESET, ROOM_PRESETS } from '../config/room-presets';
import { NO_SCENE_OBJECTS_ID, SCENE_LIBRARY } from '../geometry/scene-library';
import { DIRECTIVITY_PATTERNS, ORIENTATION_LIMITS_DEGREES } from '../config/directivity';
import { SPECULAR_RAY_DEFAULTS } from '../config/specular-rays';

const APP_MARKUP = `
  <canvas id="room" tabindex="0" aria-label="First-person listener camera. WASD move, Space/C up/down, arrows or drag look."></canvas>
  <span id="gpu-status"></span>
  <strong id="direct"></strong>
  <strong id="rt60"></strong>
  <strong id="hits"></strong>
  <strong id="timing"></strong>
  <strong id="tracer-used"></strong>
  <strong id="termination-readout"></strong>
  <strong id="specular-readout"></strong>
  <strong id="triangle-count"></strong>
  <strong id="bvh-stats"></strong>
  <strong id="occluded-count"></strong>
  <strong id="diffracted-count"></strong>
  <strong id="rt60-fit"></strong>
  <strong id="fit-bands"></strong>
  <strong id="decay-origin"></strong>
  <strong id="scheduler-preset"></strong>
  <strong id="scheduler-request"></strong>
  <strong id="scheduler-stale"></strong>
  <strong id="render-mode-readout"></strong>
  <strong id="stage-gpu"></strong>
  <strong id="stage-acoustic"></strong>
  <strong id="stage-state"></strong>
  <strong id="stage-swap"></strong>
  <strong id="stage-total"></strong>
  <strong id="stage-preprocessing"></strong>
  <strong id="worklet-cost"></strong>
  <strong id="probe-counts"></strong>
  <strong id="probe-mode"></strong>
  <strong id="probe-source"></strong>
  <strong id="probe-used"></strong>
  <strong id="probe-blend-time"></strong>
  <strong id="probe-fallbacks"></strong>
  <strong id="probe-memory"></strong>
  <strong id="probe-bake"></strong>
  <canvas id="response" aria-label="Energy response and integrated decay"></canvas>
  <p id="status" role="status"></p>
  <aside hidden>
    <select id="preset"></select>
    <select id="scene-objects"></select>
    <input id="absorption" type="range" min="0" max="0.95" step="0.01"><output id="absorption-value"></output>
    <input id="scattering" type="range" min="0" max="1" step="0.01"><output id="scattering-value"></output>
    <select id="rays"><option>4096</option><option selected>16384</option><option>65536</option></select>
    <select id="bounces"><option>16</option><option selected>32</option><option>64</option></select>
    <input id="specular-rays" type="checkbox">
    <input id="seed" type="number">
    <input id="show-rays" type="checkbox" checked>
    <input id="audio-file" type="file" accept="audio/*"><span id="audio-name">Built-in pulse signal</span>
    <button id="trace" disabled></button>
    <button id="play" disabled></button>
    <button id="play-original"></button>
    <button id="stop" disabled></button>
    <button id="export" disabled></button>
    <button id="reset"></button>
    <button id="reset-view"></button>
    <button id="fullscreen"></button>
  </aside>`;

function addNumberInput(parent: HTMLElement, attributes: Record<string, string>): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  Object.assign(input.dataset, attributes);
  parent.append(input);
  return input;
}

export function createControls(appRoot: HTMLElement): void {
  appRoot.innerHTML = APP_MARKUP;
  const controlsRoot = appRoot.querySelector('aside')!;

  // build dropdowns from config tables
  const presetSelect = appRoot.querySelector<HTMLSelectElement>('#preset')!;
  for (const [key, preset] of Object.entries(ROOM_PRESETS)) {
    const isDefault = key === DEFAULT_ROOM_PRESET;
    presetSelect.add(new Option(preset.name, key, isDefault, isDefault));
  }
  const sceneObjectSelect = appRoot.querySelector<HTMLSelectElement>('#scene-objects')!;
  for (const entry of SCENE_LIBRARY) sceneObjectSelect.add(new Option(entry.label, entry.id));
  sceneObjectSelect.value = NO_SCENE_OBJECTS_ID;

  // specular echoes toggle
  const specularRays = appRoot.querySelector<HTMLInputElement>('#specular-rays')!;
  specularRays.checked = SPECULAR_RAY_DEFAULTS.enabled;

  // room dimensions and point positions
  for (let axis = 0; axis < 3; axis++) addNumberInput(controlsRoot, { dimension: String(axis) });
  for (const point of ['source', 'listener']) {
    for (let axis = 0; axis < 3; axis++) addNumberInput(controlsRoot, { point, axis: String(axis) });
  }

  // directivity controls
  const directivitySelect = document.createElement('select');
  directivitySelect.id = 'source-directivity';
  for (const pattern of DIRECTIVITY_PATTERNS) directivitySelect.add(new Option(pattern.label, pattern.id));
  controlsRoot.append(directivitySelect);
  for (const [id, limits] of [
    ['source-yaw', ORIENTATION_LIMITS_DEGREES.yaw],
    ['source-pitch', ORIENTATION_LIMITS_DEGREES.pitch],
  ] as const) {
    const input = addNumberInput(controlsRoot, {});
    input.id = id;
    input.min = String(limits.min);
    input.max = String(limits.max);
    input.step = String(limits.step);
  }
}
