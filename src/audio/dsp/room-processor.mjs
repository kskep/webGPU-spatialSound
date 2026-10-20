// AudioWorklet entry point (audio render thread). A thin shell around HybridRoomDsp:
//   main thread -> worklet : { type: 'room-response', id, response }, { type: 'reset-block-cost' },
//                            { type: 'room-mode-solo', solo } (debug) and { type: 'stop' }
//   worklet -> main thread : 'response-applied' | 'response-error' | 'telemetry' | 'processor-error'
// Real input is channel 0 of the first input; the output is a stereo pair. Copied to
// public/audio-worklets/ by scripts/sync-worklets.mjs.
//
// Node creation options (AudioWorkletNode `processorOptions`): { maxIrSeconds } sets the longest FIR the
// convolver holds. Every telemetry message carries `blockCost`: the measured time of process() per
// render quantum since the start or the last 'reset-block-cost' (see block-cost.mjs).
import { HybridRoomDsp } from './hybrid-core.mjs';
import { BlockCostMeter, selectClock } from './block-cost.mjs';
class RoomProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dsp = new HybridRoomDsp(sampleRate, 128, {
      maxIrSeconds: options?.processorOptions?.maxIrSeconds,
    });
    this.blockCost = new BlockCostMeter(sampleRate, 128, selectClock(globalThis));
    this.zero = new Float32Array(128);
    this.running = true;
    this.blocks = 0;
    this.wasFading = false;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'stop') {
        this.running = false;
        return;
      }
      if (message.type === 'room-mode-solo') {
        this.dsp.soloModes = !!message.solo;
        return;
      }
      if (message.type === 'reset-block-cost') {
        this.blockCost.reset();
        return;
      }
      if (message.type !== 'room-response') return;
      try {
        this.dsp.setResponse(message.response);
        this.wasFading = !!this.dsp.convolver.target;
        this.port.postMessage({ type: 'response-applied', id: message.id, telemetry: this.telemetry() });
      } catch (error) {
        this.port.postMessage({ type: 'response-error', id: message.id, error: error.message });
      }
    };
  }
  // The DSP counters plus the measured cost of one render quantum.
  telemetry() {
    return { ...this.dsp.telemetry(), blockCost: this.blockCost.report() };
  }
  process(inputs, outputs) {
    if (!this.running) return false;
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    try {
      this.blockCost.begin();
      this.dsp.process(inputs[0]?.[0] || this.zero, output[0], output[1]);
      this.blockCost.end();
      this.blocks++;
      const fading = !!this.dsp.convolver.target;
      if (this.blocks % 64 === 0 || (this.wasFading && !fading))
        this.port.postMessage({ type: 'telemetry', telemetry: this.telemetry() });
      this.wasFading = fading;
    } catch (error) {
      this.port.postMessage({ type: 'processor-error', error: error.message });
      this.running = false;
      return false;
    }
    return true;
  }
}
registerProcessor('acoustic-room-processor', RoomProcessor);
