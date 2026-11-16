// Campaign AI: taxes, construction, recruitment, attacks and simple diplomacy.

import { UNITS } from '../sim/data';
import type { Army, Campaign, Faction, Settlement } from './state';
import type { Chain, Tax } from './rules';
import { MAX_UNITS, unitStrength } from './rules';

export async function aiTurn(c: Campaign, f: Faction) {
  const mine = c.settlements.filter((s) => s.owner === f.id);
  if (!mine.length) return;
  const enemies = (o: string) => c.atWar(f.id, o);

  // Continue marches from last turn.
  for (const a of c.armies.filter((x) => x.owner === f.id && x.path.length)) await c.advance(a);

  // Taxes: as high as order allows.
  for (const s of mine) {
    let best: Tax = 0;
    for (const t of [3, 2, 1, 0] as Tax[]) {
      s.tax = t;
      if (c.report(s).order >= 85) {
        best = t;
        break;
      }
    }
    s.tax = best;
  }

  const threat = (s: Settlement) => {
    let t = 0;
    for (const a of c.armies) if (enemies(a.owner) && a.owner !== 'rebels' && Math.hypot(a.x - s.x, a.y - s.y) < 90) t += c.armyStrength(a);
    return t;
  };
  const defense = (s: Settlement) => c.garrison(s).reduce((t, a) => t + c.armyStrength(a), 0) * (1 + (s.buildings.walls ?? 0) * 0.3);
  const border = (s: Settlement) => c.settlements.some((o) => o.owner !== f.id && enemies(o.owner) && Math.hypot(o.x - s.x, o.y - s.y) < 160);

  // Construction.
  const reserve = 800;
  for (const s of shuffle(c, mine)) {
    if (s.build) continue;
    const rep = c.report(s);
    const prio: Chain[] = rep.order < 80 ? ['temple', 'farms', 'market'] : border(s) ? ['barracks', 'walls', 'farms', 'market', 'stables', 'temple', 'port', 'roads'] : ['farms', 'market', 'port', 'roads', 'temple', 'barracks', 'stables', 'walls'];
    for (const ch of prio) {
      const b = c.canBuild(s, ch);
      if (b && b.ok && f.treasury - b.cost > reserve) {
        c.startBuild(s, ch);
        break;
      }
    }
  }

  // Recruitment: keep border towns defended and grow a field army while money allows.
  const net = c.incomeOf(f.id).net;
  let budget = f.treasury - 600;
  const wantMore = net > 150 || f.treasury > 4000;
  for (const s of shuffle(c, mine).sort((a, b) => threat(b) - threat(a))) {
    if (budget < 250) break;
    const opts = c.recruitable(s).filter((o) => UNITS[o.def.unit]?.cls !== 'general' && o.cost <= budget);
    if (!opts.length) continue;
    const t = threat(s);
    const d = defense(s);
    const needs = t > d * 0.7 || (border(s) && d < 4000) || (wantMore && c.rand() < 0.35);
    if (!needs || s.queue.length >= c.recruitSlots(s)) continue;
    // Prefer the strongest unit per denarius, with some variety.
    opts.sort((a, b) => unitStrength(b.def.unit, UNITS[b.def.unit].men) / b.cost - unitStrength(a.def.unit, UNITS[a.def.unit].men) / a.cost);
    const pick = opts[Math.min(opts.length - 1, Math.floor(c.rand() * Math.min(3, opts.length)))];
    if (c.recruit(s, pick.def.unit)) budget -= pick.cost;
  }

  // Split big garrisons into field armies, but keep the number of field armies sensible.
  const fieldCount = () => c.armies.filter((a) => a.owner === f.id && !a.inside).length;
  const maxField = Math.max(1, Math.ceil(mine.length / 3));
  for (const s of mine) {
    if (fieldCount() >= maxField) break;
    const g = c.garrison(s).filter((a) => a.owner === f.id);
    const total = g.reduce((t, a) => t + a.units.length, 0);
    const keep = border(s) ? 4 : 2;
    if (total >= keep + 4 && threat(s) < defense(s) * 0.5) {
      const a = g[0];
      const idx = a.units.map((_, i) => i).slice(keep);
      if (idx.length >= 3) c.split(a, idx);
    }
  }

  // Armies that meet in the field join up.
  const loose = c.armies.filter((a) => a.owner === f.id && !a.inside && !a.path.length);
  for (const a of loose) {
    if (!c.army(a.id)) continue;
    const b = loose.find((x) => x !== a && c.army(x.id) && Math.hypot(x.x - a.x, x.y - a.y) < 10 && x.units.length + a.units.length <= MAX_UNITS);
    if (b) c.merge(a, b);
  }

  // Field armies attack.
  const field = c.armies.filter((a) => a.owner === f.id && !a.path.length && a.mp > 10);
  for (const a of field) {
    if (!c.army(a.id) || a.units.length < 3) continue;
    if (a.inside) {
      const s = c.settlement(a.inside)!;
      const others = c.garrison(s).filter((x) => x.id !== a.id && x.owner === f.id);
      // Never strip a town bare.
      if (!others.length) continue;
    }
    const str = c.armyStrength(a);
    let best: { score: number; go: () => Promise<void> } | null = null;
    for (const s of c.settlements) {
      if (!enemies(s.owner)) continue;
      const d = Math.hypot(s.x - a.x, s.y - a.y);
      if (d > 230) continue;
      if (!c.map.landConnected(a.x, a.y, s.x, s.y) && !(a.inside && c.canSail(a, s))) continue;
      const def = defense(s) + 1;
      if (str < def * 1.35) continue;
      const score = (s.pop / 1000 + 4) / (d + 30) * (s.owner === 'rebels' ? 0.8 : 1.2);
      if (!best || score > best.score) best = { score, go: () => c.order(a, { kind: 'settlement', id: s.id }) };
    }
    for (const o of c.armies) {
      if (o.inside || !enemies(o.owner) || o.owner === 'rebels') continue;
      const d = Math.hypot(o.x - a.x, o.y - a.y);
      if (d > 120 || !c.map.landConnected(a.x, a.y, o.x, o.y)) continue;
      if (str < c.armyStrength(o) * 1.3) continue;
      const score = (o.units.length + 2) / (d + 20);
      if (!best || score > best.score) best = { score, go: () => c.order(a, { kind: 'army', id: o.id }) };
    }
    if (best) await best.go();
    else if (!a.inside) {
      // Nothing worth attacking: go home and wait.
      const home = mine.filter((s) => c.map.landConnected(a.x, a.y, s.x, s.y)).sort((p, q) => threat(q) - threat(p) || Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))[0];
      if (home) await c.order(a, { kind: 'settlement', id: home.id });
    }
  }

  // Diplomacy: occasional wars of opportunity and tired peace.
  const myStr = c.armies.filter((a) => a.owner === f.id).reduce((t, a) => t + c.armyStrength(a), 0);
  const neighbours = new Set<string>();
  for (const s of mine) for (const o of c.settlements) if (o.owner !== f.id && o.owner !== 'rebels' && Math.hypot(o.x - s.x, o.y - s.y) < 150) neighbours.add(o.owner);
  const realWars = f.wars.filter((w) => c.faction(w).alive);
  if (realWars.length === 0 && c.rand() < 0.05) {
    let pick: string | null = null;
    let bestRatio = 1.6;
    for (const n of neighbours) {
      const theirs = c.armies.filter((a) => a.owner === n).reduce((t, a) => t + c.armyStrength(a), 0) + 1;
      const ratio = myStr / theirs;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        pick = n;
      }
    }
    if (pick) {
      c.setWar(f.id, pick, true);
      c.addLog(`${f.name} declare war on ${c.faction(pick).name}!`, pick === c.player ? 'bad' : 'info');
    }
  } else {
    for (const w of realWars) {
      if (w === c.player) continue;
      if (c.rand() < 0.025) {
        c.setWar(f.id, w, false);
        c.addLog(`${f.name} and ${c.faction(w).name} make peace.`, 'info');
      }
    }
  }
}

/** Would this AI faction accept peace with the player? */
export function acceptsPeace(c: Campaign, f: Faction): boolean {
  const theirs = c.armies.filter((a) => a.owner === f.id).reduce((t, a) => t + c.armyStrength(a), 0) + 1;
  const ours = c.armies.filter((a) => a.owner === c.player).reduce((t, a) => t + c.armyStrength(a), 0) + 1;
  return ours / theirs > 0.9 || c.rand() < 0.25;
}

function shuffle<T>(c: Campaign, list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(c.rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function armyLabel(a: Army): string {
  return `${a.units.length} unit${a.units.length === 1 ? '' : 's'}`;
}

export { MAX_UNITS };
