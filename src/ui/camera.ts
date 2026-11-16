// RTS camera: orbits a target point on the ground.
import * as THREE from 'three';

export interface Ground {
  height(x: number, z: number): number;
}

export interface CameraLimits {
  x: number; // |tx| limit
  z: number; // |tz| limit
  minDist: number;
  maxDist: number;
}

export class RtsCamera {
  tx = 0;
  tz = 0;
  yaw = 0; // 0 = looking toward -z
  pitch = 0.62;
  dist = 150;
  // Smoothed values actually used.
  private sx = 0;
  private sz = 0;
  private syaw = 0;
  private spitch = 0.62;
  private sdist = 150;
  readonly keys = new Set<string>();
  private readonly cam: THREE.PerspectiveCamera;
  private readonly terrain: Ground;
  readonly limits: CameraLimits;

  constructor(cam: THREE.PerspectiveCamera, terrain: Ground, limits: CameraLimits = { x: 360, z: 360, minDist: 12, maxDist: 700 }) {
    this.cam = cam;
    this.terrain = terrain;
    this.limits = limits;
  }

  jump(x: number, z: number, yaw: number, dist = 150, pitch = 0.62) {
    this.tx = this.sx = x;
    this.tz = this.sz = z;
    this.yaw = this.syaw = yaw;
    this.dist = this.sdist = dist;
    this.pitch = this.spitch = pitch;
  }

  get forward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  pan(dxScreen: number, dzScreen: number) {
    // Screen-relative pan, scaled by zoom.
    const k = this.dist * 0.0022;
    const f = this.forward;
    const rx = -f.z;
    const rz = f.x;
    this.tx += (-dxScreen * rx + dzScreen * f.x) * k;
    this.tz += (-dxScreen * rz + dzScreen * f.z) * k;
    this.clamp();
  }

  zoom(factor: number) {
    this.dist = Math.max(this.limits.minDist, Math.min(this.limits.maxDist, this.dist * factor));
  }

  rotate(dyaw: number, dpitch: number) {
    this.yaw += dyaw;
    this.pitch = Math.max(0.12, Math.min(1.45, this.pitch + dpitch));
  }

  private clamp() {
    const l = this.limits;
    this.tx = Math.max(-l.x, Math.min(l.x, this.tx));
    this.tz = Math.max(-l.z, Math.min(l.z, this.tz));
  }

  update(dt: number) {
    const sp = this.dist * 0.9 * dt;
    const f = this.forward;
    const rx = -f.z;
    const rz = f.x;
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) (this.tx += f.x * sp), (this.tz += f.z * sp);
    if (k.has('s') || k.has('arrowdown')) (this.tx -= f.x * sp), (this.tz -= f.z * sp);
    if (k.has('d') || k.has('arrowright')) (this.tx += rx * sp), (this.tz += rz * sp);
    if (k.has('a') || k.has('arrowleft')) (this.tx -= rx * sp), (this.tz -= rz * sp);
    if (k.has('q')) this.yaw += 1.4 * dt;
    if (k.has('e')) this.yaw -= 1.4 * dt;
    if (k.has('pageup') || k.has('t')) this.pitch = Math.min(1.45, this.pitch + 0.8 * dt);
    if (k.has('pagedown') || k.has('b')) this.pitch = Math.max(0.12, this.pitch - 0.8 * dt);
    if (k.has('z')) this.zoom(1 - 1.2 * dt);
    if (k.has('x')) this.zoom(1 + 1.2 * dt);
    this.clamp();

    const a = 1 - Math.exp(-dt * 10);
    this.sx += (this.tx - this.sx) * a;
    this.sz += (this.tz - this.sz) * a;
    const dy = this.yaw - this.syaw;
    this.syaw += dy * a;
    this.spitch += (this.pitch - this.spitch) * a;
    this.sdist += (this.dist - this.sdist) * a;

    const ty = this.terrain.height(this.sx, this.sz);
    const cx = this.sx + Math.sin(this.syaw) * Math.cos(this.spitch) * this.sdist;
    const cz = this.sz + Math.cos(this.syaw) * Math.cos(this.spitch) * this.sdist;
    let cy = ty + Math.sin(this.spitch) * this.sdist;
    const ground = this.terrain.height(cx, cz) + 3;
    if (cy < ground) cy = ground;
    this.cam.position.set(cx, cy, cz);
    this.cam.lookAt(this.sx, ty + 1.5, this.sz);
  }
}
