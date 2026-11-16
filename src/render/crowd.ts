// GPU-animated crowds. Each unit type is one mesh with bone indices; every soldier picks a
// frame from a baked bone-animation texture in the vertex shader, so thousands of soldiers
// can play different animations for the cost of a few draw calls.
//
// Unit models are converted from 0 A.D. (Wildfire Games, CC BY-SA 3.0) by
// tools/assets/zeroad_units.py.

import * as THREE from 'three';

export interface ClipInfo {
  start: number;
  count: number;
  loop: boolean;
}

export interface UnitAssetMeta {
  vertices: number;
  indices: number;
  indexType: 'u16' | 'u32';
  bones: number;
  frames: number;
  fps: number;
  clips: Record<string, ClipInfo>;
  /** 2+: per-vertex flags (team-colour mask in the atlas alpha). */
  version?: number;
}

export interface UnitAsset {
  key: string;
  meta: UnitAssetMeta;
  geometry: THREE.BufferGeometry;
  animTex: THREE.DataTexture;
  atlas: THREE.Texture;
  material: THREE.MeshLambertMaterial;
}

const cache = new Map<string, Promise<UnitAsset | null>>();

export function loadUnitAsset(key: string, base = './units/'): Promise<UnitAsset | null> {
  if (!cache.has(key)) cache.set(key, load(key, base).catch((e) => {
    console.warn('unit asset failed', key, e);
    return null;
  }));
  return cache.get(key)!;
}

async function load(key: string, base: string): Promise<UnitAsset> {
  const [meta, bin, img] = await Promise.all([
    fetch(`${base}${key}.json`).then((r) => {
      if (!r.ok) throw new Error(`${key}.json ${r.status}`);
      return r.json() as Promise<UnitAssetMeta>;
    }),
    fetch(`${base}${key}.bin`).then((r) => {
      if (!r.ok) throw new Error(`${key}.bin ${r.status}`);
      return r.arrayBuffer();
    }),
    loadImage(`${base}${key}.png`),
  ]);
  const v = meta.vertices;
  let o = 0;
  const pos = new Float32Array(bin, o, v * 3);
  o += v * 12;
  const nrm = new Float32Array(bin, o, v * 3);
  o += v * 12;
  const uv = new Float32Array(bin, o, v * 2);
  o += v * 8;
  const bones = new Uint8Array(bin, o, v * 4);
  o += v * 4;
  const weights = new Uint8Array(bin, o, v * 4);
  o += v * 4;
  let flags: Uint8Array | null = null;
  if ((meta.version ?? 1) >= 2) {
    flags = new Uint8Array(bin, o, v * 4);
    o += v * 4;
  }
  const idxBytes = meta.indices * (meta.indexType === 'u16' ? 2 : 4);
  const idx = meta.indexType === 'u16' ? new Uint16Array(bin.slice(o, o + idxBytes)) : new Uint32Array(bin.slice(o, o + idxBytes));
  o += idxBytes;
  if (o % 4) o += 4 - (o % 4);
  const animLen = meta.frames * meta.bones * 12;
  const half = new Uint16Array(bin.slice(o, o + animLen * 2));

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(bones, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4, true));
  g.setAttribute('crowdFlags', new THREE.BufferAttribute(flags ?? new Uint8Array(v * 4), 4, false));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2.5);

  // Bone texture: width = bones * 3 texels (rows of a 3x4 matrix), height = frames + 1
  // (the last frame is duplicated so frame+1 is always readable).
  const w = meta.bones * 3;
  const h = meta.frames + 1;
  const data = new Uint16Array(w * h * 4);
  data.set(half);
  data.copyWithin(meta.frames * w * 4, (meta.frames - 1) * w * 4, meta.frames * w * 4);
  const animTex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  animTex.needsUpdate = true;

  const atlas = new THREE.Texture(img);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  atlas.needsUpdate = true;

  const material = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: 0.5 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.animTex = { value: animTex };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 skinIndex;
        attribute vec4 skinWeight;
        attribute float animFrame;
        attribute vec4 crowdFlags;
        attribute vec3 teamColor;
        varying float vPlayer;
        varying vec3 vTeam;
        uniform highp sampler2D animTex;
        mat4 boneAt(int b, int f) {
          vec4 r0 = texelFetch(animTex, ivec2(b * 3, f), 0);
          vec4 r1 = texelFetch(animTex, ivec2(b * 3 + 1, f), 0);
          vec4 r2 = texelFetch(animTex, ivec2(b * 3 + 2, f), 0);
          return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
        }
        mat4 crowdSkin() {
          int f0 = int(floor(animFrame));
          float t = fract(animFrame);
          mat4 m = mat4(0.0);
          for (int i = 0; i < 4; i++) {
            float w = skinWeight[i];
            if (w > 0.0) {
              int b = int(skinIndex[i] + 0.5);
              m += w * ((1.0 - t) * boneAt(b, f0) + t * boneAt(b, f0 + 1));
            }
          }
          return m;
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `mat4 crowdM = crowdSkin();
        vec3 objectNormal = normalize(mat3(crowdM) * normal);
        #ifdef USE_TANGENT
        vec3 objectTangent = vec3( tangent.xyz );
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = (crowdM * vec4(position, 1.0)).xyz;
        vPlayer = crowdFlags.x;
        vTeam = teamColor;
        #ifdef USE_ALPHAHASH
        vPosition = vec3( position );
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vPlayer;
        varying vec3 vTeam;`)
      .replace('#include <map_fragment>', `
        vec4 crowdTex = texture2D(map, vMapUv);
        if (vPlayer > 0.5) {
          // 0 A.D. player materials: alpha is 1 where the texture shows, 0 where the team colour shows.
          float m = 1.0 - crowdTex.a;
          float lum = dot(crowdTex.rgb, vec3(0.3333));
          crowdTex.rgb = mix(crowdTex.rgb, vTeam * (0.42 + 0.58 * sqrt(lum)), m);
          crowdTex.a = 1.0;
        }
        diffuseColor *= crowdTex;`);
  };
  material.customProgramCacheKey = () => `crowd-${key}`;
  return { key, meta, geometry: g, animTex, atlas, material };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image ' + url));
    img.src = url;
  });
}

