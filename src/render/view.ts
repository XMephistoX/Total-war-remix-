// Three.js view of a Battle. Reads simulation arrays every frame and writes instance
// matrices; never changes the simulation itself.

import * as THREE from 'three';
import { Anim, Battle, DT } from '../sim/battle';
import type { Unit } from '../sim/battle';
import type { Visual } from '../sim/data';
import { buildArrowGeometry, buildSoldierGeometry } from './models';
import type { TreeKind } from './trees';
import { Crowd } from './crowd';
import type { UnitAsset } from './crowd';

interface SoldierBatch {
  mesh: THREE.InstancedMesh;
  soldiers: Int32Array;
  crowd?: Crowd;
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
  terrainUniforms: { uContour: { value: number } } & Record<string, { value: unknown }> = { uContour: { value: 1 } };
  private overlay = new THREE.Group();
  private lineMat: Record<string, THREE.LineBasicMaterial> = {};
  private linePool: THREE.Line[] = [];
  private linesUsed = 0;
  private time = 0;
  private ghosts!: THREE.InstancedMesh;
  private ghostCount = 0;
  private readonly GHOST_MAX = 9000;
  private visualGeo = new Map<string, THREE.BufferGeometry>();
  private soldierMat!: THREE.Material;
  private readonly assets: Map<string, UnitAsset>;
  private clock!: Float32Array; // per-soldier looping animation clock
  private blobs!: THREE.InstancedMesh;

  private readonly trees: TreeKind[] | null;

