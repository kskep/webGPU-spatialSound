import { bassSweepSamples } from './test-signals';
import type { Scene, TraceResult } from '../acoustics/model';
import type { LateDecayMode } from './hybrid-response';
import type { RoomResponse } from './room-response';
import { DEFAULT_RENDER_MODE_ID, getRenderMode, type RenderMode } from '../config/render-modes';
import { DEFAULT_LATE_FIELD_PROFILE, getLateFieldProfile } from '../config/late-field';
import type { AudioUpdateTimings } from '../app/stage-timings';
import {
  BINAURAL_SETTINGS,
  defaultBinauralToggles,
  type BinauralToggleId,
  type BinauralToggles,
} from '../config/binaural';
interface RoomTelemetry {
  latencySamples: number;
  retainedInputBlocks: number;
  responseUpdates: number;
  activeResponses: number;
  persistentLateField: boolean;
  renderedSamples: number;
  blockCost?: unknown;
}

interface WorkerTimings {
  computeMs: number;
  envelopeSmoothingMs: number;
  stochasticHrtfMs: number;
  hrtfLoadMs: number;
}
interface WorkerReply {
  ir: RoomResponse;
  workerTimings: WorkerTimings;
}

// Audio playback - sends trace results to IR worker, then to AudioWorklet
// The dry source loops continuously, only the room response gets swapped
export class AudioPreview {
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private mono?: GainNode;
  private output?: GainNode;
  private originalOutput?: GainNode;
  private originalPlaying = false;
  private filter?: BiquadFilterNode;
  private imported?: AudioBuffer;
  private volume = 0.35;
  private sourceLevelDb = 0;
  private starts = 0;
  private updates = 0;
  private generation = 0;
  private importRevision = 0;
  private worker?: Worker;
  private jobId = 0;
  private pending = new Map<
    number,
    { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void }
  >();
  private hrtfMetadata: unknown;
  private lateMetadata: unknown;
  private fullIrMetadata: unknown;
  private renderMode: RenderMode = getRenderMode(DEFAULT_RENDER_MODE_ID);
  private lastTimings?: AudioUpdateTimings;
  private binaural: BinauralToggles = defaultBinauralToggles();
  private binSetId: string = BINAURAL_SETTINGS.stochastic.binSetId;
  private lateProfileId: string = DEFAULT_LATE_FIELD_PROFILE;
  private lateDecayMode: LateDecayMode = 'ray-fit';
  private roomModes = false;
  private roomModeSolo = false;
  private testSignalKind: 'pulse' | 'sweep' = 'pulse';
  private workletReady?: Promise<void>;
  private node?: AudioWorkletNode;
  private responseId = 0;
  private acknowledgements = new Map<
    number,
    { resolve: (ok: boolean) => void; reject: (error: Error) => void }
  >();
  private stats?: RoomTelemetry;
  private runtimeError?: string;
  //
  // Chooses the rendering architecture. The worklet sizes its convolver for one architecture, so
  // a change of mode ends playback (the node is rebuilt by the next play()). Returns true when
  // playback was stopped and the caller should start it again.
  setRenderMode(mode: RenderMode): boolean {
    if (mode.id === this.renderMode.id) return false;
    this.renderMode = mode;
    const wasPlaying = !!this.node;
    this.stop();
    return wasPlaying;
  }

  //
  // Chooses the layout of the late field's delay lines. The delay lines belong to the running
  // worklet, so a change ends playback (the node is rebuilt by the next play()). Returns true when
  // playback was stopped and the caller should start it again.
  setLateProfile(id: string): boolean {
    getLateFieldProfile(id);
    if (id === this.lateProfileId) return false;
    this.lateProfileId = id;
    const wasPlaying = !!this.node;
    this.stop();
    return wasPlaying;
  }

  //
  get lateProfile(): string {
    return this.lateProfileId;
  }

  //
  get renderModeId(): string {
    return this.renderMode.id;
  }

  //
  resetBlockCost(): void {
    this.node?.port.postMessage({ type: 'reset-block-cost' });
  }

