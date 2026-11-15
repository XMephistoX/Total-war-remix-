// Battle simulation. Pure logic with no rendering, so it runs in the browser, in Node for
// headless tests, and can later be ported to another engine.
//
// Design:
// - Every soldier is simulated individually but cheaply (struct-of-arrays, spatial grid).
// - Units hold the "brains": orders, formation anchor, morale, fatigue. Soldiers just walk
//   to their formation slot or, when enemies are close, pick a foe and roll dice.
// - Fixed timestep (DT) so results are reproducible for a given seed.

import { Rng } from './rng';
import { Terrain } from './terrain';
import { ARMIES, FACTIONS, UNITS, UNIT_SIZE_SCALE } from './data';
import type { FactionDef, UnitDef, UnitSize } from './data';

export const DT = 0.05;
export const BOUND = 345; // soldiers who run past this have left the field
const GRAVITY = 9.8;

export type UnitState = 'ok' | 'wavering' | 'routing' | 'shattered' | 'destroyed' | 'fled';
export type OrderKind = 'none' | 'move' | 'attack';

export interface Order {
  kind: OrderKind;
  x: number;
  z: number;
  fx: number;
  fz: number;
  files: number;
  target: number;
  run: boolean;
}

export interface MoraleMod {
  label: string;
  value: number;
}

export interface BattleEvent {
  t: number;
  side: number;
  unit: number;
  kind: 'rout' | 'rally' | 'shattered' | 'general' | 'charge' | 'victory';
  text: string;
}

export const enum Anim {
  Idle = 0,
  Walk = 1,
  Run = 2,
  Attack = 3,
  Block = 4,
  Dead = 5,
  Shoot = 6,
  Flee = 7,
}

export interface FatigueLevel {
  name: string;
  atk: number;
  def: number;
  speed: number;
  morale: number;
  canRun: boolean;
}

export function fatigueLevel(energy: number): FatigueLevel {
  if (energy >= 75) return { name: 'Fresh', atk: 0, def: 0, speed: 1, morale: 0, canRun: true };
  if (energy >= 55) return { name: 'Active', atk: 0, def: 0, speed: 1, morale: 0, canRun: true };
  if (energy >= 35) return { name: 'Winded', atk: -1, def: 0, speed: 0.95, morale: 0, canRun: true };
  if (energy >= 18) return { name: 'Tired', atk: -2, def: -1, speed: 0.9, morale: -4, canRun: true };
  if (energy >= 6) return { name: 'Very tired', atk: -3, def: -2, speed: 0.82, morale: -8, canRun: true };
  return { name: 'Exhausted', atk: -4, def: -3, speed: 0.72, morale: -14, canRun: false };
}

export class Unit {
  readonly id: number;
  readonly side: number;
  readonly def: UnitDef;
  readonly faction: FactionDef;
  /** Soldier indices, sorted by formation slot (index in this array == slot). */
  ranks: number[] = [];
  readonly all: number[] = [];
  readonly startMen: number;
  alive: number;
  // Formation anchor (center of the formation) and facing.
  cx: number;
  cz: number;
  fx: number;
  fz: number;
  files: number;
  order: Order;
  moving = false;
  running = false;
  seekR = 2.6;
  moveSpeed = 1;
  energy = 100;
  morale: number;
  mods: MoraleMod[] = [];
  state: UnitState = 'ok';
  routCount = 0;
  routTime = 0;
  rallyTimer = 0;
  rallied = false;
  chargeT = 0;
  chargeReady = true;
  noMeleeTime = 0;
  noContactTime = 99;
  meleeTime = 0;
  recentLoss = 0;
  shock = 0;
  missileHitT = -99;
  quad = [0, 0, 0, 0]; // enemy units attacking from: front, left, right, rear
  inMelee = 0;
  inMeleePrev = 0;
  mx = 0;
  mz = 0;
  my = 0;
  lag = 0;
  lagSum = 0;
  lagCount = 0;
  fleeX = 0;
  fleeZ = 1;
  fireTarget = -1;
  fireAtWill = true;
  kills = 0;
  slotsDirty = false;
  readonly isGeneral: boolean;
  /** Offset in the army frame used by the AI to keep a battle line. */
  homeDx = 0;
  homeDz = 0;
  aiTargetTime = 0;

  constructor(id: number, side: number, def: UnitDef, faction: FactionDef, men: number, cx: number, cz: number, fx: number, fz: number) {
    this.id = id;
    this.side = side;
    this.def = def;
    this.faction = faction;
    this.startMen = men;
    this.alive = men;
    this.cx = cx;
    this.cz = cz;
    this.fx = fx;
    this.fz = fz;
    this.files = Math.ceil(men / def.ranks);
    this.morale = def.morale;
    this.isGeneral = def.cls === 'general';
    this.order = { kind: 'none', x: cx, z: cz, fx, fz, files: 0, target: -1, run: false };
  }

  get active(): boolean {
    return (this.state === 'ok' || this.state === 'wavering') && this.alive > 0;
  }
  get routing(): boolean {
    return this.state === 'routing' || this.state === 'shattered';
  }
  get gone(): boolean {
    return this.state === 'destroyed' || this.state === 'fled';
  }
  get fileCount(): number {
    return Math.max(1, Math.min(this.files, this.alive));
  }
  get rankCount(): number {
    return Math.ceil(this.alive / this.fileCount);
  }
  get width(): number {
    return this.fileCount * this.def.spacing;
  }
  get depth(): number {
    return this.rankCount * this.def.rankSpacing;
  }
  get moraleTarget(): number {
    let m = this.def.morale;
    for (const mod of this.mods) m += mod.value;
    return m - this.shock;
  }
}

export interface SideInfo {
  faction: FactionDef;
  general: number; // unit id
  generalSoldier: number;
  generalAlive: boolean;
  startMen: number;
  ai: boolean;
}

export interface BattleOptions {
  seed: number;
  size: UnitSize;
  factions: [string, string];
  aiSides: [boolean, boolean];
}

export class Battle {
  readonly rng: Rng;
  readonly terrain: Terrain;
  readonly opts: BattleOptions;
  time = 0;
  tick = 0;
  units: Unit[] = [];
  sides: SideInfo[] = [];
  events: BattleEvent[] = [];
  result: { winner: number; time: number } | null = null;

  // ---- soldiers (struct of arrays) ----
  N = 0;
  x!: Float32Array;
  z!: Float32Array;
  px!: Float32Array;
  pz!: Float32Array;
  vx!: Float32Array;
  vz!: Float32Array;
  yaw!: Float32Array;
  pyaw!: Float32Array;
  unitOf!: Int32Array;
  sideOf!: Uint8Array;
  hp!: Int8Array;
  dead!: Uint8Array; // 0 alive, 1 dead, 2 fled
  slot!: Int32Array;
  target!: Int32Array;
  atkT!: Float32Array;
  reload!: Float32Array;
  impactCd!: Float32Array;
  anim!: Uint8Array;
  animT!: Float32Array;
  ammo!: Int16Array;
  radius!: Float32Array;
  phase!: Float32Array;

