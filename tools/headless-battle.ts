// Runs AI vs AI battles without graphics to check balance, mechanics and speed.
// Usage: npm run sim -- [seeds=3] [size=large] [verbose]
import { Battle, DT } from '../src/sim/battle';
import { BattleAI } from '../src/sim/ai';
import type { UnitSize } from '../src/sim/data';

const seeds = Number(process.argv[2] ?? 3);
const size = (process.argv[3] ?? 'large') as UnitSize;
const verbose = process.argv.includes('verbose');

for (let seed = 1; seed <= seeds; seed++) {
  const b = new Battle({ seed, size, factions: ['rome', 'gauls'], aiSides: [true, true] });
  const ai = [new BattleAI(0, 5), new BattleAI(1, 5)];
  const t0 = performance.now();
  let ticks = 0;
  let maxTick = 0;
  let firstContact = -1;
  let evIdx = 0;
  while (b.time < 900 && (!b.result || b.time - b.result.time < 20)) {
    const s = performance.now();
    ai[0].update(b);
    ai[1].update(b);
    b.step();
    maxTick = Math.max(maxTick, performance.now() - s);
    ticks++;
    if (firstContact < 0 && b.units.some((u) => u.inMelee > 0 && !u.def.mounted && !u.def.missile)) firstContact = b.time;
    if (verbose) {
      while (evIdx < b.events.length) {
        const e = b.events[evIdx++];
        const u = b.units[e.unit];
        const why = e.kind === 'rout' && u ? ' <- ' + u.mods.map((m) => `${m.label} ${m.value}`).join(', ') + ` shock ${u.shock.toFixed(0)} alive ${u.alive}` : '';
        console.log(`  [${e.t.toFixed(1)}s] ${e.side === 0 ? 'ROME ' : 'GAULS'} ${e.text}${why}`);
      }
      if (ticks % 400 === 0) {
        const line = b.units
          .filter((u) => !u.gone)
          .map((u) => `${u.def.id.slice(0, 6)}:${u.alive}/${Math.round(u.morale)}/${Math.round(u.energy)}${u.state === 'ok' ? '' : '(' + u.state[0] + ')'}`)
          .join(' ');
        console.log(`  t=${b.time.toFixed(0)} ${line}`);
      }
    }
  }
  const ms = performance.now() - t0;
  const s0 = b.sideStats(0);
  const s1 = b.sideStats(1);
  console.log(
    `seed ${seed} (${size}, ${b.N} soldiers): ${b.result ? (b.result.winner === 0 ? 'ROME' : 'GAULS') + ' won at ' + b.result.time.toFixed(0) + 's' : 'no result'}; ` +
      `infantry contact ${firstContact.toFixed(0)}s; Rome lost ${s0.dead} dead/${s0.fled} fled of ${s0.start}; Gauls lost ${s1.dead} dead/${s1.fled} fled of ${s1.start}; ` +
      `avg ${(ms / ticks).toFixed(2)} ms/tick (max ${maxTick.toFixed(1)}), sim speed ${((ticks * DT * 1000) / ms).toFixed(0)}x realtime`,
  );
}
