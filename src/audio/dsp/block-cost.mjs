// Cost of the audio thread's work per render quantum (thesis Chapter 5, "AudioWorklet block cost").
//
// The meter times each call of `process()` and reports the mean, the maximum and the fraction of the
// quantum duration (128 frames / sample rate, 2.67 ms at 48 kHz) that the work takes. Free of Web
// Audio globals, with the clock injected, so that Node tests can drive it.

/**
 * Picks the best clock the global scope offers.
 *
 * `performance.now()` is preferred (sub-millisecond). Some AudioWorkletGlobalScopes do not expose
 * `performance`; then `Date.now()` is used, whose resolution is one millisecond. A single block
 * (about 0.1 to 3 ms) cannot be timed with it, but the SUM over many blocks is still an unbiased
 * estimate of the total: the start of a block falls at a random point inside a millisecond tick,
 * and the tick counter advances with probability (duration / 1 ms). The mean over thousands of
 * blocks is therefore meaningful, while the maximum is not.
 */
export function selectClock(scope = globalThis) {
  if (typeof scope.performance !== 'undefined' && typeof scope.performance.now === 'function')
    return { name: 'performance.now', resolutionMs: null, now: () => scope.performance.now() };
  return { name: 'Date.now', resolutionMs: 1, now: () => Date.now() };
}

// Accumulates the duration of render quanta.
export class BlockCostMeter {
  /**
   * @param sampleRate  sample rate of the audio context in Hz
   * @param quantum     frames per render quantum (128 in the Web Audio API)
   * @param clock       `{ name, resolutionMs, now() }` as returned by `selectClock`
   */
  constructor(sampleRate, quantum = 128, clock = selectClock()) {
    this.clock = clock;
    this.quantumMs = (1000 * quantum) / sampleRate;
    this.reset();
  }

  // Starts a new measurement; the clock and the quantum length stay.
  reset() {
    this.blocks = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    this.overruns = 0;
    this.started = 0;
  }

  // Call just before the work of one quantum.
  begin() {
    this.started = this.clock.now();
  }

  // Call just after the work of one quantum.
  end() {
    const elapsed = this.clock.now() - this.started;
    this.blocks++;
    this.totalMs += elapsed;
    if (elapsed > this.maxMs) this.maxMs = elapsed;
    if (elapsed > this.quantumMs) this.overruns++;
  }

  /**
   * Snapshot for the telemetry message.
   * `maxMs` and `overruns` are exact only when `resolutionMs` is null (a sub-millisecond clock);
   * with a one-millisecond clock they are multiples of 1 ms and only the mean is trustworthy.
   */
  report() {
    const meanMs = this.blocks > 0 ? this.totalMs / this.blocks : 0;
    return {
      clock: this.clock.name,
      resolutionMs: this.clock.resolutionMs,
      blocks: this.blocks,
      meanMs,
      maxMs: this.maxMs,
      quantumMs: this.quantumMs,
      meanFractionOfQuantum: meanMs / this.quantumMs,
      maxFractionOfQuantum: this.maxMs / this.quantumMs,
      overruns: this.overruns,
    };
  }
}