  // ---- spatial grid ----
  private readonly cellSize = 3;
  private gw = 0;
  private cellStart!: Int32Array;
  private cellCount!: Int32Array;
  private cellCursor!: Int32Array;
  private gridIdx!: Int32Array;

  // ---- projectiles ----
  readonly PMAX = 4000;
  pAlive = new Uint8Array(this.PMAX);
  pX = new Float32Array(this.PMAX);
  pY = new Float32Array(this.PMAX);
  pZ = new Float32Array(this.PMAX);
  pVX = new Float32Array(this.PMAX);
  pVY = new Float32Array(this.PMAX);
  pVZ = new Float32Array(this.PMAX);
  pPrevY = new Float32Array(this.PMAX);
  pDmg = new Float32Array(this.PMAX);
  pKind = new Uint8Array(this.PMAX); // 0 arrow, 1 javelin
  pUnit = new Int32Array(this.PMAX);
  pCursor = 0;
  pCount = 0;

  /** engage[a * nU + b] = soldiers of unit a fighting unit b this tick. */
  engage!: Float32Array;
  private nU = 0;
  private tmp = { x: 0, z: 0 };

  constructor(opts: BattleOptions) {
    this.opts = opts;
    this.rng = new Rng(opts.seed);
    this.terrain = new Terrain(opts.seed);
    this.setup();
  }

  // ------------------------------------------------------------------ setup
  private setup() {
    const scale = UNIT_SIZE_SCALE[this.opts.size];
    const plans: { side: number; def: UnitDef; men: number; cx: number; cz: number; fx: number; fz: number; dx: number; dz: number }[] = [];
    for (let side = 0; side < 2; side++) {
      const fid = this.opts.factions[side];
      const army = ARMIES[fid];
      const fz = side === 0 ? -1 : 1;
      const fx = 0;
      const ccx = 0;
      const ccz = side === 0 ? 170 : -170;
      const rx = -fz;
      const rz = fx;
      for (const s of army) {
        const def = UNITS[s.unit];
        const men = Math.max(def.mounted ? 8 : 12, Math.round(def.men * scale));
        plans.push({ side, def, men, cx: ccx + rx * s.dx - fx * s.dz, cz: ccz + rz * s.dx - fz * s.dz, fx, fz, dx: s.dx, dz: s.dz });
      }
    }
    this.N = plans.reduce((a, p) => a + p.men, 0);
    const N = this.N;
    this.x = new Float32Array(N);
    this.z = new Float32Array(N);
    this.px = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vz = new Float32Array(N);
    this.yaw = new Float32Array(N);
    this.pyaw = new Float32Array(N);
    this.unitOf = new Int32Array(N);
    this.sideOf = new Uint8Array(N);
    this.hp = new Int8Array(N);
    this.dead = new Uint8Array(N);
    this.slot = new Int32Array(N);
    this.target = new Int32Array(N).fill(-1);
    this.atkT = new Float32Array(N);
    this.reload = new Float32Array(N);
    this.impactCd = new Float32Array(N);
    this.anim = new Uint8Array(N);
    this.animT = new Float32Array(N);
    this.ammo = new Int16Array(N);
    this.radius = new Float32Array(N);
    this.phase = new Float32Array(N);

    this.gw = Math.ceil(this.terrain.size / this.cellSize);
    this.cellStart = new Int32Array(this.gw * this.gw);
    this.cellCount = new Int32Array(this.gw * this.gw);
    this.cellCursor = new Int32Array(this.gw * this.gw);
    this.gridIdx = new Int32Array(N);

    for (let side = 0; side < 2; side++) {
      this.sides.push({
        faction: FACTIONS[this.opts.factions[side]],
        general: -1,
        generalSoldier: -1,
        generalAlive: true,
        startMen: 0,
        ai: this.opts.aiSides[side],
      });
    }

    let si = 0;
    for (const p of plans) {
      const u = new Unit(this.units.length, p.side, p.def, this.sides[p.side].faction, p.men, p.cx, p.cz, p.fx, p.fz);
      u.homeDx = p.dx;
      u.homeDz = p.dz;
      this.units.push(u);
      this.sides[p.side].startMen += p.men;
      for (let k = 0; k < p.men; k++) {
        const i = si++;
        u.all.push(i);
        u.ranks.push(i);
        this.slot[i] = k;
        this.unitOf[i] = u.id;
        this.sideOf[i] = p.side;
        this.hp[i] = p.def.hp;
        this.radius[i] = p.def.radius;
        this.ammo[i] = p.def.missile ? p.def.missile.ammo : 0;
        this.atkT[i] = this.rng.range(0, 2);
        this.reload[i] = this.rng.range(0, 3);
        this.phase[i] = this.rng.next() * Math.PI * 2;
        this.slotPos(u, k, this.tmp);
        this.x[i] = this.px[i] = this.tmp.x + this.rng.range(-0.2, 0.2);
        this.z[i] = this.pz[i] = this.tmp.z + this.rng.range(-0.2, 0.2);
        this.yaw[i] = this.pyaw[i] = Math.atan2(p.fx, p.fz);
      }
      if (u.isGeneral) {
        const sd = this.sides[p.side];
        sd.general = u.id;
        sd.generalSoldier = u.all[0];
        this.hp[u.all[0]] = 4;
      }
    }
    this.nU = this.units.length;
    this.engage = new Float32Array(this.nU * this.nU);
    this.buildGrid();
    this.computeAggregates();
    for (const u of this.units) {
      this.updateMoraleMods(u);
      u.morale = Math.min(100, u.moraleTarget);
    }
  }

  // ------------------------------------------------------------------ orders
  orderMove(uid: number, x: number, z: number, fx: number, fz: number, run: boolean, files = 0) {
    const u = this.units[uid];
    if (!u || !u.active) return;
    const l = Math.hypot(fx, fz) || 1;
    const lim = BOUND - 25;
    x = Math.max(-lim, Math.min(lim, x));
    z = Math.max(-lim, Math.min(lim, z));
    u.order = { kind: 'move', x, z, fx: fx / l, fz: fz / l, files, target: -1, run };
    if (files > 0) {
      const minFiles = Math.ceil(u.alive / 12);
      u.files = Math.max(minFiles, Math.min(u.alive, Math.round(files)));
      u.slotsDirty = true;
    }
    if (u.def.missile) u.fireTarget = -1;
  }

  orderAttack(uid: number, target: number, run: boolean) {
    const u = this.units[uid];
    const t = this.units[target];
    if (!u || !u.active || !t || t.side === u.side || t.gone) return;
    u.order = { kind: 'attack', x: t.mx, z: t.mz, fx: u.fx, fz: u.fz, files: 0, target, run };
    if (u.def.missile) u.fireTarget = target;
  }

