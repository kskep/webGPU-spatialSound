import { mat4, vec3, vec4 } from 'gl-matrix';
import { Camera } from '../reference/camera/camera';
import { Room, DEFAULT_WALL_MATERIAL } from '../reference/room/room';
import { SphereRenderer } from '../reference/objects/sphere-renderer';
import { SceneObjectRenderer } from '../reference/objects/scene-object-renderer';
import { ProbeRenderer } from '../reference/objects/probe-renderer';
import { pickProbe, type ProbeView } from '../probes/probe-view';
import type { SceneObject } from '../geometry/acoustic-scene';
import { RayRenderer, type DebugRaySegment } from '../reference/raytracer/ray-renderer';
import type { Scene, TraceResult, Vec3 } from '../acoustics/model';
import { OrientationIndicator } from './orientation-indicator';
import { getDirectivityPattern, ORIENTATION_ARROW_LENGTH } from '../config/directivity';

const NO_OBJECTS: SceneObject[] = [];

// What the viewport tells the probe editor about the user's actions.
export interface ProbeViewportHooks {
  // The P key: add a probe at the camera.
  addProbeAtCamera(): void;
  // A click on a probe sphere (its id), or on empty space (undefined).
  pickProbe(id: string | undefined): void;
}

// A click that moves the pointer less than this many pixels is a click, not a look-around drag.
const CLICK_TOLERANCE_PIXELS = 4;

// Distance in metres the keyboard movement keeps from the walls, floor and ceiling (see Room3D.tick).
const CAMERA_WALL_MARGIN = 0.5;

