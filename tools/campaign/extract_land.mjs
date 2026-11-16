// Prints Natural Earth (public domain) land polygons that touch the campaign map, as JSON.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
const require = createRequire(import.meta.url);
const topo = require('world-atlas/land-10m.json');
const world = JSON.parse(readFileSync(new URL('../../src/campaign/world.json', import.meta.url)));
const b = world.bbox;
const out = [];
for (const f of feature(topo, topo.objects.land).features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const p of polys) {
    if (p[0].some(([x, y]) => x > b.lonMin - 2 && x < b.lonMax + 2 && y > b.latMin - 2 && y < b.latMax + 2)) out.push(p);
  }
}
process.stdout.write(JSON.stringify(out));
