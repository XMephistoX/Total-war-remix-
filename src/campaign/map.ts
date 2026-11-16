// Campaign map rasters: heights, dryness, provinces, rivers, plus path finding on the pixel grid.
// The rasters are built by tools/campaign/build_map.py from Natural Earth coastlines.

export interface MapMeta {
  width: number;
  height: number;
  k: number;
  cos0: number;
  bbox: { lonMin: number; lonMax: number; latMin: number; latMax: number; lat0: number };
  settlements: { id: string; x: number; y: number; port: boolean; area: number }[];
  adjacency: [number, number][];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image ' + url));
    img.src = url;
  });
}

function pixels(img: HTMLImageElement): Uint8ClampedArray {
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height).data;
}

export class MapData {
  readonly W: number;
  readonly H: number;
  readonly meta: MapMeta;
  readonly height: Float32Array; // sea level 0, land up to ~1.1
  readonly dry: Float32Array; // 0..1
  readonly prov: Int16Array; // settlement index or -1
  readonly river: Float32Array; // 0..1
  readonly land: Uint8Array;
  readonly cost: Float32Array; // movement cost multiplier per pixel
  readonly comp: Int32Array; // connected land component
  terrainImg: HTMLImageElement | null = null;
  regionsImg: HTMLImageElement | null = null;
  bordersImg: HTMLImageElement | null = null;

