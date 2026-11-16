// Campaign state and turn logic. No rendering here: the view and UI read this state.

import { UNITS } from '../sim/data';
import WORLD from './world.json';
import { MapData } from './map';
import {
  CHAIN, FACTION_EXTRAS, GARRISON, MAX_UNITS, MOVE_FOOT, MOVE_HORSE, NATIVE, ROSTERS, SEA_RANGE, START_ARMY,
  economy, maxBuildLevel, recruitCost, settlementLevel, unitStrength, upkeep,
} from './rules';
import type { Chain, Culture, EconomyReport, RecruitDef, Tax } from './rules';

export interface UnitStack {
  unit: string;
  men: number; // at 'large' unit size
  xp: number;
}

export interface Army {
  id: number;
  owner: string;
  x: number;
  y: number;
  units: UnitStack[];
  mp: number;
  inside: string | null; // settlement id when garrisoned
  path: { x: number; y: number }[];
  target: Target | null;
  name: string;
}

export type Target = { kind: 'army'; id: number } | { kind: 'settlement'; id: string } | { kind: 'point'; x: number; y: number };

export interface Settlement {
  id: string;
  name: string;
  prov: string;
  idx: number; // province index in the region raster
  x: number;
  y: number;
  owner: string;
  native: Culture;
  pop: number;
  tax: Tax;
  buildings: Partial<Record<Chain, number>>;
  build: { chain: Chain; level: number; turns: number } | null;
  queue: { unit: string; turns: number }[];
  capital: boolean;
  coastal: boolean;
  unrest: number;
  lowOrder: number;
}

export interface Faction {
  id: string;
  name: string;
  culture: Culture;
  color: string;
  trim: string;
  playable: boolean;
  treasury: number;
  alive: boolean;
  capital: string | null;
  wars: string[];
  marian: boolean;
}

export interface BattleSide {
  faction: string;
  armies: number[];
}

export interface PendingBattle {
  attacker: BattleSide;
  defender: BattleSide;
  x: number;
  y: number;
  settlement: string | null;
  land: { hills: number; dry: number };
}

export interface BattleOutcome {
  attackerWon: boolean;
  /** Men left per unit, in the order of unitsOf(side). */
  survivors: [number[], number[]];
}

export interface LogEntry {
  turn: number;
  text: string;
  kind: 'info' | 'good' | 'bad' | 'event';
  x?: number;
  y?: number;
}

const ARMY_NAMES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];

export class Campaign {
  readonly map: MapData;
  turn = 0;
  player = 'rome';
  factions = new Map<string, Faction>();
  settlements: Settlement[] = [];
  armies: Army[] = [];
  log: LogEntry[] = [];
  private nextArmy = 1;
  private seed = 1;
  /** Called when the player must decide how a battle is fought. */
  onBattle: ((b: PendingBattle) => Promise<BattleOutcome>) | null = null;
  onEvent: ((title: string, text: string) => Promise<void>) | null = null;

  constructor(map: MapData) {
    this.map = map;
  }

