import { defaultScene, materialBands, type Scene } from './model.ts';
import { atmosphericLoss } from './air.ts';
import { getRoomPreset, mixAbsorption, mixScattering } from '../config/room-presets.ts';
import { LEGACY_ROOM_PRESETS } from '../reference/room/room-presets.ts';

const FALLBACK_WALL_SCATTERING = 0.15;
const LEGACY_EAR_HEIGHT = 1.7;
const LEGACY_EDGE_MARGIN = 0.5;
const ONE_KHZ_BAND = 4;

export function sceneFromRoomPreset(presetKey: string, previous: Scene): Scene {
  const preset = getRoomPreset(presetKey);
  const scene = defaultScene();
  scene.sourceDirectivity = previous.sourceDirectivity;
  scene.sourceForward = previous.sourceForward;

  scene.dimensions = [...preset.dimensions];
  scene.materials = {
    walls: mixAbsorption(preset.walls),
    floor: mixAbsorption(preset.floor),
    ceiling: mixAbsorption(preset.ceiling),
  };

  // The scalar absorption of the GUI is the 1 kHz value of the walls.
  scene.absorption = scene.materials.walls[ONE_KHZ_BAND];
  // Shell scattering is the area-weighted curve per surface; GUI scalar `scattering` scales them.
  // EDW PAIRNOUME TO AREA-WEIGHTED SCATTERING TWN YLIKWN GIA KATHE EPIFANEIA TOU DWMATIOU.
  scene.shellScattering = {
    walls: mixScattering(preset.walls),
    floor: mixScattering(preset.floor),
    ceiling: mixScattering(preset.ceiling),
  };
  scene.scattering = 1;
  // A measured room states its air conditions; the pressure stays at 101.325 kPa.
  if (preset.air) {
    scene.airDbPerMeter = atmosphericLoss(
      preset.air.temperatureCelsius,
      preset.air.relativeHumidityPercent,
      101.325,
    );
  }
  scene.source = [...preset.source];
  scene.listener = [...preset.listener];
  return scene;
}

// A scene for a legacy preset (old material table). Source at centre, listener near the back wall.
export function sceneFromLegacyRoomPreset(presetKey: string, previous: Scene): Scene {
  const preset = LEGACY_ROOM_PRESETS[presetKey];
  const scene = defaultScene();
  scene.sourceDirectivity = previous.sourceDirectivity;
  scene.sourceForward = previous.sourceForward;

  const { width, height, depth } = preset.dimensions;
  scene.dimensions = [width, height, depth];
  scene.materials = {
    walls: materialBands(preset.materials.walls as Record<string, unknown>),
    floor: materialBands(preset.materials.floor as Record<string, unknown>),
    ceiling: materialBands(preset.materials.ceiling as Record<string, unknown>),
  };

  scene.absorption = scene.materials.walls[ONE_KHZ_BAND];
  scene.scattering = Number(
    preset.materials.walls.scattering1k ?? preset.materials.walls.scatteringMid ?? FALLBACK_WALL_SCATTERING,
  );

  const earHeight = Math.min(LEGACY_EAR_HEIGHT, height - LEGACY_EDGE_MARGIN);
  scene.source = [0, earHeight, 0];
  scene.listener = [0, earHeight, depth / 2 - LEGACY_EDGE_MARGIN];
  return scene;
}
