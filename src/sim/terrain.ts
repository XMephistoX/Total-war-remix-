import { Rng } from './rng';

// Heightfield battlefield. Coordinates are meters, centered on (0,0).
// Player army deploys around z = +150 facing north (-z), enemy around z = -150.
export class Terrain {
  readonly size: number;
  readonly cell: number;
  readonly n: number; // vertices per side
  readonly h: Float32Array;
  readonly half: number;
  readonly hills: { x: number; z: number; r: number; h: number }[] = [];

  readonly hilliness: number;

  constructor(seed: number, size = 800, cell = 2, hilliness = 1) {
    this.hilliness = hilliness;
    this.size = size;
    this.cell = cell;
    this.half = size / 2;
    this.n = Math.round(size / cell) + 1;
    this.h = new Float32Array(this.n * this.n);
    this.generate(seed);
  }

  private generate(seed: number) {
    const rng = new Rng(seed * 7919 + 13);
    const perm = new Uint8Array(512);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const grad = (hash: number, x: number, y: number) => {
      const g = hash & 7;
      const u = g < 4 ? x : y;
      const v = g < 4 ? y : x;
      return ((g & 1) ? -u : u) + ((g & 2) ? -2 * v : 2 * v);
    };
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const noise = (x: number, y: number) => {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      x -= Math.floor(x);
      y -= Math.floor(y);
      const u = fade(x);
      const v = fade(y);
      const a = perm[X] + Y;
      const b = perm[X + 1] + Y;
      const l1 = grad(perm[a], x, y) + u * (grad(perm[b], x - 1, y) - grad(perm[a], x, y));
      const l2 = grad(perm[a + 1], x, y - 1) + u * (grad(perm[b + 1], x - 1, y - 1) - grad(perm[a + 1], x, y - 1));
      return (l1 + v * (l2 - l1)) * 0.35;
    };

    // A few big hills so there is real high ground to fight over.
    const hillCount = 3 + rng.int(3);
    for (let i = 0; i < hillCount; i++) {
      this.hills.push({
        x: rng.range(-260, 260),
        z: rng.range(-200, 200),
        r: rng.range(45, 110),
        h: rng.range(7, 20) * this.hilliness,
      });
    }

    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const x = -this.half + i * this.cell;
        const z = -this.half + j * this.cell;
        let y = 0;
        // Rolling ground.
        y += noise(x / 160, z / 160) * 6 * Math.sqrt(this.hilliness);
        y += noise(x / 60 + 31, z / 60 + 17) * 1.6;
        y += noise(x / 18 + 71, z / 18 + 5) * 0.35;
        for (const hl of this.hills) {
          const d2 = ((x - hl.x) ** 2 + (z - hl.z) ** 2) / (hl.r * hl.r);
          y += hl.h * Math.exp(-d2 * 1.6);
        }
        // Rise towards the map edge so the battlefield reads as a valley.
        const edge = Math.max(Math.abs(x), Math.abs(z)) / this.half;
        if (edge > 0.82) y += (edge - 0.82) * (edge - 0.82) * 900;
        this.h[j * this.n + i] = y;
      }
    }
  }

  height(x: number, z: number): number {
    const fx = (x + this.half) / this.cell;
    const fz = (z + this.half) / this.cell;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i < 0) i = 0;
    if (j < 0) j = 0;
    if (i > this.n - 2) i = this.n - 2;
    if (j > this.n - 2) j = this.n - 2;
    const tx = Math.min(1, Math.max(0, fx - i));
    const tz = Math.min(1, Math.max(0, fz - j));
    const n = this.n;
    const h00 = this.h[j * n + i];
    const h10 = this.h[j * n + i + 1];
    const h01 = this.h[(j + 1) * n + i];
    const h11 = this.h[(j + 1) * n + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Rise per meter when moving in direction (dx,dz) (unit vector). Positive = uphill. */
  slope(x: number, z: number, dx: number, dz: number): number {
    return this.height(x + dx, z + dz) - this.height(x, z);
  }
}