  // ------------------------------------------------------------------ setup
  newGame(player: string, seed = Date.now() % 100000) {
    this.player = player;
    this.seed = seed;
    this.turn = 0;
    this.factions.clear();
    for (const f of WORLD.factions) {
      this.factions.set(f.id, {
        id: f.id, name: f.name, culture: f.culture as Culture, color: f.color, trim: f.trim, playable: f.playable,
        treasury: f.id === 'rebels' ? 0 : 5000, alive: true, capital: null, wars: [], marian: false,
      });
    }
    this.settlements = WORLD.settlements.map((s, i) => {
      const m = this.map.settlements[i];
      const f = this.factions.get(s.owner)!;
      const native: Culture = NATIVE[s.id] ?? (f.culture === 'mixed' ? 'greek' : f.culture);
      const pop = s.pop;
      const b: Partial<Record<Chain, number>> = { barracks: 1 };
      if (pop >= 4000) b.farms = 1;
      if (pop >= 5000) b.stables = 1;
      if (pop >= 6000) b.market = 1;
      if (pop >= 4000) b.temple = 1;
      if (pop >= 5000) b.walls = pop >= 12000 ? 2 : 1;
      if (m.port && pop >= 4000) b.port = 1;
      if (pop >= 12000) b.barracks = 2;
      if ((s as { capital?: boolean }).capital) {
        b.barracks = Math.max(2, b.barracks ?? 0);
        b.stables = 2;
        b.roads = 1;
        f.capital = s.id;
      }
      return {
        id: s.id, name: s.name, prov: s.prov, idx: i, x: m.x + 0.5, y: m.y + 0.5, owner: s.owner, native, pop, tax: 1 as Tax,
        buildings: b, build: null, queue: [], capital: !!(s as { capital?: boolean }).capital, coastal: m.port, unrest: 0, lowOrder: 0,
      };
    });
    // Starting wars of 270 BC.
    const war = (a: string, b: string) => this.setWar(a, b, true);
    war('rome', 'gauls');
    war('carthage', 'syracuse');
    war('macedon', 'greeks');
    war('macedon', 'epirus');
    war('seleucids', 'ptolemies');
    war('dacia', 'scythia');
    war('germans', 'gauls');
    war('thrace', 'macedon');
    // Armies: one field army at every capital, a garrison in every settlement.
    this.armies = [];
    for (const f of this.factions.values()) {
      if (!f.capital) continue;
      const cap = this.settlement(f.capital)!;
      const units = START_ARMY[f.culture] ?? [];
      if (units.length) this.spawnArmy(f.id, cap.x, cap.y, units, null);
    }
    for (const s of this.settlements) {
      const f = this.factions.get(s.owner)!;
      const cul = f.id === 'rebels' ? s.native : f.culture;
      const g = GARRISON[cul] ?? GARRISON.mixed;
      const lvl = settlementLevel(s.pop);
      const list = [...g];
      if (lvl >= 2) list.push(g[0]);
      if (lvl >= 3) list.push(g[1], g[0]);
      this.spawnArmy(s.owner, s.x, s.y, list, s.id);
    }
    this.log = [{ turn: 0, text: `${this.yearName()}: the campaign begins.`, kind: 'event' }];
    this.refreshMoves();
  }