  orderHalt(uid: number) {
    const u = this.units[uid];
    if (!u || !u.active) return;
    u.order = { kind: 'none', x: u.cx, z: u.cz, fx: u.fx, fz: u.fz, files: 0, target: -1, run: false };
    u.cx = u.mx;
    u.cz = u.mz;
    u.slotsDirty = true;
  }

  // ------------------------------------------------------------------ main step
  step() {
    if (this.result && this.tick > 0 && this.time - this.result.time > 600) return;
    const dt = DT;
    this.time += dt;
    this.tick++;
    this.px.set(this.x);
    this.pz.set(this.z);
    this.pyaw.set(this.yaw);
    this.buildGrid();
    this.computeAggregates();
    this.engage.fill(0);
    for (const u of this.units) {
      u.inMeleePrev = u.inMelee;
      u.inMelee = 0;
    }
    for (const u of this.units) this.updateUnit(u, dt);
    this.updateSoldiers(dt);
    this.updateProjectiles(dt);
    this.resolveCollisions();
    for (const u of this.units) {
      u.recentLoss *= Math.exp(-dt / 7);
      u.shock *= Math.exp(-dt / 12);
      u.lag = u.lagCount > 0 ? u.lagSum / u.lagCount : 0;
      u.lagSum = 0;
      u.lagCount = 0;
    }
    this.checkVictory();
  }

  // ------------------------------------------------------------------ grid
  private cellIndex(x: number, z: number): number {
    const h = this.terrain.half;
    let gx = Math.floor((x + h) / this.cellSize);
    let gz = Math.floor((z + h) / this.cellSize);
    if (gx < 0) gx = 0;
    else if (gx >= this.gw) gx = this.gw - 1;
    if (gz < 0) gz = 0;
    else if (gz >= this.gw) gz = this.gw - 1;
    return gz * this.gw + gx;
  }

  private buildGrid() {
    const cc = this.cellCount;
    cc.fill(0);
    const N = this.N;
    for (let i = 0; i < N; i++) if (this.dead[i] === 0) cc[this.cellIndex(this.x[i], this.z[i])]++;
    let acc = 0;
    for (let c = 0; c < cc.length; c++) {
      this.cellStart[c] = acc;
      this.cellCursor[c] = acc;
      acc += cc[c];
    }
    for (let i = 0; i < N; i++) {
      if (this.dead[i] !== 0) continue;
      const c = this.cellIndex(this.x[i], this.z[i]);
      this.gridIdx[this.cellCursor[c]++] = i;
    }
  }

