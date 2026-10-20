import { objectBounds, type SceneObject } from '../../geometry/acoustic-scene';
import { resolveObjectMaterialId } from '../../geometry/materials';

type Rgb = [number, number, number];

const MATERIAL_COLORS: Record<string, Rgb> = {
  'wood-panel-solid': [0.62, 0.38, 0.2],
  'painted-concrete-block': [0.42, 0.48, 0.58],
  'glass-window': [0.45, 0.75, 0.85],
  'heavy-velour-curtain': [0.68, 0.22, 0.3],
  'carpet-heavy-on-concrete': [0.35, 0.5, 0.32],
  'porous-absorber-100mm': [0.15, 0.62, 0.66],
};
const FALLBACK_COLOR: Rgb = [0.6, 0.6, 0.6];

// position (3) + normal (3) + colour (3)
const FLOATS_PER_VERTEX = 9;

export class SceneObjectRenderer {
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private uniformBindGroup: GPUBindGroup;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCount = 0;

  constructor(
    private device: GPUDevice,
    colorFormat: GPUTextureFormat,
  ) {
    this.uniformBuffer = device.createBuffer({
      size: 16 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = this.createPipeline(colorFormat);
    this.uniformBindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  // Replaces the drawn boxes. Pass an empty list to draw nothing.
  setObjects(objects: SceneObject[]): void {
    this.vertexBuffer?.destroy();
    this.vertexBuffer = null;
    this.vertexCount = 0;
    if (objects.length === 0) return;

    const vertices: number[] = [];
    for (const object of objects) {
      this.appendBox(
        vertices,
        object,
        MATERIAL_COLORS[resolveObjectMaterialId(object.material)] ?? FALLBACK_COLOR,
      );
    }

    const data = new Float32Array(vertices);
    this.vertexBuffer = this.device.createBuffer({
      label: 'Scene object vertices',
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(this.vertexBuffer.getMappedRange()).set(data);
    this.vertexBuffer.unmap();
    this.vertexCount = data.length / FLOATS_PER_VERTEX;
  }

  render(pass: GPURenderPassEncoder, viewProjection: Float32Array): void {
    if (!this.vertexBuffer || this.vertexCount === 0) return;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProjection as Float32Array<ArrayBuffer>);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.uniformBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount);
  }

  dispose(): void {
    this.vertexBuffer?.destroy();
    this.uniformBuffer.destroy();
  }

  // Adds 6 faces x 2 triangles, each vertex carrying its face's outward normal.
  private appendBox(vertices: number[], object: SceneObject, color: Rgb): void {
    const { min, max } = objectBounds(object);
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const faces: Array<{ normal: Rgb; corners: number[][] }> = [
      {
        normal: [-1, 0, 0],
        corners: [
          [x0, y0, z0],
          [x0, y0, z1],
          [x0, y1, z1],
          [x0, y1, z0],
        ],
      },
      {
        normal: [1, 0, 0],
        corners: [
          [x1, y0, z1],
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y1, z1],
        ],
      },
      {
        normal: [0, -1, 0],
        corners: [
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y0, z1],
          [x0, y0, z1],
        ],
      },
      {
        normal: [0, 1, 0],
        corners: [
          [x0, y1, z0],
          [x0, y1, z1],
          [x1, y1, z1],
          [x1, y1, z0],
        ],
      },
      {
        normal: [0, 0, -1],
        corners: [
          [x1, y0, z0],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y1, z0],
        ],
      },
      {
        normal: [0, 0, 1],
        corners: [
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1],
        ],
      },
    ];
    for (const face of faces) {
      const [a, b, c, d] = face.corners;
      for (const corner of [a, b, c, a, c, d]) {
        vertices.push(...corner, ...face.normal, ...color);
      }
    }
  }

  private createPipeline(colorFormat: GPUTextureFormat): GPURenderPipeline {
    const shader = this.device.createShaderModule({
      label: 'Scene object shader',
      code: /* wgsl */ `
        struct Uniforms { viewProjection: mat4x4f };
        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        struct VertexIn {
          @location(0) position: vec3f,
          @location(1) normal: vec3f,
          @location(2) color: vec3f,
        };
        struct VertexOut {
          @builtin(position) position: vec4f,
          @location(0) normal: vec3f,
          @location(1) color: vec3f,
        };

        @vertex
        fn vertexMain(input: VertexIn) -> VertexOut {
          var output: VertexOut;
          output.position = uniforms.viewProjection * vec4f(input.position, 1.0);
          output.normal = input.normal;
          output.color = input.color;
          return output;
        }

        @fragment
        fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
          // Two fixed lights plus ambient give each face a clearly different shade.
          let normal = normalize(input.normal);
          let keyLight = normalize(vec3f(0.4, 1.0, 0.35));
          let fillLight = normalize(vec3f(-0.7, 0.5, -0.2));
          let diffuse = max(dot(normal, keyLight), 0.0) * 0.45 + max(dot(normal, fillLight), 0.0) * 0.2;
          return vec4f(input.color * (0.45 + diffuse), 1.0);
        }
      `,
    });
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shader,
        entryPoint: 'vertexMain',
        buffers: [
          {
            arrayStride: FLOATS_PER_VERTEX * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format: colorFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });
  }
}
