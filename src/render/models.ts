// Placeholder soldier models built from primitives. One merged mesh per (visual, faction),
// drawn with GPU instancing. These get swapped for real low-poly models later; the rest of
// the game only cares about the Visual id.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FactionDef, Visual } from '../sim/data';

const SKIN = 0xc99a74;
const METAL = 0x9aa0a6;
const DARK = 0x3b3128;
const WOOD = 0x7a5532;
const HORSE = 0x6b4a2f;
const HORSE_DARK = 0x3d2a1c;

type Part = THREE.BufferGeometry;

function colorize(g: Part, color: number): Part {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.index) {
    const ng = g.toNonIndexed();
    g.dispose();
    return ng;
  }
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx = 0, ry = 0, rz = 0): Part {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.rotateX(rx), g.rotateY(ry), g.rotateZ(rz);
  g.translate(x, y, z);
  return colorize(g, color);
}

function cyl(r1: number, r2: number, h: number, x: number, y: number, z: number, color: number, rx = 0, rz = 0, seg = 6): Part {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return colorize(g, color);
}

function ball(r: number, x: number, y: number, z: number, color: number, half = false): Part {
  const g = new THREE.SphereGeometry(r, 7, half ? 3 : 5, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI);
  g.translate(x, y, z);
  return colorize(g, color);
}

function cone(r: number, h: number, x: number, y: number, z: number, color: number, rx = 0): Part {
  const g = new THREE.ConeGeometry(r, h, 6);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return colorize(g, color);
}

/** A standing soldier facing +Z with feet at y = 0. */
function footSoldier(f: FactionDef, opts: { shield: 'scutum' | 'round' | 'none'; weapon: 'sword' | 'spear' | 'bow' | 'javelin' }, y0 = 0): Part[] {
  const roman = f.culture === 'roman';
  const legs = roman ? SKIN : 0x6a5a40; // Gauls wear trousers
  const p: Part[] = [];
  p.push(box(0.13, 0.82, 0.15, -0.1, y0 + 0.41, 0, legs));
  p.push(box(0.13, 0.82, 0.15, 0.1, y0 + 0.41, 0, legs));
  p.push(box(0.44, 0.62, 0.26, 0, y0 + 1.12, 0, f.primary)); // tunic
  if (roman) p.push(box(0.46, 0.34, 0.28, 0, y0 + 1.25, 0, METAL)); // mail / pectorale
  p.push(box(0.11, 0.5, 0.11, -0.29, y0 + 1.15, 0.05, f.primary, 0.3));
  p.push(box(0.11, 0.5, 0.11, 0.29, y0 + 1.15, 0.08, SKIN, -0.6));
  p.push(ball(0.12, 0, y0 + 1.57, 0, SKIN));
  if (roman) {
    p.push(ball(0.135, 0, y0 + 1.6, 0, METAL, true));
    p.push(box(0.04, 0.12, 0.2, 0, y0 + 1.76, -0.01, f.trim));
  } else {
    p.push(ball(0.13, 0, y0 + 1.61, -0.02, 0xb98a3c, true)); // hair
  }
  if (opts.shield === 'scutum') {
    p.push(box(0.56, 0.95, 0.06, -0.33, y0 + 1.0, 0.18, f.secondary));
    p.push(ball(0.07, -0.33, y0 + 1.0, 0.22, f.trim));
  } else if (opts.shield === 'round') {
    p.push(cyl(0.3, 0.3, 0.05, -0.33, y0 + 1.05, 0.18, f.secondary, Math.PI / 2, 0, 10));
    p.push(ball(0.06, -0.33, y0 + 1.05, 0.21, f.trim));
  }
  if (opts.weapon === 'sword') {
    p.push(box(0.05, 0.05, 0.62, 0.32, y0 + 1.0, 0.38, METAL));
  } else if (opts.weapon === 'spear') {
    p.push(cyl(0.025, 0.025, 3.4, 0.3, y0 + 1.3, 0.5, WOOD, 1.2));
    p.push(cone(0.05, 0.25, 0.3, y0 + 1.3 + Math.cos(1.2) * 1.7, 0.5 + Math.sin(1.2) * 1.7 + 0.1, METAL, 1.2));
  } else if (opts.weapon === 'javelin') {
    p.push(cyl(0.018, 0.018, 1.7, 0.32, y0 + 1.45, 0.1, WOOD, 0.25));
  } else if (opts.weapon === 'bow') {
    p.push(box(0.04, 1.15, 0.04, -0.32, y0 + 1.2, 0.22, WOOD, 0, 0, 0.12));
    p.push(cyl(0.07, 0.06, 0.55, 0.08, y0 + 1.25, -0.2, DARK, 0.25)); // quiver
  }
  return p;
}

