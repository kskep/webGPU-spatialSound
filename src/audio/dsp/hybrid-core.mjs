// Hybrid room DSP (thesis 4.5): the algorithm run inside the AudioWorklet, kept free of Web Audio
// globals so that Node tests can drive it directly.
//
//   input --+--> StreamingConvolver (early FIR, 2 blocks of latency) ---------------------> output
//           |                                                                                 ^
//           +--> LateFdn (persistent late field, 8 bands) --delay--> x per-band gain --------+
//           |                                                                                 ^
//           +--delay--> ModalBank (optional room modes, room-modes.mjs) --> x per-mode weight -+
import { StreamingConvolver } from './stream-core.mjs';
import { LateFdn } from './late-fdn.mjs';
import { MAX_ROOM_MODES, ModalBank } from './room-modes.mjs';
/**
 * Longest FIR in seconds that the convolver holds when the caller gives no limit. This is the
 * streaming budget of the hybrid architecture (MAX_HYBRID_IR_SECONDS in src/config/render-modes.ts).
 */
const DEFAULT_MAX_IR_SECONDS = 2;

/**
 * A persistent source-history FIR and continuous late field share one sample clock.
 * The FDN output is delayed by the convolver latency so that both parts stay time aligned, and each
 * band is scaled by the late gain that belongs to the response currently being faded in or out.
 *
 * Two architectures use this class (src/config/render-modes.ts):
 *  - hybrid: every response carries a late-field configuration, and the FDN runs next to the FIR;
 *  - full-ir: the responses carry none, the FIR is the whole room response and the FDN never exists.
 * The first response fixes the architecture; mixing them needs a fresh processor.
 *
 * `options.maxIrSeconds` sets the longest FIR the convolver can hold (the length of its history).
 */
export class HybridRoomDsp {
  constructor(sampleRate, quantum = 128, options = {}) {
    this.sampleRate = sampleRate;
    this.quantum = quantum;
    this.maxIrSeconds = options.maxIrSeconds ?? DEFAULT_MAX_IR_SECONDS;
    this.convolver = new StreamingConvolver(sampleRate, this.maxIrSeconds, 512, 0.08, true, MAX_ROOM_MODES);
    this.latency = this.convolver.telemetry().latencySamples;
    // One delay line per band and ear, as long as the convolver latency (circular, see delayPosition).
    this.delayedL = Array.from({ length: 8 }, () => new Float32Array(this.latency));
    this.delayedR = Array.from({ length: 8 }, () => new Float32Array(this.latency));
    this.gainBlock = new Float32Array(quantum * 8);
    // Room modes (created by the first response that carries them): the input delayed by the convolver
    // latency, and the crossfaded per-mode weights of the current quantum.
    this.modal = null;
    this.modalDelay = new Float32Array(this.latency);
    this.modalBlock = new Float32Array(quantum * MAX_ROOM_MODES);
    this.modalActive = new Uint8Array(quantum);
    this.modalRebuilds = 0;
    // Debug: output only the room modes. The FIR and the FDN keep running (so their history stays
    // intact when solo is switched off) but are not added to the output.
    this.soloModes = false;
    this.delayPosition = 0;
    this.field = null;
    this.lateless = false;
    this.signature = '';
    this.samples = 0;
    this.decayUpdates = 0;
  }
  /**
   * Applies a new room response.
   * The geometry of the late field (sample rate, volume, surface, mean free time) fixes the delay
   * lengths, so a change there needs a fresh processor. The decay times alone only change the
   * feedback gains, so they are updated in place (see LateFdn.setDecay) and playback continues.
   */
  setResponse(packet) {
    if (!packet.late) {
      this.setLatelessResponse(packet);
      return;
    }
    if (this.lateless) throw new Error('A change of rendering architecture needs a fresh audio processor.');
    // The decay times and the coherence mix can change in place; only the geometry fixes the delay lines.
    const { rt60Bands, interauralCoherence, coherenceMix, ...geometry } = packet.late.config;
    const signature = JSON.stringify(geometry);
    if (this.field && signature !== this.signature)
      throw new Error('A room change needs a fresh audio processor.');
    if (
      packet.late.config.sampleRate !== this.sampleRate ||
      packet.late.gains.length !== 8 ||
      packet.late.gains.some((v) => !Number.isFinite(v) || v < 0)
    )
      throw new Error('Invalid persistent late response.');
    const decayChanged =
      !!this.field && rt60Bands.some((rt, band) => rt !== this.field.config.rt60Bands[band]);
    if (!this.field) {
      this.field = new LateFdn(packet.late.config);
      this.signature = signature;
    }
    packet.prepared.lateGains = packet.late.gains;
    this.setModes(packet);
    this.convolver.setResponse(packet.prepared);
    if (decayChanged) {
      this.field.setDecay(rt60Bands);
      this.decayUpdates++;
    }
    // A new coherence mix (or none) is ramped in; an unchanged one does nothing.
    this.field.setCoherenceMix(coherenceMix);
  }
  /**
   * Room modes of a hybrid response (`packet.modes`, see src/audio/hybrid-response.ts). The bank is kept
   * while the mode frequencies stay the same (only the decay is updated, so the modes keep ringing); a
   * different set of modes (another Schroeder frequency) replaces the bank, which restarts silent.
   * A response without modes fades their weights out with the FIR crossfade.
   */
  setModes(packet) {
    const modes = packet.modes;
    if (!modes) {
      delete packet.prepared.modalWeights;
      return;
    }
    if (
      modes.config.sampleRate !== this.sampleRate ||
      modes.weights.length !== modes.config.frequencies.length ||
      modes.weights.length > MAX_ROOM_MODES ||
      modes.weights.some((v) => !Number.isFinite(v))
    )
      throw new Error('Invalid room-mode response.');
    if (this.modal?.matches(modes.config)) this.modal.setDecay(modes.config.rt60s);
    else {
      this.modal = new ModalBank(modes.config);
      this.modalRebuilds++;
    }
    packet.prepared.modalWeights = modes.weights;
  }
  // Full-IR response: the convolver alone renders the room, so there is no late field and no gains.
  setLatelessResponse(packet) {
    if (this.field) throw new Error('A change of rendering architecture needs a fresh audio processor.');
    this.lateless = true;
    this.convolver.setResponse(packet.prepared);
  }