  constructor(renderer: THREE.WebGLRenderer, battle: Battle, assets: Map<string, UnitAsset> = new Map(), trees: TreeKind[] | null = null) {
    this.trees = trees;
    this.battle = battle;
    this.assets = assets;
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
    const gg = new THREE.CircleGeometry(0.42, 10).rotateX(-Math.PI / 2);
    const gm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, depthTest: true });
    this.ghosts = new THREE.InstancedMesh(gg, gm, this.GHOST_MAX);
    this.ghosts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.GHOST_MAX * 3), 3);
    this.ghosts.count = 0;
    this.ghosts.frustumCulled = false;
    this.ghosts.renderOrder = 5;
    this.scene.add(this.ghosts);
    for (const [k, c] of Object.entries({ sel: 0xffe27a, own: 0x9be37a, enemy: 0xff6a5a, plan: 0xffffff, move: 0x9be37a, attack: 0xff6a5a, range: 0x7fd4ff })) {
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
    const dry = Math.max(0, Math.min(1, this.battle.opts.land?.dry ?? 0));
    const step = 2; // use every 2nd height sample (4 m mesh)
    const n = Math.floor((t.n - 1) / step) + 1;
    const pos = new Float32Array(n * n * 3);
    const splat = new Float32Array(n * n * 4);
    const tint = new Float32Array(n * n * 3);
    const idx: number[] = [];
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
        // Splat weights: lush grass / wild grass / dirt / rocky grass.
        const nz = fbm(x / 140, z / 140, 3) * 2 - 1;
        const nz2 = fbm(x / 38 + 17.3, z / 38 - 4.1, 4);
        let rock = Math.max(0, Math.min(1, (slope - 0.22) * 4));
        let dirt = Math.max(0, Math.min(1, (nz2 - 0.62 + dry * 0.35) * 5)) * (1 - rock);
        dirt = Math.max(dirt, Math.max(0, Math.min(1, (slope - 0.12) * 3)) * (1 - rock) * 0.6);
        const hi = Math.max(0, Math.min(1, (y - 9) / 10));
        let grassB = Math.max(0, Math.min(1, 0.5 + dry * 0.6 + nz * 0.8)) * (1 - rock) * (1 - dirt);
        grassB = Math.max(grassB, hi * 0.7 * (1 - rock));
        const grassA = Math.max(0, 1 - rock - dirt - grassB);
        const sum = grassA + grassB + dirt + rock || 1;
        splat.set([grassA / sum, grassB / sum, dirt / sum, rock / sum], k * 4);
        // Gentle darkening in hollows, light on crests: makes the relief readable.
        const lap = (t.height(x + 8, z) + t.height(x - 8, z) + t.height(x, z + 8) + t.height(x, z - 8)) / 4 - y;
        const shade = 1 - Math.max(-0.12, Math.min(0.12, lap * 0.05));
        tint.set([shade * (1 + dry * 0.1), shade * (1 - dry * 0.02), shade * (1 - dry * 0.22)], k * 3);
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
    g.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    g.setAttribute('color', new THREE.BufferAttribute(tint, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    // Mediterranean terrain textures from 0 A.D. (Wildfire Games, CC BY-SA 3.0).
    const loader = new THREE.TextureLoader();
    const tex = (name: string) => {
      const tx = loader.load(`./terrain/${name}.jpg`);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.anisotropy = 8;
      return tx;
    };
    const uniforms = {
      tGrassA: { value: tex('grass_a') },
      tGrassB: { value: tex('grass_b') },
      tDirt: { value: tex('dirt') },
      tRock: { value: tex('rock') },
      uContour: { value: 1.0 },
    };
    this.terrainUniforms = uniforms;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 splat;
          varying vec4 vSplat;
          varying vec3 vTerrainPos;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vSplat = splat;
          vTerrainPos = position;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tGrassA;
          uniform sampler2D tGrassB;
          uniform sampler2D tDirt;
          uniform sampler2D tRock;
          uniform float uContour;
          varying vec4 vSplat;
          varying vec3 vTerrainPos;
          vec3 tri(sampler2D tx, vec2 p) {
            // Two scales blended to hide tiling.
            return mix(texture2D(tx, p / 9.0).rgb, texture2D(tx, p / 41.0 + 0.37).rgb, 0.35);
          }`)
        .replace('#include <map_fragment>', `
          vec2 tp = vTerrainPos.xz;
          vec3 ground = tri(tGrassA, tp) * vSplat.x + tri(tGrassB, tp) * vSplat.y + tri(tDirt, tp) * vSplat.z + tri(tRock, tp) * vSplat.w;
          diffuseColor.rgb *= ground;
          // Height contour lines every 2.5 m (stronger every 10 m) so slopes are easy to read.
          float hc = vTerrainPos.y / 2.5;
          float fw = max(fwidth(hc), 1e-4);
          float d = abs(fract(hc - 0.5) - 0.5) / fw;
          float minor = 1.0 - smoothstep(0.0, 1.2, d);
          float hm = vTerrainPos.y / 10.0;
          float fwm = max(fwidth(hm), 1e-4);
          float major = 1.0 - smoothstep(0.0, 1.4, abs(fract(hm - 0.5) - 0.5) / fwm);
          float edge = smoothstep(330.0, 345.0, max(abs(tp.x), abs(tp.y)));
          diffuseColor.rgb *= 1.0 - uContour * (1.0 - edge) * (minor * 0.10 + major * 0.16);`);
    };
    this.terrainMesh = new THREE.Mesh(g, mat);
    this.scene.add(this.terrainMesh);
  }

  private addTrees() {
    if (this.trees && this.trees.length) {
      this.addRealTrees(this.trees);
      return;
    }
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

  /** Woods of 0 A.D. trees around the battlefield, in clumps of one kind. */
  private addRealTrees(kinds: TreeKind[]) {
    const t = this.battle.terrain;
    let s = 11;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const weight: Record<string, number> = { pine: 0.45, cypress: 0.25, beech: 0.3 };
    // placements[kind][variant] = matrices
    const placements = kinds.map((k) => k.variants.map(() => [] as THREE.Matrix4[]));
    const pickKind = () => {
      let r = rnd();
      for (let i = 0; i < kinds.length; i++) {
        r -= weight[kinds[i].name] ?? 1 / kinds.length;
        if (r <= 0) return i;
      }
      return kinds.length - 1;
    };
    const place = (ki: number, x: number, z: number, big = 1) => {
      const k = kinds[ki];
      const vi = Math.floor(rnd() * k.variants.length);
      const sc = (0.75 + rnd() * 0.55) * big;
      const m = new THREE.Matrix4().makeRotationY(rnd() * 6.283);
      m.scale(new THREE.Vector3(sc, sc * (0.9 + rnd() * 0.2), sc));
      m.setPosition(x, t.height(x, z) - 0.2, z);
      placements[ki][vi].push(m);
    };
    // Woods: clumps outside the playable square, denser further out.
    let clumps = 0;
    while (clumps < 150) {
      const x = (rnd() * 2 - 1) * 420;
      const z = (rnd() * 2 - 1) * 420;
      const edge = Math.max(Math.abs(x), Math.abs(z));
      if (edge < 352) continue;
      clumps++;
      const ki = pickKind();
      const n = 3 + Math.floor(rnd() * 9);
      const r = 8 + rnd() * 16;
      for (let j = 0; j < n; j++) {
        const a = rnd() * 6.283;
        const d = Math.sqrt(rnd()) * r;
        const px = x + Math.cos(a) * d;
        const pz = z + Math.sin(a) * d;
        if (Math.max(Math.abs(px), Math.abs(pz)) < 348) continue;
        place(rnd() < 0.85 ? ki : pickKind(), px, pz);
      }
    }
    // A few lone trees along the inner edge so the field doesn't end in a hard line.
    for (let j = 0; j < 40; j++) {
      const side = Math.floor(rnd() * 4);
      const along = (rnd() * 2 - 1) * 330;
      const depth = 330 + rnd() * 18;
      const x = side < 2 ? (side === 0 ? depth : -depth) : along;
      const z = side < 2 ? along : (side === 2 ? depth : -depth);
      place(pickKind(), x, z, 1.1);
    }
    kinds.forEach((k, ki) => k.variants.forEach((parts, vi) => {
      const list = placements[ki][vi];
      if (!list.length) return;
      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.computeBoundingSphere();
        this.scene.add(mesh);
      }
    }));
  }

  private addSoldiers() {
    const b = this.battle;
    this.soldierBatch = new Int32Array(b.N);
    this.soldierInst = new Int32Array(b.N);
    this.tint = new Float32Array(b.N * 3).fill(1);
    this.clock = new Float32Array(b.N);
    for (let i = 0; i < b.N; i++) this.clock[i] = b.phase[i] * 0.7;
    const groups = new Map<string, number[]>();
    for (const u of b.units) {
      const model = u.def.model && this.assets.has(u.def.model) ? `m:${u.def.model}` : `v:${u.def.visual}|${u.faction.id}`;
      if (!groups.has(model)) groups.set(model, []);
      groups.get(model)!.push(...u.all);
    }
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.soldierMat = mat;
    for (const [key, list] of groups) {
      let mesh: THREE.InstancedMesh;
      let crowd: Crowd | undefined;
      if (key.startsWith('m:')) {
        crowd = new Crowd(this.assets.get(key.slice(2))!, list.length);
        mesh = crowd.mesh;
      } else {
        const [visual, fid] = key.slice(2).split('|');
        const faction = b.units.find((u) => u.faction.id === fid)!.faction;
        const geo = buildSoldierGeometry(visual as Visual, faction);
        this.visualGeo.set(`${visual}|${fid}`, geo);
        mesh = new THREE.InstancedMesh(geo, mat, list.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
      }
      const bi = this.batches.length;
      const arr = Int32Array.from(list);
      const team = new THREE.Color();
      arr.forEach((s, k) => {
        this.soldierBatch[s] = bi;
        this.soldierInst[s] = k;
        if (crowd) crowd.setTeam(k, team.setHex(b.units[b.unitOf[s]].faction.primary));
      });
      this.batches.push({ mesh, soldiers: arr, crowd });
      this.scene.add(mesh);
    }

    // Soft round shadows under every living soldier: cheap and grounds the crowd.
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const cx = cv.getContext('2d')!;
    const grad = cx.createRadialGradient(32, 32, 2, 32, 32, 31);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = grad;
    cx.fillRect(0, 0, 64, 64);
    const blobTex = new THREE.CanvasTexture(cv);
    const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.blobs = new THREE.InstancedMesh(blobGeo, new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }), b.N);
    this.blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 1;
    this.scene.add(this.blobs);
  }

  /** Picks the animation frame for one soldier of a converted model. */
  private crowdFrame(crowd: Crowd, i: number, alpha: number, dt: number): number {
    const b = this.battle;
    const u = b.units[b.unitOf[i]];
    const odd = b.phase[i] > Math.PI;
    const at = b.animT[i] + alpha * DT;
    switch (b.anim[i]) {
      case Anim.Walk: {
        const sp = Math.hypot(b.vx[i], b.vz[i]);
        this.clock[i] += dt * Math.max(0.5, Math.min(1.8, sp / (u.def.mounted ? 3.2 : 1.5)));
        return crowd.frameAt('walk', this.clock[i]);
      }
      case Anim.Run:
      case Anim.Flee: {
        const sp = Math.hypot(b.vx[i], b.vz[i]);
        this.clock[i] += dt * Math.max(0.6, Math.min(1.6, sp / (u.def.mounted ? 8.5 : 4.2)));
        return crowd.frameAt('run', this.clock[i]);
      }
      case Anim.Attack: {
        const clip = odd && crowd.has('attack2') ? 'attack2' : 'attack1';
        return crowd.frameAt(clip, Math.min(1, at / 1.0) * crowd.duration(clip), false);
      }
      case Anim.Shoot: {
        const clip = crowd.has('shoot') ? 'shoot' : 'attack1';
        return crowd.frameAt(clip, Math.min(1, at / 1.0) * crowd.duration(clip), false);
      }
      case Anim.Dead: {
        const clip = odd && crowd.has('death2') ? 'death2' : 'death1';
        return crowd.frameAt(clip, at, false);
      }
      default: {
        this.clock[i] += dt;
        const ready = u.inMeleePrev > 0 || b.anim[i] === Anim.Block || (u.order.kind === 'attack' && !u.moving);
        return crowd.frameAt(ready && crowd.has('ready') ? 'ready' : 'idle', this.clock[i]);
      }
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
    const be = this.blobs.instanceMatrix.array as Float32Array;
    let nb = 0;
    for (const batch of this.batches) {
      const e = batch.mesh.instanceMatrix.array as Float32Array;
      const ca = batch.mesh.instanceColor!.array as Float32Array;
      const list = batch.soldiers;
      const crowd = batch.crowd;
      const fr = crowd ? (crowd.frames.array as Float32Array) : null;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const o = k * 16;
        if (b.dead[i] === 2) {
          // Left the battlefield: hide.
          for (let q = 0; q < 16; q++) e[o + q] = 0;
          continue;
        }
        if (crowd && fr) {
          const x = b.px[i] + (b.x[i] - b.px[i]) * alpha;
          const z = b.pz[i] + (b.z[i] - b.pz[i]) * alpha;
          let dyw = b.yaw[i] - b.pyaw[i];
          if (dyw > Math.PI) dyw -= Math.PI * 2;
          else if (dyw < -Math.PI) dyw += Math.PI * 2;
          const yaw = b.pyaw[i] + dyw * alpha;
          const y = t.height(x, z);
          writeMatrix(e, o, x, y, z, Math.sin(yaw), Math.cos(yaw), 0, 0);
          fr[k] = this.crowdFrame(crowd, i, alpha, dtReal);
          ca[k * 3] = this.tint[i * 3];
          ca[k * 3 + 1] = this.tint[i * 3 + 1];
          ca[k * 3 + 2] = this.tint[i * 3 + 2];
          if (b.dead[i] === 0) nb = this.blob(be, nb, x, y, z, b.radius[i]);
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
        if (b.dead[i] === 0) nb = this.blob(be, nb, x, t.height(x, z), z, b.radius[i]);
        ca[k * 3] = this.tint[i * 3];
        ca[k * 3 + 1] = this.tint[i * 3 + 1];
        ca[k * 3 + 2] = this.tint[i * 3 + 2];
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.instanceColor!.needsUpdate = true;
      if (crowd) crowd.frames.needsUpdate = true;
    }
    this.blobs.count = nb;
    this.blobs.instanceMatrix.needsUpdate = true;

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
      const kind = b.pKind[c];
      writeMatrix(ae, o, b.pX[c] + vx * lead, b.pY[c] + vy * lead, b.pZ[c] + vz * lead, Math.sin(yaw), Math.cos(yaw), pitch, 0, kind === 1 ? 1.9 : kind === 2 ? 0.12 : 1);
      n++;
    }
    this.arrows.count = n;
    this.arrows.instanceMatrix.needsUpdate = true;
  }

  private blob(e: Float32Array, n: number, x: number, y: number, z: number, r: number): number {
    const o = n * 16;
    const sx = r > 0.6 ? 2.1 : 1.05;
    const sz = sx;
    e[o] = sx;
    e[o + 1] = 0;
    e[o + 2] = 0;
    e[o + 3] = 0;
    e[o + 4] = 0;
    e[o + 5] = 1;
    e[o + 6] = 0;
    e[o + 7] = 0;
    e[o + 8] = 0;
    e[o + 9] = 0;
    e[o + 10] = sz;
    e[o + 11] = 0;
    e[o + 12] = x;
    e[o + 13] = y + 0.04;
    e[o + 14] = z;
    e[o + 15] = 1;
    return n + 1;
  }

  // ------------------------------------------------------------------ overlay lines
  beginOverlay() {
    this.linesUsed = 0;
  }

  endOverlay() {
    for (let k = this.linesUsed; k < this.linePool.length; k++) this.linePool[k].visible = false;
  }

  polyline(points: number[], mat: string) {
    this.line(points, mat);
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

  // ------------------------------------------------------------------ ghost markers (order preview)
  beginGhosts() {
    this.ghostCount = 0;
  }

  ghost(x: number, z: number, r: number, g: number, b: number) {
    if (this.ghostCount >= this.GHOST_MAX) return;
    const k = this.ghostCount++;
    const e = this.ghosts.instanceMatrix.array as Float32Array;
    const o = k * 16;
    e.fill(0, o, o + 16);
    e[o] = 1;
    e[o + 5] = 1;
    e[o + 10] = 1;
    e[o + 12] = x;
    e[o + 13] = this.battle.terrain.height(x, z) + 0.12;
    e[o + 14] = z;
    e[o + 15] = 1;
    const c = this.ghosts.instanceColor!.array as Float32Array;
    c[k * 3] = r;
    c[k * 3 + 1] = g;
    c[k * 3 + 2] = b;
  }

  endGhosts() {
    this.ghosts.count = this.ghostCount;
    this.ghosts.instanceMatrix.needsUpdate = true;
    this.ghosts.instanceColor!.needsUpdate = true;
  }

  /** Small rendered picture of a unit's soldier model, for the unit cards. */
  portrait(u: Unit, size = 96): string {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x50402a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(2, 4, 5);
    scene.add(sun);
    const asset = u.def.model ? this.assets.get(u.def.model) : undefined;
    let mesh: THREE.Object3D;
    let minY = 0;
    let h = 1.8;
    if (asset) {
      const crowd = new Crowd(asset, 1);
      crowd.setTeam(0, new THREE.Color(u.faction.primary));
      crowd.mesh.setMatrixAt(0, new THREE.Matrix4().makeRotationY(-0.45));
      crowd.frames.setX(0, crowd.frameAt('idle', 0.3));
      mesh = crowd.mesh;
    } else {
      const geo = this.visualGeo.get(`${u.def.visual}|${u.faction.id}`);
      if (!geo) return '';
      const m = new THREE.Mesh(geo, this.soldierMat);
      m.rotation.y = -0.55;
      geo.computeBoundingBox();
      minY = geo.boundingBox!.min.y;
      h = geo.boundingBox!.max.y - minY;
      mesh = m;
    }
    scene.add(mesh);
    const bb = { min: { y: minY } };
    const mounted = u.def.mounted;
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    const focusY = bb.min.y + h * (mounted ? 0.62 : 0.6);
    cam.position.set(0, focusY + 0.2, mounted ? 6.2 : 4.4);
    cam.lookAt(0, focusY, 0);
    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const prevTarget = this.renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    this.renderer.getClearColor(prevClear);
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(scene, cam);
    const px = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClear, prevAlpha);
    rt.dispose();
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
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

function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in [0,1]. */
function fbm(x: number, y: number, octaves: number): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += vnoise(x, y) * amp;
    norm += amp;
    x = x * 2.03 + 11.7;
    y = y * 2.03 - 5.3;
    amp *= 0.5;
  }
  return s / norm;
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
