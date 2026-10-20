import { vec3, mat4 } from 'gl-matrix';

// Draws the sound source as a lit sphere (indexed UV sphere, one draw call) in the 3D view.
export class SphereRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private uniformBuffer: GPUBuffer;
  private uniformBindGroup: GPUBindGroup;
  private indexCount: number;

  constructor(device: GPUDevice) {
    this.device = device;

    // Create sphere mesh data
    const { vertices, indices } = this.createSphereData();
    this.indexCount = indices.length;

    // Create buffers
    this.vertexBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(this.vertexBuffer.getMappedRange()).set(vertices);
    this.vertexBuffer.unmap();

    this.indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint16Array(this.indexBuffer.getMappedRange()).set(indices);
    this.indexBuffer.unmap();

    // Create uniform buffer - Fix size to accommodate both matrices
    this.uniformBuffer = device.createBuffer({
      size: 128, // 2 mat4x4 (64 bytes each)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create pipeline and bind group
    this.pipeline = this.createPipeline();
    this.uniformBindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });
  }

  private createSphereData(
    radius: number = 1,
    segments: number = 16,
  ): { vertices: Float32Array; indices: Uint16Array } {
    const vertices: number[] = [];
    const indices: number[] = [];

    // Generate vertices
    for (let lat = 0; lat <= segments; lat++) {
      const theta = (lat * Math.PI) / segments;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      for (let lon = 0; lon <= segments; lon++) {
        const phi = (lon * 2 * Math.PI) / segments;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);

        const x = cosPhi * sinTheta;
        const y = cosTheta;
        const z = sinPhi * sinTheta;

        vertices.push(x * radius, y * radius, z * radius);
      }
    }

    // Generate indices
    for (let lat = 0; lat < segments; lat++) {
      for (let lon = 0; lon < segments; lon++) {
        const first = lat * (segments + 1) + lon;
        const second = first + segments + 1;

        indices.push(first, second, first + 1);
        indices.push(second, second + 1, first + 1);
      }
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint16Array(indices),
    };
  }

  private createPipeline(): GPURenderPipeline {
    const shader = this.device.createShaderModule({
      code: `
                struct Uniforms {
                    viewProjectionMatrix: mat4x4f,
                    modelMatrix: mat4x4f,
                };

                @group(0) @binding(0) var<uniform> uniforms: Uniforms;

                struct VertexOutput {
                    @builtin(position) position: vec4f,
                    @location(0) normal: vec3f,
                };

                @vertex
                fn vertexMain(@location(0) position: vec3f) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniforms.viewProjectionMatrix * uniforms.modelMatrix * vec4f(position, 1.0);
                    output.normal = position.xyz;  // For a unit sphere, position is the same as normal
                    return output;
                }

                @fragment
                fn fragmentMain(@location(0) normal: vec3f) -> @location(0) vec4f {
                    let N = normalize(normal);
                    let L = normalize(vec3f(1.0, 1.0, 1.0));
                    let diffuse = max(dot(N, L), 0.0);
                    return vec4f(vec3f(1.0, 1.0, 0.0) * (0.5 + 0.5 * diffuse), 1.0);
                }
            `,
    });

    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [
          this.device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
              },
            ],
          }),
        ],
      }),
      vertex: {
        module: shader,
        entryPoint: 'vertexMain',
        buffers: [
          {
            arrayStride: 12,
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: 'float32x3',
              },
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
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus',
      },
    });
  }

  public render(
    renderPass: GPURenderPassEncoder,
    viewProjectionMatrix: Float32Array,
    position: vec3,
    radius: number,
  ): void {
    // Create combined uniform data
    const uniformData = new Float32Array(32); // 2 mat4 = 32 floats

    // Copy view projection matrix to first half
    uniformData.set(viewProjectionMatrix, 0);

    // Create and copy model matrix to second half
    const modelMatrix = mat4.create();
    mat4.translate(modelMatrix, modelMatrix, position);
    mat4.scale(modelMatrix, modelMatrix, [radius, radius, radius]);
    uniformData.set(modelMatrix, 16); // Start at float 16 (64 bytes offset)

    // Write entire uniform buffer at once
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.uniformBindGroup);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.indexCount);
  }
  public dispose(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.uniformBuffer.destroy();
  }
}
