import code from './mesh-trace.wgsl?raw';
import {
  directionPan,
  earlyArrivals,
  effectiveMaterials,
  validateScene,
  type Arrival,
  type Bands,
  type Scene,
  type TraceResult,
  type Vec3,
} from '../acoustics/model.ts';
import { applyEarlyOcclusion } from '../acoustics/occlusion.ts';
import {
  extractSpecularEchoes,
  SpecularPathCollector,
  type SpecularRaysReport,
} from '../acoustics/specular-echoes.ts';
import type { SpecularRaySettings } from '../config/specular-rays.ts';
import { DECAY_FIT_DEFAULTS, lateDecayFromStatistics } from '../acoustics/decay-fit.ts';
import { PARAMS_UNIFORM_BYTES, writeDirectivityUniform } from './directivity-uniform.ts';
import {
  histogramBinCount,
  type ResolvedTermination,
  type TerminationReport,
} from '../config/ray-termination.ts';
import type { BVH } from '../geometry/bvh.ts';
import type { PreparedScene } from './prepared-scene.ts';
import type { TraceCallTimings } from '../app/stage-timings.ts';

// floats per ray segment: arrival, 8 bands, -direction(3), end point(3)
const FLOATS_PER_SEGMENT = 15;
const BYTES_PER_SEGMENT = FLOATS_PER_SEGMENT * 4;
// ray paths kept for 3D visualisation
const VISUALISED_PATHS = 48;

// mesh tracer uniform block: common (80 floats) + ray termination fields
const TERMINATION_FLOAT_OFFSET = PARAMS_UNIFORM_BYTES / 4;
const MESH_UNIFORM_BYTES = (TERMINATION_FLOAT_OFFSET + 8) * 4;
// uniform word that enables specular path tagging
const TAG_WORD = TERMINATION_FLOAT_OFFSET + 6;
// bytes of tags per segment: path hash + surface word
const BYTES_PER_TAG = 8;

// late buffer layout: counter words and words per histogram bin
const COUNTER_WORDS = 8;
const BIN_WORDS = 17;
// one unit of the 64-bit fixed-point energy sums: 2^-52
const HISTOGRAM_UNIT = 2 ** -52;

// scratch buffer for reflection surface ids, reused per hit
const reflectionScratch = new Uint32Array(4096);

// feeds a specular receiver hit to the collector if the ray only reflected specularly
function collectSpecularHit(
  collector: SpecularPathCollector,
  tags: Uint32Array,
  rayBase: number,
  bounce: number,
  hit: Arrival,
): void {
  const word = (rayBase + bounce) * 2;
  if ((tags[word + 1] & 1) === 0) return;
  for (let k = 0; k < bounce; k++) reflectionScratch[k] = tags[(rayBase + k) * 2 + 1] >>> 1;
  collector.add(bounce, tags[word], reflectionScratch, hit);
}

export type MeshTraceResult = TraceResult & {
  bvh: BVH['stats'];
  occludedEarly: number;
  diffractedEarly: number;
  traceTimings: TraceCallTimings;
  termination?: TerminationReport;
};

// options for MeshTracer.trace
export interface MeshTraceOptions {
  // whether to compute image-source early arrivals inside the call (default true)
  includeEarlyPart?: boolean;
  // energy-based ray termination (omit for legacy fixed-bounce rule)
  termination?: ResolvedTermination;
  // discrete echoes from specular ray paths
  specularRays?: SpecularRaySettings;
}

// GPU ray tracer over the acoustic triangle mesh (BVH traversal).
// Early sound from image-source method; stochastic rays provide scattered and late paths.
// The prepared scene (mesh, BVH, GPU buffers) is built once per geometry revision.
export class MeshTracer {
  private constructor(
    readonly device: GPUDevice,
    private pipeline: GPUComputePipeline,
  ) {}

