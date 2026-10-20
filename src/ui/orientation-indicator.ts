import { vec3 } from 'gl-matrix';
import { ORIENTATION_ARROW_STYLE } from '../config/directivity';

// Floats per vertex: position (3) + surface normal (3).
const FLOATS_PER_VERTEX = 6;

// Direction the light comes from (world space). Only used to shade the arrow so its shape reads.
const LIGHT_DIRECTION = vec3.normalize(vec3.create(), vec3.fromValues(0.4, 0.8, 0.5));

// Brightness of a face turned away from the light, so no face goes completely dark.
const AMBIENT_LIGHT = 0.45;

export class OrientationIndicator {
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private vertexBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private vertexCount: number;

  constructor(private device: GPUDevice) {
    const shader = device.createShaderModule({
      code: `
        struct Uniforms {
          viewProjection: mat4x4f,
          colour: vec4f,
          lightDirection: vec4f,   // xyz = direction towards the light, w = ambient brightness
        }
        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) normal: vec3f,
        }

        @vertex
        fn vertexMain(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOutput {
          var output: VertexOutput;
          output.position = uniforms.viewProjection * vec4f(position, 1.0);
          output.normal = normal;
          return output;
        }

        @fragment
        fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
          // Two-sided diffuse shading: the faces look the same from inside and outside.
          let facing = abs(dot(normalize(input.normal), uniforms.lightDirection.xyz));
          let brightness = uniforms.lightDirection.w + (1.0 - uniforms.lightDirection.w) * facing;
          return vec4f(uniforms.colour.rgb * brightness, 1.0);
        }
      `,
    });
    this.pipeline = device.createRenderPipeline({
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
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fragmentMain',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
    });

    const sides = ORIENTATION_ARROW_STYLE.sides;
    // Shaft: 2 triangles per side. Cone: 1 triangle per side for the surface and 1 for the base disc.
    this.vertexCount = (2 * sides + sides + sides) * 3;
    this.vertexBuffer = device.createBuffer({
      size: this.vertexCount * FLOATS_PER_VERTEX * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // 16 floats for the matrix + 4 for the colour + 4 for the light.
    this.uniformBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    device.queue.writeBuffer(
      this.uniformBuffer,
      64,
      new Float32Array([...ORIENTATION_ARROW_STYLE.colour, 1]),
    );
    device.queue.writeBuffer(this.uniformBuffer, 80, new Float32Array([...LIGHT_DIRECTION, AMBIENT_LIGHT]));
  }

  // Records the draw call. `forward` need not be normalised.
  render(
    pass: GPURenderPassEncoder,
    viewProjection: Float32Array,
    source: vec3,
    forward: [number, number, number],
    length: number,
  ): void {
    const vertices = buildArrowMesh(source, forward, length);
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProjection);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount);
  }

  dispose(): void {
    this.uniformBuffer.destroy();
    this.vertexBuffer.destroy();
  }
}

// Appends one triangle (three positions and one flat normal) to `out`.
function pushTriangle(out: number[], a: vec3, b: vec3, c: vec3): void {
  const normal = vec3.cross(
    vec3.create(),
    vec3.subtract(vec3.create(), b, a),
    vec3.subtract(vec3.create(), c, a),
  );
  vec3.normalize(normal, normal);
  for (const point of [a, b, c]) out.push(point[0], point[1], point[2], normal[0], normal[1], normal[2]);
}

function buildArrowMesh(source: vec3, forward: [number, number, number], length: number): Float32Array {
  const { sides, shaftRadius, headRadius, headLengthFraction } = ORIENTATION_ARROW_STYLE;

  const axis = vec3.normalize(vec3.create(), vec3.fromValues(...forward));
  const helper = Math.abs(axis[1]) < 0.9 ? vec3.fromValues(0, 1, 0) : vec3.fromValues(1, 0, 0);
  const sideA = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axis, helper));
  const sideB = vec3.cross(vec3.create(), axis, sideA);

  const tip = vec3.scaleAndAdd(vec3.create(), source, axis, length);
  const headBase = vec3.scaleAndAdd(vec3.create(), source, axis, length * (1 - headLengthFraction));

  // A point on the circle of `radius` around the axis at `center`, at angle index `step`.
  const ringPoint = (center: vec3, radius: number, step: number): vec3 => {
    const angle = (2 * Math.PI * step) / sides;
    const point = vec3.scaleAndAdd(vec3.create(), center, sideA, Math.cos(angle) * radius);
    return vec3.scaleAndAdd(point, point, sideB, Math.sin(angle) * radius);
  };

  const out: number[] = [];
  for (let step = 0; step < sides; step++) {
    const next = step + 1;

    // Shaft: a quad (two triangles) between the circle at the source and the circle at the cone base.
    const shaftStartA = ringPoint(source, shaftRadius, step);
    const shaftStartB = ringPoint(source, shaftRadius, next);
    const shaftEndA = ringPoint(headBase, shaftRadius, step);
    const shaftEndB = ringPoint(headBase, shaftRadius, next);
    pushTriangle(out, shaftStartA, shaftStartB, shaftEndA);
    pushTriangle(out, shaftStartB, shaftEndB, shaftEndA);

    // Cone surface: from the base circle to the tip.
    const baseA = ringPoint(headBase, headRadius, step);
    const baseB = ringPoint(headBase, headRadius, next);
    pushTriangle(out, baseA, baseB, tip);

    // Cone base disc, so the step from the shaft to the wider head is closed.
    pushTriangle(out, headBase, baseB, baseA);
  }
  return new Float32Array(out);
}