/** An instanced crowd of one unit type. */
export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  readonly frames: THREE.InstancedBufferAttribute;
  readonly team: THREE.InstancedBufferAttribute;
  readonly asset: UnitAsset;

  constructor(asset: UnitAsset, count: number) {
    this.asset = asset;
    const geo = asset.geometry.clone();
    this.frames = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.frames.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('animFrame', this.frames);
    this.team = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(0.5), 3);
    geo.setAttribute('teamColor', this.team);
    this.mesh = new THREE.InstancedMesh(geo, asset.material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
  }

  /** Team colour of one instance (linear RGB, from a THREE.Color). */
  setTeam(i: number, c: THREE.Color) {
    this.team.setXYZ(i, c.r, c.g, c.b);
    this.team.needsUpdate = true;
  }

  /** Absolute frame (with fraction) for a clip at a time in seconds. */
  frameAt(clip: string, t: number, loop?: boolean): number {
    const c = this.asset.meta.clips[clip] ?? this.asset.meta.clips.idle;
    if (!c) return 0;
    const fps = this.asset.meta.fps;
    let f = t * fps;
    const last = c.count - 1;
    if (loop ?? c.loop) {
      f = f % last;
      if (f < 0) f += last;
    } else {
      f = Math.max(0, Math.min(last, f));
    }
    return c.start + f;
  }

  has(clip: string): boolean {
    return clip in this.asset.meta.clips;
  }

  duration(clip: string): number {
    const c = this.asset.meta.clips[clip];
    return c ? (c.count - 1) / this.asset.meta.fps : 1;
  }
}