  /** t and r are RGBA pixels of terrain.png and regions.png. */
  constructor(meta: MapMeta, t: ArrayLike<number>, r: ArrayLike<number>) {
    this.meta = meta;
    this.W = meta.width;
    this.H = meta.height;
    const n = this.W * this.H;
    this.height = new Float32Array(n);
    this.dry = new Float32Array(n);
    this.prov = new Int16Array(n);
    this.river = new Float32Array(n);
    this.land = new Uint8Array(n);
    this.cost = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = (t[i * 4] << 8) | t[i * 4 + 1];
      this.height[i] = (v - 32768) / 30000;
      this.dry[i] = t[i * 4 + 2] / 255;
      const p = r[i * 4];
      this.prov[i] = p === 255 ? -1 : p;
      this.river[i] = r[i * 4 + 1] / 255;
      this.land[i] = this.height[i] > 0 ? 1 : 0;
    }
    // Movement cost: slopes, mountains, deserts and rivers slow armies down.
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const i = y * this.W + x;
        if (!this.land[i]) {
          this.cost[i] = 99;
          continue;
        }
        const h = this.height[i];
        const hx = this.height[i + (x < this.W - 1 ? 1 : 0)] - this.height[i - (x > 0 ? 1 : 0)];
        const hy = this.height[i + (y < this.H - 1 ? this.W : 0)] - this.height[i - (y > 0 ? this.W : 0)];
        const slope = Math.hypot(hx, hy);
        this.cost[i] = 1 + slope * 40 + Math.max(0, h - 0.35) * 4 + Math.max(0, this.dry[i] - 0.7) * 2.5 + this.river[i] * 1.5;
      }
    }
    this.comp = new Int32Array(n).fill(-1);
    let c = 0;
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!this.land[i] || this.comp[i] >= 0) continue;
      this.comp[i] = c;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        const x = j % this.W;
        const y = (j - x) / this.W;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
            const k = ny * this.W + nx;
            if (this.land[k] && this.comp[k] < 0) {
              this.comp[k] = c;
              stack.push(k);
            }
          }
        }
      }
      c++;
    }
  }

  static async load(base = './campaign/'): Promise<MapData> {
    const [meta, terrain, regions, borders] = await Promise.all([
      fetch(`${base}map.json`).then((r) => {
        if (!r.ok) throw new Error(`map.json ${r.status}`);
        return r.json() as Promise<MapMeta>;
      }),
      loadImage(`${base}terrain.png`),
      loadImage(`${base}regions.png`),
      loadImage(`${base}borders.png`),
    ]);
    const m = new MapData(meta, pixels(terrain), pixels(regions));
    m.terrainImg = terrain;
    m.regionsImg = regions;
    m.bordersImg = borders;
    return m;
  }

  get settlements() {
    return this.meta.settlements;
  }

  private idx(x: number, y: number): number {
    const xi = Math.max(0, Math.min(this.W - 1, Math.floor(x)));
    const yi = Math.max(0, Math.min(this.H - 1, Math.floor(y)));
    return yi * this.W + xi;
  }

  isLand(x: number, y: number): boolean {
    return this.land[this.idx(x, y)] === 1;
  }

  provinceAt(x: number, y: number): number {
    return this.prov[this.idx(x, y)];
  }

  dryAt(x: number, y: number): number {
    return this.dry[this.idx(x, y)];
  }

  /** Bilinear height in map units (0 = sea level). */
  heightAt(x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.W - 1.001, x - 0.5));
    const fy = Math.max(0, Math.min(this.H - 1.001, y - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const i = y0 * this.W + x0;
    const h = this.height;
    return (h[i] * (1 - tx) + h[i + 1] * tx) * (1 - ty) + (h[i + this.W] * (1 - tx) + h[i + this.W + 1] * tx) * ty;
  }

  /** How hilly the land is around a point (for battle maps). */
  roughness(x: number, y: number): number {
    let mn = 9;
    let mx = -9;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const h = this.heightAt(x + dx, y + dy);
        mn = Math.min(mn, h);
        mx = Math.max(mx, h);
      }
    }
    return Math.max(0, mx - mn);
  }

  landConnected(ax: number, ay: number, bx: number, by: number): boolean {
    const a = this.comp[this.idx(ax, ay)];
    const b = this.comp[this.idx(bx, by)];
    return a >= 0 && a === b;
  }

  stepCost(ax: number, ay: number, bx: number, by: number): number {
    const d = Math.hypot(bx - ax, by - ay);
    return d * 0.5 * (this.cost[this.idx(ax, ay)] + this.cost[this.idx(bx, by)]);
  }

  // ------------------------------------------------------------------ A*
  private g: Float32Array | null = null;
  private from: Int32Array | null = null;
  private closed: Uint8Array | null = null;

  findPath(sx: number, sy: number, tx: number, ty: number, mult: (prov: number) => number, maxNodes = 400000):
    { path: { x: number; y: number }[]; cost: number[] } | null {
    const W = this.W;
    const s = this.idx(sx, sy);
    const t = this.idx(tx, ty);
    if (!this.land[t]) return null;
    if (!this.land[s] || this.comp[s] !== this.comp[t]) return null;
    if (!this.g) this.initSearch();
    const g = this.g!;
    const from = this.from!;
    const closed = this.closed!;
    const touched: number[] = [];
    // Binary heap.
    const hk: number[] = [];
    const hv: number[] = [];
    const push = (k: number, v: number) => {
      hk.push(k);
      hv.push(v);
      let i = hk.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= hk[i]) break;
        [hk[p], hk[i]] = [hk[i], hk[p]];
        [hv[p], hv[i]] = [hv[i], hv[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = hv[0];
      const lk = hk.pop()!;
      const lv = hv.pop()!;
      if (hk.length) {
        hk[0] = lk;
        hv[0] = lv;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < hk.length && hk[l] < hk[m]) m = l;
          if (r < hk.length && hk[r] < hk[m]) m = r;
          if (m === i) break;
          [hk[m], hk[i]] = [hk[i], hk[m]];
          [hv[m], hv[i]] = [hv[i], hv[m]];
          i = m;
        }
      }
      return top;
    };
    const txi = t % W;
    const tyi = (t - txi) / W;
    const hfun = (i: number) => {
      const x = i % W;
      const y = (i - x) / W;
      const dx = Math.abs(x - txi);
      const dy = Math.abs(y - tyi);
      return (Math.max(dx, dy) + 0.414 * Math.min(dx, dy)) * 0.7;
    };
    g[s] = 0;
    from[s] = -1;
    touched.push(s);
    push(hfun(s), s);
    let found = false;
    let expanded = 0;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DY = [0, 0, 1, -1, 1, -1, 1, -1];
    const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
    while (hk.length) {
      const i = pop();
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === t) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) break;
      const x = i % W;
      const y = (i - x) / W;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.H) continue;
        const j = ny * W + nx;
        if (!this.land[j] || closed[j]) continue;
        const c = g[i] + DL[k] * 0.5 * (this.cost[i] + this.cost[j]) * mult(this.prov[j]);
        if (from[j] === -2 || c < g[j]) {
          if (from[j] === -2) touched.push(j);
          g[j] = c;
          from[j] = i;
          push(c + hfun(j), j);
        }
      }
    }
    let out: { path: { x: number; y: number }[]; cost: number[] } | null = null;
    if (found) {
      const rev: number[] = [];
      for (let i = t; i !== s && i >= 0; i = from[i]) rev.push(i);
      rev.reverse();
      out = { path: rev.map((i) => ({ x: (i % W) + 0.5, y: Math.floor(i / W) + 0.5 })), cost: rev.map((i) => g[i]) };
    }
    // Reset touched nodes for the next search.
    for (const i of touched) {
      closed[i] = 0;
      from[i] = -2;
    }
    return out;
  }

  /** Must be called once before the first search so 'from' starts as -2 (unvisited). */
  initSearch() {
    const n = this.W * this.H;
    this.g = new Float32Array(n);
    this.from = new Int32Array(n).fill(-2);
    this.closed = new Uint8Array(n);
  }
}
