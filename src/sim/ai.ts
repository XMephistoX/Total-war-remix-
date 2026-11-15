// Simple battle AI. Holds a line, advances, charges the closest enemies, uses archers
// from behind the line, sends cavalry around the flanks and into the rear of enemies
// that are already fighting, and pulls cavalry back out of long grinding melees.

import type { Battle, Unit } from './battle';

export class BattleAI {
  readonly side: number;
  private phase: 'hold' | 'advance' | 'engage' = 'hold';
  private next = 0;
  private readonly holdUntil: number;
  private cavCycle = new Map<number, number>();

  constructor(side: number, holdSeconds = 35) {
    this.side = side;
    this.holdUntil = holdSeconds;
  }

  update(b: Battle) {
    if (b.time < this.next || b.result) return;
    this.next = b.time + 0.5;

    const mine = b.units.filter((u) => u.side === this.side && u.active);
    const enemies = b.units.filter((u) => u.side !== this.side && u.active);
    const routers = b.units.filter((u) => u.side !== this.side && u.routing && u.alive > 0);
    if (mine.length === 0) return;

    const myC = centroid(mine);
    if (enemies.length === 0) {
      for (const u of mine) {
        if (u.def.mounted && routers.length > 0 && u.order.kind !== 'attack') {
          b.orderAttack(u.id, nearest(u, routers).id, true);
        }
      }
      return;
    }
    const enC = centroid(enemies);
    let fx = enC.x - myC.x;
    let fz = enC.z - myC.z;
    const gap = Math.hypot(fx, fz) || 1;
    fx /= gap;
    fz /= gap;
    const rx = -fz;
    const rz = fx;

    let closest = 1e9;
    for (const u of mine) for (const e of enemies) closest = Math.min(closest, dist(u, e));
    if (this.phase === 'hold' && (b.time > this.holdUntil || closest < 230)) this.phase = 'advance';
    if (this.phase === 'advance' && closest < 75) this.phase = 'engage';

    // Where the battle line wants to be: walk toward the enemy, stop short of contact.
    const lineAdvance = this.phase === 'hold' ? 0 : Math.max(0, Math.min(30, closest - 60));
    const lineX = myC.x + fx * lineAdvance;
    const lineZ = myC.z + fz * lineAdvance;
    const linePos = (u: Unit) => ({
      x: lineX + rx * u.homeDx - fx * u.homeDz,
      z: lineZ + rz * u.homeDx - fz * u.homeDz,
    });

    for (const u of mine) {
      const cls = u.def.cls;
      const busy = u.inMeleePrev > 0;
      if (cls === 'missile') {
        this.missile(b, u, enemies, linePos(u), fx, fz);
      } else if (cls === 'cavalry') {
        this.cavalry(b, u, enemies, routers, linePos(u), fx, fz);
      } else if (cls === 'general') {
        // Stay behind the line, join in only against weak or broken enemies nearby.
        const near = enemies.filter((e) => dist(u, e) < 45);
        if (near.length > 0 && !busy) {
          b.orderAttack(u.id, nearest(u, near).id, true);
        } else if (routers.length > 0 && !busy && this.phase === 'engage') {
          const r = nearest(u, routers);
          if (dist(u, r) < 90) b.orderAttack(u.id, r.id, true);
        } else if (!busy && u.order.kind !== 'attack') {
          const others = mine.filter((m) => m !== u);
          if (others.length === 0) {
            b.orderAttack(u.id, nearest(u, enemies).id, true);
            continue;
          }
          const oc = centroid(others);
          const p = { x: oc.x - fx * 55, z: oc.z - fz * 55 };
          if (Math.hypot(p.x - u.cx, p.z - u.cz) > 12) b.orderMove(u.id, p.x, p.z, fx, fz, false);
        }
      } else {
        // Infantry and spears.
        const cur = u.order.kind === 'attack' ? b.units[u.order.target] : null;
        const curValid = cur && cur.active;
        const chasing = cur && cur.routing;
        if (busy && curValid) continue;
        if (this.phase === 'engage') {
          const e = nearest(u, enemies);
          const d = dist(u, e);
          if (d < 110 && (!curValid || (chasing && b.time - u.aiTargetTime > 6) || b.time - u.aiTargetTime > 8)) {
            if (!curValid || cur!.id !== e.id) {
              b.orderAttack(u.id, e.id, d < 45);
              u.aiTargetTime = b.time;
            } else if (d < 45 && !u.order.run) {
              u.order.run = true;
            }
            continue;
          }
          if (curValid) {
            if (dist(u, cur!) < 45) u.order.run = true;
            continue;
          }
        }
        if (busy) continue;
        if (chasing && b.time - u.aiTargetTime < 8) continue;
        const p = linePos(u);
        if (this.phase !== 'hold' && Math.hypot(p.x - u.cx, p.z - u.cz) > 3) b.orderMove(u.id, p.x, p.z, fx, fz, false);
      }
    }
  }

