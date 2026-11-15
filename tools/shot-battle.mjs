// Fast-forwards an AI vs AI battle inside the real page and screenshots key moments.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const out = process.argv[2] ?? 'shots';
const times = (process.argv[3] ?? '40,75,110,160').split(',').map(Number);
const file = pathToFileURL(process.cwd() + '/dist/index.html').href;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1440, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.type() + ': ' + m.text()); });
await page.goto(file);
await page.evaluate((d) => (window.__dist = d), Number(process.argv[4] ?? 95));
await new Promise((r) => setTimeout(r, 2000));
await page.click('#go');
await new Promise((r) => setTimeout(r, 1500));
await page.click('#btnMenu');
await page.click('#mAuto');
await page.click('#btnPause');
await page.click('#btnPause'); // pause again; we step manually
let k = 0;
for (const t of times) {
  const info = await page.evaluate((t) => {
    const g = window.__game;
    const b = g.battle;
    while (b.time < t) { g.ai[0]?.update(b); g.ai[1]?.update(b); b.step(); }
    // Find where the action is: centroid of units in melee, else of everything.
    let x = 0, z = 0, n = 0;
    for (const u of b.units) if (u.inMelee > 0) { x += u.mx; z += u.mz; n++; }
    if (!n) for (const u of b.units) if (u.active) { x += u.mx; z += u.mz; n++; }
    x /= n; z /= n;
    const own = b.units.find((u) => u.side === 0 && u.inMelee > 0) || b.units.find((u) => u.side === 0 && u.active);
    g.selected.clear();
    if (own) { g.selected.add(own.id); g.focus = own.id; }
    g.cam.jump(x, z, 0.5, Number(window.__dist || 95), 0.42);
    return { x, z, time: b.time, events: b.events.slice(-4).map((e) => e.text) };
  }, t);
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${out}/b${k}-close.png` });
  await page.evaluate(() => { const g = window.__game; g.cam.jump(g.cam.tx, g.cam.tz, 0.5, 260, 0.75); });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: `${out}/b${k}-wide.png` });
  console.log(k, JSON.stringify(info));
  k++;
}
console.log(errors.slice(0, 20).join('\n') || 'no errors');
await browser.close();