  // creates the tracer; pass sharedDevice to avoid opening a second GPU connection
  static async create(onLost: (message: string) => void, sharedDevice?: GPUDevice): Promise<MeshTracer> {
    let device = sharedDevice;
    if (!device) {
      if (!navigator.gpu) {
        throw new Error('WebGPU is unavailable. Open localhost in a WebGPU-capable Chrome or Edge browser.');
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter is available.');

      device = await adapter.requestDevice();
      device.lost.then((info) => onLost('GPU connection lost: ' + (info.message || info.reason)));
      device.addEventListener('uncapturederror', (event) => onLost(event.error.message));
    }

    // Surface WGSL compile errors with line numbers instead of a silent pipeline failure.
    const module = device.createShaderModule({ label: 'Mesh BVH acoustic tracer', code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length > 0) {
      throw new Error(errors.map((m) => 'WGSL line ' + m.lineNum + ': ' + m.message).join('\n'));
    }

    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    return new MeshTracer(device, pipeline);
  }

  // traces scene over the prepared geometry; poses, seed, rays, bounces travel in the uniform buffer
  async trace(
    scene: Scene,
    prepared: PreparedScene,
    options: MeshTraceOptions = {},
  ): Promise<MeshTraceResult> {
    validateScene(scene);
    // The scene buffers are shared between traces; keep them alive until this trace has finished.
    prepared.beginUse();
    try {
      return await this.traceOverScene(
        scene,
        prepared,
        options.includeEarlyPart ?? true,
        options.termination,
        options.specularRays?.enabled ? options.specularRays : undefined,
      );
    } finally {
      prepared.endUse();
    }
  }

  private async traceOverScene(
    scene: Scene,
    prepared: PreparedScene,
    includeEarlyPart: boolean,
    termination?: ResolvedTermination,
    specularRays?: SpecularRaySettings,
  ): Promise<MeshTraceResult> {
    const started = performance.now();
    const timings: TraceCallTimings = {
      earlyMs: 0,
      gpuDispatchMs: 0,
      gpuReadbackMs: 0,
      gpuDecodeMs: 0,
      decayFitMs: 0,
    };
    // Detailed records per ray: all segments in the legacy rule, the first ones in energy mode.
    const segmentsPerRay = (termination ? termination.detailedBounces : scene.bounces) + 1;
    const histogramBins = termination ? histogramBinCount(termination) : 0;

    const sceneBuffers = prepared.gpuBuffers(this.device);
    const bvh = prepared.bvh;

    // Batches bound storage memory even at maximum ray/reflection settings.
    const maxBatchByMemory = Math.floor(
      this.device.limits.maxStorageBufferBindingSize / (segmentsPerRay * BYTES_PER_SEGMENT),
    );
    // EDW PERIORIZOUME TA RAYS ANA BATCH GIA NA XWRANE TA RECORDS STA GPU BUFFER LIMITS.
    const batchSize = Math.min(8192, scene.rays, maxBatchByMemory);
    const outputBytes = batchSize * segmentsPerRay * BYTES_PER_SEGMENT;
    // Specular path tags : 8 bytes per segment when on, a 16-byte dummy binding otherwise.
    const tagBytes = specularRays ? batchSize * segmentsPerRay * BYTES_PER_TAG : 16;
    const collector = specularRays ? new SpecularPathCollector() : undefined;

    // Early part: exact image-source arrivals, with objects occluding/diffracting them.
    let stageStarted = performance.now();
    const early = includeEarlyPart
      ? applyEarlyOcclusion(scene, earlyArrivals(scene), bvh, prepared.objects)
      : { arrivals: [], occluded: 0, diffracted: 0 };
    timings.earlyMs = performance.now() - stageStarted;
    const arrivals: Arrival[] = [...early.arrivals];
    const analyticalCount = arrivals.length;
    const paths: number[][] = [];

    const shellMaterials = effectiveMaterials(scene);
    const uniformBuffer = this.device.createBuffer({
      size: MESH_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Counters and late histogram (energy mode); a 16-byte dummy otherwise, because the binding exists in
    // the shader. Buffers start zeroed, which is the empty histogram.
    const lateBytes = termination ? (COUNTER_WORDS + histogramBins * BIN_WORDS) * 4 : 16;
    const lateBuffer = this.device.createBuffer({
      size: lateBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const lateReadback = this.device.createBuffer({
      size: lateBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const outputBuffer = this.device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readbackBuffer = this.device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const tagBuffer = this.device.createBuffer({
      size: tagBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const tagReadback = this.device.createBuffer({
      size: tagBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    try {
      const bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: outputBuffer } },
          { binding: 2, resource: { buffer: sceneBuffers.nodes } },
          { binding: 3, resource: { buffer: sceneBuffers.triangles } },
          { binding: 4, resource: { buffer: sceneBuffers.materials } },
          { binding: 5, resource: { buffer: lateBuffer } },
          { binding: 6, resource: { buffer: tagBuffer } },
        ],
      });

      for (let rayOffset = 0; rayOffset < scene.rays; rayOffset += batchSize) {
        const raysInBatch = Math.min(batchSize, scene.rays - rayOffset);

        // Dispatch: write the uniforms, encode and submit, and wait until the GPU has finished.
        stageStarted = performance.now();
        // Uniform block: same layout as trace.wgsl.
        const uniformData = new ArrayBuffer(MESH_UNIFORM_BYTES);
        const floats = new Float32Array(uniformData);
        const uints = new Uint32Array(uniformData);
        floats.set([
          ...scene.dimensions,
          0,
          ...scene.source,
          0,
          ...scene.listener,
          scene.receiverRadius,
          scene.scattering,
          scene.earlyOrder,
          scene.speed,
          scene.rays,
        ]);
        uints.set([raysInBatch, segmentsPerRay, scene.seed, rayOffset], 16);
        floats.set(
          [
            ...shellMaterials.walls,
            ...shellMaterials.floor,
            ...shellMaterials.ceiling,
            ...scene.airDbPerMeter,
          ],
          20,
        );
        writeDirectivityUniform(floats, scene);
        if (termination) {
          // Energy cutoff as a linear factor; path limit in metres; histogram bins per metre of path.
          floats.set(
            [
              Math.pow(10, termination.energyCutoffDb / 10),
              termination.maxPathSeconds * scene.speed,
              1 / (termination.histogramBinSeconds * scene.speed),
              0,
            ],
            TERMINATION_FLOAT_OFFSET,
          );
          uints.set([1, termination.maxBounces + 1, 0, histogramBins], TERMINATION_FLOAT_OFFSET + 4);
        }
        if (specularRays) uints[TAG_WORD] = 1;
        this.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(raysInBatch / 64));
        pass.end();
        encoder.copyBufferToBuffer(
          outputBuffer,
          0,
          readbackBuffer,
          0,
          raysInBatch * segmentsPerRay * BYTES_PER_SEGMENT,
        );
        if (specularRays) {
          encoder.copyBufferToBuffer(
            tagBuffer,
            0,
            tagReadback,
            0,
            raysInBatch * segmentsPerRay * BYTES_PER_TAG,
          );
        }
        // The late buffer is final after the last batch: copy it in the same submission.
        if (termination && rayOffset + raysInBatch >= scene.rays) {
          encoder.copyBufferToBuffer(lateBuffer, 0, lateReadback, 0, lateBytes);
        }
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        timings.gpuDispatchMs += performance.now() - stageStarted;

        // Readback: wait until the finished results can be read by the CPU.
        stageStarted = performance.now();
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        if (specularRays) await tagReadback.mapAsync(GPUMapMode.READ);
        timings.gpuReadbackMs += performance.now() - stageStarted;

        // Decode: turn the 15-float segment records into arrivals.
        stageStarted = performance.now();
        const result = new Float32Array(readbackBuffer.getMappedRange());
        const tags = specularRays ? new Uint32Array(tagReadback.getMappedRange()) : undefined;
        for (let ray = 0; ray < raysInBatch; ray++) {
          const keepPath = rayOffset + ray < VISUALISED_PATHS;
          const path: number[] = [...scene.source];
          for (let bounce = 0; bounce < segmentsPerRay; bounce++) {
            const record = (ray * segmentsPerRay + bounce) * FLOATS_PER_SEGMENT;
            const arrivalDistance = result[record];
            if (arrivalDistance > 0) {
              const bands = Array.from(result.subarray(record + 1, record + 9)) as Bands;
              const energy = bands.reduce((sum, value) => sum + value, 0) / 8;
              if (energy > 0) {
                const direction = Array.from(result.subarray(record + 9, record + 12)) as Vec3;
                const hit: Arrival = {
                  distance: arrivalDistance,
                  time: arrivalDistance / scene.speed,
                  energy,
                  energyBands: bands,
                  order: bounce,
                  direction,
                  pan: directionPan(direction, scene.listenerForward),
                  kind: 'stochastic',
                };
                arrivals.push(hit);
                if (collector && tags) collectSpecularHit(collector, tags, ray * segmentsPerRay, bounce, hit);
              }
            }
            if (keepPath) path.push(result[record + 12], result[record + 13], result[record + 14]);
          }
          if (keepPath) paths.push(path);
        }
        readbackBuffer.unmap();
        if (specularRays) tagReadback.unmap();
        timings.gpuDecodeMs += performance.now() - stageStarted;
      }

      // Energy mode: read the late histogram and counters back once (copied with the last batch).
      let report: TerminationReport | undefined;
      if (termination) {
        stageStarted = performance.now();
        await lateReadback.mapAsync(GPUMapMode.READ);
        timings.gpuReadbackMs += performance.now() - stageStarted;
        stageStarted = performance.now();
        const words = new Uint32Array(lateReadback.getMappedRange());
        report = this.decodeLateHistogram(words, scene, prepared, termination, outputBytes, arrivals);
        lateReadback.unmap();
        timings.gpuDecodeMs += performance.now() - stageStarted;
      }
      // Everything that crossed from the GPU to the CPU: all detailed records plus the late buffer and the path tags.
      const readbackBytes =
        scene.rays * segmentsPerRay * (BYTES_PER_SEGMENT + (specularRays ? BYTES_PER_TAG : 0)) +
        (termination ? lateBytes : 0);
      timings.readbackBytes = readbackBytes;
      if (report) report.readbackBytes = readbackBytes;

      // Late decay measured from the rays just traced (RT60 per band, with an Eyring fallback). In energy
      // mode the traced energy is complete up to the report's coverage instead of 0.7 x bounces x mean free time.
      stageStarted = performance.now();
      const lateDecay = lateDecayFromStatistics(
        scene,
        prepared.statistics,
        arrivals,
        report ? { completeUntilSeconds: report.completeUntilSeconds } : {},
      );
      timings.decayFitMs = performance.now() - stageStarted;

      // specular echoes: done after the decay fit so the fit sees the full stochastic pool
      let finalArrivals = arrivals;
      let specularReport: SpecularRaysReport | undefined;
      if (specularRays && collector) {
        stageStarted = performance.now();
        const extraction = extractSpecularEchoes(scene, prepared.mesh, bvh, specularRays, collector);
        finalArrivals = [
          ...arrivals.slice(0, analyticalCount),
          ...extraction.echoes,
          ...arrivals.slice(analyticalCount).filter((arrival) => !extraction.removed.has(arrival)),
          ...extraction.residual,
        ];
        specularReport = extraction.report;
        timings.specularMs = performance.now() - stageStarted;
      }

      return {
        arrivals: finalArrivals,
        analyticalCount,
        paths,
        lateDecay,
        elapsedMs: performance.now() - started,
        bvh: bvh.stats,
        occludedEarly: early.occluded,
        diffractedEarly: early.diffracted,
        traceTimings: timings,
        ...(report ? { termination: report } : {}),
        ...(specularReport ? { specularRays: specularReport } : {}),
      };
    } finally {
      uniformBuffer.destroy();
      outputBuffer.destroy();
      readbackBuffer.destroy();
      lateBuffer.destroy();
      lateReadback.destroy();
      tagBuffer.destroy();
      tagReadback.destroy();
    }
  }

  // decodes the late histogram into binned stochastic arrivals (one per non-empty bin)
  private decodeLateHistogram(
    words: Uint32Array,
    scene: Scene,
    prepared: PreparedScene,
    termination: ResolvedTermination,
    detailedBufferBytes: number,
    arrivals: Arrival[],
  ): TerminationReport {
    const bins = histogramBinCount(termination);
    let histogramHits = 0;
    for (let bin = 0; bin < bins; bin++) {
      const word = COUNTER_WORDS + bin * BIN_WORDS;
      const hitCount = words[word + 16];
      if (hitCount === 0) continue;
      const bands = Array.from({ length: 8 }, (_, band) => {
        const low = words[word + 2 * band];
        const high = words[word + 2 * band + 1];
        return (high * 4294967296 + low) * HISTOGRAM_UNIT;
      }) as Bands;
      const energy = bands.reduce((sum, value) => sum + value, 0) / 8;
      if (!(energy > 0)) continue;
      histogramHits += hitCount;
      const time = (bin + 0.5) * termination.histogramBinSeconds;
      arrivals.push({
        distance: time * scene.speed,
        time,
        energy,
        energyBands: bands,
        order: termination.detailedBounces + 1,
        direction: [0, 0, 0],
        pan: 0,
        kind: 'stochastic',
        binned: true,
        hitCount,
      });
    }
    // Complete up to the path limit; sooner when the bounce cap would stop typical rays first.
    const meanFreeTime = prepared.statistics.meanFreePath / scene.speed;
    const capSeconds = DECAY_FIT_DEFAULTS.truncationFactor * termination.maxBounces * meanFreeTime;
    return {
      resolved: termination,
      completeUntilSeconds: Math.min(termination.maxPathSeconds, capSeconds),
      stoppedBy: { energy: words[1], time: words[2], bounces: words[3], lost: words[4] },
      segmentsTraced: words[5],
      longestRaySegments: words[6],
      histogramBins: bins,
      histogramHits,
      histogramOverflows: words[0],
      detailedBufferBytes,
      histogramBufferBytes: words.byteLength,
      readbackBytes: 0,
    };
  }
}
