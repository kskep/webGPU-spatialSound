import { mat4, vec3 } from 'gl-matrix';

export class Camera {
  private position: vec3;
  private yaw: number;
  private pitch: number;
  private front: vec3;
  private up: vec3;
  private readonly PITCH_LIMIT = 89.0; // Prevent camera flip at 90 degrees
  private readonly MOVEMENT_SPEED = 5.0;
  private readonly MOUSE_SENSITIVITY = 0.1;
  private readonly KEYBOARD_ROTATION_SPEED = 2.0; // New constant for keyboard rotation speed

  constructor(position: vec3 = vec3.fromValues(0, 1.7, 3), yaw: number = -90, pitch: number = 0) {
    this.position = position;
    this.yaw = yaw;
    this.pitch = pitch;
    this.front = vec3.create();
    this.up = vec3.fromValues(0, 1, 0);

    // Initialize view direction
    this.updateVectors();
  }

  private updateVectors(): void {
    // Calculate new front vector
    this.front = vec3.fromValues(
      Math.cos((this.yaw * Math.PI) / 180) * Math.cos((this.pitch * Math.PI) / 180),
      Math.sin((this.pitch * Math.PI) / 180),
      Math.sin((this.yaw * Math.PI) / 180) * Math.cos((this.pitch * Math.PI) / 180),
    );
    vec3.normalize(this.front, this.front);
  }

  public rotate(deltaX: number, deltaY: number): void {
    // Apply mouse sensitivity
    this.yaw += deltaX * this.MOUSE_SENSITIVITY;
    this.pitch -= deltaY * this.MOUSE_SENSITIVITY;

    // Constrain pitch to prevent flipping
    this.pitch = Math.max(-this.PITCH_LIMIT, Math.min(this.PITCH_LIMIT, this.pitch));

    this.updateVectors();
  }

  public moveForward(distance: number): void {
    const movement = vec3.scale(vec3.create(), this.front, distance * this.MOVEMENT_SPEED);
    vec3.add(this.position, this.position, movement);
  }

  public moveRight(distance: number): void {
    const right = vec3.cross(vec3.create(), this.front, this.up);
    vec3.normalize(right, right);
    const movement = vec3.scale(vec3.create(), right, distance * this.MOVEMENT_SPEED);
    vec3.add(this.position, this.position, movement);
  }

  public moveUp(distance: number): void {
    const movement = vec3.scale(vec3.create(), this.up, distance * this.MOVEMENT_SPEED);
    vec3.add(this.position, this.position, movement);
  }

  public getViewMatrix(): mat4 {
    const target = vec3.add(vec3.create(), this.position, this.front);
    const viewMatrix = mat4.create();
    mat4.lookAt(viewMatrix, this.position, target, this.up);
    return viewMatrix;
  }

  public getViewProjection(aspect: number): mat4 {
    const projectionMatrix = mat4.create();
    mat4.perspectiveZO(projectionMatrix, Math.PI / 4, aspect, 0.1, 100.0);

    const viewProjection = mat4.create();
    mat4.multiply(viewProjection, projectionMatrix, this.getViewMatrix());
    return viewProjection;
  }

  public getPosition(): vec3 {
    return vec3.clone(this.position);
  }

  public getFront(): vec3 {
    return vec3.clone(this.front);
  }

  public rotateWithKeyboard(direction: 'left' | 'right' | 'up' | 'down'): void {
    switch (direction) {
      case 'left':
        this.yaw -= this.KEYBOARD_ROTATION_SPEED;
        break;
      case 'right':
        this.yaw += this.KEYBOARD_ROTATION_SPEED;
        break;
      case 'up':
        this.pitch += this.KEYBOARD_ROTATION_SPEED;
        break;
      case 'down':
        this.pitch -= this.KEYBOARD_ROTATION_SPEED;
        break;
    }

    // Constrain pitch to prevent flipping
    this.pitch = Math.max(-this.PITCH_LIMIT, Math.min(this.PITCH_LIMIT, this.pitch));

    this.updateVectors();
  }

  public setPosition(position: vec3): void {
    this.position = vec3.clone(position);
  }
}
