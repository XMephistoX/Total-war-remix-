// Campaign -> real battle -> back to campaign, with screenshots. Fast-forwards the battle with both sides on AI.
import puppeteer from 'puppeteer-core';
const url = process.env.GAME_URL ?? 'http://localhost:4173/';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 760 }, protocolTimeout: 900000 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(url);
await page.waitForFunction(() => window.__game && window.__game.view, { timeout: 300000 });
await page.evaluate(() => document.querySelector('[data-group="csize"][data-value="normal"]').click());
await page.evaluate(() => document.getElementById('goCampaign').click());
await page.evaluate(() => document.querySelector('.pf[data-f="rome"]').click());
await page.waitForFunction(() => window.__campaign && window.__campaign.active, { timeout: 300000 });
await page.evaluate(() => document.querySelector('#cDialog button')?.click());
step('campaign open');
await page.screenshot({ path: 'shots/cb0-map.png' });
// Start a battle between the Roman field army and the Gallic army at Gergovia (moved next to it).
const before = await page.evaluate(() => {
  const ui = window.__campaign;
  const c = ui.c;
  const r = c.armies.find((a) => a.owner === 'rome' && !a.inside);
  const g = c.armies.find((a) => a.owner === 'gauls' && !a.inside);
  g.x = r.x + 3; g.y = r.y + 2;
  window.__fight = c.fight({ faction: 'rome', armies: [r.id] }, { faction: 'gauls', armies: [g.id] }, r.x, r.y, null);
  return { r: r.id, g: g.id, rmen: c.armyMen(r), gmen: c.armyMen(g) };
});
await page.waitForFunction(() => !document.getElementById('cDialog').hidden, { timeout: 60000 });
await page.screenshot({ path: 'shots/cb1-prompt.png' });
await page.evaluate(() => document.querySelector('#cDialog button[data-i="0"]').click());
await page.waitForFunction(() => document.getElementById('campaign').hidden && window.__game.settings?.campaign && window.__game.battle.time === 0 && window.__game.view && !window.__game.suspended, { timeout: 300000 });
step('battle ready');
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: 'shots/cb2-deploy.png' });
await page.evaluate(() => {
  const g = window.__game;
  g.autoPlayer = true;
  g.ai[g.player] = new g.ai[g.enemy].constructor(g.player, 0);
  g.started = true;
  g.paused = true;
  const b = g.battle;
  while (b.time < 70) { g.ai[0]?.update(b); g.ai[1]?.update(b); b.step(); }
  let x = 0, z = 0, n = 0;
  for (const u of b.units) if (u.inMelee > 0) { x += u.mx; z += u.mz; n++; }
  if (n) g.cam.jump(x / n, z / n, 0.7, 40, 0.35);
});
await new Promise((r) => setTimeout(r, 5000));
await page.screenshot({ path: 'shots/cb3-fight.png' });
await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  while (!b.result && b.time < 1500) { g.ai[0]?.update(b); g.ai[1]?.update(b); b.step(); }
  g.paused = false;
});
await page.waitForFunction(() => !document.getElementById('end').hidden, { timeout: 120000 });
await page.screenshot({ path: 'shots/cb4-end.png' });
await page.evaluate(() => document.getElementById('endCampaign').click());
await page.waitForFunction(() => window.__campaign.active, { timeout: 60000 });
await page.evaluate(() => window.__fight);
const after = await page.evaluate((ids) => {
  const c = window.__campaign.c;
  const r = c.army(ids.r);
  const g = c.army(ids.g);
  return { rmen: r ? c.armyMen(r) : 0, gmen: g ? c.armyMen(g) : 0, log: c.log.slice(-2).map((l) => l.text) };
}, before);
step(`before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: 'shots/cb5-back.png' });
console.log(errors.slice(0, 12).join('\n') || 'no errors');
await browser.close();