function horseman(f: FactionDef, general: boolean): Part[] {
  const p: Part[] = [];
  // Horse.
  p.push(box(0.5, 0.58, 1.7, 0, 1.28, 0, HORSE));
  p.push(box(0.26, 0.75, 0.32, 0, 1.75, 0.82, HORSE, -0.55));
  p.push(box(0.2, 0.22, 0.55, 0, 2.08, 1.15, HORSE, 0.35));
  for (const [x, z] of [
    [-0.17, 0.62],
    [0.17, 0.62],
    [-0.17, -0.62],
    [0.17, -0.62],
  ]) {
    p.push(box(0.12, 1.0, 0.13, x, 0.5, z, HORSE_DARK));
  }
  p.push(box(0.08, 0.6, 0.1, 0, 1.2, -0.92, HORSE_DARK, -0.4));
  p.push(box(0.56, 0.08, 0.7, 0, 1.6, -0.05, f.primary)); // saddle cloth
  // Rider.
  const roman = f.culture === 'roman';
  p.push(box(0.14, 0.5, 0.16, -0.27, 1.62, 0.05, roman ? SKIN : 0x6a5a40, 0.6));
  p.push(box(0.14, 0.5, 0.16, 0.27, 1.62, 0.05, roman ? SKIN : 0x6a5a40, 0.6));
  p.push(box(0.42, 0.6, 0.26, 0, 2.0, -0.05, f.primary));
  if (roman || general) p.push(box(0.44, 0.32, 0.28, 0, 2.12, -0.05, METAL));
  p.push(ball(0.12, 0, 2.45, -0.05, SKIN));
  p.push(ball(0.135, 0, 2.48, -0.05, METAL, true));
  p.push(cyl(0.3, 0.3, 0.05, -0.3, 2.0, 0.05, f.secondary, Math.PI / 2, 0, 10));
  p.push(cyl(0.025, 0.025, 2.8, 0.3, 2.05, 0.6, WOOD, 1.35));
  if (general) {
    p.push(box(0.05, 0.25, 0.28, 0, 2.7, -0.05, f.trim)); // plume
    p.push(box(0.5, 0.7, 0.05, 0, 1.95, -0.23, f.trim, 0.2)); // cape
  }
  return p;
}

export function buildSoldierGeometry(visual: Visual, f: FactionDef): THREE.BufferGeometry {
  const roman = f.culture === 'roman';
  let parts: Part[];
  switch (visual) {
    case 'sword':
      parts = footSoldier(f, { shield: roman ? 'scutum' : 'round', weapon: 'sword' });
      break;
    case 'spear':
      parts = footSoldier(f, { shield: roman ? 'scutum' : 'round', weapon: 'spear' });
      break;
    case 'archer':
      parts = footSoldier(f, { shield: 'none', weapon: 'bow' });
      break;
    case 'skirmisher':
      parts = footSoldier(f, { shield: 'round', weapon: 'javelin' });
      break;
    case 'cavalry':
      parts = horseman(f, false);
      break;
    case 'general':
      parts = horseman(f, true);
      break;
  }
  const g = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  g.computeBoundingSphere();
  return g;
}

export function buildArrowGeometry(): THREE.BufferGeometry {
  const shaft = box(0.035, 0.035, 0.85, 0, 0, 0, 0x5b4630);
  const head = box(0.06, 0.06, 0.1, 0, 0, 0.45, 0x8a8f96);
  const fl = box(0.12, 0.01, 0.12, 0, 0, -0.38, 0xe8e2d0);
  const g = mergeGeometries([shaft, head, fl], false)!;
  return g;
}
