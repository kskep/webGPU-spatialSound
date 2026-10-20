import { vec3 } from 'gl-matrix';

// One ray segment for the debug view: world-space endpoints and the energy that colours it.
export interface DebugRaySegment {
  start: vec3;
  end: vec3;
  energy: number;
}

// Draws traced ray segments as lines coloured by energy (at most MAX_RENDER_RAYS per frame).
export class RayRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private vertexBuffer: GPUBuffer;
  private uniformBuffer: GPUBuffer;
  private uniformBindGroup: GPUBindGroup;
  // Render budget for debug rays to keep frame time stable.
  private readonly MAX_RENDER_RAYS = 2500;

  constructor(device: GPUDevice) {
    this.device = device;

    // Create pipeline with shader that renders rays with color based on energy
    const shader = this.device.createShaderModule({
      code: `
                struct Uniforms {
                    viewProjection: mat4x4f,
                };

                struct VertexInput {
                    @location(0) position: vec3f,
                    @location(1) energy: f32,
                };

                struct VertexOutput {
                    @builtin(position) position: vec4f,
                    @location(0) energy: f32,
                };

                @group(0) @binding(0) var<uniform> uniforms: Uniforms;

                @vertex
                fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniforms.viewProjection * vec4f(input.position, 1.0);
                    output.energy = input.energy;
                    return output;
                }

                @fragment
                fn fragmentMain(@location(0) energy: f32) -> @location(0) vec4f {
                    // Make rays invisible below threshold
                    if (energy < 0.05) {
                        return vec4f(0.0);
                    }
                    // Make rays more visible with higher alpha
                    let alpha = mix(0.3, 1.0, energy);
                    return vec4f(1.0, energy, 0.0, alpha);
                }
            `,
    });

    // Create pipeline
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = device.createRenderPipeline({
      vertex: {
        module: shader,
        entryPoint: 'vertexMain',
        buffers: [
          {
            arrayStride: 16, // vec3f position + f32 energy
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32' },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: navigator.gpu.getPreferredCanvasFormat(),
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'line-list',
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus',
      },
      layout: pipelineLayout,
    });

    // Create uniform buffer
    this.uniformBuffer = device.createBuffer({
      size: 64, // mat4x4
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    this.uniformBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });

    // Create empty vertex buffer (will be updated with ray data)
    this.vertexBuffer = device.createBuffer({
      size: 1024, // Initial size, will be recreated as needed
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  public render(pass: GPURenderPassEncoder, viewProjection: Float32Array, segments: DebugRaySegment[]): void {
    if (segments.length === 0) return;

    // Update uniform buffer with view projection matrix
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProjection);

    // Deterministically decimate debug segment list for rendering only.
    // This keeps acoustic calculations intact while reducing GPU upload + draw cost.
    const step = Math.max(1, Math.ceil(segments.length / this.MAX_RENDER_RAYS));
    const renderSegmentCount = Math.ceil(segments.length / step);

    // Create vertex data for sampled segments.
    const vertices = new Float32Array(renderSegmentCount * 8); // 2 points per segment, 4 floats per point
    let vertexOffset = 0;

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += step) {
      const segment = segments[segmentIndex];
      vertices[vertexOffset++] = segment.start[0];
      vertices[vertexOffset++] = segment.start[1];
      vertices[vertexOffset++] = segment.start[2];
      vertices[vertexOffset++] = segment.energy;
      vertices[vertexOffset++] = segment.end[0];
      vertices[vertexOffset++] = segment.end[1];
      vertices[vertexOffset++] = segment.end[2];
      vertices[vertexOffset++] = segment.energy * 0.2;
    }

    // Recreate vertex buffer if needed
    if (this.vertexBuffer.size < vertices.byteLength) {
      this.vertexBuffer.destroy();
      this.vertexBuffer = this.device.createBuffer({
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    // Update vertex buffer
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

    // Draw rays
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.uniformBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(renderSegmentCount * 2, 1, 0, 0); // 2 vertices per sampled segment
  }
  public dispose(): void {
    this.vertexBuffer.destroy();
    this.uniformBuffer.destroy();
  }
}