  //
  setLateDecayMode(mode: LateDecayMode): void {
    this.lateDecayMode = mode;
  }
  //
  setRoomModes(value: boolean): void {
    this.roomModes = value;
  }
  //
  setRoomModeSolo(value: boolean): void {
    this.roomModeSolo = value;
    this.node?.port.postMessage({ type: 'room-mode-solo', solo: value });
  }
  //
  setBinauralToggle(id: BinauralToggleId, value: boolean): void {
    this.binaural = { ...this.binaural, [id]: value };
  }
  //
  setBinSet(id: string): void {
    this.binSetId = id;
  }
  //
  binauralState() {
    return { ...this.binaural, binSetId: this.binSetId };
  }
  //
  setVolume(value: number): void {
    this.volume = value;
    if (this.output) this.output.gain.setTargetAtTime(value * 0.63, this.context!.currentTime, 0.02);
    if (this.originalOutput) {
      this.originalOutput.gain.setTargetAtTime(value * 0.63, this.context!.currentTime, 0.02);
    }
  }
  //
  // Source sound power relative to the default, in dB. Applied as a gain on the dry signal before
  // the room: the room response is linear, so this equals scaling the energy of every traced ray
  // by 10^(dB/10) without tracing again. Smoothed over ~20 ms to avoid clicks.
  setSourceLevel(db: number): void {
    this.sourceLevelDb = db;
    if (this.mono) this.mono.gain.setTargetAtTime(10 ** (db / 20), this.context!.currentTime, 0.02);
  }
  //
  telemetry() {
    return {
      backend: this.originalPlaying ? 'direct-buffer-source' : 'history-preserving-worklet',
      sourceStarts: this.starts,
      responseUpdates: this.updates,
      activeResponses: this.stats?.activeResponses ?? 0,
      playing: !!this.source,
      playbackMode: this.originalPlaying ? 'original' : 'convolved',
      renderMode: this.renderMode.id,
      hrtf: this.hrtfMetadata,
      binaural: this.binauralState(),
      roomModes: this.roomModes,
      roomModeSolo: this.roomModeSolo,
      late: this.lateMetadata,
      fullIr: this.fullIrMetadata,
      lastUpdateTimings: this.lastTimings,
      ...this.stats,
      error: this.runtimeError,
    };
  }
  //
  async load(file: File): Promise<boolean> {
    const revision = ++this.importRevision;
    this.context ??= new AudioContext();
    const decoded = await this.context.decodeAudioData(await file.arrayBuffer());
    if (revision !== this.importRevision) return false;
    this.imported = decoded;
    return true;
  }
  //
  useTestSignal(kind: 'pulse' | 'sweep' = 'pulse'): void {
    this.importRevision++;
    this.imported = undefined;
    this.testSignalKind = kind;
  }
  //
  private buildIR(scene: Scene, result: TraceResult, sampleRate: number): Promise<WorkerReply> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./ir-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event) => {
        const { id, ir, error, hrtf, workerTimings } = event.data;
        const job = this.pending.get(id);
        if (!job) return;
        this.pending.delete(id);
        if (error) job.reject(new Error(error));
        else {
          this.hrtfMetadata = hrtf;
          this.lateMetadata = ir.architecture === 'hybrid' ? ir.late : undefined;
          this.fullIrMetadata = ir.architecture === 'full-ir' ? ir.fullIr : undefined;
          job.resolve({ ir, workerTimings });
        }
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'IR worker failed.'));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = undefined;
      };
    }
    const id = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({
        id,
        scene,
        result,
        sampleRate,
        lateDecayMode: this.lateDecayMode,
        renderMode: this.renderMode,
        binaural: { toggles: this.binaural, binSetId: this.binSetId },
        lateProfile: this.lateProfileId,
        roomModes: this.roomModes,
      });
    });
  }
  //
  stop(): void {
    this.generation++;
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
    }
    this.source = undefined;
    this.originalPlaying = false;
    this.originalOutput?.disconnect();
    this.originalOutput = undefined;
    this.mono?.disconnect();
    this.mono = undefined;
    if (this.node) {
      this.node.port.postMessage({ type: 'stop' });
      this.node.disconnect();
      this.node.port.close();
      this.node = undefined;
    }
    for (const ack of this.acknowledgements.values()) ack.resolve(false);
    this.acknowledgements.clear();
    this.stats = undefined;
  }
  //
  private async initializeNode(ctx: AudioContext, generation: number): Promise<boolean> {
    this.workletReady ??= ctx.audioWorklet.addModule('/audio-worklets/room-processor.mjs');
    await this.workletReady;
    if (generation !== this.generation) return false;
    if (this.node) return true;
    const node = new AudioWorkletNode(ctx, 'acoustic-room-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { maxIrSeconds: this.renderMode.maxIrSeconds },
    });
    node.port.onmessage = (event) => {
      if (this.node !== node) return;
      const message = event.data;
      if (message.telemetry) this.stats = message.telemetry;
      if (message.type === 'response-applied') {
        this.acknowledgements.get(message.id)?.resolve(true);
        this.acknowledgements.delete(message.id);
      }
      if (message.type === 'response-error') {
        this.acknowledgements.get(message.id)?.reject(new Error(message.error));
        this.acknowledgements.delete(message.id);
      }
      if (message.type === 'processor-error') {
        this.runtimeError = message.error;
        for (const ack of this.acknowledgements.values()) ack.reject(new Error(message.error));
        this.acknowledgements.clear();
        this.stop();
      }
    };
    node.onprocessorerror = () => {
      if (this.node !== node) return;
      this.runtimeError = 'The room audio processor stopped unexpectedly.';
      this.stop();
    };
    node.connect(this.output!);
    node.port.postMessage({ type: 'room-mode-solo', solo: this.roomModeSolo });
    this.node = node;
    return true;
  }
  //
  async playOriginal(): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.context ??= new AudioContext();
    await this.context.resume();
    if (generation !== this.generation) return;

    const ctx = this.context;
    const source = ctx.createBufferSource();
    source.buffer =
      this.imported ?? (this.testSignalKind === 'sweep' ? this.bassSweep(ctx) : this.testSignal(ctx));
    source.loop = true;

    // EDW PERNAME TON ARXIKO IXO MONO APO TO MASTER VOLUME, XWRIS MONO MIX, HRTF I ROOM FILTERS.
    this.originalOutput = ctx.createGain();
    this.originalOutput.gain.value = this.volume * 0.63;
    source.connect(this.originalOutput).connect(ctx.destination);
    this.source = source;
    this.originalPlaying = true;
    this.runtimeError = undefined;
    source.start();
    this.starts++;
  }

  // Starts playback, or updates a playing room: builds the response in the worker, hands it to the
  // worklet (transferring the spectrum buffers) and, on the first call, starts the looping source.
  // Resolves with the audio-side stage timings, or undefined when stop() superseded the update.
  async play(scene: Scene, result: TraceResult): Promise<AudioUpdateTimings | undefined> {
    if (this.originalPlaying) this.stop();
    const generation = this.generation;
    this.context ??= new AudioContext();
    await this.context.resume();
    if (generation !== this.generation) return undefined;
    const ctx = this.context;
    if (!this.output) {
      this.output = ctx.createGain();
      this.output.gain.value = this.volume * 0.63;
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'highpass';
      this.filter.frequency.value = 25;
      this.output.connect(this.filter).connect(ctx.destination);
    }
    const buildStarted = performance.now();
    const { ir, workerTimings } = await this.buildIR(scene, result, ctx.sampleRate);
    const irBuildMs = performance.now() - buildStarted;
    if (generation !== this.generation) return undefined;
    const nodeStarted = performance.now();
    if (!(await this.initializeNode(ctx, generation)) || generation !== this.generation) return undefined;
    const nodeSetupMs = performance.now() - nodeStarted;
    const id = ++this.responseId;
    const swapStarted = performance.now();
    const applied = await new Promise<boolean>((resolve, reject) => {
      this.acknowledgements.set(id, { resolve, reject });
      const prepared = ir.prepared;
      this.node!.port.postMessage({ type: 'room-response', id, response: ir }, [
        prepared.lr.buffer,
        prepared.li.buffer,
        prepared.rr.buffer,
        prepared.ri.buffer,
      ]);
    });
    if (!applied || generation !== this.generation) return undefined;
    const rendererSwapMs = performance.now() - swapStarted;
    this.updates++;
    this.runtimeError = undefined;
    if (!this.source) {
      const source = ctx.createBufferSource();
      source.buffer =
        this.imported ?? (this.testSignalKind === 'sweep' ? this.bassSweep(ctx) : this.testSignal(ctx));
      source.loop = true;
      this.mono = ctx.createGain();
      this.mono.channelCount = 1;
      this.mono.channelCountMode = 'explicit';
      this.mono.gain.value = 10 ** (this.sourceLevelDb / 20);
      source.connect(this.mono).connect(this.node!);
      this.source = source;
      source.start();
      this.starts++;
    }
    this.lastTimings = {
      irBuildMs,
      workerComputeMs: workerTimings.computeMs,
      envelopeSmoothingMs: workerTimings.envelopeSmoothingMs,
      stochasticHrtfMs: workerTimings.stochasticHrtfMs,
      messagingMs: Math.max(0, irBuildMs - workerTimings.computeMs - workerTimings.hrtfLoadMs),
      hrtfLoadMs: workerTimings.hrtfLoadMs,
      nodeSetupMs,
      rendererSwapMs,
    };
    return this.lastTimings;
  }
  //
  //
  private bassSweep(ctx: AudioContext): AudioBuffer {
    const samples = bassSweepSamples(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }
  private testSignal(ctx: AudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const time = i / ctx.sampleRate;
      const local = time % 0.5;
      data[i] =
        Math.exp(-local * 28) *
        (Math.sin(2 * Math.PI * 220 * time) + 0.35 * Math.sin(2 * Math.PI * 440 * time));
    }
    return buffer;
  }
}
