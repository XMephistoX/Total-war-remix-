// Tree models converted from 0 A.D. (Wildfire Games, CC BY-SA 3.0) by tools/assets/zeroad_trees.py.

import * as THREE from 'three';
import { BIN_EXT } from './crowd';

interface PartMeta {
  tex: string;
  vOffset: number;
  vCount: number;
  iOffset: number;
  iCount: number;
}

interface TreesMeta {
  kinds: { name: string; variants: { parts: PartMeta[] }[] }[];
}

export interface TreePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface TreeKind {
  name: string;
  variants: TreePart[][];
}

let cache: Promise<TreeKind[] | null> | null = null;

export function loadTrees(base = './trees/'): Promise<TreeKind[] | null> {
  if (!cache) cache = load(base).catch((e) => {
    console.warn('trees failed', e);
    return null;
  });
  return cache;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

async function load(base: string): Promise<TreeKind[]> {
  const [meta, bin] = await Promise.all([
    fetch(`${base}trees.json`).then((r) => {
      if (!r.ok) throw new Error(`trees.json ${r.status}`);
      return r.json() as Promise<TreesMeta>;
    }),
    fetch(`${base}trees${BIN_EXT}`).then((r) => {
      if (!r.ok) throw new Error(`trees${BIN_EXT} ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const names = [...new Set(meta.kinds.flatMap((k) => k.variants.flatMap((v) => v.parts.map((p) => p.tex))))];
  const images = await Promise.all(names.map((n) => loadImage(base + n)));
  const materials = new Map<string, THREE.Material>();
  names.forEach((n, i) => {
    const tex = new THREE.Texture(images[i]);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    materials.set(n, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide }));
  });
  return meta.kinds.map((k) => ({
    name: k.name,
    variants: k.variants.map((v) => v.parts.map((p) => {
      const verts = new Float32Array(bin, p.vOffset, p.vCount * 8);
      const inter = new THREE.InterleavedBuffer(verts, 8);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.InterleavedBufferAttribute(inter, 3, 0));
      g.setAttribute('normal', new THREE.InterleavedBufferAttribute(inter, 3, 3));
      g.setAttribute('uv', new THREE.InterleavedBufferAttribute(inter, 2, 6));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, p.iOffset, p.iCount), 1));
      g.computeBoundingSphere();
      return { geometry: g, material: materials.get(p.tex)! };
    })),
  }));
}
