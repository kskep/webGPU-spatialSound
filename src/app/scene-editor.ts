// Owns the scene (room, source, listener, furniture) and connects GUI controls to it.
import { defaultScene, validateScene, type Scene } from '../acoustics/model';
import { forwardFromAngles } from '../acoustics/directivity';
import { sceneFromRoomPreset } from '../acoustics/room-preset';
import { parseSceneObjects, type SceneObject } from '../geometry/acoustic-scene';
import { NO_SCENE_OBJECTS_ID, SCENE_LIBRARY } from '../geometry/scene-library';
import { DEFAULT_ROOM_PRESET } from '../config/room-presets';

export interface SceneEditorHooks {
  onSceneChanged(): void;
  refreshControls(): void;
  status(message: string, error?: boolean): void;
  sceneProblem(): string | undefined;
  onReset(): void;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// hidden controls whose value is a plain number
const NUMERIC_CONTROLS = '[data-dimension], [data-point], #absorption, #scattering, #rays, #bounces, #seed';

export class SceneEditor {
  scene: Scene = sceneFromRoomPreset(DEFAULT_ROOM_PRESET, defaultScene());
  sceneObjects: SceneObject[] = [];
  loadedSceneId = NO_SCENE_OBJECTS_ID;

  private hooks: SceneEditorHooks;
  private loadToken = 0;

  constructor(hooks: SceneEditorHooks) {
    this.hooks = hooks;
  }

  // validates and commits an edited scene, or restores controls on failure
  private tryCommit(candidate: Scene): void {
    try {
      validateScene(candidate);
      this.scene = candidate;
      this.hooks.onSceneChanged();
    } catch (error) {
      this.hooks.refreshControls();
      this.hooks.status((error as Error).message, true);
    }
  }

  // connects GUI controls to the scene (call once)
  bind(): void {
    this.bindNumericControls();
    this.bindDirectivityControls();
    this.bindRoomPreset();
    this.bindFurnitureScene();
    this.bindReset();
  }

  private bindNumericControls(): void {
    document.querySelectorAll<HTMLInputElement>(NUMERIC_CONTROLS).forEach((control) =>
      control.addEventListener('change', () => {
        const candidate: Scene = structuredClone(this.scene);
        const value = Number(control.value);
        if (control.dataset.dimension) {
          candidate.dimensions[Number(control.dataset.dimension)] = value;
        } else if (control.dataset.point) {
          candidate[control.dataset.point as 'source' | 'listener'][Number(control.dataset.axis)] = value;
        } else {
          candidate[control.id as 'absorption' | 'scattering' | 'rays' | 'bounces' | 'seed'] = value;
        }
        this.tryCommit(candidate);
      }),
    );
  }

  // source pattern, yaw and pitch
  private bindDirectivityControls(): void {
    const onChange = (): void => {
      const candidate: Scene = structuredClone(this.scene);
      candidate.sourceDirectivity = byId<HTMLSelectElement>('source-directivity').value;
      const yaw = Number(byId<HTMLInputElement>('source-yaw').value);
      const pitch = Number(byId<HTMLInputElement>('source-pitch').value);
      candidate.sourceForward = forwardFromAngles(yaw, pitch);
      this.tryCommit(candidate);
    };
    for (const id of ['source-directivity', 'source-yaw', 'source-pitch'])
      byId(id).addEventListener('change', onChange);
  }

  private bindRoomPreset(): void {
    byId('preset').addEventListener('change', () => {
      this.scene = sceneFromRoomPreset(byId<HTMLSelectElement>('preset').value, this.scene);
      this.hooks.onSceneChanged();
    });
  }

  // furniture scene dropdown: downloads the object list and applies its room preset
  private bindFurnitureScene(): void {
    byId('scene-objects').addEventListener('change', async () => {
      const selectedId = byId<HTMLSelectElement>('scene-objects').value;
      const entry = SCENE_LIBRARY.find((candidate) => candidate.id === selectedId) ?? SCENE_LIBRARY[0];
      const token = ++this.loadToken;
      try {
        let objects: SceneObject[] = [];
        if (entry.file) {
          const response = await fetch('/scenes/' + entry.file);
          if (!response.ok) throw new Error(`Could not load scene file ${entry.file}.`);
          objects = parseSceneObjects(await response.json());
        }
        if (token !== this.loadToken) return; // a newer selection superseded this one

        // Hall scenes are authored for a specific preset: switch the room first so the objects fit.
        if (entry.roomPreset) {
          byId<HTMLSelectElement>('preset').value = entry.roomPreset;
          this.scene = sceneFromRoomPreset(entry.roomPreset, this.scene);
        }
        this.sceneObjects = objects;
        this.loadedSceneId = entry.id;
        this.hooks.onSceneChanged();
        if (objects.length > 0 && !this.hooks.sceneProblem()) {
          this.hooks.status(`Loaded "${entry.label}" (${objects.length} objects). Run a trace.`);
        }
      } catch (error) {
        byId<HTMLSelectElement>('scene-objects').value = this.loadedSceneId;
        this.hooks.refreshControls();
        this.hooks.status((error as Error).message, true);
      }
    });
  }

  private bindReset(): void {
    byId('reset').addEventListener('click', () => {
      this.scene = sceneFromRoomPreset(DEFAULT_ROOM_PRESET, defaultScene());
      byId<HTMLSelectElement>('preset').value = DEFAULT_ROOM_PRESET;
      this.loadToken++;
      this.sceneObjects = [];
      this.loadedSceneId = NO_SCENE_OBJECTS_ID;
      byId<HTMLSelectElement>('scene-objects').value = NO_SCENE_OBJECTS_ID;
      this.hooks.onSceneChanged();
      this.hooks.onReset();
    });
  }
}
