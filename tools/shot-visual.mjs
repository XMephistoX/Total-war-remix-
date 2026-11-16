// Screenshots of the battle with the real models: deployment close-up, then mid-battle.
import puppeteer from 'puppeteer-core';
const url = process.env.GAME_URL ?? 'http://localhost:4173/';
const size = process.argv[2] ?? 'normal';
const times = (process.argv[3] ?? '0,90').split(',').map(Number);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 860 }, protocolTimeout: 600000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => window.__game && window.__game.view, { timeout: 120000 });
await page.evaluate((size) => document.querySelector(`[data-group="size"][data-value="${size}"]`).click(), size);
await page.evaluate(() => document.getElementById('go').click());
await page.waitForFunction(() => document.getElementById('start').hidden && window.__game.view && window.__game.battle.time === 0, { timeout: 120000 });
await page.evaluate(() => { const g = window.__game; g.autoPlayer = true; g.ai[g.player] = new g.ai[g.enemy].constructor(g.player, 0); g.started = true; g.paused = true; });
let k = 0;
for (const t of times) {
  await page.evaluate((t) => {
    const g = window.__game, b = g.battle;
    while (b.time < t) { g.ai[0]?.update(b); g.ai[1]?.update(b); b.step(); }
    let x = 0, z = 0, n = 0;
    for (const u of b.units) if (u.inMelee > 0) { x += u.mx; z += u.mz; n++; }
    if (!n) { const u = b.units.find((u) => u.def.id === 'hastati'); x = u.mx; z = u.mz - 4; n = 1; }
    g.cam.jump(x / n, z / n, 0.7, 26, 0.32);
  }, t);
  await new Promise((r) => setTimeout(r, 6000));
  await page.screenshot({ path: `shots/v${k}-close.png` });
  await page.evaluate(() => { const g = window.__game; g.cam.jump(g.cam.tx, g.cam.tz, 0.4, 160, 0.55); });
  await new Promise((r) => setTimeout(r, 6000));
  await page.screenshot({ path: `shots/v${k}-wide.png` });
  k++;
}
console.log(errors.slice(0, 10).join('\n') || 'no errors');
await browser.close();