  // ------------------------------------------------------------------ helpers
  rand(): number {
    // Deterministic per save (mulberry32).
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  year(): number {
    return WORLD.startYear + Math.floor(this.turn / 2);
  }

  yearName(): string {
    const y = this.year();
    const season = this.turn % 2 === 0 ? 'Summer' : 'Winter';
    return `${season}, ${y < 0 ? `${-y} BC` : `AD ${y}`}`;
  }

  settlement(id: string): Settlement | undefined {
    return this.settlements.find((s) => s.id === id);
  }

  army(id: number): Army | undefined {
    return this.armies.find((a) => a.id === id);
  }

  faction(id: string): Faction {
    return this.factions.get(id)!;
  }

  atWar(a: string, b: string): boolean {
    if (a === b) return false;
    if (a === 'rebels' || b === 'rebels') return true;
    return this.faction(a).wars.includes(b);
  }

  setWar(a: string, b: string, on: boolean) {
    const fa = this.faction(a);
    const fb = this.faction(b);
    fa.wars = fa.wars.filter((x) => x !== b);
    fb.wars = fb.wars.filter((x) => x !== a);
    if (on) {
      fa.wars.push(b);
      fb.wars.push(a);
    }
  }

  garrison(s: Settlement): Army[] {
    return this.armies.filter((a) => a.inside === s.id);
  }

  armyStrength(a: Army): number {
    return a.units.reduce((t, u) => t + unitStrength(u.unit, u.men), 0);
  }

  armyMen(a: Army): number {
    return a.units.reduce((t, u) => t + u.men, 0);
  }

  isMounted(a: Army): boolean {
    return a.units.every((u) => UNITS[u.unit]?.mounted);
  }

  maxMoves(a: Army): number {
    return this.isMounted(a) ? MOVE_HORSE : MOVE_FOOT;
  }

  spawnArmy(owner: string, x: number, y: number, units: string[], inside: string | null): Army {
    const a: Army = {
      id: this.nextArmy++, owner, x, y, inside, path: [], target: null, mp: 0,
      units: units.filter((u) => UNITS[u]).map((u) => ({ unit: u, men: UNITS[u].men, xp: 0 })),
      name: '',
    };
    a.name = this.armyName(owner);
    a.mp = this.maxMoves(a);
    this.armies.push(a);
    return a;
  }

  private armyName(owner: string): string {
    const n = this.armies.filter((a) => a.owner === owner).length;
    return `${ARMY_NAMES[n % ARMY_NAMES.length]} Army`;
  }

  distToCapital(s: Settlement): number {
    const f = this.faction(s.owner);
    const cap = f.capital ? this.settlement(f.capital) : undefined;
    if (!cap) return 400;
    return Math.hypot(cap.x - s.x, cap.y - s.y);
  }

  report(s: Settlement): EconomyReport {
    const men = this.garrison(s).reduce((t, a) => t + this.armyMen(a), 0);
    const f = this.faction(s.owner);
    return economy({
      pop: s.pop, tax: s.tax, buildings: s.buildings, capital: f.capital === s.id, distToCapital: this.distToCapital(s),
      garrisonMen: men, foreign: f.id !== 'rebels' && f.culture !== s.native && !(f.culture === 'hellenistic' && s.native === 'greek'), unrest: s.unrest,
    });
  }

  incomeOf(fid: string): { income: number; upkeep: number; net: number } {
    let income = 0;
    for (const s of this.settlements) if (s.owner === fid) income += this.report(s).income;
    let up = 0;
    for (const a of this.armies) if (a.owner === fid) for (const u of a.units) up += upkeep(u.unit);
    return { income, upkeep: up, net: income - up };
  }

  /** Units this settlement can recruit now (own roster plus local troops of its native culture). */
  recruitable(s: Settlement): { def: RecruitDef; local: boolean; cost: number }[] {
    const f = this.faction(s.owner);
    if (f.id === 'rebels') return [];
    const out: { def: RecruitDef; local: boolean; cost: number }[] = [];
    const ok = (d: RecruitDef) => (s.buildings[d.chain] ?? 0) >= d.level && (!d.only || d.only.includes(s.id)) &&
      (!d.marian || (d.marian === 'after') === f.marian);
    for (const d of [...(ROSTERS[f.culture] ?? []), ...(FACTION_EXTRAS[f.id] ?? [])]) if (ok(d)) out.push({ def: d, local: false, cost: recruitCost(d.unit) });
    if (s.native !== f.culture) {
      for (const d of ROSTERS[s.native] ?? []) {
        if (d.level > 1 || UNITS[d.unit]?.cls === 'general') continue;
        if ((s.buildings[d.chain] ?? 0) < 1 || out.some((o) => o.def.unit === d.unit)) continue;
        out.push({ def: d, local: true, cost: Math.round(recruitCost(d.unit) * 1.2) });
      }
    }
    return out;
  }

  canBuild(s: Settlement, chain: Chain): { level: number; cost: number; turns: number; ok: boolean; why: string } | null {
    const c = CHAIN[chain];
    const cur = s.buildings[chain] ?? 0;
    if (cur >= c.names.length) return null;
    if (chain === 'port' && !s.coastal) return null;
    const level = cur + 1;
    const cost = c.cost[cur];
    const turns = c.turns[cur];
    let why = '';
    if (level > Math.max(1, maxBuildLevel(s.pop))) why = `Needs a bigger settlement`;
    else if (s.build) why = 'Already building';
    else if (this.faction(s.owner).treasury < cost) why = 'Not enough money';
    return { level, cost, turns, ok: !why, why };
  }

  startBuild(s: Settlement, chain: Chain): boolean {
    const b = this.canBuild(s, chain);
    if (!b || !b.ok) return false;
    this.faction(s.owner).treasury -= b.cost;
    s.build = { chain, level: b.level, turns: b.turns };
    return true;
  }

  cancelBuild(s: Settlement) {
    if (!s.build) return;
    this.faction(s.owner).treasury += CHAIN[s.build.chain].cost[s.build.level - 1];
    s.build = null;
  }

  recruitSlots(s: Settlement): number {
    return 1 + Math.floor(settlementLevel(s.pop) / 2);
  }

  recruit(s: Settlement, unit: string): boolean {
    const opt = this.recruitable(s).find((o) => o.def.unit === unit);
    if (!opt) return false;
    const f = this.faction(s.owner);
    if (f.treasury < opt.cost || s.queue.length >= 6) return false;
    f.treasury -= opt.cost;
    s.queue.push({ unit, turns: 1 });
    return true;
  }

  cancelRecruit(s: Settlement, i: number) {
    const q = s.queue[i];
    if (!q) return;
    this.faction(s.owner).treasury += recruitCost(q.unit);
    s.queue.splice(i, 1);
  }

  // ------------------------------------------------------------------ movement
  refreshMoves() {
    for (const a of this.armies) a.mp = this.maxMoves(a);
  }

  /** Plans a path; returns per-point cumulative cost. */
  plan(a: Army, tx: number, ty: number): { path: { x: number; y: number }[]; cost: number[] } | null {
    return this.map.findPath(a.x, a.y, tx, ty, (prov) => {
      const s = prov >= 0 ? this.settlements[prov] : undefined;
      return s && s.owner === a.owner && (s.buildings.roads ?? 0) > 0 ? 0.7 : 1;
    });
  }

  /** Can this army sail from its port to a settlement? */
  canSail(a: Army, s: Settlement): boolean {
    if (!a.inside) return false;
    const from = this.settlement(a.inside);
    if (!from || !from.coastal || !s.coastal || from.id === s.id) return false;
    if (a.mp < this.maxMoves(a) * 0.99) return false;
    const range = SEA_RANGE + (from.buildings.port ?? 0) * 60;
    return Math.hypot(from.x - s.x, from.y - s.y) <= range;
  }

  /** Gives an army an order. The move happens right away up to its movement points. */
  async order(a: Army, target: Target): Promise<void> {
    let tx: number;
    let ty: number;
    if (target.kind === 'army') {
      const t = this.army(target.id);
      if (!t) return;
      tx = t.x;
      ty = t.y;
    } else if (target.kind === 'settlement') {
      const s = this.settlement(target.id)!;
      if (this.canSail(a, s)) {
        // Sail when there is no land route or it is much longer than the sea crossing.
        const land = this.map.landConnected(a.x, a.y, s.x, s.y) ? this.plan(a, s.x, s.y) : null;
        const landCost = land ? land.cost[land.cost.length - 1] ?? 0 : Infinity;
        if (landCost > this.maxMoves(a) * 2.5) {
          await this.sail(a, s);
          return;
        }
      }
      tx = s.x;
      ty = s.y;
    } else {
      tx = target.x;
      ty = target.y;
    }
    const p = this.plan(a, tx, ty);
    if (!p) return;
    a.path = p.path;
    a.target = target;
    await this.advance(a);
  }

  async sail(a: Army, s: Settlement) {
    a.mp = 0;
    a.path = [];
    a.target = null;
    if (s.owner === a.owner) {
      this.enter(a, s);
      return;
    }
    a.inside = null;
    a.x = s.x + 2;
    a.y = s.y + 2;
    if (this.atWar(a.owner, s.owner) || this.declareIfNeeded(a.owner, s.owner)) await this.attackSettlement(a, s);
  }

  private declareIfNeeded(a: string, b: string): boolean {
    if (this.atWar(a, b)) return true;
    this.setWar(a, b, true);
    this.addLog(`${this.faction(a).name} declares war on ${this.faction(b).name}!`, 'bad');
    return true;
  }

  private enter(a: Army, s: Settlement) {
    // Merge into an existing garrison army when there is room.
    const g = this.garrison(s).find((x) => x.id !== a.id && x.owner === a.owner && x.units.length + a.units.length <= MAX_UNITS);
    a.x = s.x;
    a.y = s.y;
    if (g) {
      g.units.push(...a.units);
      g.mp = Math.min(g.mp, a.mp);
      this.armies = this.armies.filter((x) => x !== a);
    } else {
      a.inside = s.id;
    }
  }

  /** Walks an army along its path until movement points run out or it meets something. */
  async advance(a: Army): Promise<void> {
    if (!a.path.length) return;
    const step = (from: { x: number; y: number }, to: { x: number; y: number }) => this.map.stepCost(from.x, from.y, to.x, to.y) *
      (() => {
        const prov = this.map.provinceAt(to.x, to.y);
        const s = prov >= 0 ? this.settlements[prov] : undefined;
        return s && s.owner === a.owner && (s.buildings.roads ?? 0) > 0 ? 0.7 : 1;
      })();
    if (a.inside && a.path.length) {
      a.inside = null;
    }
    while (a.path.length) {
      const next = a.path[0];
      const c = step(a, next);
      if (c > a.mp + 1e-6) break;
      a.mp -= c;
      a.x = next.x;
      a.y = next.y;
      a.path.shift();
      // Contact checks.
      const hit = this.contactAt(a);
      if (hit) {
        a.path = [];
        await this.resolveContact(a, hit);
        return;
      }
    }
    if (!a.path.length) {
      const t = a.target;
      a.target = null;
      if (t?.kind === 'settlement') {
        const s = this.settlement(t.id)!;
        if (s.owner === a.owner && Math.hypot(a.x - s.x, a.y - s.y) < 3) this.enter(a, s);
      } else if (t?.kind === 'army') {
        const other = this.army(t.id);
        if (other && other.owner === a.owner && Math.hypot(a.x - other.x, a.y - other.y) < 4) this.merge(a, other);
      }
    }
  }

  private contactAt(a: Army): Target | null {
    for (const s of this.settlements) {
      if (s.owner === a.owner) continue;
      if (Math.hypot(a.x - s.x, a.y - s.y) < 3.2) {
        const t = a.target;
        if (this.atWar(a.owner, s.owner) || (t?.kind === 'settlement' && t.id === s.id)) return { kind: 'settlement', id: s.id };
      }
    }
    for (const o of this.armies) {
      if (o === a || o.inside || o.owner === a.owner) continue;
      if (Math.hypot(a.x - o.x, a.y - o.y) < 4.5) {
        const t = a.target;
        if (this.atWar(a.owner, o.owner) || (t?.kind === 'army' && t.id === o.id)) return { kind: 'army', id: o.id };
      }
    }
    return null;
  }

  private async resolveContact(a: Army, t: Target) {
    if (t.kind === 'settlement') {
      const s = this.settlement(t.id)!;
      this.declareIfNeeded(a.owner, s.owner);
      await this.attackSettlement(a, s);
    } else if (t.kind === 'army') {
      const o = this.army(t.id)!;
      this.declareIfNeeded(a.owner, o.owner);
      await this.fight({ faction: a.owner, armies: [a.id] }, { faction: o.owner, armies: [o.id] }, o.x, o.y, null);
    }
  }

  merge(a: Army, into: Army) {
    const room = MAX_UNITS - into.units.length;
    const moved = a.units.splice(0, room);
    into.units.push(...moved);
    into.mp = Math.min(into.mp, a.mp);
    if (!a.units.length) this.armies = this.armies.filter((x) => x !== a);
  }

  /** Moves some units of an army into a new army (for splitting). */
  split(a: Army, unitIdx: number[]): Army | null {
    if (!unitIdx.length || unitIdx.length >= a.units.length + 1) return null;
    const keep: UnitStack[] = [];
    const take: UnitStack[] = [];
    a.units.forEach((u, i) => (unitIdx.includes(i) ? take : keep).push(u));
    if (!take.length) return null;
    if (!keep.length) return a;
    a.units = keep;
    const b: Army = { id: this.nextArmy++, owner: a.owner, x: a.x, y: a.y, units: take, mp: a.mp, inside: a.inside, path: [], target: null, name: this.armyName(a.owner) };
    this.armies.push(b);
    return b;
  }

  disband(a: Army, unitIdx: number) {
    a.units.splice(unitIdx, 1);
    if (!a.units.length) this.armies = this.armies.filter((x) => x !== a);
  }

  // ------------------------------------------------------------------ battles
  private async attackSettlement(a: Army, s: Settlement) {
    const defenders = this.garrison(s).filter((g) => g.owner === s.owner);
    if (!defenders.length || defenders.every((d) => !d.units.length)) {
      this.capture(s, a);
      return;
    }
    await this.fight({ faction: a.owner, armies: [a.id] }, { faction: s.owner, armies: defenders.map((d) => d.id) }, s.x, s.y, s.id);
  }

  landAt(x: number, y: number): { hills: number; dry: number } {
    const rough = this.map.roughness(x, y);
    return { hills: Math.max(0.3, Math.min(2, 0.5 + rough * 6)), dry: this.map.dryAt(x, y) };
  }

  unitsOf(side: BattleSide): { army: Army; i: number; u: UnitStack }[] {
    const out: { army: Army; i: number; u: UnitStack }[] = [];
    for (const id of side.armies) {
      const a = this.army(id);
      if (!a) continue;
      a.units.forEach((u, i) => {
        if (out.length < MAX_UNITS) out.push({ army: a, i, u });
      });
    }
    return out;
  }

  async fight(attacker: BattleSide, defender: BattleSide, x: number, y: number, settlement: string | null) {
    const b: PendingBattle = { attacker, defender, x, y, settlement, land: this.landAt(x, y) };
    const involvesPlayer = attacker.faction === this.player || defender.faction === this.player;
    const outcome = involvesPlayer && this.onBattle ? await this.onBattle(b) : this.autoResolve(b);
    this.applyBattle(b, outcome);
  }

  autoResolve(b: PendingBattle): BattleOutcome {
    const A = this.unitsOf(b.attacker);
    const D = this.unitsOf(b.defender);
    const s = b.settlement ? this.settlement(b.settlement) : undefined;
    const walls = s ? (s.buildings.walls ?? 0) : 0;
    const gen = (l: typeof A) => (l.some((x) => UNITS[x.u.unit]?.cls === 'general') ? 1.15 : 1);
    let sa = A.reduce((t, x) => t + unitStrength(x.u.unit, x.u.men), 0) * gen(A) * (0.85 + this.rand() * 0.3);
    let sd = D.reduce((t, x) => t + unitStrength(x.u.unit, x.u.men), 0) * gen(D) * (1 + walls * 0.3) * (0.85 + this.rand() * 0.3);
    sa = Math.max(1, sa);
    sd = Math.max(1, sd);
    const attackerWon = sa > sd;
    const ratio = attackerWon ? sd / sa : sa / sd; // loser strength relative to winner, < 1
    const winLoss = 0.08 + 0.45 * ratio * ratio;
    const loseLoss = 0.45 + 0.4 * (1 - ratio);
    const cas = (list: typeof A, loss: number) => list.map((x) => Math.max(0, Math.round(x.u.men * (1 - Math.min(1, loss * (0.7 + this.rand() * 0.6))))));
    return {
      attackerWon,
      survivors: [cas(A, attackerWon ? winLoss : loseLoss), cas(D, attackerWon ? loseLoss : winLoss)],
    };
  }

  applyBattle(b: PendingBattle, o: BattleOutcome) {
    const sides = [b.attacker, b.defender];
    let lostA = 0;
    let lostD = 0;
    sides.forEach((side, k) => {
      const list = this.unitsOf(side);
      list.forEach((x, i) => {
        const left = o.survivors[k][i] ?? x.u.men;
        if (k === 0) lostA += x.u.men - left;
        else lostD += x.u.men - left;
        x.u.men = left;
        x.u.xp = Math.min(9, x.u.xp + (left > 0 ? 1 : 0));
      });
      for (const id of side.armies) {
        const a = this.army(id);
        if (!a) continue;
        a.units = a.units.filter((u) => u.men >= Math.max(6, (UNITS[u.unit]?.men ?? 100) * 0.08));
        if (!a.units.length) this.armies = this.armies.filter((x) => x !== a);
      }
    });
    const att = this.faction(b.attacker.faction);
    const def = this.faction(b.defender.faction);
    const where = b.settlement ? ` at ${this.settlement(b.settlement)!.name}` : '';
    const winner = o.attackerWon ? att : def;
    const loser = o.attackerWon ? def : att;
    const mine = att.id === this.player || def.id === this.player;
    const playerWon = winner.id === this.player;
    this.addLog(`${winner.name} defeat ${loser.name}${where} (${lostA + lostD} men fell).`, mine ? (playerWon ? 'good' : 'bad') : 'info', b.x, b.y);
    if (o.attackerWon) {
      // Defenders that survive retreat; a settlement falls.
      if (b.settlement) {
        const s = this.settlement(b.settlement)!;
        for (const id of b.defender.armies) {
          const a = this.army(id);
          if (a) this.retreat(a, b.x, b.y);
        }
        const winnerArmy = this.army(b.attacker.armies[0]);
        if (winnerArmy && !this.garrison(s).some((g) => g.owner === s.owner)) this.capture(s, winnerArmy);
      } else {
        for (const id of b.defender.armies) {
          const a = this.army(id);
          if (a) this.retreat(a, b.x, b.y);
        }
      }
    } else {
      for (const id of b.attacker.armies) {
        const a = this.army(id);
        if (a) {
          a.mp = 0;
          a.path = [];
          this.retreat(a, b.x, b.y);
        }
      }
    }
  }

  private retreat(a: Army, fx: number, fy: number) {
    // Step back away from the enemy; a garrison that cannot leave its town is lost.
    if (a.inside) {
      const s = this.settlement(a.inside);
      if (s && s.owner === a.owner) {
        const own = this.settlements
          .filter((o) => o.owner === a.owner && o.id !== s.id)
          .sort((p, q) => Math.hypot(p.x - s.x, p.y - s.y) - Math.hypot(q.x - s.x, q.y - s.y))[0];
        if (!own || Math.hypot(own.x - s.x, own.y - s.y) > 160) {
          this.armies = this.armies.filter((x) => x !== a);
          return;
        }
        a.inside = null;
        const d = Math.hypot(own.x - s.x, own.y - s.y) || 1;
        a.x = s.x + ((own.x - s.x) / d) * 12;
        a.y = s.y + ((own.y - s.y) / d) * 12;
        return;
      }
    }
    const dx = a.x - fx;
    const dy = a.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    for (let r = 10; r <= 24; r += 2) {
      const nx = a.x + (dx / d) * r;
      const ny = a.y + (dy / d) * r;
      if (this.map.isLand(nx, ny)) {
        a.x = nx;
        a.y = ny;
        break;
      }
    }
    a.mp = 0;
    a.path = [];
  }

  capture(s: Settlement, by: Army) {
    const old = this.faction(s.owner);
    const nu = this.faction(by.owner);
    for (const g of this.garrison(s)) if (g.owner !== by.owner) this.armies = this.armies.filter((x) => x !== g);
    s.owner = by.owner;
    s.build = null;
    s.queue = [];
    s.unrest = 30;
    s.lowOrder = 0;
    s.tax = 1;
    by.path = [];
    by.mp = 0;
    by.target = null;
    this.enter(by, s);
    const loot = Math.round(s.pop * 0.05);
    nu.treasury += loot;
    this.addLog(`${nu.name} capture ${s.name}${loot ? ` and take ${loot} denarii in loot` : ''}.`, by.owner === this.player ? 'good' : old.id === this.player ? 'bad' : 'info', s.x, s.y);
    if (old.capital === s.id) {
      const next = this.settlements.filter((o) => o.owner === old.id).sort((p, q) => q.pop - p.pop)[0];
      old.capital = next ? next.id : null;
      if (next) next.capital = true;
      s.capital = false;
    }
    if (!nu.capital) {
      nu.capital = s.id;
      s.capital = true;
    }
    this.checkAlive(old);
  }

  private checkAlive(f: Faction) {
    if (f.id === 'rebels' || !f.alive) return;
    if (this.settlements.some((s) => s.owner === f.id)) return;
    f.alive = false;
    this.armies = this.armies.filter((a) => a.owner !== f.id);
    this.addLog(`${f.name} ${f.name.endsWith('s') ? 'have' : 'has'} been destroyed!`, f.id === this.player ? 'bad' : 'event');
  }

  addLog(text: string, kind: LogEntry['kind'], x?: number, y?: number) {
    this.log.push({ turn: this.turn, text, kind, x, y });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  // ------------------------------------------------------------------ turns
  /** Ends the player's turn: AI factions move, then everything ticks over to the next season. */
  async endTurn(ai: (c: Campaign, f: Faction) => Promise<void>) {
    // Player armies continue multi-turn paths at the start of next turn (after the tick), like RTW.
    for (const f of this.factions.values()) {
      if (f.id === this.player || !f.alive || f.id === 'rebels') continue;
      await ai(this, f);
    }
    this.tick();
    this.turn++;
    this.refreshMoves();
    await this.events();
    for (const a of this.armies.filter((x) => x.owner === this.player && x.path.length)) await this.advance(a);
  }

  /** Economy, growth, construction, recruitment and order for every settlement. */
  private tick() {
    const income = new Map<string, number>();
    for (const s of this.settlements) {
      const f = this.faction(s.owner);
      const rep = this.report(s);
      income.set(f.id, (income.get(f.id) ?? 0) + rep.income);
      s.pop = Math.max(400, Math.round(s.pop * (1 + rep.growth)));
      s.unrest = Math.max(0, s.unrest - 6);
      // Construction.
      if (s.build && --s.build.turns <= 0) {
        s.buildings[s.build.chain] = s.build.level;
        if (f.id === this.player) this.addLog(`${s.name}: ${CHAIN[s.build.chain].names[s.build.level - 1]} completed.`, 'info', s.x, s.y);
        s.build = null;
      }
      // Recruitment.
      const slots = this.recruitSlots(s);
      let done = 0;
      while (s.queue.length && done < slots) {
        const q = s.queue[0];
        if (--q.turns > 0) break;
        s.queue.shift();
        done++;
        const g = this.garrison(s).find((a) => a.owner === s.owner && a.units.length < MAX_UNITS);
        const unit = { unit: q.unit, men: UNITS[q.unit].men, xp: 0 };
        if (g) g.units.push(unit);
        else {
          const a = this.spawnArmy(s.owner, s.x, s.y, [], s.id);
          a.units.push(unit);
        }
      }
      // Revolts.
      if (f.id !== 'rebels') {
        s.lowOrder = rep.order < 40 ? s.lowOrder + 1 : 0;
        if (s.lowOrder >= 2) {
          for (const g of this.garrison(s)) this.armies = this.armies.filter((x) => x !== g);
          const old = f;
          s.owner = 'rebels';
          s.build = null;
          s.queue = [];
          s.lowOrder = 0;
          const list = GARRISON[s.native] ?? GARRISON.mixed;
          this.spawnArmy('rebels', s.x, s.y, [...list, list[0]], s.id);
          this.addLog(`${s.name} revolts against ${old.name}!`, old.id === this.player ? 'bad' : 'info', s.x, s.y);
          if (old.capital === s.id) {
            const next = this.settlements.filter((o) => o.owner === old.id).sort((p, q) => q.pop - p.pop)[0];
            old.capital = next ? next.id : null;
          }
          this.checkAlive(old);
        }
      }
    }
    for (const f of this.factions.values()) {
      if (!f.alive || f.id === 'rebels') continue;
      let up = 0;
      for (const a of this.armies) if (a.owner === f.id) for (const u of a.units) up += upkeep(u.unit);
      f.treasury += (income.get(f.id) ?? 0) - up;
      // Bankrupt factions lose their weakest unit each turn.
      if (f.treasury < -2000) {
        const a = this.armies.filter((x) => x.owner === f.id && x.units.length).sort((p, q) => q.units.length - p.units.length)[0];
        if (a) {
          a.units.pop();
          if (!a.units.length) this.armies = this.armies.filter((x) => x !== a);
          if (f.id === this.player) this.addLog('The treasury is empty: unpaid soldiers desert!', 'bad');
        }
      }
    }
    // Garrison armies in a settlement that changed hands are gone; stray empty armies too.
    this.armies = this.armies.filter((a) => a.units.length > 0);
  }

  private async events() {
    // The Marian reforms reshape the Roman army.
    const rome = this.factions.get('rome');
    if (rome && rome.alive && !rome.marian) {
      const owned = this.settlements.filter((s) => s.owner === 'rome').length;
      const roma = this.settlement('roma');
      if (this.year() >= -107 || (this.year() >= -180 && (owned >= 30 || (roma && roma.owner === 'rome' && roma.pop >= 40000)))) {
        rome.marian = true;
        const text = 'Gaius Marius has reformed the legions. Rome now recruits professional Legionary Cohorts, Auxilia and Legionary Cavalry instead of Hastati, Principes, Triarii, Velites and Equites.';
        this.addLog('The Marian reforms!', 'event');
        if (this.onEvent && (this.player === 'rome')) await this.onEvent('The Marian Reforms', text);
      }
    }
  }

  // ------------------------------------------------------------------ save / load
  save(): string {
    return JSON.stringify({
      v: 1, turn: this.turn, player: this.player, seed: this.seed, nextArmy: this.nextArmy,
      factions: [...this.factions.values()], settlements: this.settlements, armies: this.armies, log: this.log.slice(-60),
    });
  }

  load(json: string) {
    const d = JSON.parse(json);
    this.turn = d.turn;
    this.player = d.player;
    this.seed = d.seed;
    this.nextArmy = d.nextArmy;
    this.factions = new Map((d.factions as Faction[]).map((f) => [f.id, f]));
    this.settlements = d.settlements;
    this.armies = d.armies;
    this.log = d.log ?? [];
  }
}