// Original spatialAudio geometry, shaders and first-person listener camera.
export class Room3D {
  private context: GPUCanvasContext;
  private room?: Room;
  private sphere: SphereRenderer;
  private rays: RayRenderer;
  private orientation: OrientationIndicator;
  private objectRenderer: SceneObjectRenderer;
  private probeRenderer: ProbeRenderer;
  // Draws the lines from the listener to the probes in use (a second ray renderer: each has its own buffer).
  private blendLines: RayRenderer;
  private probeView: ProbeView = { spheres: [], lines: [] };
  private drawnObjects: SceneObject[] = [];
  private camera = new Camera(vec3.fromValues(0, 1.7, 2), -90, 0);
  private depth?: GPUTexture;
  private scene?: Scene;
  private segments: DebugRaySegment[] = [];
  private showRays = true;
  private keys = new Set<string>();
  private frame = 0;
  private lastTime = 0;
  private off: (() => void)[] = [];
  constructor(
    private canvas: HTMLCanvasElement,
    private device: GPUDevice,
    private onPose: (position: Vec3, forward: Vec3) => void,
    // The default listener position of the current room preset, if there is one (see resetCamera).
    private defaultListener: () => Vec3 | undefined = () => undefined,
    private probeHooks?: ProbeViewportHooks,
  ) {
    this.context = canvas.getContext('webgpu')!;
    this.context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
    });
    this.sphere = new SphereRenderer(device);
    this.objectRenderer = new SceneObjectRenderer(device, navigator.gpu.getPreferredCanvasFormat());
    this.rays = new RayRenderer(device);
    this.probeRenderer = new ProbeRenderer(device);
    this.blendLines = new RayRenderer(device);
    this.orientation = new OrientationIndicator(device);
    this.bind();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }
  update(scene: Scene, result?: TraceResult, showRays = true, objects: SceneObject[] = NO_OBJECTS): void {
    // Re-upload the box geometry only when the object list actually changed.
    if (objects !== this.drawnObjects) {
      this.drawnObjects = objects;
      this.objectRenderer.setObjects(objects);
    }
    const resized = !this.scene || scene.dimensions.some((v, i) => v !== this.scene!.dimensions[i]);
    this.scene = structuredClone(scene);
    this.showRays = showRays;
    const dimensions = {
      width: scene.dimensions[0],
      height: scene.dimensions[1],
      depth: scene.dimensions[2],
    };
    if (!this.room)
      this.room = new Room(this.device, {
        dimensions,
        materials: {
          walls: { ...DEFAULT_WALL_MATERIAL },
          floor: { ...DEFAULT_WALL_MATERIAL },
          ceiling: { ...DEFAULT_WALL_MATERIAL },
        },
      });
    else if (resized) this.room.updateDimensions(dimensions);
    this.camera.setPosition(vec3.fromValues(...scene.listener));
    this.segments = [];
    if (result)
      for (const path of result.paths.slice(0, 24))
        for (let i = 3; i < Math.min(path.length, 27); i += 3)
          this.segments.push({
            start: vec3.fromValues(path[i - 3], path[i - 2], path[i - 1]),
            end: vec3.fromValues(path[i], path[i + 1], path[i + 2]),
            energy: Math.pow(1 - scene.absorption, i / 3 - 1),
          });
  }
  // Sets what is drawn for the probes: spheres and the lines to the probes in use.
  setProbeView(view: ProbeView): void {
    this.probeView = view;
  }

  resetCamera(): void {
    if (!this.scene) return;
    const [width, height, depth] = this.scene.dimensions;
    const preset = this.defaultListener();
    const fits =
      preset !== undefined &&
      Math.abs(preset[0]) <= width / 2 - CAMERA_WALL_MARGIN &&
      Math.abs(preset[2]) <= depth / 2 - CAMERA_WALL_MARGIN &&
      preset[1] >= CAMERA_WALL_MARGIN &&
      preset[1] <= height - CAMERA_WALL_MARGIN;
    const position = fits ? preset : ([0, Math.min(1.7, height - 0.5), depth / 2 - 0.5] as Vec3);
    this.camera = new Camera(vec3.fromValues(...position), -90, 0);
    this.publish();
  }
  // Tells the app where the acoustic listener now is (camera position and facing).
  private publish(): void {
    this.onPose(Array.from(this.camera.getPosition()) as Vec3, Array.from(this.camera.getFront()) as Vec3);
  }
  private tick(time: number): void {
    const deltaSeconds = Math.min(0.05, this.lastTime ? (time - this.lastTime) / 1000 : 0);
    this.lastTime = time;
    if (this.scene) {
      const before = this.camera.getPosition();
      let rotated = false;
      if (this.keys.has('w')) this.camera.moveForward(deltaSeconds);
      if (this.keys.has('s')) this.camera.moveForward(-deltaSeconds);
      if (this.keys.has('d')) this.camera.moveRight(deltaSeconds);
      if (this.keys.has('a')) this.camera.moveRight(-deltaSeconds);
      if (this.keys.has(' ')) this.camera.moveUp(deltaSeconds);
      if (this.keys.has('c')) this.camera.moveUp(-deltaSeconds);
      for (const [key, direction] of [
        ['arrowleft', 'left'],
        ['arrowright', 'right'],
        ['arrowup', 'up'],
        ['arrowdown', 'down'],
      ] as const)
        if (this.keys.has(key)) {
          this.camera.rotateWithKeyboard(direction);
          rotated = true;
        }
      const position = this.camera.getPosition();
      const [width, height, depth] = this.scene.dimensions;
      position[0] = Math.max(-width / 2 + 0.5, Math.min(width / 2 - 0.5, position[0]));
      position[1] = Math.max(0.5, Math.min(height - 0.5, position[1]));
      position[2] = Math.max(-depth / 2 + 0.5, Math.min(depth / 2 - 0.5, position[2]));
      const delta = vec3.subtract(vec3.create(), position, this.scene.source);
      const minimum = this.scene.receiverRadius * 2 + 0.02;
      if (vec3.length(delta) < minimum) {
        if (vec3.length(delta) < 1e-5) vec3.set(delta, 0, 0, 1);
        vec3.normalize(delta, delta);
        vec3.scaleAndAdd(position, this.scene.source, delta, minimum);
      }
      this.camera.setPosition(position);
      if (vec3.distance(before, position) > 0.00001 || rotated) this.publish();
      this.draw();
    }
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }
  // Renders room, objects, source marker, orientation arrow and rays into the canvas.
  private draw(): void {
    if (!this.scene || !this.room || !this.canvas.clientWidth || !this.canvas.clientHeight) return;
    const ratio = Math.min(devicePixelRatio, 2);
    const width = Math.round(this.canvas.clientWidth * ratio);
    const height = Math.round(this.canvas.clientHeight * ratio);
    if (!this.depth || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.depth?.destroy();
      this.depth = this.device.createTexture({
        size: [width, height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: this.depth!.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
    const viewProjection = new Float32Array(this.camera.getViewProjection(width / height));
    this.room.render(pass, viewProjection);
    this.objectRenderer.render(pass, viewProjection);
    this.sphere.render(pass, viewProjection, vec3.fromValues(...this.scene.source), 0.2);
    // An omnidirectional source has no orientation, so the arrow is only drawn for directional patterns.
    if (this.hasOrientation(this.scene))
      this.orientation.render(
        pass,
        viewProjection,
        vec3.fromValues(...this.scene.source),
        this.scene.sourceForward,
        ORIENTATION_ARROW_LENGTH,
      );
    if (this.showRays) this.rays.render(pass, viewProjection, this.segments);
    this.probeRenderer.render(pass, viewProjection, this.probeView.spheres);
    // Lines run from the probe to the listener and are brighter for a larger weight.
    this.blendLines.render(
      pass,
      viewProjection,
      this.probeView.lines.map((line) => ({
        start: vec3.fromValues(...line.to),
        end: vec3.fromValues(...line.from),
        energy: 0.3 + 0.7 * line.weight,
      })),
    );
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  // True when the source's pattern is not omnidirectional in every band.
  private hasOrientation(scene: Scene): boolean {
    return getDirectivityPattern(scene.sourceDirectivity).alpha.some((alpha) => alpha < 1);
  }
  // Keyboard (WASD, Space/C, arrows, Home) and pointer-drag look controls; undone in dispose().
  private bind(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      name: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ) => {
      this.canvas.addEventListener(name, handler);
      this.off.push(() => this.canvas.removeEventListener(name, handler));
    };
    on('click', () => this.canvas.focus());
    on('keydown', (event) => {
      const key = event.key.toLowerCase();
      if (['w', 'a', 's', 'd', ' ', 'c', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
        event.preventDefault();
        this.keys.add(key);
      }
      if (event.key === 'Home') {
        event.preventDefault();
        this.resetCamera();
      }
      // P adds a probe at the camera.
      if (key === 'p' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        this.probeHooks?.addProbeAtCamera();
      }
    });
    on('keyup', (event) => this.keys.delete(event.key.toLowerCase()));
    on('blur', () => this.keys.clear());
    let dragging = false;
    let pressedAt: [number, number] | undefined;
    on('pointerdown', (event) => {
      dragging = true;
      pressedAt = [event.clientX, event.clientY];
      this.canvas.focus();
      this.canvas.setPointerCapture(event.pointerId);
    });
    on('pointerup', (event) => {
      dragging = false;
      // A click without a drag selects the probe under the pointer (or clears the selection).
      if (
        pressedAt &&
        this.probeHooks &&
        Math.hypot(event.clientX - pressedAt[0], event.clientY - pressedAt[1]) < CLICK_TOLERANCE_PIXELS
      ) {
        const rect = this.canvas.getBoundingClientRect();
        this.probeHooks.pickProbe(this.pickAt(event.clientX - rect.left, event.clientY - rect.top));
      }
      pressedAt = undefined;
    });
    on('pointercancel', () => {
      dragging = false;
    });
    on('pointermove', (event) => {
      if (dragging) {
        this.camera.rotate(event.movementX, event.movementY);
        this.publish();
      }
    });
    const clear = () => this.keys.clear();
    window.addEventListener('blur', clear);
    this.off.push(() => window.removeEventListener('blur', clear));
  }
  // Id of the probe sphere under the canvas point (x, y) in CSS pixels, if any.
  private pickAt(x: number, y: number): string | undefined {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height || this.probeView.spheres.length === 0) return undefined;
    const inverse = mat4.invert(mat4.create(), this.camera.getViewProjection(width / height));
    if (!inverse) return undefined;
    const ndcX = (x / width) * 2 - 1;
    const ndcY = 1 - (y / height) * 2;
    // WebGPU depth runs from 0 (near) to 1 (far).
    const unproject = (depth: number): vec3 => {
      const point = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, depth, 1), inverse);
      return vec3.fromValues(point[0] / point[3], point[1] / point[3], point[2] / point[3]);
    };
    const near = unproject(0);
    const far = unproject(1);
    const direction = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), far, near));
    return pickProbe(this.probeView, Array.from(near) as Vec3, Array.from(direction) as Vec3);
  }
  dispose(): void {
    cancelAnimationFrame(this.frame);
    for (const off of this.off) off();
    this.depth?.destroy();
    this.room?.dispose();
    this.sphere.dispose();
    this.objectRenderer.dispose();
    this.rays.dispose();
    this.probeRenderer.dispose();
    this.blendLines.dispose();
    this.orientation.dispose();
    this.context.unconfigure();
  }
}
