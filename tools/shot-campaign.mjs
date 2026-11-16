// Screenshots of the campaign map: overview, a selected town, a selected army with a path, after one turn.
import puppeteer from 'puppeteer-core';
const url = process.env.GAME_URL ?? 'http://localhost:4173/';
const faction = process.argv[2] ?? 'rome';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 760 }, protocolTimeout: 900000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(url);
await page.waitForFunction(() => window.__game && window.__game.view, { timeout: 300000 });
step('menu');
await page.evaluate(() => document.getElementById('goCampaign').click());
await page.evaluate((f) => document.querySelector(`.pf[data-f="${f}"]`).click(), faction);
await page.waitForFunction(() => window.__campaign && window.__campaign.active, { timeout: 300000 });
step('campaign open');
await page.evaluate(() => document.querySelector('#cDialog button')?.click());
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: 'shots/c0-start.png' });
await page.evaluate(() => { const c = window.__campaign; c.cam.jump(c.cam.tx, c.cam.tz, 0.2, 520, 1.1); });
await new Promise((r) => setTimeout(r, 5000));
await page.screenshot({ path: 'shots/c1-wide.png' });
step('wide');
// Select the capital.
await page.evaluate(() => { const c = window.__campaign; const s = c.c.settlement(c.c.faction(c.c.player).capital); c.cam.jump(s.x - c.c.map.W / 2, s.y - c.c.map.H / 2 + 10, 0, 90, 0.8); c.selectSettlement(s.id); });
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: 'shots/c2-town.png' });
step('town');
// Select the field army and preview a path.
const tgt = await page.evaluate(() => {
  const c = window.__campaign;
  const a = c.c.armies.find((x) => x.owner === c.c.player && !x.inside) ?? c.c.armies.find((x) => x.owner === c.c.player && x.units.length > 5);
  c.selectArmy(a.id);
  const p = c.view.project(a.x + 12, a.y - 18, 0);
  return { x: p.sx, y: p.sy, id: a.id };
});
await page.mouse.move(tgt.x, tgt.y);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'shots/c3-army.png' });
step('army');
// End turn.
await page.evaluate(() => window.__campaign.endTurn());
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: 'shots/c4-turn2.png' });
const info = await page.evaluate(() => ({ turn: window.__campaign.c.yearName(), log: window.__campaign.c.log.slice(-5).map((l) => l.text) }));
step(JSON.stringify(info));
console.log(errors.slice(0, 12).join('\n') || 'no errors');
await browser.close();
