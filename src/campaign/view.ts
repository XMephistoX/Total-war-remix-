// Three.js view of the campaign map: relief, sea, province borders in faction colours, forests,
// towns that grow with their population, and armies shown as mounted generals.

import * as THREE from 'three';
import type { MapData } from './map';
import type { Army, Campaign, Settlement } from './state';
import { settlementLevel } from './rules';
import { Crowd } from '../render/crowd';
import type { UnitAsset } from '../render/crowd';

export const HS = 26; // vertical scale: map height 1.0 -> 26 world units

/** Which converted model stands for a culture's armies on the map. */
export const ARMY_MODEL: Record<string, string> = {
  roman: 'rome_general', celtic: 'gaul_chieftain', germanic: 'gaul_cavalry', iberian: 'gaul_cavalry', thracian: 'gaul_cavalry',
  punic: 'rome_equites', greek: 'rome_equites', hellenistic: 'rome_general', eastern: 'rome_equites', nomad: 'gaul_cavalry',
  numidian: 'gaul_cavalry', mixed: 'gaul_cavalry',
};

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, o = 4): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < o; i++) {
    s += vnoise(x * f, y * f) * a;
    f *= 2.03;
    a *= 0.5;
  }
  return s / (1 - Math.pow(0.5, o));
}

export class CampaignView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 1, 6000);
  readonly map: MapData;
  readonly c: Campaign;
  private readonly renderer: THREE.WebGLRenderer;
  private ownerTex: THREE.DataTexture;
  private ownerData: Uint8Array;
  private terrainMat!: THREE.MeshLambertMaterial;
  private water!: THREE.Mesh;
  private waterMat!: THREE.ShaderMaterial;
  private houses!: THREE.InstancedMesh;
  private roofs!: THREE.InstancedMesh;
  private walls!: THREE.InstancedMesh;
  private temples!: THREE.InstancedMesh;
  private townKey = '';
  private crowds = new Map<string, Crowd>();
  private armyDisplay = new Map<number, { x: number; y: number; yaw: number; walk: number }>();
  private pathLine: THREE.Mesh | null = null;
  private pathLine2: THREE.Mesh | null = null;
  private ring: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private time = 0;
  readonly assets: Map<string, UnitAsset>;
  political = false;

  constructor(renderer: THREE.WebGLRenderer, c: Campaign, assets: Map<string, UnitAsset>) {
    this.renderer = renderer;
    this.c = c;
    this.map = c.map;
    this.assets = assets;
    const sky = new THREE.Color(0xb9cfdc);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 900, 2600);
    this.scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x4a4030, 1.25));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.0);
    sun.position.set(-400, 600, 300);
    this.scene.add(sun);
    this.ownerData = new Uint8Array(256 * 4);
    this.ownerTex = new THREE.DataTexture(this.ownerData, 256, 1, THREE.RGBAFormat);
    this.ownerTex.magFilter = this.ownerTex.minFilter = THREE.NearestFilter;
    this.ownerTex.needsUpdate = true;
    this.buildTerrain();
    this.buildWater();
    this.buildForests();
    const ringGeo = new THREE.RingGeometry(3.2, 4.0, 40).rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.renderOrder = 5;
    this.ring.visible = false;
    this.scene.add(this.ring);
    this.hoverRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
    this.hoverRing.renderOrder = 5;
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);
    this.updateOwners();
  }

  // ------------------------------------------------------------------ coordinates
  world(x: number, y: number, lift = 0): THREE.Vector3 {
    return new THREE.Vector3(x - this.map.W / 2, Math.max(0, this.map.heightAt(x, y)) * HS + lift, y - this.map.H / 2);
  }

  ground(wx: number, wz: number): number {
    return Math.max(0, this.map.heightAt(wx + this.map.W / 2, wz + this.map.H / 2)) * HS;
  }

  // ------------------------------------------------------------------ terrain
  private buildTerrain() {
    const m = this.map;
    const step = 2;
    const nx = Math.floor((m.W - 1) / step) + 1;
    const ny = Math.floor((m.H - 1) / step) + 1;
    const pos = new Float32Array(nx * ny * 3);
    const col = new Float32Array(nx * ny * 3);
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    const lush = [0.32, 0.44, 0.2];
    const forest = [0.18, 0.3, 0.13];
    const dryc = [0.66, 0.6, 0.36];
    const sand = [0.86, 0.75, 0.5];
    const rock = [0.5, 0.46, 0.4];
    const snow = [0.93, 0.94, 0.97];
    const seabed = [0.55, 0.6, 0.5];
    const lerp = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = i * step + 0.5;
        const y = j * step + 0.5;
        const h = m.heightAt(x, y);
        const k = j * nx + i;
        pos[k * 3] = x - m.W / 2;
        pos[k * 3 + 1] = h > 0 ? h * HS : h * HS * 1.5 - 0.6;
        pos[k * 3 + 2] = y - m.H / 2;
        let c: number[];
        if (h <= 0.002) {
          c = seabed;
        } else {
          const d = m.dryAt(x, y);
          const slope = Math.hypot(m.heightAt(x + 2, y) - m.heightAt(x - 2, y), m.heightAt(x, y + 2) - m.heightAt(x, y - 2));
          const n = fbm(x / 9, y / 9, 4);
          const n2 = fbm(x / 2.5 + 40, y / 2.5, 3);
          c = d < 0.45 ? lerp(lush, dryc, d / 0.45) : lerp(dryc, sand, Math.min(1, (d - 0.45) / 0.4));
          // Forest patches in the lusher lowlands and hills.
          const f = Math.max(0, Math.min(1, (n - 0.5) * 5)) * Math.max(0, 1 - d * 2.2) * (h < 0.55 ? 1 : 0.3);
          c = lerp(c, forest, f * 0.75);
          c = lerp(c, rock, Math.max(0, Math.min(1, (slope - 0.05) * 9 + (h - 0.55) * 2)));
          c = lerp(c, snow, Math.max(0, Math.min(1, (h - 0.68 - n2 * 0.08) * 7)));
          if (h < 0.012 && d > 0.2) c = lerp(c, sand, 0.6);
          const riv = m.river[Math.floor(y) * m.W + Math.floor(x)];
          if (riv > 0.25) c = lerp(c, [0.25, 0.42, 0.55], Math.min(1, (riv - 0.25) * 1.6));
          const v = 0.9 + n2 * 0.2;
          c = [c[0] * v, c[1] * v, c[2] * v];
        }
        col.set(c, k * 3);
      }
    }
    let q = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        idx[q++] = a;
        idx[q++] = a + nx;
        idx[q++] = a + 1;
        idx[q++] = a + 1;
        idx[q++] = a + nx;
        idx[q++] = a + nx + 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const regionTex = new THREE.Texture(m.bordersImg ?? m.regionsImg ?? undefined);
    regionTex.flipY = false;
    regionTex.magFilter = regionTex.minFilter = THREE.NearestFilter;
    regionTex.generateMipmaps = false;
    regionTex.needsUpdate = true;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const uniforms = {
      tRegion: { value: regionTex },
      tOwner: { value: this.ownerTex },
      uSize: { value: new THREE.Vector2(m.W, m.H) },
      uRSize: { value: new THREE.Vector2(m.bordersImg ? m.W * 3 : m.W, m.bordersImg ? m.H * 3 : m.H) },
      uPolitical: { value: 0 },
      uHover: { value: -1 },
      uSel: { value: -1 },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform vec2 uSize;
          varying vec2 vMapUv2;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vMapUv2 = position.xz + uSize * 0.5;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vMapUv2;
          uniform sampler2D tRegion;
          uniform sampler2D tOwner;
          uniform vec2 uSize;
          uniform vec2 uRSize;
          uniform float uPolitical;
          uniform float uHover;
          uniform float uSel;
          float regionAt(vec2 p) { return floor(texture2D(tRegion, p / uRSize).r * 255.0 + 0.5); }
          vec4 ownerOf(float id) { return texture2D(tOwner, vec2((id + 0.5) / 256.0, 0.5)); }`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          {
            vec2 p = vMapUv2 * (uRSize / uSize);
            float id = regionAt(p);
            if (id < 254.5) {
              vec2 fw = fwidth(p) * 0.9;
              float a = regionAt(p + vec2(fw.x, 0.0));
              float b = regionAt(p - vec2(fw.x, 0.0));
              float c = regionAt(p + vec2(0.0, fw.y));
              float d = regionAt(p - vec2(0.0, fw.y));
              vec2 fw2 = fw * 2.2;
              float a2 = regionAt(p + vec2(fw2.x, 0.0));
              float b2 = regionAt(p - vec2(fw2.x, 0.0));
              float c2 = regionAt(p + vec2(0.0, fw2.y));
              float d2 = regionAt(p - vec2(0.0, fw2.y));
              vec4 me = ownerOf(id);
              // Coastlines are not borders; only land next to land counts.
              bool edge = (a != id && a < 254.5) || (b != id && b < 254.5) || (c != id && c < 254.5) || (d != id && d < 254.5);
              bool realm = (a2 < 254.5 && ownerOf(a2).a != me.a) || (b2 < 254.5 && ownerOf(b2).a != me.a) || (c2 < 254.5 && ownerOf(c2).a != me.a) || (d2 < 254.5 && ownerOf(d2).a != me.a);
              edge = edge || realm;
              vec3 fc = me.rgb;
              gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, uPolitical * 0.55 + 0.06);
              if (abs(id - uHover) < 0.5) gl_FragColor.rgb += vec3(0.07);
              if (abs(id - uSel) < 0.5) gl_FragColor.rgb += vec3(0.05, 0.05, 0.0);
              if (edge) {
                if (realm) gl_FragColor.rgb = mix(gl_FragColor.rgb, fc * 1.1, 0.85);
                else gl_FragColor.rgb *= 0.72;
              }
            }
          }`);
    };
    mat.customProgramCacheKey = () => 'campaign-terrain';
    (mat as unknown as { uniformsRef: typeof uniforms }).uniformsRef = uniforms;
    this.terrainMat = mat;
    const mesh = new THREE.Mesh(g, mat);
    this.scene.add(mesh);
    this.terrainMesh = mesh;
  }

  terrainMesh!: THREE.Mesh;

  private get uniforms() {
    return (this.terrainMat as unknown as { uniformsRef: Record<string, THREE.IUniform> }).uniformsRef;
  }

  private buildWater() {
    const m = this.map;
    // Depth texture for the water colour.
    const depth = new Uint8Array(m.W * m.H);
    for (let i = 0; i < depth.length; i++) depth[i] = Math.max(0, Math.min(255, Math.round(-m.height[i] * 500)));
    const dtex = new THREE.DataTexture(depth, m.W, m.H, THREE.RedFormat);
    dtex.magFilter = dtex.minFilter = THREE.LinearFilter;
    dtex.needsUpdate = true;
    const g = new THREE.PlaneGeometry(m.W * 3, m.H * 3, 1, 1).rotateX(-Math.PI / 2);
    this.waterMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { tDepth: { value: dtex }, uTime: { value: 0 }, uSize: { value: new THREE.Vector2(m.W, m.H) }, uSun: { value: new THREE.Vector3(-0.5, 0.7, 0.4).normalize() } },
      ]),
      vertexShader: `
        varying vec3 vW;
        #include <fog_pars_vertex>
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D tDepth;
        uniform float uTime;
        uniform vec2 uSize;
        uniform vec3 uSun;
        varying vec3 vW;
        #include <fog_pars_fragment>
        float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1, 0)), u.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), u.x), u.y); }
        void main() {
          vec2 uv = (vW.xz + uSize * 0.5) / uSize;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          float d = inside > 0.5 ? texture2D(tDepth, uv).r : 1.0;
          vec3 shallow = vec3(0.16, 0.46, 0.52);
          vec3 deep = vec3(0.04, 0.16, 0.30);
          vec3 col = mix(shallow, deep, smoothstep(0.0, 0.35, d));
          vec2 q = vW.xz * 0.18;
          float w = n2(q + vec2(uTime * 0.35, uTime * 0.2)) + n2(q * 2.3 - vec2(uTime * 0.25, -uTime * 0.3)) * 0.5;
          vec3 nrm = normalize(vec3((w - 0.75) * 0.35, 1.0, (n2(q.yx + uTime * 0.3) - 0.5) * 0.35));
          vec3 view = normalize(cameraPosition - vW);
          float spec = pow(max(0.0, dot(reflect(-uSun, nrm), view)), 60.0);
          float fres = pow(1.0 - max(0.0, view.y), 3.0);
          col = mix(col, vec3(0.72, 0.82, 0.88), fres * 0.5) + spec * 0.6;
          float foam = (1.0 - smoothstep(0.0, 0.03, d)) * (0.55 + 0.45 * sin(uTime * 1.5 + (vW.x + vW.z) * 0.8));
          col = mix(col, vec3(0.92, 0.95, 0.95), foam * 0.45 * inside);
          gl_FragColor = vec4(col, 0.93);
          #include <fog_fragment>
        }`,
    });
    this.water = new THREE.Mesh(g, this.waterMat);
    this.water.position.y = 0.05;
    this.water.renderOrder = 2;
    this.scene.add(this.water);
  }

  private buildForests() {
    const m = this.map;
    const trunk = new THREE.CylinderGeometry(0.06, 0.08, 0.5, 5).translate(0, 0.25, 0);
    const crown = new THREE.ConeGeometry(0.45, 1.5, 6).translate(0, 1.1, 0);
    const colorize = (g: THREE.BufferGeometry, c: number) => {
      const col = new THREE.Color(c);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    };
    const merged = mergeGeometries([colorize(trunk, 0x5a4330), colorize(crown, 0xffffff)]);
    const spots: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const mtx = new THREE.Matrix4();
    for (let y = 2; y < m.H - 2; y += 1.6) {
      for (let x = 2; x < m.W - 2; x += 1.6) {
        const jx = x + (hash(x, y) - 0.5) * 1.4;
        const jy = y + (hash(y, x) - 0.5) * 1.4;
        const h = m.heightAt(jx, jy);
        if (h < 0.02 || h > 0.6) continue;
        const d = m.dryAt(jx, jy);
        if (d > 0.42) continue;
        const n = fbm(jx / 9, jy / 9, 4);
        const dense = (n - 0.5) * 5 * (1 - d * 2.2);
        if (dense < 0.25 || hash(jx * 3.1, jy * 1.7) > Math.min(0.85, dense)) continue;
        if (m.river[Math.floor(jy) * m.W + Math.floor(jx)] > 0.3) continue;
        // Keep towns clear.
        let near = false;
        for (const s of this.c.settlements) if (Math.abs(s.x - jx) < 5 && Math.abs(s.y - jy) < 5) near = true;
        if (near) continue;
        const sc = 0.8 + hash(jx, jy * 2) * 0.7;
        mtx.makeRotationY(hash(jy, jx) * 6.28);
        mtx.scale(new THREE.Vector3(sc, sc * (0.85 + hash(jx * 2, jy) * 0.4), sc));
        const p = this.world(jx, jy);
        mtx.setPosition(p.x, p.y - 0.05, p.z);
        spots.push(mtx.clone());
        const pine = h > 0.3 || d > 0.25;
        colors.push(new THREE.Color(pine ? 0x2f4a26 : 0x3d5b2a).multiplyScalar(0.85 + hash(jx * 5, jy * 7) * 0.3));
      }
    }
    const mesh = new THREE.InstancedMesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }), spots.length);
    spots.forEach((s, i) => {
      mesh.setMatrixAt(i, s);
      mesh.setColorAt(i, colors[i]);
    });
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------------ towns
  private buildTowns() {
    const key = this.c.settlements.map((s) => `${settlementLevel(s.pop)}${s.buildings.walls ?? 0}${s.buildings.temple ?? 0}`).join('');
    if (key === this.townKey) return;
    this.townKey = key;
    for (const m of [this.houses, this.roofs, this.walls, this.temples]) {
      if (m) {
        this.scene.remove(m);
        m.dispose();
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const roof = new THREE.ConeGeometry(0.75, 0.5, 4).rotateY(Math.PI / 4).translate(0, 1.25, 0);
    const wallSeg = new THREE.BoxGeometry(1, 1, 0.25).translate(0, 0.5, 0);
    const temple = new THREE.BoxGeometry(1.6, 0.9, 1).translate(0, 0.45, 0);
    const H: THREE.Matrix4[] = [];
    const W: { m: THREE.Matrix4; stone: boolean }[] = [];
    const T: THREE.Matrix4[] = [];
    const m4 = new THREE.Matrix4();
    for (const s of this.c.settlements) {
      const lvl = settlementLevel(s.pop);
      const count = [3, 6, 10, 16, 24, 32][lvl];
      const rad = 0.9 + lvl * 0.45;
      for (let i = 0; i < count; i++) {
        const a = hash(s.x + i, s.y) * 6.283;
        const r = Math.sqrt(hash(s.y + i * 1.7, s.x)) * rad;
        const x = s.x + Math.cos(a) * r;
        const y = s.y + Math.sin(a) * r;
        const p = this.world(x, y);
        const sx = 0.35 + hash(i, s.x) * 0.25;
        const sy = 0.3 + hash(s.y, i) * 0.35 + (lvl >= 4 ? 0.15 : 0);
        m4.makeRotationY(Math.round(hash(i * 3, s.y) * 4) * (Math.PI / 2) + 0.2);
        m4.scale(new THREE.Vector3(sx, sy, sx * (0.8 + hash(i, i) * 0.6)));
        m4.setPosition(p.x, p.y - 0.05, p.z);
        H.push(m4.clone());
      }
      if ((s.buildings.temple ?? 0) >= 2 || lvl >= 3) {
        const p = this.world(s.x, s.y);
        m4.makeScale(0.8 + lvl * 0.1, 0.8 + lvl * 0.1, 0.8 + lvl * 0.1);
        m4.setPosition(p.x, p.y, p.z);
        T.push(m4.clone());
      }
      const wl = s.buildings.walls ?? 0;
      if (wl > 0) {
        const wr = rad + 0.7;
        const segs = Math.max(10, Math.round(wr * 7));
        for (let i = 0; i < segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          const x = s.x + Math.cos(a) * wr;
          const y = s.y + Math.sin(a) * wr;
          const p = this.world(x, y);
          const len = (2 * Math.PI * wr) / segs + 0.05;
          m4.makeRotationY(-a + Math.PI / 2);
          m4.scale(new THREE.Vector3(len, wl >= 2 ? 0.55 : 0.4, 1));
          m4.setPosition(p.x, p.y - 0.05, p.z);
          W.push({ m: m4.clone(), stone: wl >= 2 });
        }
      }
    }
    const make = (geo: THREE.BufferGeometry, color: number, list: THREE.Matrix4[]) => {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color }), Math.max(1, list.length));
      list.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      mesh.count = list.length;
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
      return mesh;
    };
    this.houses = make(box, 0xe9dfcb, H);
    this.roofs = make(roof, 0xa4523a, H);
    this.temples = make(temple, 0xf2efe6, T);
    this.walls = make(wallSeg, 0x8a7d6b, W.map((w) => w.m));
    W.forEach((w, i) => this.walls.setColorAt(i, new THREE.Color(w.stone ? 0x9c958a : 0x6e5638)));
  }

  updateOwners() {
    const fac = [...this.c.factions.keys()];
    this.c.settlements.forEach((s, i) => {
      const f = this.c.faction(s.owner);
      const col = new THREE.Color(f.color);
      this.ownerData[i * 4] = Math.round(col.r * 255);
      this.ownerData[i * 4 + 1] = Math.round(col.g * 255);
      this.ownerData[i * 4 + 2] = Math.round(col.b * 255);
      this.ownerData[i * 4 + 3] = fac.indexOf(f.id) * 10 + 5; // owner id, used to find realm borders
    });
    this.ownerTex.needsUpdate = true;
    this.buildTowns();
  }

  // ------------------------------------------------------------------ armies
  private crowdFor(a: Army): Crowd | null {
    const f = this.c.faction(a.owner);
    let key = ARMY_MODEL[f.culture] ?? 'gaul_cavalry';
    if (!this.assets.has(key)) key = [...this.assets.keys()].find((k) => k.endsWith('general') || k.endsWith('cavalry')) ?? '';
    const asset = this.assets.get(key);
    if (!asset) return null;
    let crowd = this.crowds.get(key);
    if (!crowd) {
      crowd = new Crowd(asset, 256);
      crowd.mesh.count = 0;
      this.crowds.set(key, crowd);
      this.scene.add(crowd.mesh);
    }
    return crowd;
  }

  /** Smoothly moved positions of the armies, for labels and picking. */
  armyPos(a: Army): { x: number; y: number } {
    const d = this.armyDisplay.get(a.id);
    return d ? { x: d.x, y: d.y } : { x: a.x, y: a.y };
  }

  private updateArmies(dt: number) {
    for (const cr of this.crowds.values()) cr.mesh.count = 0;
    const seen = new Set<number>();
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(3.3, 3.3, 3.3);
    const team = new THREE.Color();
    for (const a of this.c.armies) {
      seen.add(a.id);
      let d = this.armyDisplay.get(a.id);
      if (!d) {
        d = { x: a.x, y: a.y, yaw: 0, walk: 0 };
        this.armyDisplay.set(a.id, d);
      }
      const dx = a.x - d.x;
      const dy = a.y - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.05) {
        const sp = Math.max(18, dist * 2.2) * dt;
        const k = Math.min(1, sp / dist);
        d.x += dx * k;
        d.y += dy * k;
        d.yaw = Math.atan2(dx, dy);
        d.walk += dt;
      } else {
        d.walk = 0;
      }
      if (a.inside) continue; // garrisons are shown by the town
      const crowd = this.crowdFor(a);
      if (!crowd) continue;
      const i = crowd.mesh.count++;
      const p = this.world(d.x, d.y);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.yaw);
      m4.compose(p, q, sc);
      crowd.mesh.setMatrixAt(i, m4);
      crowd.setTeam(i, team.set(this.c.faction(a.owner).color));
      const moving = d.walk > 0 && dist > 0.05;
      crowd.frames.setX(i, moving ? crowd.frameAt('run', this.time * 0.9 + a.id) : crowd.frameAt('idle', this.time + a.id * 0.37));
    }
    for (const cr of this.crowds.values()) {
      cr.mesh.instanceMatrix.needsUpdate = true;
      cr.frames.needsUpdate = true;
      cr.team.needsUpdate = true;
    }
    for (const id of [...this.armyDisplay.keys()]) if (!seen.has(id)) this.armyDisplay.delete(id);
  }

  // ------------------------------------------------------------------ overlays
  showPath(points: { x: number; y: number }[] | null, split = 0) {
    for (const l of [this.pathLine, this.pathLine2]) {
      if (l) {
        this.scene.remove(l);
        l.geometry.dispose();
      }
    }
    this.pathLine = this.pathLine2 = null;
    if (!points || points.length < 2) return;
    // A flat ribbon over the ground reads much better than a 1 px line.
    const mk = (pts: { x: number; y: number }[], color: number) => {
      const v = pts.map((p) => this.world(p.x, p.y, 0.45));
      const pos = new Float32Array(v.length * 2 * 3);
      const w = 0.55;
      for (let i = 0; i < v.length; i++) {
        const a = v[Math.max(0, i - 1)];
        const b = v[Math.min(v.length - 1, i + 1)];
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        pos.set([v[i].x - dz * w, v[i].y, v[i].z + dx * w, v[i].x + dz * w, v[i].y, v[i].z - dx * w], i * 6);
      }
      const idx: number[] = [];
      for (let i = 0; i < v.length - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
      mesh.renderOrder = 10;
      this.scene.add(mesh);
      return mesh;
    };
    const s = Math.max(1, Math.min(points.length, split));
    this.pathLine = mk(points.slice(0, Math.max(2, s)), 0x7dff7a);
    if (s < points.length) this.pathLine2 = mk(points.slice(s - 1), 0xffd25a);
  }

  select(x: number | null, y = 0, r = 4) {
    this.ring.visible = x !== null;
    if (x !== null) {
      this.ring.position.copy(this.world(x, y, 0.3));
      this.ring.scale.setScalar(r / 4);
    }
  }

  hover(x: number | null, y = 0, r = 4) {
    this.hoverRing.visible = x !== null;
    if (x !== null) {
      this.hoverRing.position.copy(this.world(x, y, 0.3));
      this.hoverRing.scale.setScalar(r / 4);
    }
  }

  setProvinceHighlight(hover: number, sel: number) {
    const u = this.uniforms;
    if (!u) return;
    u.uHover.value = hover;
    u.uSel.value = sel;
    u.uPolitical.value = this.political ? 1 : 0;
  }

  /** Screen position of a map point (for HTML labels). */
  project(x: number, y: number, lift = 0): { sx: number; sy: number; vis: boolean; dist: number } {
    const p = this.world(x, y, lift);
    const dist = p.distanceTo(this.camera.position);
    p.project(this.camera);
    const el = this.renderer.domElement;
    return { sx: ((p.x + 1) / 2) * el.clientWidth, sy: ((1 - p.y) / 2) * el.clientHeight, vis: p.z < 1 && p.z > -1, dist };
  }

  /** Map point under the cursor. */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.terrainMesh, false)[0];
    if (hit) return { x: hit.point.x + this.map.W / 2, y: hit.point.z + this.map.H / 2 };
    // Fall back to the sea plane.
    const o = ray.ray.origin;
    const dir = ray.ray.direction;
    if (dir.y >= 0) return null;
    const t = -o.y / dir.y;
    return { x: o.x + dir.x * t + this.map.W / 2, y: o.z + dir.z * t + this.map.H / 2 };
  }

  settlementAt(x: number, y: number): Settlement | null {
    let best: Settlement | null = null;
    let bd = 4.5;
    for (const s of this.c.settlements) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    this.time += dt;
    this.waterMat.uniforms.uTime.value = this.time;
    this.buildTowns();
    this.updateArmies(dt);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !(o instanceof THREE.InstancedMesh && [...this.crowds.values()].some((c) => c.mesh === o))) m.geometry.dispose();
    });
  }
}

/** Minimal geometry merge (positions, normals, colors) to avoid pulling in addons. */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => g.toNonIndexed());
  const n = parts.reduce((t, g) => t + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nrm.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}
