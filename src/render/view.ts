// Three.js view of a Battle. Reads simulation arrays every frame and writes instance
// matrices; never changes the simulation itself.

import * as THREE from 'three';
import { Anim, Battle, DT } from '../sim/battle';
import type { Unit } from '../sim/battle';
import type { Visual } from '../sim/data';
import { buildArrowGeometry, buildSoldierGeometry } from './models';

interface SoldierBatch {
  mesh: THREE.InstancedMesh;
  soldiers: Int32Array;
}

export class BattleView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly battle: Battle;
  private batches: SoldierBatch[] = [];
  private soldierBatch!: Int32Array;
  private soldierInst!: Int32Array;
  private arrows: THREE.InstancedMesh;
  private tint!: Float32Array; // per soldier tint (r,g,b)
  private terrainMesh!: THREE.Mesh;
  private overlay = new THREE.Group();
  private lineMat: Record<string, THREE.LineBasicMaterial> = {};
  private linePool: THREE.Line[] = [];
  private linesUsed = 0;
  private time = 0;

  constructor(renderer: THREE.WebGLRenderer, battle: Battle) {
    this.battle = battle;
    this.renderer = renderer;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);

    const horizon = new THREE.Color(0xc9d6df);
    this.scene.background = horizon;
    this.scene.fog = new THREE.Fog(horizon, 450, 1700);
    this.scene.add(new THREE.HemisphereLight(0xdbe8ff, 0x5c5236, 1.35));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.1);
    sun.position.set(-300, 420, 180);
    this.scene.add(sun);
    this.addSky();
    this.addTerrain();
    this.addTrees();
    this.addSoldiers();

    this.arrows = new THREE.InstancedMesh(buildArrowGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), battle.PMAX);
    this.arrows.count = 0;
    this.arrows.frustumCulled = false;
    this.scene.add(this.arrows);

    this.scene.add(this.overlay);
    for (const [k, c] of Object.entries({ sel: 0xffe27a, own: 0x9be37a, enemy: 0xff6a5a, plan: 0xffffff, move: 0x9be37a, attack: 0xff6a5a })) {
      this.lineMat[k] = new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: k === 'plan' ? 0.85 : 0.75, depthTest: false });
    }
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ world
  private addSky() {
    const g = new THREE.SphereGeometry(3000, 24, 12);
    const top = new THREE.Color(0x6f9fd8);
    const hor = new THREE.Color(0xc9d6df);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < g.attributes.position.count; i++) {
      const y = g.attributes.position.getY(i) / 3000;
      const c = hor.clone().lerp(top, Math.max(0, Math.min(1, y * 2.2)));
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    this.scene.add(new THREE.Mesh(g, m));
  }

  private addTerrain() {
    const t = this.battle.terrain;
    const step = 2; // use every 2nd height sample (4 m mesh)
    const n = Math.floor((t.n - 1) / step) + 1;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const idx: number[] = [];
    const grassA = new THREE.Color(0x5f7d35);
    const grassB = new THREE.Color(0x7f9440);
    const dirt = new THREE.Color(0x8a7650);
    const high = new THREE.Color(0x9aa058);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const gi = i * step;
        const gj = j * step;
        const x = -t.half + gi * t.cell;
        const z = -t.half + gj * t.cell;
        const y = t.h[gj * t.n + gi];
        const k = j * n + i;
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        const sx = t.height(x + 2, z) - t.height(x - 2, z);
        const sz = t.height(x, z + 2) - t.height(x, z - 2);
        const slope = Math.hypot(sx, sz) / 4;
        const nz = Math.sin(x * 0.045 + Math.sin(z * 0.03) * 2) * 0.5 + Math.sin(z * 0.06 + x * 0.01) * 0.5;
        c.copy(grassA).lerp(grassB, 0.5 + nz * 0.35);
        c.lerp(high, Math.max(0, Math.min(1, (y - 6) / 18)) * 0.5);
        c.lerp(dirt, Math.max(0, Math.min(1, (slope - 0.18) * 3)));
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
    }
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const d = a + n;
        const e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    // Small procedural texture for grass detail.
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const cx = cv.getContext('2d')!;
    const img = cx.createImageData(128, 128);
    let seed = 1;
    for (let p = 0; p < 128 * 128; p++) {
      seed = (seed * 16807) % 2147483647;
      const v = 215 + ((seed / 2147483647) * 40) | 0;
      img.data[p * 4] = v;
      img.data[p * 4 + 1] = v;
      img.data[p * 4 + 2] = v;
      img.data[p * 4 + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const uv = new Float32Array(n * n * 2);
    for (let k = 0; k < n * n; k++) {
      uv[k * 2] = pos[k * 3] / 6;
      uv[k * 2 + 1] = pos[k * 3 + 2] / 6;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.terrainMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, map: tex }));
    this.scene.add(this.terrainMesh);
  }

  private addTrees() {
    const t = this.battle.terrain;
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0);
    const crown = new THREE.ConeGeometry(2.6, 7, 6).translate(0, 6, 0);
    const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: 0x5a4330 }), 900);
    const crowns = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ color: 0x3d5e2c }), 900);
    const m = new THREE.Matrix4();
    let k = 0;
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    while (k < 900) {
      const x = (rnd() * 2 - 1) * 395;
      const z = (rnd() * 2 - 1) * 395;
      if (Math.max(Math.abs(x), Math.abs(z)) < 345) continue;
      const sc = 0.7 + rnd() * 0.7;
      m.makeRotationY(rnd() * 6.28);
      m.scale(new THREE.Vector3(sc, sc * (0.8 + rnd() * 0.5), sc));
      m.setPosition(x, t.height(x, z) - 0.3, z);
      trunks.setMatrixAt(k, m);
      crowns.setMatrixAt(k, m);
      k++;
    }
    this.scene.add(trunks, crowns);
  }

  private addSoldiers() {
    const b = this.battle;
    this.soldierBatch = new Int32Array(b.N);
    this.soldierInst = new Int32Array(b.N);
    this.tint = new Float32Array(b.N * 3).fill(1);
    const groups = new Map<string, number[]>();
    for (const u of b.units) {
      const key = `${u.def.visual}|${u.faction.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(...u.all);
    }
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (const [key, list] of groups) {
      const [visual, fid] = key.split('|');
      const faction = b.units.find((u) => u.faction.id === fid)!.faction;
      const geo = buildSoldierGeometry(visual as Visual, faction);
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      const bi = this.batches.length;
      const arr = Int32Array.from(list);
      arr.forEach((s, k) => {
        this.soldierBatch[s] = bi;
        this.soldierInst[s] = k;
      });
      this.batches.push({ mesh, soldiers: arr });
      this.scene.add(mesh);
    }
  }

  // ------------------------------------------------------------------ per frame
  setUnitTint(u: Unit, r: number, g: number, bl: number) {
    for (const s of u.all) {
      this.tint[s * 3] = r;
      this.tint[s * 3 + 1] = g;
      this.tint[s * 3 + 2] = bl;
    }
  }

  update(alpha: number, dtReal: number) {
    this.time += dtReal;
    const b = this.battle;
    const t = b.terrain;
    const time = this.time;
    for (const batch of this.batches) {
      const e = batch.mesh.instanceMatrix.array as Float32Array;
      const ca = batch.mesh.instanceColor!.array as Float32Array;
      const list = batch.soldiers;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const o = k * 16;
        if (b.dead[i] === 2) {
          // Left the battlefield: hide.
          for (let q = 0; q < 16; q++) e[o + q] = 0;
          continue;
        }
        const x = b.px[i] + (b.x[i] - b.px[i]) * alpha;
        const z = b.pz[i] + (b.z[i] - b.pz[i]) * alpha;
        let dy = b.yaw[i] - b.pyaw[i];
        if (dy > Math.PI) dy -= Math.PI * 2;
        else if (dy < -Math.PI) dy += Math.PI * 2;
        const yaw = b.pyaw[i] + dy * alpha;
        let y = t.height(x, z);
        let pitch = 0;
        let roll = 0;
        let fwd = 0;
        const ph = b.phase[i];
        const at = b.animT[i] + alpha * DT;
        const mounted = b.radius[i] > 0.6;
        switch (b.anim[i]) {
          case Anim.Idle:
            pitch = Math.sin(time * 1.3 + ph) * 0.02;
            break;
          case Anim.Walk:
            y += Math.abs(Math.sin(time * (mounted ? 5 : 7) + ph)) * 0.05;
            pitch = 0.04;
            break;
          case Anim.Run:
          case Anim.Flee:
            if (mounted) {
              pitch = Math.sin(time * 9 + ph) * 0.07;
              y += Math.abs(Math.sin(time * 9 + ph)) * 0.14;
            } else {
              y += Math.abs(Math.sin(time * 11 + ph)) * 0.1;
              pitch = 0.16;
            }
            break;
          case Anim.Attack: {
            const k2 = Math.min(1, at / 0.6);
            const s = Math.sin(k2 * Math.PI);
            pitch = s * (mounted ? 0.15 : 0.42);
            fwd = s * 0.25;
            break;
          }
          case Anim.Block:
            pitch = -Math.sin(Math.min(1, at / 0.35) * Math.PI) * 0.18;
            break;
          case Anim.Shoot:
            pitch = at < 0.5 ? -0.12 : 0.04;
            break;
          case Anim.Dead: {
            const k2 = Math.min(1, at / 0.7);
            const ease = 1 - (1 - k2) * (1 - k2);
            if (mounted) {
              roll = (ph > Math.PI ? 1 : -1) * ease * 1.45;
              y -= ease * 0.15;
            } else {
              pitch = -ease * 1.5;
              y += ease * 0.05;
            }
            break;
          }
        }
        const sy = Math.sin(yaw);
        const cy = Math.cos(yaw);
        const px2 = x + sy * fwd;
        const pz2 = z + cy * fwd;
        writeMatrix(e, o, px2, y, pz2, sy, cy, pitch, roll);
        ca[k * 3] = this.tint[i * 3];
        ca[k * 3 + 1] = this.tint[i * 3 + 1];
        ca[k * 3 + 2] = this.tint[i * 3 + 2];
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.instanceColor!.needsUpdate = true;
    }

    // Projectiles.
    const ae = this.arrows.instanceMatrix.array as Float32Array;
    let n = 0;
    const lead = alpha * DT;
    for (let c = 0; c < b.PMAX; c++) {
      if (b.pAlive[c] === 0) continue;
      const vx = b.pVX[c];
      const vy = b.pVY[c];
      const vz = b.pVZ[c];
      const hs = Math.hypot(vx, vz) || 1;
      const yaw = Math.atan2(vx, vz);
      const pitch = -Math.atan2(vy, hs);
      const o = n * 16;
      writeMatrix(ae, o, b.pX[c] + vx * lead, b.pY[c] + vy * lead, b.pZ[c] + vz * lead, Math.sin(yaw), Math.cos(yaw), pitch, 0, b.pKind[c] === 1 ? 1.9 : 1);
      n++;
    }
    this.arrows.count = n;
    this.arrows.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ overlay lines
  beginOverlay() {
    this.linesUsed = 0;
  }

  endOverlay() {
    for (let k = this.linesUsed; k < this.linePool.length; k++) this.linePool[k].visible = false;
  }

  private line(points: number[], mat: string) {
    let l = this.linePool[this.linesUsed];
    if (!l) {
      l = new THREE.Line(new THREE.BufferGeometry(), this.lineMat.sel);
      l.frustumCulled = false;
      l.renderOrder = 10;
      this.linePool.push(l);
      this.overlay.add(l);
    }
    this.linesUsed++;
    l.visible = true;
    l.material = this.lineMat[mat];
    const g = l.geometry;
    const attr = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr || attr.array.length !== points.length) {
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
    } else {
      (attr.array as Float32Array).set(points);
      attr.needsUpdate = true;
    }
    g.computeBoundingSphere();
  }

  /** Rectangle outline on the ground. (cx,cz) center, (fx,fz) facing, w width, d depth. */
  rect(cx: number, cz: number, fx: number, fz: number, w: number, d: number, mat: string) {
    const t = this.battle.terrain;
    const rx = -fz;
    const rz = fx;
    const corners = [
      [-w / 2, d / 2],
      [w / 2, d / 2],
      [w / 2, -d / 2],
      [-w / 2, -d / 2],
      [-w / 2, d / 2],
    ];
    const pts: number[] = [];
    for (let k = 0; k < corners.length - 1; k++) {
      const [a0, b0] = corners[k];
      const [a1, b1] = corners[k + 1];
      for (let s = 0; s < 6; s++) {
        const f = s / 6;
        const lat = a0 + (a1 - a0) * f;
        const fwd = b0 + (b1 - b0) * f;
        const x = cx + rx * lat + fx * fwd;
        const z = cz + rz * lat + fz * fwd;
        pts.push(x, t.height(x, z) + 0.35, z);
      }
    }
    const [la, lb] = corners[4];
    const x = cx + rx * la + fx * lb;
    const z = cz + rz * la + fz * lb;
    pts.push(x, t.height(x, z) + 0.35, z);
    this.line(pts, mat);
    // Facing tick at the front.
    const fx0 = cx + fx * (d / 2);
    const fz0 = cz + fz * (d / 2);
    const fx1 = cx + fx * (d / 2 + 2.5);
    const fz1 = cz + fz * (d / 2 + 2.5);
    this.line([fx0, t.height(fx0, fz0) + 0.35, fz0, fx1, t.height(fx1, fz1) + 0.35, fz1], mat);
  }

  path(x0: number, z0: number, x1: number, z1: number, mat: string) {
    const t = this.battle.terrain;
    const pts: number[] = [];
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 6));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const x = x0 + (x1 - x0) * f;
      const z = z0 + (z1 - z0) * f;
      pts.push(x, t.height(x, z) + 0.4, z);
    }
    this.line(pts, mat);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) {
        const map = (mat as THREE.MeshLambertMaterial).map;
        if (map) map.dispose();
        mat.dispose();
      }
    });
  }
}

/** Column-major matrix: translate * Ry(yaw) * Rx(pitch) * Rz(roll) * scale. */
function writeMatrix(e: Float32Array, o: number, x: number, y: number, z: number, sy: number, cy: number, pitch: number, roll: number, sz = 1) {
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  // Rows of R = Ry * Rx * Rz
  const m00 = cy * cr + sy * sp * sr;
  const m01 = -cy * sr + sy * sp * cr;
  const m02 = sy * cp;
  const m10 = cp * sr;
  const m11 = cp * cr;
  const m12 = -sp;
  const m20 = -sy * cr + cy * sp * sr;
  const m21 = sy * sr + cy * sp * cr;
  const m22 = cy * cp;
  e[o] = m00;
  e[o + 1] = m10;
  e[o + 2] = m20;
  e[o + 3] = 0;
  e[o + 4] = m01;
  e[o + 5] = m11;
  e[o + 6] = m21;
  e[o + 7] = 0;
  e[o + 8] = m02 * sz;
  e[o + 9] = m12 * sz;
  e[o + 10] = m22 * sz;
  e[o + 11] = 0;
  e[o + 12] = x;
  e[o + 13] = y;
  e[o + 14] = z;
  e[o + 15] = 1;
}