  // Renders one quantum: the convolved early part plus the delayed, gain-weighted late field (if any).
  process(input, left, right) {
    if (input.length !== this.quantum) throw new Error('Unexpected render quantum.');
    this.convolver.process(
      input,
      left,
      right,
      this.field ? this.gainBlock : null,
      this.modal ? this.modalBlock : null,
      this.modalActive,
    );
    if (this.soloModes) {
      left.fill(0);
      right.fill(0);
    }
    if (this.field)
      for (let i = 0; i < input.length; i++) {
        this.field.tick(input[i]);
        for (let band = 0; band < 8; band++) {
          const delayLeft = this.delayedL[band];
          const delayRight = this.delayedR[band];
          const gain = this.gainBlock[i * 8 + band];
          if (!this.soloModes) {
            left[i] += delayLeft[this.delayPosition] * gain;
            right[i] += delayRight[this.delayPosition] * gain;
          }
          delayLeft[this.delayPosition] = this.field.bandL[band];
          delayRight[this.delayPosition] = this.field.bandR[band];
        }
        // The mode bank runs on the delayed input, which equals delaying its output (it is linear). The
        // delay line is fed even without a bank, so a bank created later starts from the right input.
        const delayed = this.modalDelay[this.delayPosition];
        this.modalDelay[this.delayPosition] = input[i];
        if (this.modal) {
          const out = this.modal.tick(
            delayed,
            this.modalActive[i] ? this.modalBlock : null,
            i * MAX_ROOM_MODES,
          );
          left[i] += out;
          right[i] += out;
        }
        this.delayPosition++;
        if (this.delayPosition === this.latency) this.delayPosition = 0;
      }
    this.samples += input.length;
  }
  telemetry() {
    return {
      ...this.convolver.telemetry(),
      architecture: this.lateless ? 'full-ir' : 'hybrid',
      maxIrSeconds: this.maxIrSeconds,
      irPartitions: Math.max(this.convolver.current?.partitions ?? 0, this.convolver.target?.partitions ?? 0),
      renderedSamples: this.samples,
      activeResponses: this.convolver.target ? 2 : 1,
      persistentLateField: !!this.field,
      decayUpdates: this.decayUpdates,
      roomModeCount: this.modal ? this.modal.count : 0,
      roomModeRebuilds: this.modalRebuilds,
      soloModes: this.soloModes,
    };
  }
}
