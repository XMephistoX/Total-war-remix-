// Runs the campaign with every faction on AI for N turns, no graphics. Checks for crashes and prints a summary.
// Usage: npx tsx tools/headless-campaign.ts [turns] [player]
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { MapData } from '../src/campaign/map';
import type { MapMeta } from '../src/campaign/map';
import { Campaign } from '../src/campaign/state';
import { aiTurn } from '../src/campaign/ai';

const turns = Number(process.argv[2] ?? 40);
const player = process.argv[3] ?? 'rome';
const base = new URL('../public/campaign/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('map.json', base), 'utf8')) as MapMeta;
const t = PNG.sync.read(readFileSync(new URL('terrain.png', base)));
const r = PNG.sync.read(readFileSync(new URL('regions.png', base)));
const map = new MapData(meta, t.data, r.data);
const c = new Campaign(map);
c.newGame(player, 7);
// The player is also run by the AI here; battles involving it auto-resolve.
c.onBattle = async (b) => c.autoResolve(b);
const t0 = performance.now();
for (let i = 0; i < turns; i++) {
  const ts = performance.now();
  await aiTurn(c, c.faction(player));
  await c.endTurn(aiTurn);
  const ms = performance.now() - ts;
  if (i % 10 === 9 || i === turns - 1) {
    const counts = [...c.factions.values()].filter((f) => f.alive).map((f) => `${f.id}:${c.settlements.filter((s) => s.owner === f.id).length}`).join(' ');
    console.log(`${c.yearName()} (${ms.toFixed(0)} ms/turn) ${counts}`);
  }
}
const f = c.faction(player);
const inc = c.incomeOf(player);
console.log(`${player}: treasury ${f.treasury}, income ${inc.income}, upkeep ${inc.upkeep}, armies ${c.armies.filter((a) => a.owner === player).length}, marian ${f.marian}`);
console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)} s; last log:`);
for (const l of c.log.slice(-12)) console.log('  ', l.text);
