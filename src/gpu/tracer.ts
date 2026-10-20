import code from './trace.wgsl?raw';
import {
  bandMeanScattering,
  SHELL_SCATTERING_FLOAT_OFFSET,
  SHOEBOX_UNIFORM_BYTES,
  writeDirectivityUniform,
} from './directivity-uniform';
import {
  earlyArrivals,
  effectiveMaterials,
  effectiveScattering,
  directionPan,
  validateScene,
  type Bands,
  type Vec3,
  type Scene,
  type TraceResult,
} from '../acoustics/model';
// GPU ray tracer for the shoebox room
// dispatches rays on the GPU and reads back the results
export class AcousticTracer {
  private constructor(
    readonly device: GPUDevice,
    private pipeline: GPUComputePipeline,
  ) {}
  static async create(onLost: (message: string) => void): Promise<AcousticTracer> {
    if (!navigator.gpu)
      throw new Error('WebGPU is unavailable. Open localhost in a WebGPU-capable Chrome or Edge browser.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    device.lost.then((info) => onLost('GPU connection lost: ' + (info.message || info.reason)));
    device.addEventListener('uncapturederror', (event) => onLost(event.error.message));
    const module = device.createShaderModule({ label: 'Eight-band acoustic tracer', code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length)
      throw new Error(errors.map((m) => 'WGSL line ' + m.lineNum + ': ' + m.message).join('\n'));
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    return new AcousticTracer(device, pipeline);
  }
  // run the trace - dispatches rays in batches to stay within buffer limits
  async trace(scene: Scene): Promise<TraceResult> {
    validateScene(scene);
    const started = performance.now();
    const segments = scene.bounces + 1;
    // batch size to fit in GPU buffer limits
    const batchSize = Math.min(
      8192,
      scene.rays,
      Math.floor(this.device.limits.maxStorageBufferBindingSize / (segments * 60)),
    );
    const bytes = batchSize * segments * 60;
    const materials = effectiveMaterials(scene);
    const scattering = effectiveScattering(scene);
    const uniform = this.device.createBuffer({
      size: SHOEBOX_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const output = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const arrivals = earlyArrivals(scene);
    const analyticalCount = arrivals.length;
    const paths: number[][] = [];
    try {
      const group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: output } },
        ],
      });
      for (let offset = 0; offset < scene.rays; offset += batchSize) {
        const count = Math.min(batchSize, scene.rays - offset);
        const data = new ArrayBuffer(SHOEBOX_UNIFORM_BYTES);
        const floats = new Float32Array(data);
        const uints = new Uint32Array(data);
        // fill uniform buffer
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
        uints.set([count, segments, scene.seed, offset], 16);
        floats.set(
          [...materials.walls, ...materials.floor, ...materials.ceiling, ...scene.airDbPerMeter],
          20,
        );
        writeDirectivityUniform(floats, scene);
        floats.set(
          [...scattering.walls, ...scattering.floor, ...scattering.ceiling],
          SHELL_SCATTERING_FLOAT_OFFSET,
        );
        floats.set(
          [
            bandMeanScattering(scattering.walls),
            bandMeanScattering(scattering.floor),
            bandMeanScattering(scattering.ceiling),
          ],
          SHELL_SCATTERING_FLOAT_OFFSET + 24,
        );
        this.device.queue.writeBuffer(uniform, 0, data);
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, count * segments * 60);
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(readback.getMappedRange());
        for (let ray = 0; ray < count; ray++) {
          const path = [...scene.source];
          for (let bounce = 0; bounce < segments; bounce++) {
            const record = (ray * segments + bounce) * 15;
            if (result[record] > 0) {
              const bands = Array.from(result.subarray(record + 1, record + 9)) as Bands;
              const energy = bands.reduce((sum, band) => sum + band, 0) / 8;
              if (energy > 0) {
                const direction = Array.from(result.subarray(record + 9, record + 12)) as Vec3;
                arrivals.push({
                  distance: result[record],
                  time: result[record] / scene.speed,
                  energy,
                  energyBands: bands,
                  order: bounce,
                  direction,
                  pan: directionPan(direction, scene.listenerForward),
                  kind: 'stochastic',
                });
              }
            }
            if (offset + ray < 48) path.push(result[record + 12], result[record + 13], result[record + 14]);
          }
          if (offset + ray < 48) paths.push(path);
        }
        readback.unmap();
      }
      return { arrivals, analyticalCount, paths, elapsedMs: performance.now() - started };
    } finally {
      uniform.destroy();
      output.destroy();
      readback.destroy();
    }
  }
}
