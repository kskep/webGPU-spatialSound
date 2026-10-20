import type { ProbeSphere } from '../../probes/probe-view';

// Most probe spheres drawn in one frame (the probe set is limited to fewer, see src/config/probes.ts).
const MAX_SPHERES = 1024;
// Bytes per instance: centre and radius (4 floats), colour (4 floats).
const INSTANCE_BYTES = 32;

export class ProbeRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private instanceBuffer: GPUBuffer;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private indexCount: number;

  constructor(device: GPUDevice) {
    this.device = device;
    const { vertices, indices } = this.sphereData(10);
    this.indexCount = indices.length;
    this.vertexBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, vertices);
    this.indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);
    this.instanceBuffer = device.createBuffer({
      size: MAX_SPHERES * INSTANCE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.uniformBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({
      code: `
        struct Uniforms { viewProjection: mat4x4f };
        @group(0) @binding(0) var<uniform> uniforms: Uniforms;
        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) normal: vec3f,
          @location(1) color: vec3f,
        };
        @vertex
        fn vertexMain(
          @location(0) position: vec3f,
          @location(1) centerRadius: vec4f,
          @location(2) color: vec4f,
        ) -> VertexOutput {
          var output: VertexOutput;
          let world = centerRadius.xyz + position * centerRadius.w;
          output.position = uniforms.viewProjection * vec4f(world, 1.0);
          output.normal = position;
          output.color = color.rgb;
          return output;
        }
        @fragment
        fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
          let light = max(dot(normalize(input.normal), normalize(vec3f(1.0, 1.0, 1.0))), 0.0);
          return vec4f(input.color * (0.45 + 0.55 * light), 1.0);
        }
      `,
    });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module: shader,
        entryPoint: 'vertexMain',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          {
            arrayStride: INSTANCE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fragmentMain',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  // A unit UV sphere: positions only, `segments` bands of latitude and longitude.
  private sphereData(segments: number): { vertices: Float32Array; indices: Uint16Array } {
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let lat = 0; lat <= segments; lat++) {
      const theta = (lat * Math.PI) / segments;
      for (let lon = 0; lon <= segments; lon++) {
        const phi = (lon * 2 * Math.PI) / segments;
        vertices.push(Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
      }
    }
    for (let lat = 0; lat < segments; lat++)
      for (let lon = 0; lon < segments; lon++) {
        const first = lat * (segments + 1) + lon;
        const second = first + segments + 1;
        indices.push(first, second, first + 1, second, second + 1, first + 1);
      }
    return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
  }

  // Draws `spheres` (nothing for an empty list).
  render(pass: GPURenderPassEncoder, viewProjection: Float32Array, spheres: ProbeSphere[]): void {
    if (spheres.length === 0) return;
    const count = Math.min(spheres.length, MAX_SPHERES);
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      const sphere = spheres[i];
      data.set([...sphere.position, sphere.radius, ...sphere.color, 1], i * 8);
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProjection);
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setVertexBuffer(1, this.instanceBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.drawIndexed(this.indexCount, count);
  }

  dispose(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.instanceBuffer.destroy();
    this.uniformBuffer.destroy();
  }
}
