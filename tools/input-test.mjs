// Drives the real UI with mouse input and checks that orders reach the simulation.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const file = pathToFileURL(process.cwd() + '/dist/index.html').href;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1440, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(file);
await new Promise((r) => setTimeout(r, 1500));
await page.click('#go');
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
await page.mouse.move(100, 520);
await page.mouse.down();
await page.mouse.move(700, 650, { steps: 8 });
await page.mouse.move(1400, 760, { steps: 8 });
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

// 9) Space starts the battle; time advances.
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 3000));
const t = await page.evaluate(() => ({ t: window.__game.battle.time, started: window.__game.started, paused: window.__game.paused }));
check('space starts the battle', t.started && !t.paused && t.t > 0, JSON.stringify(t));
await page.screenshot({ path: 'shots/input.png' });
console.log(errors.join('\n') || 'no page errors');
await browser.close();