  private missile(b: Battle, u: Unit, enemies: Unit[], home: { x: number; z: number }, fx: number, fz: number) {
    // Skirmish: back off from approaching melee troops.
    const threat = enemies.filter((e) => !e.def.missile && dist(u, e) < 38 && e.order.kind !== 'none');
    if (threat.length > 0 && u.inMeleePrev === 0) {
      const t = nearest(u, threat);
      const ax = u.mx - t.mx;
      const az = u.mz - t.mz;
      const l = Math.hypot(ax, az) || 1;
      if (u.order.kind !== 'move' || !u.order.run) b.orderMove(u.id, u.mx + (ax / l) * 45 - fx * 10, u.mz + (az / l) * 45 - fz * 10, fx, fz, true);
      return;
    }
    if (u.order.kind === 'move' && u.moving) return;
    if (b.ammoLeft(u) <= 0) {
      if (Math.hypot(home.x - u.cx, home.z - u.cz) > 10) b.orderMove(u.id, home.x - fx * 40, home.z - fz * 40, fx, fz, false);
      return;
    }
    // Fire at the nearest enemy that is not mixed up with our troops.
    let best: Unit | null = null;
    let bestD = 1e9;
    for (const e of enemies) {
      const d = dist(u, e);
      const mixed = e.inMeleePrev > 3;
      const score = d + (mixed ? 500 : 0);
      if (score < bestD) {
        bestD = score;
        best = e;
      }
    }
    if (best && bestD < 220 && this.phase !== 'hold') {
      if (u.order.kind !== 'attack' || u.order.target !== best.id) b.orderAttack(u.id, best.id, false);
      return;
    }
    if (this.phase !== 'hold' && Math.hypot(home.x - u.cx, home.z - u.cz) > 4) b.orderMove(u.id, home.x, home.z, fx, fz, false);
  }

  private cavalry(b: Battle, u: Unit, enemies: Unit[], routers: Unit[], home: { x: number; z: number }, fx: number, fz: number) {
    // Pull out of long grinding fights, then charge again.
    if (u.inMeleePrev > 0 && u.meleeTime > 12 && u.order.kind === 'attack') {
      const t = b.units[u.order.target];
      const ax = u.mx - (t ? t.mx : u.mx + fx);
      const az = u.mz - (t ? t.mz : u.mz + fz);
      const l = Math.hypot(ax, az) || 1;
      b.orderMove(u.id, u.mx + (ax / l) * 60, u.mz + (az / l) * 60, -ax / l, -az / l, true);
      this.cavCycle.set(u.id, b.time + 9);
      return;
    }
    if ((this.cavCycle.get(u.id) ?? 0) > b.time) return;
    if (u.inMeleePrev > 0) return;

    const cur = u.order.kind === 'attack' ? b.units[u.order.target] : null;
    if (cur && cur.active && b.time - u.aiTargetTime < 10) return;

    // 1) Enemy missile troops that are exposed.
    const missiles = enemies.filter((e) => e.def.missile && dist(u, e) < 260);
    // 2) Enemies already locked in melee with our infantry: hit them in the rear.
    const engaged = enemies.filter((e) => e.inMeleePrev > 5 && !e.def.mounted);
    // 3) Routing enemies: run them down.
    let target: Unit | null = null;
    if (this.phase !== 'hold' && missiles.length > 0) target = nearest(u, missiles);
    else if (engaged.length > 0) target = nearest(u, engaged);
    else if (routers.length > 0 && this.phase === 'engage') target = nearest(u, routers);
    else {
      const cav = enemies.filter((e) => e.def.mounted && dist(u, e) < 70);
      if (cav.length > 0) target = nearest(u, cav);
    }

    if (target) {
      // Approach from behind if the target is facing us.
      const rearX = target.mx - target.fx * 40;
      const rearZ = target.mz - target.fz * 40;
      const toU = Math.hypot(rearX - u.mx, rearZ - u.mz);
      const facingUs = (u.mx - target.mx) * target.fx + (u.mz - target.mz) * target.fz > 0;
      if (!target.routing && !target.def.missile && facingUs && toU > 25 && dist(u, target) > 30) {
        // Swing wide around the flank.
        const sideSign = (u.mx - target.mx) * -target.fz + (u.mz - target.mz) * target.fx > 0 ? 1 : -1;
        const wx = target.mx - target.fz * 70 * sideSign - target.fx * 30;
        const wz = target.mz + target.fx * 70 * sideSign - target.fz * 30;
        const viaX = Math.hypot(wx - u.mx, wz - u.mz) > 20 ? wx : rearX;
        const viaZ = Math.hypot(wx - u.mx, wz - u.mz) > 20 ? wz : rearZ;
        if (u.order.kind !== 'move' || Math.hypot(u.order.x - viaX, u.order.z - viaZ) > 15) {
          b.orderMove(u.id, viaX, viaZ, target.mx - viaX, target.mz - viaZ, true);
        }
        return;
      }
      b.orderAttack(u.id, target.id, true);
      u.aiTargetTime = b.time;
      return;
    }
    if (this.phase !== 'hold' && u.order.kind !== 'move' && Math.hypot(home.x - u.cx, home.z - u.cz) > 6) {
      b.orderMove(u.id, home.x, home.z, fx, fz, false);
    }
  }
}

function centroid(us: Unit[]) {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const u of us) {
    x += u.mx * u.alive;
    z += u.mz * u.alive;
    n += u.alive;
  }
  return { x: x / Math.max(1, n), z: z / Math.max(1, n) };
}

function dist(a: Unit, b: Unit) {
  return Math.hypot(a.mx - b.mx, a.mz - b.mz);
}

function nearest(u: Unit, list: Unit[]): Unit {
  let best = list[0];
  let bd = 1e9;
  for (const e of list) {
    const d = dist(u, e);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}