  /** Nearest living soldier within r of (x,z) matching the filter. */
  nearest(x: number, z: number, r: number, filter: (j: number) => boolean): number {
    const h = this.terrain.half;
    const cs = this.cellSize;
    const gx0 = Math.max(0, Math.floor((x - r + h) / cs));
    const gx1 = Math.min(this.gw - 1, Math.floor((x + r + h) / cs));
    const gz0 = Math.max(0, Math.floor((z - r + h) / cs));
    const gz1 = Math.min(this.gw - 1, Math.floor((z + r + h) / cs));
    let best = -1;
    let bestD = r * r;
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gz * this.gw + gx;
        const s = this.cellStart[c];
        const e = s + this.cellCount[c];
        for (let k = s; k < e; k++) {
          const j = this.gridIdx[k];
          const dx = this.x[j] - x;
          const dz = this.z[j] - z;
          const d = dx * dx + dz * dz;
          if (d < bestD && filter(j)) {
            bestD = d;
            best = j;
          }
        }
      }
    }
    return best;
  }

  private nearestEnemy(i: number, r: number): number {
    const side = this.sideOf[i];
    const h = this.terrain.half;
    const cs = this.cellSize;
    const x = this.x[i];
    const z = this.z[i];
    const gx0 = Math.max(0, Math.floor((x - r + h) / cs));
    const gx1 = Math.min(this.gw - 1, Math.floor((x + r + h) / cs));
    const gz0 = Math.max(0, Math.floor((z - r + h) / cs));
    const gz1 = Math.min(this.gw - 1, Math.floor((z + r + h) / cs));
    let best = -1;
    let bestD = r * r;
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gz * this.gw + gx;
        const s = this.cellStart[c];
        const e = s + this.cellCount[c];
        for (let k = s; k < e; k++) {
          const j = this.gridIdx[k];
          if (this.sideOf[j] === side) continue;
          const dx = this.x[j] - x;
          const dz = this.z[j] - z;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ units
  slotPos(u: Unit, s: number, out: { x: number; z: number }) {
    const n = Math.max(1, u.alive);
    const files = Math.max(1, Math.min(u.files, n));
    const ranks = Math.ceil(n / files);
    const file = s % files;
    const rank = Math.floor(s / files);
    const inRank = rank === ranks - 1 ? n - rank * files : files;
    const lat = (file - (inRank - 1) / 2) * u.def.spacing;
    const back = (rank - (ranks - 1) / 2) * u.def.rankSpacing;
    // right = (-fz, fx), back = (-fx, -fz)
    out.x = u.cx - u.fz * lat - u.fx * back;
    out.z = u.cz + u.fx * lat - u.fz * back;
  }

  private computeAggregates() {
    for (const u of this.units) {
      let sx = 0;
      let sz = 0;
      let sy = 0;
      let n = 0;
      for (const i of u.all) {
        if (this.dead[i] !== 0) continue;
        sx += this.x[i];
        sz += this.z[i];
        n++;
      }
      u.alive = n;
      if (n > 0) {
        u.mx = sx / n;
        u.mz = sz / n;
        sy = this.terrain.height(u.mx, u.mz);
        u.my = sy;
      }
      if (n === 0 && !u.gone) {
        const allFled = u.all.every((i) => this.dead[i] === 2);
        u.state = allFled ? 'fled' : 'destroyed';
        if (u.isGeneral) this.killGeneral(u.side);
      }
    }
  }

  private compactSlots(u: Unit) {
    const alive: number[] = [];
    for (const i of u.ranks) if (this.dead[i] === 0) alive.push(i);
    u.ranks = alive;
    for (let k = 0; k < alive.length; k++) this.slot[alive[k]] = k;
    u.slotsDirty = false;
  }

  private rotateFacing(u: Unit, tx: number, tz: number, dt: number) {
    const l = Math.hypot(tx, tz);
    if (l < 1e-6) return;
    tx /= l;
    tz /= l;
    const cur = Math.atan2(u.fx, u.fz);
    const want = Math.atan2(tx, tz);
    let d = want - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) > 2.0) {
      // About face: flip the formation and reverse slot order so nobody has to cross over.
      u.fx = tx;
      u.fz = tz;
      u.ranks.reverse();
      for (let k = 0; k < u.ranks.length; k++) this.slot[u.ranks[k]] = k;
      return;
    }
    const rate = (u.def.mounted ? 1.3 : 0.8) * dt;
    const a = cur + Math.max(-rate, Math.min(rate, d));
    u.fx = Math.sin(a);
    u.fz = Math.cos(a);
  }

  private updateUnit(u: Unit, dt: number) {
    if (u.gone) return;
    if (u.slotsDirty) this.compactSlots(u);
    const fat = fatigueLevel(u.energy);
    const def = u.def;

    // ---- rout / rally / state ----
    if (u.routing) {
      u.routTime += dt;
      u.order.kind = 'none';
      u.fireTarget = -1;
      u.cx = u.mx;
      u.cz = u.mz;
      // Run toward own edge, away from the nearest threat.
      let ax = 0;
      let az = u.side === 0 ? 1 : -1;
      let best = 1e9;
      let bx = 0;
      let bz = 0;
      for (const e of this.units) {
        if (e.side === u.side || !e.active) continue;
        const d = Math.hypot(e.mx - u.mx, e.mz - u.mz);
        if (d < best) {
          best = d;
          bx = u.mx - e.mx;
          bz = u.mz - e.mz;
        }
      }
      if (best < 150) {
        const l = Math.hypot(bx, bz) || 1;
        ax += (bx / l) * 1.4;
        az += (bz / l) * 1.4;
      }
      const l = Math.hypot(ax, az) || 1;
      u.fleeX = ax / l;
      u.fleeZ = az / l;
      u.seekR = 0;
      u.moving = true;
      u.running = true;
      u.energy = Math.max(0, u.energy - 0.35 * def.stamina * dt);

      if (u.state === 'routing') {
        const lostFrac = 1 - u.alive / u.startMen;
        if (u.routCount >= 3 || lostFrac > 0.8) {
          u.state = 'shattered';
          this.emit(u, 'shattered', `${u.def.name} are shattered`);
        } else if (u.routTime > 10 && u.morale >= 42 && best > 45) {
          u.rallyTimer += dt;
          if (u.rallyTimer > 5) {
            u.state = 'ok';
            u.rallied = true;
            u.rallyTimer = 0;
            u.cx = u.mx;
            u.cz = u.mz;
            if (best < 1e9) {
              u.fx = -bx / (Math.hypot(bx, bz) || 1);
              u.fz = -bz / (Math.hypot(bx, bz) || 1);
            }
            u.order = { kind: 'none', x: u.cx, z: u.cz, fx: u.fx, fz: u.fz, files: 0, target: -1, run: false };
            u.slotsDirty = true;
            this.emit(u, 'rally', `${u.def.name} have rallied`);
          }
        } else {
          u.rallyTimer = 0;
        }
      }
    } else {
      // ---- orders ----
      u.moving = false;
      u.running = false;
      u.seekR = 2.6;
      const o = u.order;
      let destX = u.cx;
      let destZ = u.cz;
      let faceX = u.fx;
      let faceZ = u.fz;
      let wantMove = false;
      if (o.kind === 'attack') {
        const t = this.units[o.target];
        if (!t || t.gone || t.alive === 0) {
          o.kind = 'none';
          u.fireTarget = -1;
        } else {
          const dx = t.mx - u.cx;
          const dz = t.mz - u.cz;
          const d = Math.hypot(dx, dz) || 1;
          faceX = dx / d;
          faceZ = dz / d;
          if (def.missile && this.ammoLeft(u) > 0) {
            const range = this.effRange(u, t) * 0.92;
            const dc = Math.hypot(t.mx - u.mx, t.mz - u.mz);
            u.fireTarget = t.id;
            if (dc > range) {
              destX = t.mx - faceX * range * 0.9;
              destZ = t.mz - faceZ * range * 0.9;
              wantMove = true;
            }
          } else {
            const gap = u.depth / 2 + (t.routing ? 0 : t.depth / 2) + 0.5;
            destX = t.mx - faceX * gap;
            destZ = t.mz - faceZ * gap;
            wantMove = Math.hypot(destX - u.cx, destZ - u.cz) > 0.6;
            const closing = Math.hypot(t.mx - u.mx, t.mz - u.mz) < gap + 26;
            if (t.routing) u.seekR = closing ? 16 : 3;
            else u.seekR = closing || u.inMeleePrev > 0 ? 12 : 3;
          }
          o.x = t.mx;
          o.z = t.mz;
        }
      }
      if (o.kind === 'move') {
        destX = o.x;
        destZ = o.z;
        const d = Math.hypot(destX - u.cx, destZ - u.cz);
        if (d > 0.4) {
          wantMove = true;
          if (d > 14) {
            faceX = (destX - u.cx) / d;
            faceZ = (destZ - u.cz) / d;
          } else {
            faceX = o.fx;
            faceZ = o.fz;
          }
          u.seekR = 0;
        } else {
          faceX = o.fx;
          faceZ = o.fz;
          u.cx = destX;
          u.cz = destZ;
          o.kind = 'none';
        }
      }
      if (o.kind === 'none') {
        u.seekR = u.inMeleePrev > 0 ? 7 : 2.6;
        // Missile units fire at will at the closest enemy in range that isn't mixed up with friends.
        if (def.missile && u.fireAtWill && u.inMeleePrev === 0) {
          if (u.fireTarget >= 0) {
            const t = this.units[u.fireTarget];
            if (!t || t.gone || t.alive === 0 || Math.hypot(t.mx - u.mx, t.mz - u.mz) > this.effRange(u, t)) u.fireTarget = -1;
          }
          if (u.fireTarget < 0 && this.tick % 10 === u.id % 10) u.fireTarget = this.pickMissileTarget(u);
          if (u.fireTarget >= 0) {
            const t = this.units[u.fireTarget];
            faceX = t.mx - u.mx;
            faceZ = t.mz - u.mz;
          }
        }
      }
      if (def.missile && u.inMeleePrev > 0) u.seekR = 5;

      if (wantMove) {
        u.moving = true;
        u.running = o.run && fat.canRun;
        let speed = (u.running ? def.run : def.walk) * fat.speed;
        const ddx = destX - u.cx;
        const ddz = destZ - u.cz;
        const d = Math.hypot(ddx, ddz) || 1;
        const slope = this.terrain.slope(u.cx, u.cz, ddx / d, ddz / d);
        speed *= 1 - Math.max(-0.12, Math.min(0.45, slope * 1.8));
        // Do not let the anchor run away from the men.
        if (u.lag > 12) speed *= 0.15;
        else if (u.lag > 6) speed *= 0.5;
        const step = Math.min(d, speed * dt);
        const lim = BOUND - 20;
        u.cx = Math.max(-lim, Math.min(lim, u.cx + (ddx / d) * step));
        u.cz = Math.max(-lim, Math.min(lim, u.cz + (ddz / d) * step));
        u.moveSpeed = (u.running ? def.run : def.walk) * fat.speed;
        // Fatigue: running is expensive, uphill worse.
        const drain = (u.running ? (def.mounted ? 0.55 : 0.85) : 0.06) + Math.max(0, slope) * (u.running ? 1.6 : 0.6);
        u.energy -= drain * def.stamina * dt;
      } else {
        u.moveSpeed = def.walk * fat.speed;
      }
      this.rotateFacing(u, faceX, faceZ, dt);

      // Fighting is tiring; resting recovers.
      if (u.inMeleePrev > u.alive * 0.12) {
        u.energy -= 0.42 * def.stamina * dt;
        u.meleeTime += dt;
        u.noMeleeTime = 0;
      } else {
        u.noMeleeTime += dt;
        if (u.noMeleeTime > 2) u.meleeTime = 0;
        if (!u.moving) u.energy += 0.3 * dt;
      }
      u.energy = Math.max(0, Math.min(100, u.energy));

      // Charge: first contact while running.
      if (u.inMeleePrev === 0) u.noContactTime += dt;
      else u.noContactTime = 0;
      if (u.noContactTime > 6) u.chargeReady = true;
      if (u.inMeleePrev > 0 && u.chargeReady && (u.running || u.lag > 2) && o.kind === 'attack') {
        u.chargeT = 5;
        u.chargeReady = false;
        const t = this.units[o.target];
        if (t) {
          const impact = def.mounted ? 10 : def.discipline === 'impetuous' ? 8 : 4;
          this.addShock(t, impact);
        }
      }
      if (u.inMeleePrev > 0 && u.chargeReady && u.lag < 2) u.chargeReady = false;
    }
    u.chargeT = Math.max(0, u.chargeT - dt);

    // ---- morale ----
    if ((this.tick + u.id) % 5 === 0) this.updateMoraleMods(u);
    const target = Math.max(0, Math.min(100, u.moraleTarget));
    if (target < u.morale) u.morale = Math.max(target, u.morale - 9 * dt);
    else u.morale = Math.min(target, u.morale + (u.routing ? 2.2 : 1.6) * dt);

    if (u.state === 'ok' || u.state === 'wavering') {
      if (u.morale < 18) {
        u.state = 'routing';
        u.routCount++;
        u.routTime = 0;
        u.rallyTimer = 0;
        u.rallied = false;
        for (const i of u.all) this.target[i] = -1;
        this.emit(u, 'rout', `${u.def.name} are routing!`);
        // Panic is contagious.
        for (const f of this.units) {
          if (f.side !== u.side || f === u || !f.active) continue;
          if (Math.hypot(f.mx - u.mx, f.mz - u.mz) < 70) this.addShock(f, 3);
        }
      } else if (u.morale < 35) u.state = 'wavering';
      else u.state = 'ok';
    }
  }

  private pickMissileTarget(u: Unit): number {
    let best = -1;
    let bestD = 1e9;
    for (const t of this.units) {
      if (t.side === u.side || t.gone || t.alive === 0) continue;
      const d = Math.hypot(t.mx - u.mx, t.mz - u.mz);
      if (d > this.effRange(u, t)) continue;
      // Skip enemies that are locked in melee with our own men (friendly fire).
      let mixed = false;
      if (t.inMeleePrev > 0) {
        for (const f of this.units) {
          if (f.side === u.side && this.engage[f.id * this.nU + t.id] > 0) mixed = true;
        }
        if (t.inMeleePrev > 3) mixed = true;
      }
      const score = d + (mixed ? 1000 : 0) + (t.routing ? 300 : 0);
      if (score < bestD) {
        bestD = score;
        best = t.id;
      }
    }
    return bestD >= 1000 ? -1 : best;
  }

  effRange(u: Unit, t: Unit): number {
    const m = u.def.missile;
    if (!m) return 0;
    const dh = u.my - t.my;
    return m.range * (1 + Math.max(-0.15, Math.min(0.3, dh / 50)));
  }

  private updateMoraleMods(u: Unit) {
    const mods: MoraleMod[] = [];
    const add = (label: string, value: number) => {
      if (Math.abs(value) >= 1) mods.push({ label, value: Math.round(value) });
    };
    const lost = 1 - u.alive / u.startMen;
    add('Casualties', -lost * 45);
    const recent = u.recentLoss / u.startMen;
    add('Heavy losses', -Math.min(24, recent * 160));

    // Flanking is judged from where the attacking units are relative to this unit's
    // facing (not individual soldiers, which get mixed up in a melee).
    let qf = 0;
    let ql = 0;
    let qr = 0;
    let qb = 0;
    if (!u.routing) {
      for (const e of this.units) {
        if (e.side === u.side || e.alive === 0) continue;
        const a = this.engage[e.id * this.nU + u.id];
        if (a < 3) continue;
        const dx = e.mx - u.mx;
        const dz = e.mz - u.mz;
        const l = Math.hypot(dx, dz);
        if (l < Math.max(6, u.depth * 0.5)) {
          qf++;
          continue;
        }
        const f = (dx * u.fx + dz * u.fz) / l;
        const r = (dx * -u.fz + dz * u.fx) / l;
        if (f > 0.4) qf++;
        else if (f < -0.55) qb++;
        else if (r > 0) qr++;
        else ql++;
      }
    }
    u.quad[0] = qf;
    u.quad[1] = ql;
    u.quad[2] = qr;
    u.quad[3] = qb;
    const sidesHit = (qf ? 1 : 0) + (ql ? 1 : 0) + (qr ? 1 : 0) + (qb ? 1 : 0);
    if (ql || qr) add('Flanked', -10 * ((ql ? 1 : 0) + (qr ? 1 : 0)));
    if (qb) add('Attacked from behind', -18);
    if (sidesHit >= 3) add('Surrounded', -12);

    const sd = this.sides[u.side];
    if (u.isGeneral) add('Commander', 6);
    else if (sd.generalAlive && sd.general >= 0) {
      const g = this.units[sd.general];
      if (g.active && Math.hypot(g.mx - u.mx, g.mz - u.mz) < 120) add('General nearby', 10);
    }
    if (!sd.generalAlive) add('General slain', -12);

    let routers = 0;
    for (const f of this.units) {
      if (f.side !== u.side || f === u || !f.routing || f.alive === 0) continue;
      if (Math.hypot(f.mx - u.mx, f.mz - u.mz) < 70) routers++;
    }
    add('Friends fleeing', -Math.min(12, routers * 4));

    const fat = fatigueLevel(u.energy);
    add(fat.name, fat.morale);

    // High ground and odds against the enemies we are actually fighting.
    let eMen = 0;
    let eH = 0;
    let eCount = 0;
    let enemyBreaking = false;
    for (const e of this.units) {
      if (e.side === u.side) continue;
      const a = this.engage[e.id * this.nU + u.id];
      const b = this.engage[u.id * this.nU + e.id];
      if (a + b <= 0) continue;
      eMen += e.alive;
      eH += e.my;
      eCount++;
      if (e.state === 'wavering' || e.routing) enemyBreaking = true;
    }
    if (eCount > 0 && !u.routing) {
      const dh = u.my - eH / eCount;
      if (dh > 2) add('Higher ground', 6);
      else if (dh < -2) add('Lower ground', -4);
      if (eMen > u.alive * 1.8) add('Outnumbered', -8);
    }
    if (enemyBreaking && !u.routing) add('Enemy breaking', 6);
    if (this.time - u.missileHitT < 5 && !u.routing) add('Under fire', -4);
    if (u.chargeT > 0 && u.def.discipline === 'impetuous') add('Charging', 8);

    // How the battle is going overall.
    let mine = 0;
    let theirs = 0;
    for (const f of this.units) {
      if (!f.active) continue;
      if (f.side === u.side) mine += f.alive;
      else theirs += f.alive;
    }
    if (theirs > 0 && mine < theirs * 0.5) add('Battle going badly', -8);
    else if (mine > theirs * 2) add('Winning', 6);
    if (u.def.discipline === 'disciplined' && !u.routing) add('Disciplined', 4);
    u.mods = mods;
  }

  // ------------------------------------------------------------------ soldiers
  private updateSoldiers(dt: number) {
    const N = this.N;
    const tmp = this.tmp;
    const terrain = this.terrain;
    for (let i = 0; i < N; i++) {
      if (this.dead[i] !== 0) {
        this.animT[i] += dt;
        continue;
      }
      const u = this.units[this.unitOf[i]];
      const def = u.def;
      this.atkT[i] -= dt;
      this.reload[i] -= dt;
      this.impactCd[i] -= dt;
      this.animT[i] += dt;
      const x = this.x[i];
      const z = this.z[i];
      let destX = x;
      let destZ = z;
      let speed = 0;
      let faceX = Math.sin(this.yaw[i]);
      let faceZ = Math.cos(this.yaw[i]);
      let fighting = false;
      const fat = fatigueLevel(u.energy);

      if (u.routing) {
        const jitter = Math.sin(this.phase[i] * 3.1) * 0.6;
        destX = x + (u.fleeX - u.fleeZ * jitter) * 10;
        destZ = z + (u.fleeZ + u.fleeX * jitter) * 10;
        speed = def.run * Math.max(0.75, fat.speed) * (0.85 + 0.15 * Math.sin(this.phase[i]));
        faceX = u.fleeX;
        faceZ = u.fleeZ;
        this.target[i] = -1;
        if (Math.abs(x) > BOUND || Math.abs(z) > BOUND) {
          this.dead[i] = 2;
          this.anim[i] = Anim.Flee;
          continue;
        }
      } else {
        let t = this.target[i];
        if (t >= 0) {
          if (this.dead[t] !== 0) t = -1;
          else {
            const ddx = this.x[t] - x;
            const ddz = this.z[t] - z;
            if (ddx * ddx + ddz * ddz > 12 * 12) t = -1;
          }
        }
        let seek = u.seekR;
        if (seek > 3 && !def.mounted) {
          const files = u.fileCount;
          const sl = this.slot[i];
          const rank = Math.floor(sl / files);
          const file = sl % files;
          if (rank >= 2 && file >= 2 && file < files - 2) seek = 2.4;
        }
        if (seek > 0 && (t < 0 || (this.tick + i) % 9 === 0)) {
          const n = this.nearestEnemy(i, seek);
          if (n >= 0) t = n;
        }
        if (u.seekR === 0) t = -1;
        this.target[i] = t;

        if (t >= 0) {
          const tx = this.x[t];
          const tz = this.z[t];
          const ddx = tx - x;
          const ddz = tz - z;
          const d = Math.hypot(ddx, ddz) || 1e-3;
          const reach = this.radius[i] + this.radius[t] + def.reach;
          faceX = ddx / d;
          faceZ = ddz / d;
          if (d > reach * 0.9) {
            destX = tx - faceX * reach * 0.8;
            destZ = tz - faceZ * reach * 0.8;
            speed = (u.running || d > 4 ? def.run * 0.9 : def.walk * 1.4) * fat.speed;
          }
          if (d <= reach) {
            fighting = true;
            const tu = this.unitOf[t];
            this.engage[u.id * this.nU + tu] += 1;
            u.inMelee++;
            if (this.atkT[i] <= 0) {
              this.meleeAttack(i, t, d);
              this.atkT[i] = (def.mounted ? 1.7 : 2.1) * (0.75 + 0.5 * this.rng.next());
            }
          }
        } else {
          this.slotPos(u, this.slot[i], tmp);
          destX = tmp.x;
          destZ = tmp.z;
          const d = Math.hypot(destX - x, destZ - z);
          u.lagSum += d;
          u.lagCount++;
          speed = u.moveSpeed;
          if (d > 3) speed = Math.max(speed * 1.2, def.walk * 1.5 * fat.speed);
          if (d > 0.8 && (u.moving || d > 2)) {
            faceX = (destX - x) / d;
            faceZ = (destZ - z) / d;
          } else {
            faceX = u.fx;
            faceZ = u.fz;
          }
          // Missiles.
          if (def.missile && u.fireTarget >= 0 && !u.moving && this.ammo[i] > 0) {
            const tu = this.units[u.fireTarget];
            faceX = tu.mx - x;
            faceZ = tu.mz - z;
            if (this.reload[i] <= 0) this.fire(i, u, tu);
          }
        }
      }

      // ---- integrate ----
      let dx = destX - x;
      let dz = destZ - z;
      const dist = Math.hypot(dx, dz);
      let wantVX = 0;
      let wantVZ = 0;
      if (dist > 0.05 && speed > 0) {
        dx /= dist;
        dz /= dist;
        let s = speed;
        if (dist < 1.5 && !u.routing) s *= dist / 1.5;
        const slope = terrain.slope(x, z, dx, dz);
        s *= 1 - Math.max(-0.12, Math.min(0.45, slope * 1.8));
        wantVX = dx * s;
        wantVZ = dz * s;
      }
      const accel = Math.min(1, (def.mounted ? 2.2 : 6) * dt);
      this.vx[i] += (wantVX - this.vx[i]) * accel;
      this.vz[i] += (wantVZ - this.vz[i]) * accel;
      this.x[i] = x + this.vx[i] * dt;
      this.z[i] = z + this.vz[i] * dt;

      // Turn toward facing.
      const want = Math.atan2(faceX, faceZ);
      let dy = want - this.yaw[i];
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const turn = (def.mounted ? 3 : 7) * dt;
      this.yaw[i] += Math.max(-turn, Math.min(turn, dy));

      // Animation state.
      const a = this.anim[i];
      const busy = (a === Anim.Attack && this.animT[i] < 0.6) || (a === Anim.Block && this.animT[i] < 0.35) || (a === Anim.Shoot && this.animT[i] < 0.8);
      if (!busy) {
        const sp = Math.hypot(this.vx[i], this.vz[i]);
        const na = u.routing ? Anim.Flee : sp < 0.25 ? Anim.Idle : sp < def.walk * 1.25 ? Anim.Walk : Anim.Run;
        if (na !== a) {
          this.anim[i] = fighting && na === Anim.Idle ? Anim.Idle : na;
          this.animT[i] = 0;
        }
      }
    }
  }

  private meleeAttack(i: number, t: number, d: number) {
    const A = this.units[this.unitOf[i]];
    const B = this.units[this.unitOf[t]];
    const da = A.def;
    const db = B.def;
    const fa = fatigueLevel(A.energy);
    const fb = fatigueLevel(B.energy);
    let atk = da.attack + fa.atk;
    if (A.chargeT > 0) atk += da.charge * Math.min(1, A.chargeT / 3);
    if (da.bonusVsCav && db.mounted) atk += da.bonusVsCav;
    const dh = this.terrain.height(this.x[i], this.z[i]) - this.terrain.height(this.x[t], this.z[t]);
    atk += Math.max(-3, Math.min(3, dh * 0.6));
    if (A.state === 'wavering') atk -= 1;

    // Direction from defender to attacker.
    const dirX = (this.x[i] - this.x[t]) / d;
    const dirZ = (this.z[i] - this.z[t]) / d;
    const sfx = Math.sin(this.yaw[t]);
    const sfz = Math.cos(this.yaw[t]);
    const dot = sfx * dirX + sfz * dirZ;
    let def: number;
    if (B.routing) def = db.armor * 0.7;
    else if (dot > 0.35) def = db.defense + db.armor + db.shield;
    else if (dot > -0.4) def = db.defense * 0.8 + db.armor + db.shield * 0.5;
    else def = db.defense * 0.35 + db.armor;
    def += fb.def;

    this.anim[i] = Anim.Attack;
    this.animT[i] = 0;
    // Even match ~5% per swing; every point of advantage multiplies the odds by 1.15.
    const p = Math.max(0.008, Math.min(0.45, 0.05 * Math.pow(1.15, atk - def)));
    if (this.rng.next() < p) {
      this.damage(t, i);
    } else if (this.anim[t] !== Anim.Attack) {
      this.anim[t] = Anim.Block;
      this.animT[t] = 0;
    }
  }

  private damage(t: number, by: number) {
    this.hp[t]--;
    if (this.hp[t] > 0) return;
    this.dead[t] = 1;
    this.anim[t] = Anim.Dead;
    this.animT[t] = 0;
    this.vx[t] = 0;
    this.vz[t] = 0;
    const B = this.units[this.unitOf[t]];
    B.alive--;
    B.recentLoss += 1;
    B.slotsDirty = true;
    if (by >= 0) this.units[this.unitOf[by]].kills++;
    const sd = this.sides[B.side];
    if (t === sd.generalSoldier && sd.generalAlive) this.killGeneral(B.side);
  }

  private killGeneral(side: number) {
    const sd = this.sides[side];
    if (!sd.generalAlive) return;
    sd.generalAlive = false;
    for (const f of this.units) if (f.side === side && !f.gone) this.addShock(f, 16);
    const u = this.units[sd.general];
    this.emit(u, 'general', `${sd.faction.name}'s general has been slain!`);
  }

  private fire(i: number, u: Unit, t: Unit) {
    const m = u.def.missile!;
    if (t.alive === 0) return;
    // Pick a random living soldier of the target unit.
    let s = -1;
    for (let tries = 0; tries < 4 && s < 0; tries++) {
      const c = t.all[this.rng.int(t.all.length)];
      if (this.dead[c] === 0) s = c;
    }
    if (s < 0) return;
    const sx = this.x[i];
    const sz = this.z[i];
    const sy = this.terrain.height(sx, sz) + 1.6;
    let tx = this.x[s];
    let tz = this.z[s];
    const dist0 = Math.hypot(tx - sx, tz - sz);
    if (dist0 > this.effRange(u, t) * 1.05) return;
    const tof = dist0 / m.speed + 0.15;
    tx += this.vx[s] * tof * 0.8;
    tz += this.vz[s] * tof * 0.8;
    const sigma = (m.kind === 'arrow' ? 1.1 : 0.6) + dist0 * (m.kind === 'arrow' ? 0.03 : 0.035);
    tx += this.rng.gauss() * sigma;
    tz += this.rng.gauss() * sigma;
    const ty = this.terrain.height(tx, tz) + 1.0;
    const dist = Math.hypot(tx - sx, tz - sz) || 1;
    const T = dist / m.speed + 0.15;
    const k = this.pCursor;
    for (let n = 0; n < this.PMAX; n++) {
      const c = (k + n) % this.PMAX;
      if (this.pAlive[c] === 0) {
        this.pCursor = (c + 1) % this.PMAX;
        this.pAlive[c] = 1;
        this.pCount++;
        this.pX[c] = sx;
        this.pY[c] = sy;
        this.pZ[c] = sz;
        this.pPrevY[c] = sy;
        this.pVX[c] = (tx - sx) / T;
        this.pVZ[c] = (tz - sz) / T;
        this.pVY[c] = (ty - sy + 0.5 * GRAVITY * T * T) / T;
        this.pDmg[c] = m.damage;
        this.pKind[c] = m.kind === 'arrow' ? 0 : 1;
        this.pUnit[c] = u.id;
        break;
      }
    }
    this.ammo[i]--;
    this.reload[i] = m.reload * (0.85 + 0.3 * this.rng.next());
    this.anim[i] = Anim.Shoot;
    this.animT[i] = 0;
  }

  private updateProjectiles(dt: number) {
    if (this.pCount === 0) return;
    for (let c = 0; c < this.PMAX; c++) {
      if (this.pAlive[c] === 0) continue;
      this.pVY[c] -= GRAVITY * dt;
      const ox = this.pX[c];
      const oy = this.pY[c];
      const oz = this.pZ[c];
      this.pPrevY[c] = oy;
      const nx = ox + this.pVX[c] * dt;
      const ny = oy + this.pVY[c] * dt;
      const nz = oz + this.pVZ[c] * dt;
      this.pX[c] = nx;
      this.pY[c] = ny;
      this.pZ[c] = nz;
      if (Math.abs(nx) > 395 || Math.abs(nz) > 395) {
        this.pAlive[c] = 0;
        this.pCount--;
        continue;
      }
      if (this.pVY[c] > 0) continue;
      const g = this.terrain.height(nx, nz);
      const band = g + 1.0;
      if (ny <= band) {
        // Point where the projectile crossed body height.
        const og = this.terrain.height(ox, oz) + 1.0;
        const f = oy - og > 0 ? Math.min(1, (oy - og) / Math.max(1e-3, oy - og - (ny - band))) : 0;
        const hx = ox + (nx - ox) * f;
        const hz = oz + (nz - oz) * f;
        const s = this.nearest(hx, hz, 1.0, (j) => {
          const r = this.radius[j] + 0.25;
          const ddx = this.x[j] - hx;
          const ddz = this.z[j] - hz;
          return ddx * ddx + ddz * ddz <= r * r;
        });
        if (s >= 0) this.missileHit(c, s);
        this.pAlive[c] = 0;
        this.pCount--;
      }
    }
  }

  private missileHit(c: number, s: number) {
    const B = this.units[this.unitOf[s]];
    const db = B.def;
    const vl = Math.hypot(this.pVX[c], this.pVZ[c]) || 1;
    const fromX = -this.pVX[c] / vl;
    const fromZ = -this.pVZ[c] / vl;
    const dot = Math.sin(this.yaw[s]) * fromX + Math.cos(this.yaw[s]) * fromZ;
    const shield = B.routing ? 0 : dot > 0.2 ? db.shield : dot > -0.3 ? db.shield * 0.5 : 0;
    let p = 0.26 + 0.03 * (this.pDmg[c] - db.armor - shield);
    if (db.mounted) p *= 0.85;
    p = Math.max(0.03, Math.min(0.75, p));
    B.missileHitT = this.time;
    if (this.rng.next() < p) {
      const shooter = this.units[this.pUnit[c]];
      this.damage(s, -1);
      shooter.kills++;
    }
  }

  // ------------------------------------------------------------------ collisions + cavalry impact
  private resolveCollisions() {
    const N = this.N;
    const h = this.terrain.half;
    const cs = this.cellSize;
    for (let i = 0; i < N; i++) {
      if (this.dead[i] !== 0) continue;
      const ri = this.radius[i];
      const xi = this.x[i];
      const zi = this.z[i];
      const gx = Math.floor((xi + h) / cs);
      const gz = Math.floor((zi + h) / cs);
      for (let oz = -1; oz <= 1; oz++) {
        const cz = gz + oz;
        if (cz < 0 || cz >= this.gw) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox;
          if (cx < 0 || cx >= this.gw) continue;
          const c = cz * this.gw + cx;
          const s = this.cellStart[c];
          const e = s + this.cellCount[c];
          for (let k = s; k < e; k++) {
            const j = this.gridIdx[k];
            if (j <= i || this.dead[j] !== 0) continue;
            const rr = ri + this.radius[j];
            let dx = this.x[j] - this.x[i];
            let dz = this.z[j] - this.z[i];
            const d2 = dx * dx + dz * dz;
            if (d2 >= rr * rr) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-4) {
              dx = Math.sin(this.phase[i]);
              dz = Math.cos(this.phase[i]);
              d = 1;
            } else {
              dx /= d;
              dz /= d;
            }
            const overlap = rr - (d2 < 1e-8 ? 0 : d);
            const mi = this.radius[i] > 0.6 ? 5 : 1;
            const mj = this.radius[j] > 0.6 ? 5 : 1;
            const wi = mj / (mi + mj);
            const wj = mi / (mi + mj);
            const push = Math.min(overlap, 0.5) * 0.8;
            this.x[i] -= dx * push * wi;
            this.z[i] -= dz * push * wi;
            this.x[j] += dx * push * wj;
            this.z[j] += dz * push * wj;
            if (this.sideOf[i] !== this.sideOf[j] && mi !== mj) {
              if (mi > mj) this.cavalryImpact(i, j);
              else this.cavalryImpact(j, i);
            }
          }
        }
      }
    }
  }

  private cavalryImpact(c: number, f: number) {
    if (this.impactCd[c] > 0 || this.dead[c] !== 0 || this.dead[f] !== 0) return;
    const sp = Math.hypot(this.vx[c], this.vz[c]);
    if (sp < 4) return;
    this.impactCd[c] = 0.9;
    const C = this.units[this.unitOf[c]];
    const F = this.units[this.unitOf[f]];
    const dc = C.def;
    const df = F.def;
    const dirX = this.vx[c] / sp;
    const dirZ = this.vz[c] / sp;
    // Is the foot soldier facing the horse?
    const facing = Math.sin(this.yaw[f]) * -dirX + Math.cos(this.yaw[f]) * -dirZ;
    const braced = df.bonusVsCav !== undefined && !F.routing && facing > 0.3;
    if (C.chargeReady && C.order.kind === 'attack') {
      C.chargeT = 5;
      C.chargeReady = false;
      this.emit(C, 'charge', `${C.def.name} charge!`);
    }
    const front = facing > 0.3 && !F.routing;
    const fdef = df.defense + df.armor + (front ? df.shield : 0);
    let p = braced ? 0.06 : Math.max(0.05, Math.min(0.6, 0.3 + 0.03 * (dc.charge + dc.attack * 0.3 - fdef)));
    if (this.rng.next() < p) this.damage(f, c);
    this.addShock(F, braced ? 0.1 : 0.35);
    if (braced) {
      p = 0.3;
      if (this.rng.next() < p) this.damage(c, f);
      this.vx[c] *= 0.2;
      this.vz[c] *= 0.2;
    } else if (this.dead[f] === 0) {
      this.x[f] += dirX * 1.3;
      this.z[f] += dirZ * 1.3;
      this.anim[f] = Anim.Block;
      this.animT[f] = 0;
      this.vx[c] *= 0.8;
      this.vz[c] *= 0.8;
    }
  }

  // ------------------------------------------------------------------ end
  private checkVictory() {
    if (this.result) return;
    const active = [0, 0];
    for (const u of this.units) if (u.active) active[u.side]++;
    for (let s = 0; s < 2; s++) {
      if (active[s] === 0) {
        const winner = 1 - s;
        this.result = { winner, time: this.time };
        this.events.push({ t: this.time, side: winner, unit: -1, kind: 'victory', text: `${this.sides[winner].faction.name} win the battle` });
        return;
      }
    }
  }

  addShock(u: Unit, v: number) {
    u.shock = Math.min(30, u.shock + v);
  }

  private emit(u: Unit, kind: BattleEvent['kind'], text: string) {
    this.events.push({ t: this.time, side: u.side, unit: u.id, kind, text });
  }

  ammoLeft(u: Unit): number {
    let a = 0;
    for (const i of u.all) if (this.dead[i] === 0) a += this.ammo[i];
    return a;
  }

  sideStats(side: number) {
    let alive = 0;
    let start = 0;
    let fled = 0;
    let kills = 0;
    for (const u of this.units) {
      if (u.side !== side) continue;
      start += u.startMen;
      kills += u.kills;
      for (const i of u.all) {
        if (this.dead[i] === 0) alive++;
        else if (this.dead[i] === 2) fled++;
      }
    }
    return { start, alive, fled, dead: start - alive - fled, kills };
  }
}

