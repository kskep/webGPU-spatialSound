// Choose the response builder. Both return convolver data; the hybrid response
// also contains settings for the persistent late feedback delay network.
import type { Scene, TraceResult } from '../acoustics/model.ts';
import type { RenderMode } from '../config/render-modes.ts';
import { buildFullIrResponse, type FullIrResponse } from './full-ir-response.ts';
import { buildHybridResponse, type HybridResponse, type LateDecayMode } from './hybrid-response.ts';
import type { HrtfBank } from './hrtf.ts';
import type { IrBuildTimings } from './ir-synthesis.ts';
import type { BinauralSettings, BinauralToggles } from '../config/binaural.ts';

// What the IR worker sends to the audio thread.
export type RoomResponse = HybridResponse | FullIrResponse;

export interface RoomResponseOptions {
  lateDecayMode?: LateDecayMode;
  // Filled in with the time spent in the stages the telemetry reports separately.
  timings?: IrBuildTimings;
  // The Task M toggles (src/config/binaural.ts); omitted = all off = the original behaviour.
  binaural?: BinauralToggles;
  // Id of the late-field layout (src/config/late-field.ts); omitted = 'standard'.
  lateProfile?: string;
  // Tunable numbers of the binaural options; defaults to BINAURAL_SETTINGS.
  binauralSettings?: BinauralSettings;
  // Low-frequency room modes (hybrid architecture only; the full-IR builder ignores it). Default off.
  roomModes?: boolean;
}

// Builds the response of `mode` for one trace.
export function buildRoomResponse(
  mode: RenderMode,
  scene: Scene,
  result: TraceResult,
  sampleRate: number,
  hrtf?: HrtfBank,
  options: RoomResponseOptions = {},
): RoomResponse {
  const common = {
    lateDecayMode: options.lateDecayMode,
    maxIrSeconds: mode.maxIrSeconds,
    timings: options.timings,
    binaural: options.binaural,
    lateProfile: options.lateProfile,
    binauralSettings: options.binauralSettings,
    roomModes: options.roomModes,
  };
  switch (mode.architecture) {
    case 'hybrid':
      return buildHybridResponse(scene, result, sampleRate, hrtf, common);
    case 'full-ir':
      return buildFullIrResponse(scene, result, sampleRate, hrtf, common);
  }
}
