// Streaming partitioned convolution (thesis 4.5): the early part of the room response.
//
// A stereo FIR of up to a few seconds is cut into partitions of `blockSize` samples. The spectrum of
// every partition is computed once (`prepareResponse`, off the audio thread). While audio streams in,
// the spectrum of each new input block is stored in a history ring, and every output block is the
// inverse FFT of sum over p of H_p * X_(now - p) (uniformly partitioned overlap-save convolution).
// Because the input spectra are kept, a new FIR can replace the old one at any time and instantly
// "sees" the same past input, which is what makes crossfading between rooms seamless.

// Twiddle factors exp(-2*pi*i*k/size) per transform size, built once and shared by all convolvers.
const twiddleTables = new Map();

/**
 * In-place radix-2 decimation-in-time FFT (Cooley-Tukey) of `real` + i*`imag`; the length must be a
 * power of two. `inverse` conjugates the twiddles and divides by n, so an fft followed by an inverse
 * restores the input. Float64 throughout, because the FIR spectra are precomputed in double precision.
 */
export function fft(real, imag, inverse = false) {
  const n = real.length;
  // Bit-reversal permutation: `reversed` is the bit-reversed counterpart of `index`.
  for (let index = 1, reversed = 0; index < n; index++) {
    let bit = n >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      const savedReal = real[index];
      real[index] = real[reversed];
      real[reversed] = savedReal;
      const savedImag = imag[index];
      imag[index] = imag[reversed];
      imag[reversed] = savedImag;
    }
  }
  // Butterflies: combine pairs of half-size transforms into transforms of `size`.
  // EDW KANOUME TA FFT BUTTERFLIES GIA NA METAFEROUME TO SIGNAL METAKSY XRONOU KAI SYXNOTITAS.
  for (let size = 2; size <= n; size *= 2) {
    let table = twiddleTables.get(size);
    if (!table) {
      table = { cos: new Float64Array(size / 2), sin: new Float64Array(size / 2) };
      for (let k = 0; k < size / 2; k++) {
        table.cos[k] = Math.cos((-2 * Math.PI * k) / size);
        table.sin[k] = Math.sin((-2 * Math.PI * k) / size);
      }
      twiddleTables.set(size, table);
    }
    for (let start = 0; start < n; start += size)
      for (let k = 0; k < size / 2; k++) {
        const top = start + k;
        const bottom = top + size / 2;
        const cosine = table.cos[k];
        const sine = inverse ? -table.sin[k] : table.sin[k];
        const rotatedReal = cosine * real[bottom] - sine * imag[bottom];
        const rotatedImag = sine * real[bottom] + cosine * imag[bottom];
        real[bottom] = real[top] - rotatedReal;
        imag[bottom] = imag[top] - rotatedImag;
        real[top] += rotatedReal;
        imag[top] += rotatedImag;
      }
  }
  if (inverse)
    for (let index = 0; index < n; index++) {
      real[index] /= n;
      imag[index] /= n;
    }
}

/**
 * Splits a stereo FIR into partitions of `blockSize` samples and stores the spectrum of each one
 * (uniformly partitioned convolution, overlap-save). Runs off the audio thread.
 *
 * Result fields: `lr`/`li` are the real/imaginary parts of the left-ear spectra and `rr`/`ri` those of
 * the right ear, each `partitions * bins` floats (partition-major). A real signal needs only
 * blockSize + 1 bins; the other half of the 2 * blockSize spectrum is the conjugate mirror.
 */
