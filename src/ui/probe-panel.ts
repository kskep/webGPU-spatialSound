// Probe controls: display, grid placement, selected probe, baking and JSON files.
// These controls call ProbeController directly and refresh when the set changes.
import type { GUI, GUIController } from 'dat.gui';
import type { ProbeController } from '../app/probe-controller';
import { PROBE_MODES } from '../config/probes';
import { countProbes } from '../probes/probe-set';

// Writes `text` to a file the browser downloads.
function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Heights typed as "1.2, 1.7" as numbers; NaN entries are kept so that the validator names them.
function parseHeights(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .filter((part) => part !== '')
    .map(Number);
}

// Controllers with the dat.gui range methods that the typings leave out.
type RangeController = GUIController & {
  min(value: number): GUIController;
  max(value: number): GUIController;
};

// Adds the Probes folder to `gui` and keeps it in step with `probes`.
export function mountProbeFolder(
  gui: GUI,
  probes: ProbeController,
  status: (message: string, error?: boolean) => void,
): void {
  const folder = gui.addFolder('Probes');
  const state: Record<string, any> = {
    mode: probes.mode,
    showProbes: probes.probesVisible,
    showBlend: probes.blendVisible,
    gridSpacing: probes.config.grid.spacing,
    gridHeights: probes.config.grid.heights.join(', '),
    gridClearance: probes.config.grid.clearance,
    selected: '',
    x: 0,
    y: 0,
    z: 0,
    label: '',
    enabled: true,
    bakeProgress: '—',
    bakeTime: '—',
    setSummary: '—',
  };
  const id = (controller: GUIController, name: string): GUIController => {
    controller.domElement.id = 'control-probe_' + name;
    return controller;
  };
  // Adds a button; the id goes on the whole row, which is what a click must hit (the button has no width).
  const button = (container: GUI, key: string, label: string): GUIController => {
    const controller = container.add(state, key).name(label);
    controller.domElement.closest('li')!.id = 'control-probe_' + key;
    return controller;
  };
  // Makes a text controller display-only.
  const readOnly = (controller: GUIController): GUIController => {
    controller.domElement.querySelector('input')!.readOnly = true;
    return controller;
  };

  // Mode and display
  const mode = id(
    folder
      .add(state, 'mode', Object.fromEntries(PROBE_MODES.map((entry) => [entry.label, entry.id])))
      .name('Mode'),
    'mode',
  );
  mode.onChange((value: string) => probes.setMode(value));
  mode.domElement.title = PROBE_MODES.map((entry) => `${entry.label}: ${entry.description}`).join('\n');
  id(folder.add(state, 'showProbes').name('Show probes'), 'showProbes').onChange((value: boolean) =>
    probes.setShowProbes(value),
  );
  id(folder.add(state, 'showBlend').name('Show blend'), 'showBlend').onChange((value: boolean) =>
    probes.setShowBlend(value),
  );
  readOnly(id(folder.add(state, 'setSummary').name('Probes'), 'summary'));

  // Grid
  const grid = folder.addFolder('Grid');
  // Sends the grid fields to the controller; a bad value is reported and the fields go back.
  const applyGrid = (): void => {
    const message = probes.setGrid({
      spacing: Number(state.gridSpacing),
      heights: parseHeights(String(state.gridHeights)),
      clearance: Number(state.gridClearance),
    });
    if (message) {
      status(message, true);
      state.gridSpacing = probes.config.grid.spacing;
      state.gridHeights = probes.config.grid.heights.join(', ');
      state.gridClearance = probes.config.grid.clearance;
      grid.__controllers.forEach((controller) => controller.updateDisplay());
    }
  };
  id(grid.add(state, 'gridSpacing', 0.25, 10, 0.05).name('Spacing (m)'), 'gridSpacing').onFinishChange(
    applyGrid,
  );
  id(grid.add(state, 'gridHeights').name('Heights (m)'), 'gridHeights').onFinishChange(applyGrid);
  id(grid.add(state, 'gridClearance', 0.05, 2, 0.05).name('Clearance (m)'), 'gridClearance').onFinishChange(
    applyGrid,
  );
  state.addGrid = () => {
    applyGrid();
    probes.generateGrid('add');
  };
  state.replaceGrid = () => {
    applyGrid();
    probes.generateGrid('replace');
  };
  state.clearAll = () => probes.clearAll();
  button(grid, 'addGrid', 'Add grid');
  button(grid, 'replaceGrid', 'Replace with grid');
  button(grid, 'clearAll', 'Delete all probes');
  grid.open();

  state.addAtCamera = () => probes.addAtCamera();
  const addButton = button(folder, 'addAtCamera', 'Add probe at camera (P)');
  addButton.domElement.closest('li')!.title =
    'Adds a probe at the camera position. Keyboard shortcut: P in the viewport.';

  // Selected probe
  const selection = folder.addFolder('Selected probe');
  const picker = id(selection.add(state, 'selected', { none: '' }).name('Probe'), 'selected');
  picker.onChange((value: string) => probes.select(value || undefined));
  const axes: RangeController[] = ['x', 'y', 'z'].map(
    (axis) => id(selection.add(state, axis, -10, 10, 0.05).name(axis), axis) as RangeController,
  );
  // Sends the slider positions to the controller; a refused move puts the sliders back.
  const moveSelected = (): void => {
    const probe = probes.selectedProbe;
    if (!probe) return;
    if (!probes.moveProbeTo(probe.id, [Number(state.x), Number(state.y), Number(state.z)])) syncSelection();
  };
  axes.forEach((controller) => controller.onFinishChange(moveSelected));
  const labelField = id(selection.add(state, 'label').name('Label'), 'label');
  labelField.onFinishChange((value: string) => {
    const probe = probes.selectedProbe;
    if (probe) probes.setProbeLabel(probe.id, value);
  });
  const enabledField = id(selection.add(state, 'enabled').name('Enabled'), 'enabled');
  enabledField.onChange((value: boolean) => {
    const probe = probes.selectedProbe;
    if (probe) probes.setProbeEnabled(probe.id, value);
  });
  state.moveToCamera = () => probes.moveSelectedToCamera();
  state.rebake = () => void probes.bakeSelected();
  state.remove = () => probes.removeSelected();
  button(selection, 'moveToCamera', 'Move to camera');
  button(selection, 'rebake', 'Re-bake');
  button(selection, 'remove', 'Delete');
  selection.open();

  // Bake
  const bake = folder.addFolder('Bake');
  state.bakeAll = () => void probes.bakeAll();
  state.bakeStale = () => void probes.bakeStale();
  state.cancelBake = () => probes.cancelBake();
  button(bake, 'bakeAll', 'Bake all');
  button(bake, 'bakeStale', 'Bake stale / unbaked');
  button(bake, 'cancelBake', 'Cancel');
  readOnly(id(bake.add(state, 'bakeProgress').name('Progress'), 'bakeProgress'));
  readOnly(id(bake.add(state, 'bakeTime').name('Bake time'), 'bakeTime'));
  bake.open();

  // Export and import
  const picker2 = document.createElement('input');
  picker2.type = 'file';
  picker2.accept = '.json,application/json';
  picker2.hidden = true;
  picker2.addEventListener('change', async () => {
    const file = picker2.files?.[0];
    picker2.value = '';
    if (file) probes.importText(await file.text());
  });
  document.body.append(picker2);
  state.exportSet = () => downloadText(probes.exportText(), `probes-${probes.set.sceneKey}.json`);
  state.importSet = () => picker2.click();
  button(folder, 'exportSet', 'Export probes');
  button(folder, 'importSet', 'Import probes');

  folder.open();

  // Keeping the folder in step with the controller
  // Rewrites the dropdown's options from the probe labels (the dat.gui list is fixed at creation).
  let pickerSignature = '';
  const rebuildPicker = (): void => {
    const select = picker.domElement.querySelector('select')!;
    // Rewriting the options closes an open dropdown, so it is only done when the list changed.
    const signature = probes.set.probes.map((probe) => `${probe.id}:${probe.label}`).join('|');
    if (signature !== pickerSignature) {
      pickerSignature = signature;
      select.replaceChildren(new Option('none', ''));
      for (const probe of probes.set.probes) select.add(new Option(probe.label, probe.id));
    }
    select.value = probes.selectedId ?? '';
    state.selected = select.value;
  };
  // The slider ranges follow the room, with the clearance the placement rules need.
  const fitRanges = (): void => {
    const { bounds, wallClearance } = probes.placementContext();
    axes.forEach((controller, axis) => {
      controller.min(bounds.min[axis] + wallClearance);
      controller.max(bounds.max[axis] - wallClearance);
    });
  };
  function syncSelection(): void {
    const probe = probes.selectedProbe;
    state.selected = probe?.id ?? '';
    if (probe) {
      [state.x, state.y, state.z] = probe.position.map((value) => Number(value.toFixed(3)));
      state.label = probe.label;
      state.enabled = probe.enabled;
    }
    for (const controller of [...axes, labelField, enabledField])
      controller.domElement.closest('li')!.style.opacity = probe ? '1' : '.45';
    refreshDisplays();
  }
  const refreshDisplays = (): void => {
    for (const container of [folder, grid, selection, bake])
      for (const controller of container.__controllers) controller.updateDisplay();
  };
  const sync = (): void => {
    fitRanges();
    rebuildPicker();
    const counts = countProbes(probes.set);
    state.mode = probes.mode;
    state.showProbes = probes.probesVisible;
    state.showBlend = probes.blendVisible;
    state.setSummary = `${counts.total} (${counts.baked} baked, ${counts.stale} stale, ${counts.unbaked} unbaked)`;
    const status = probes.bakeStatus;
    state.bakeProgress = '—';
    if (status.running) {
      state.bakeProgress = `${status.done} / ${status.total}`;
    } else if (status.last) {
      state.bakeProgress = `${status.last.baked.length} baked`;
      if (status.last.failed.length > 0) {
        state.bakeProgress += `, ${status.last.failed.length} failed`;
      }
      if (status.last.cancelled) state.bakeProgress += ' (stopped)';
    }
    const perProbe = status.last?.perProbeMs ?? [];
    state.bakeTime =
      perProbe.length > 0
        ? `${(status.last!.totalMs / 1000).toFixed(1)} s (${(perProbe.reduce((a, b) => a + b, 0) / perProbe.length).toFixed(0)} ms per probe)`
        : '—';
    syncSelection();
  };
  probes.subscribe(sync);
  window.addEventListener('scene-ui-refresh', sync);
  window.addEventListener('pagehide', () => {
    window.removeEventListener('scene-ui-refresh', sync);
    picker2.remove();
  });
  sync();
}
