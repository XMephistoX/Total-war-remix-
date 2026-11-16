// Drives the real UI with mouse input and checks that orders reach the simulation.
import puppeteer from 'puppeteer-core';
const file = process.env.GAME_URL ?? 'http://localhost:4173/';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1440, height: 860 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
await page.goto(file);
step('page loaded');
await page.waitForFunction(() => window.__game && window.__game.view, { timeout: 120000 });
await page.evaluate(() => document.querySelector('[data-group="size"][data-value="normal"]')?.click());
step('menu ready');
await page.evaluate(() => document.getElementById('go').click());
await page.waitForFunction(() => document.getElementById('start').hidden && window.__game.battle.time === 0, { timeout: 120000 });
step('battle ready');
await new Promise((r) => setTimeout(r, 1500));
const check = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${extra}`);
const state = () => page.evaluate(() => {
  const g = window.__game;
  return { sel: [...g.selected], units: g.battle.units.map((u) => ({ id: u.id, side: u.side, name: u.def.name, order: u.order.kind, run: u.order.run, files: u.files, target: u.order.target, cx: u.cx, cz: u.cz, x: u.order.x, z: u.order.z })) };
});

// 1) Click the third card (Hastati).
const cards = await page.$$('.card');
await cards[2].click();
let s = await state();
check('card click selects unit', s.sel.length === 1 && s.units[s.sel[0]].name === 'Hastati', JSON.stringify(s.sel));
const hid = s.sel[0];

// 2) Right-click on the ground in the middle of the screen -> move order.
await page.mouse.click(720, 380, { button: 'right' });
s = await state();
check('right click ground gives move order', s.units[hid].order === 'move' && !s.units[hid].run, `${s.units[hid].x.toFixed(0)},${s.units[hid].z.toFixed(0)}`);

// 3) Double right-click -> run.
await page.mouse.click(700, 400, { button: 'right' });
await page.mouse.click(700, 400, { button: 'right' });
s = await state();
check('double right click runs', s.units[hid].order === 'move' && s.units[hid].run);

// 4) Right-drag a formation line -> changes files.
const before = s.units[hid].files;
await page.mouse.move(500, 450);
await page.mouse.down({ button: 'right' });
for (let x = 500; x <= 950; x += 30) await page.mouse.move(x, 450);
await page.mouse.up({ button: 'right' });
s = await state();
check('right drag sets formation width', s.units[hid].order === 'move' && s.units[hid].files !== before, `files ${before} -> ${s.units[hid].files}`);

// 5) Right click on an enemy banner -> attack.
const target = await page.evaluate(() => {
  const g = window.__game;
  const e = g.battle.units.find((u) => u.side === 1 && u.def.id === 'warband');
  return e.id;
});
const bannerBox = await (await page.$$('.banner'))[target].boundingBox();
if (bannerBox) {
  await page.mouse.click(bannerBox.x + bannerBox.width / 2, bannerBox.y + 10, { button: 'right' });
  s = await state();
  check('right click enemy banner attacks', s.units[hid].order === 'attack' && s.units[hid].target === target);
} else check('enemy banner visible', false);

// 6) Box select a region with several units.
await page.keyboard.press('Escape');
const box = await page.evaluate(() => {
  const g = window.__game;
  const r = g.canvas.getBoundingClientRect();
  const pts = g.battle.units.filter((u) => u.side === 0).map((u) => {
    const v = new (g.view.camera.position.constructor)(u.mx, u.my + 1, u.mz).project(g.view.camera);
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }).filter((q) => q.x > 20 && q.x < 1420 && q.y > 60 && q.y < 700).sort((a, b) => a.x - b.x).slice(0, 3);
  return { x0: Math.min(...pts.map((q) => q.x)) - 25, x1: Math.max(...pts.map((q) => q.x)) + 25, y0: Math.min(...pts.map((q) => q.y)) - 25, y1: Math.max(...pts.map((q) => q.y)) + 25, n: pts.length };
});
await page.mouse.move(box.x0, box.y0);
await page.mouse.down();
await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 6 });
await page.mouse.move(box.x1, Math.min(700, box.y1), { steps: 6 });
await page.mouse.up();
s = await state();
check('box select picks several units', s.sel.length >= 3, `selected ${s.sel.length}`);

// 7) Ctrl+A, then H halts.
await page.keyboard.down('Control');
await page.keyboard.press('a');
await page.keyboard.up('Control');
s = await state();
check('ctrl+a selects all own units', s.sel.length === s.units.filter((u) => u.side === 0).length, `${s.sel.length}`);
await page.mouse.click(720, 330, { button: 'right' });
s = await state();
check('group move gives every unit a move order', s.sel.every((id) => s.units[id].order === 'move'));
await page.keyboard.press('h');
s = await state();
check('H halts', s.sel.every((id) => s.units[id].order === 'none'));

// 8) Left-click on soldiers in the world selects their unit.
const p = await page.evaluate(() => {
  const g = window.__game;
  const u = g.battle.units.find((u) => u.side === 0 && u.def.id === 'principes');
  const v = new (g.view.camera.position.constructor)(u.mx, u.my + 1, u.mz).project(g.view.camera);
  const r = g.canvas.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, id: u.id };
});
await page.keyboard.press('Escape');
await page.mouse.click(p.x, p.y);
s = await state();
check('clicking soldiers selects their unit', s.sel.length === 1 && s.sel[0] === p.id, JSON.stringify(s.sel));

// 8b) Left click on empty ground deselects; clicking the selected unit again deselects it.
await page.mouse.click(p.x, p.y);
s = await state();
check('clicking the selected unit again deselects it', s.sel.length === 0, JSON.stringify(s.sel));
await page.mouse.click(p.x, p.y);
await page.mouse.click(60, 300);
s = await state();
check('left click on empty ground deselects', s.sel.length === 0, JSON.stringify(s.sel));

// 8c) Guard toggle with G.
await page.mouse.click(p.x, p.y);
const gid = (await state()).sel[0];
const g0 = await page.evaluate((id) => window.__game.battle.units[id].guard, gid);
await page.keyboard.press('g');
const g1 = await page.evaluate((id) => window.__game.battle.units[id].guard, gid);
check('G toggles guard mode', g0 !== g1, `${g0} -> ${g1}`);
await page.keyboard.press('g');

// 8d) Control group: Ctrl+1 assigns, Esc clears, 1 recalls.
await page.keyboard.down('Control');
await page.keyboard.press('Digit1');
await page.keyboard.up('Control');
await page.keyboard.press('Escape');
await page.keyboard.press('Digit1');
s = await state();
check('ctrl+1 then 1 recalls the group', s.sel.length === 1 && s.sel[0] === gid, JSON.stringify(s.sel));

// 8e) Clicking a unit flag selects it.
await page.keyboard.press('Escape');
const flagId = await page.evaluate(() => {
  const g = window.__game;
  const i = g.banners.findIndex((el, id) => g.battle.units[id].side === 0 && el.style.display !== 'none' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().top > 40 && el.getBoundingClientRect().bottom < 680);
  if (i < 0) return null;
  const r = g.banners[i].querySelector('.cloth').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: i };
});
if (flagId) {
  await page.mouse.click(flagId.x, flagId.y);
  s = await state();
  check('clicking a flag selects its unit', s.sel.length === 1 && s.sel[0] === flagId.id, JSON.stringify(s.sel));
} else check('own flag visible', false);

// 9) Space starts the battle; time advances.
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 3000));
const t = await page.evaluate(() => ({ t: window.__game.battle.time, started: window.__game.started, paused: window.__game.paused }));
check('space starts the battle', t.started && !t.paused && t.t > 0, JSON.stringify(t));
await page.screenshot({ path: 'shots/input.png' });
console.log(errors.join('\n') || 'no page errors');
await browser.close();