export function prepareResponse(left, right, blockSize = 512) {
  if (blockSize < 128 || blockSize & (blockSize - 1))
    throw new Error('Partition size must be a power of two.');
  if (!left.length || !right.length) throw new Error('An impulse response cannot be empty.');
  const length = Math.max(left.length, right.length);
  const partitions = Math.ceil(length / blockSize);
  const bins = blockSize + 1;
  const size = blockSize * 2;
  const leftReal = new Float32Array(partitions * bins);
  const leftImag = new Float32Array(partitions * bins);
  const rightReal = new Float32Array(partitions * bins);
  const rightImag = new Float32Array(partitions * bins);
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let partition = 0; partition < partitions; partition++)
    for (let channel = 0; channel < 2; channel++) {
      // Zero-padded to 2 * blockSize so that the product of spectra is a linear (not circular) convolution.
      real.fill(0);
      imag.fill(0);
      const input = channel === 0 ? left : right;
      for (let i = 0; i < blockSize && partition * blockSize + i < input.length; i++) {
        const value = input[partition * blockSize + i];
        if (!Number.isFinite(value)) throw new Error('Non-finite FIR sample.');
        real[i] = value;
      }
      fft(real, imag);
      (channel === 0 ? leftReal : rightReal).set(real.subarray(0, bins), partition * bins);
      (channel === 0 ? leftImag : rightImag).set(imag.subarray(0, bins), partition * bins);
    }
  return {
    blockSize,
    length,
    partitions,
    bins,
    lr: leftReal,
    li: leftImag,
    rr: rightReal,
    ri: rightImag,
  };
}

/**
 * Linear blend (1 - mix) * `from` + mix * `to` of two prepared responses: every spectrum bin, the
 * eight late-field gains and the room-mode weights (if any). Used when a new response arrives while the previous fade is unfinished,
 * so the next fade starts from what is currently audible instead of jumping.
 */
function blendedResponse(from, to, mix) {
  const partitions = Math.max(from.partitions, to.partitions);
  const bins = from.bins;
  const out = {
    blockSize: from.blockSize,
    length: Math.max(from.length, to.length),
    partitions,
    bins,
  };
  for (const key of ['lr', 'li', 'rr', 'ri']) {
    const data = new Float32Array(partitions * bins);
    for (let i = 0; i < data.length; i++) data[i] = (from[key][i] || 0) * (1 - mix) + (to[key][i] || 0) * mix;
    out[key] = data;
  }
  out.lateGains = Array.from(
    { length: 8 },
    (_, band) => (from.lateGains?.[band] || 0) * (1 - mix) + (to.lateGains?.[band] || 0) * mix,
  );
  if (from.modalWeights || to.modalWeights)
    out.modalWeights = Array.from(
      { length: Math.max(from.modalWeights?.length ?? 0, to.modalWeights?.length ?? 0) },
      (_, m) => (from.modalWeights?.[m] || 0) * (1 - mix) + (to.modalWeights?.[m] || 0) * mix,
    );
  return out;
}

/**
 * Streaming stereo convolver with a history of input spectra that survives FIR changes.
 * Both sides of a crossfade (`current` fading out, `target` fading in) use the same historical input.
 *
 * `staggered = true` spreads the work of one block over the render quanta of the next block
 * (see startJob / jobStep) to avoid a CPU spike on a single audio callback, at the price of one
 * extra block of latency. The render thread runs it that way; offline tests also use the direct mode.
 *
 * `modalSlots` > 0 also crossfades the output weights of the room-mode bank (room-modes.mjs): a response
 * may carry `modalWeights` (one per mode), which are queued per output sample like the late gains.
 */
