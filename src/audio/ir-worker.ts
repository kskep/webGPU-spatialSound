// Web Worker: builds the room response (early FIR, and the late-field gains or the full tail depending
// on the rendering architecture) off the main thread so that the UI never stalls.
// Receives { id, scene, result, sampleRate, lateDecayMode, renderMode, binaural }; replies with the response,
// whose spectrum buffers are transferred, not copied, and the time the worker spent (`workerTimings`).
// The HRTF bank is loaded once.
import type { LateDecayMode } from './hybrid-response';
import { buildRoomResponse } from './room-response';
import { HrtfBank } from './hrtf';
import type { IrBuildTimings } from './ir-synthesis';
import type { Scene, TraceResult } from '../acoustics/model';
import type { RenderMode } from '../config/render-modes';
import { BINAURAL_SETTINGS, type BinauralToggles } from '../config/binaural';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
let bank: Promise<HrtfBank> | undefined;
scope.onmessage = async (event) => {
  const { id, scene, result, sampleRate, lateDecayMode, renderMode, binaural, lateProfile, roomModes } =
    event.data as {
      id: number;
      scene: Scene;
      result: TraceResult;
      sampleRate: number;
      lateDecayMode?: LateDecayMode;
      renderMode: RenderMode;
      binaural?: { toggles: BinauralToggles; binSetId: string };
      lateProfile?: string;
      roomModes?: boolean;
    };
  try {
    // Loading the HRTF file happens once; it is timed apart so that it does not hide in the first update.
    const hrtfStarted = performance.now();
    bank ??= fetch('/hrtf/RIEC_hrir_subject_080.bin').then(async (response) => {
      if (!response.ok) throw new Error('Measured HRTF asset could not be loaded.');
      return new HrtfBank(await response.arrayBuffer());
    });
    const hrtf = await bank;
    // One-off analysis of the HRTF set (equalisation, triangulation, coherence), part of the load.
    if (binaural) hrtf.prepare(binaural.toggles);
    const hrtfLoadMs = performance.now() - hrtfStarted;

    const buildStarted = performance.now();
    const stageTimings: IrBuildTimings = { envelopeSmoothingMs: 0, stochasticHrtfMs: 0 };
    const settings = binaural && {
      ...BINAURAL_SETTINGS,
      stochastic: { ...BINAURAL_SETTINGS.stochastic, binSetId: binaural.binSetId },
    };
    const ir = buildRoomResponse(renderMode, scene, result, sampleRate, hrtf, {
      lateDecayMode,
      timings: stageTimings,
      binaural: binaural?.toggles,
      lateProfile,
      binauralSettings: settings,
      roomModes,
    });
    const workerTimings = {
      computeMs: performance.now() - buildStarted,
      envelopeSmoothingMs: stageTimings.envelopeSmoothingMs,
      stochasticHrtfMs: stageTimings.stochasticHrtfMs ?? 0,
      hrtfLoadMs,
    };
    scope.postMessage(
      {
        id,
        ir,
        hrtf: hrtf.metadata(
          binaural && {
            equalise: binaural.toggles.diffuseFieldEq,
            interpolate: binaural.toggles.hrtfInterpolation,
          },
        ),
        workerTimings,
      },
      [ir.prepared.lr.buffer, ir.prepared.li.buffer, ir.prepared.rr.buffer, ir.prepared.ri.buffer],
    );
  } catch (error) {
    bank = undefined;
    scope.postMessage({ id, error: (error as Error).message });
  }
};