export class StreamingConvolver {
  constructor(
    sampleRate,
    maxSeconds = 1.5,
    blockSize = 512,
    fadeSeconds = 0.08,
    staggered = false,
    modalSlots = 0,
  ) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.size = blockSize * 2;
    this.bins = blockSize + 1;
    // Number of input blocks whose spectra are retained = the longest FIR that can be rendered.
    this.capacity = Math.ceil((sampleRate * maxSeconds) / blockSize) + 1;
    this.historyR = new Float32Array(this.capacity * this.bins);
    this.historyI = new Float32Array(this.capacity * this.bins);
    this.previous = new Float32Array(blockSize);
    this.input = new Float32Array(blockSize);
    this.offset = 0;
    this.write = -1;
    this.blocks = 0;
    this.staggered = staggered;
    this.outputPosition = 0;
    this.epoch = 0;
    this.jobActive = false;
    // Accumulators of the staggered job: [current L, current R, target L, target R].
    this.job = {
      real: Array.from({ length: 4 }, () => new Float64Array(this.size)),
      imag: Array.from({ length: 4 }, () => new Float64Array(this.size)),
    };
    // Rendered output waiting to be played, and the per-band late gains that go with each sample.
    this.queueL = new Float32Array(blockSize * (staggered ? 2 : 1));
    this.queueR = new Float32Array(blockSize * (staggered ? 2 : 1));
    this.queueGains = new Float32Array(this.queueL.length * 8);
    // Room-mode weights per output sample, and whether that sample has any (0 = the bank is silent).
    this.modalSlots = modalSlots;
    this.queueModal = new Float32Array(this.queueL.length * modalSlots);
    this.queueModalActive = new Uint8Array(modalSlots ? this.queueL.length : 0);
    // Scratch buffers: xR/xI = spectrum of the newest input block, yR/yI = accumulated output spectrum.
    this.xR = new Float64Array(this.size);
    this.xI = new Float64Array(this.size);
    this.yR = new Float64Array(this.size);
    this.yI = new Float64Array(this.size);
    this.oldL = new Float32Array(blockSize);
    this.oldR = new Float32Array(blockSize);
    this.newL = new Float32Array(blockSize);
    this.newR = new Float32Array(blockSize);
    this.current = null;
    this.target = null;
    this.fade = 0;
    this.fadeLength = Math.max(1, Math.round(sampleRate * fadeSeconds));
    this.responses = 0;
    // Populate FFT lookup tables before the source is started.
    fft(new Float64Array(this.size), new Float64Array(this.size));
  }

  // Installs a prepared response: it becomes `current` at once, or `target` of a new crossfade.
  setResponse(response) {
    if (
      response.blockSize !== this.blockSize ||
      response.bins !== this.bins ||
      response.partitions > this.capacity
    )
      throw new Error('IR exceeds the streaming convolver budget.');
    for (const key of ['lr', 'li', 'rr', 'ri'])
      if (
        !(response[key] instanceof Float32Array) ||
        response[key].length !== response.partitions * this.bins
      )
        throw new Error('Malformed IR spectrum.');
    if (!this.current) this.current = response;
    else {
      if (this.target)
        this.current = blendedResponse(this.current, this.target, Math.min(1, this.fade / this.fadeLength));
      this.target = response;
      this.fade = 0;
    }
    this.responses++;
    this.epoch++;
  }

  /**
   * Direct mode: renders one output block of `response` into `left`/`right`.
   * Frequency-domain multiply-accumulate over the partitions (y = sum of H_p * X_(now - p)), then
   * restore the conjugate-mirrored half of the spectrum and keep the last blockSize samples of the
   * inverse FFT (overlap-save discards the first half).
   */
  renderBank(response, left, right) {
    if (!response) {
      left.fill(0);
      right.fill(0);
      return;
    }
    const count = Math.min(response.partitions, this.blocks);
    const bins = this.bins;
    const size = this.size;
    for (let channel = 0; channel < 2; channel++) {
      this.yR.fill(0);
      this.yI.fill(0);
      const filterReal = channel === 0 ? response.lr : response.rr;
      const filterImag = channel === 0 ? response.li : response.ri;
      for (let partition = 0; partition < count; partition++) {
        const history = ((this.write - partition + this.capacity) % this.capacity) * bins;
        const coeff = partition * bins;
        for (let bin = 0; bin < bins; bin++) {
          const inputReal = this.historyR[history + bin];
          const inputImag = this.historyI[history + bin];
          const re = filterReal[coeff + bin];
          const im = filterImag[coeff + bin];
          this.yR[bin] += inputReal * re - inputImag * im;
          this.yI[bin] += inputReal * im + inputImag * re;
        }
      }
      for (let bin = 1; bin < bins - 1; bin++) {
        this.yR[size - bin] = this.yR[bin];
        this.yI[size - bin] = -this.yI[bin];
      }
      fft(this.yR, this.yI, true);
      (channel === 0 ? left : right).set(this.yR.subarray(this.blockSize));
    }
  }

  // Staggered mode: snapshots the state needed to render the block that was just completed.
  startJob() {
    const job = this.job;
    job.current = this.current;
    job.target = this.target;
    job.fade = this.fade;
    job.epoch = this.epoch;
    job.anchor = this.write;
    job.blocks = this.blocks;
    job.step = 0;
    job.count = Math.max(job.current?.partitions || 0, job.target?.partitions || 0);
    for (let i = 0; i < 4; i++) {
      job.real[i].fill(0);
      job.imag[i].fill(0);
    }
    this.jobActive = true;
  }

  // Writes the crossfaded late-field gain of each of the 8 bands for output sample `index`.
  gainsAt(index, from, to, mix) {
    for (let band = 0; band < 8; band++)
      this.queueGains[index * 8 + band] =
        (from?.lateGains?.[band] || 0) * (1 - mix) + (to?.lateGains?.[band] || 0) * mix;
    if (!this.modalSlots) return;
    const fromModal = from?.modalWeights;
    const toModal = to?.modalWeights;
    const active = !!(fromModal || toModal);
    this.queueModalActive[index] = active ? 1 : 0;
    if (active)
      for (let m = 0, base = index * this.modalSlots; m < this.modalSlots; m++)
        this.queueModal[base + m] = (fromModal?.[m] || 0) * (1 - mix) + (toModal?.[m] || 0) * mix;
  }

  /**
   * Staggered mode: does a slice of the pending job during one render quantum of `quantum` samples.
   * The partitions are divided evenly over blockSize / quantum calls; the last call finishes the
   * inverse FFTs and crossfades the two banks into the output queue.
   */
  jobStep(quantum) {
    const job = this.job;
    const steps = this.blockSize / quantum;
    const begin = Math.floor((job.count * job.step) / steps);
    const end = Math.floor((job.count * ++job.step) / steps);
    for (let bank = 0; bank < 2; bank++) {
      const response = bank === 0 ? job.current : job.target;
      if (!response) continue;
      const count = Math.min(end, response.partitions, job.blocks);
      for (let channel = 0; channel < 2; channel++) {
        const filterReal = channel === 0 ? response.lr : response.rr;
        const filterImag = channel === 0 ? response.li : response.ri;
        const real = job.real[bank * 2 + channel];
        const imag = job.imag[bank * 2 + channel];
        for (let partition = begin; partition < count; partition++) {
          const history = ((job.anchor - partition + this.capacity) % this.capacity) * this.bins;
          const coeff = partition * this.bins;
          for (let bin = 0; bin < this.bins; bin++) {
            const inputReal = this.historyR[history + bin];
            const inputImag = this.historyI[history + bin];
            const re = filterReal[coeff + bin];
            const im = filterImag[coeff + bin];
            real[bin] += inputReal * re - inputImag * im;
            imag[bin] += inputReal * im + inputImag * re;
          }
        }
      }
    }
    if (job.step < steps) return;
    for (let bank = 0; bank < (job.target ? 2 : 1); bank++)
      for (let channel = 0; channel < 2; channel++) {
        const real = job.real[bank * 2 + channel];
        const imag = job.imag[bank * 2 + channel];
        for (let bin = 1; bin < this.bins - 1; bin++) {
          real[this.size - bin] = real[bin];
          imag[this.size - bin] = -imag[bin];
        }
        fft(real, imag, true);
      }
    for (let i = 0; i < this.blockSize; i++) {
      const mix = job.target ? Math.min(1, (job.fade + i) / this.fadeLength) : 0;
      const index = (this.outputPosition + i) % this.queueL.length;
      this.queueL[index] =
        job.real[0][this.blockSize + i] * (1 - mix) + job.real[2][this.blockSize + i] * mix;
      this.queueR[index] =
        job.real[1][this.blockSize + i] * (1 - mix) + job.real[3][this.blockSize + i] * mix;
      this.gainsAt(index, job.current, job.target, mix);
    }
    if (job.target && job.epoch === this.epoch) {
      this.fade += this.blockSize;
      if (this.fade >= this.fadeLength) {
        this.current = this.target;
        this.target = null;
      }
    }
    this.jobActive = false;
  }

  /**
   * Called when `input` holds a full block: transforms the last two blocks (previous + input) into
   * the history ring, then renders (direct mode) or schedules (staggered mode) the output block.
   */
  computeBlock() {
    this.xR.set(this.previous, 0);
    this.xR.set(this.input, this.blockSize);
    this.xI.fill(0);
    fft(this.xR, this.xI);
    this.write = (this.write + 1) % this.capacity;
    this.blocks++;
    this.historyR.set(this.xR.subarray(0, this.bins), this.write * this.bins);
    this.historyI.set(this.xI.subarray(0, this.bins), this.write * this.bins);
    if (this.staggered) {
      this.previous.set(this.input);
      this.startJob();
      return;
    }
    this.renderBank(this.current, this.oldL, this.oldR);
    if (this.target) {
      this.renderBank(this.target, this.newL, this.newR);
      for (let i = 0; i < this.blockSize; i++) {
        // EDW KANOUME CROSSFADE METAKSY PALIAS KAI NEAS APOKRISIS GIA NA MIN AKOUGETAI APOTOMO ALLAGMA.
        const mix = Math.min(1, (this.fade + i) / this.fadeLength);
        this.queueL[i] = this.oldL[i] * (1 - mix) + this.newL[i] * mix;
        this.queueR[i] = this.oldR[i] * (1 - mix) + this.newR[i] * mix;
        this.gainsAt(i, this.current, this.target, mix);
      }
      this.fade += this.blockSize;
      if (this.fade >= this.fadeLength) {
        this.current = this.target;
        this.target = null;
      }
    } else {
      this.queueL.set(this.oldL);
      this.queueR.set(this.oldR);
      for (let i = 0; i < this.blockSize; i++) this.gainsAt(i, this.current, null, 0);
    }
    this.previous.set(this.input);
  }

  /**
   * Processes one render quantum (`input.length` samples, e.g. 128): copies already rendered output
   * (and late gains) out of the queue, collects the input, and triggers the next block when full.
   */
  process(input, left, right, gains, modal, modalActive) {
    if (input.length !== left.length || input.length !== right.length || this.blockSize % input.length)
      throw new Error('Render quantum does not divide the partition.');
    const quantum = input.length;
    const read = this.staggered ? this.outputPosition : this.offset;
    left.set(this.queueL.subarray(read, read + quantum));
    right.set(this.queueR.subarray(read, read + quantum));
    if (gains) gains.set(this.queueGains.subarray(read * 8, (read + quantum) * 8));
    if (modal) {
      modal.set(this.queueModal.subarray(read * this.modalSlots, (read + quantum) * this.modalSlots));
      modalActive.set(this.queueModalActive.subarray(read, read + quantum));
    }
    if (this.staggered) this.outputPosition = (this.outputPosition + quantum) % this.queueL.length;
    this.input.set(input, this.offset);
    this.offset += quantum;
    if (this.staggered && this.jobActive) this.jobStep(quantum);
    if (this.offset === this.blockSize) {
      this.computeBlock();
      this.offset = 0;
    }
  }

  telemetry() {
    return {
      latencySamples: this.blockSize * (this.staggered ? 2 : 1),
      retainedInputBlocks: Math.min(this.blocks, this.capacity),
      responseUpdates: this.responses,
    };
  }
}
