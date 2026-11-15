// Headless Chrome check: load the built page, start a battle, take screenshots, report errors.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
const out = process.argv[2] ?? 'shots';
const file = pathToFileURL(process.cwd() + '/dist/index.html').href;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1440, height: 860 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
await page.goto(file);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${out}/0-start.png` });
await page.click('#go');
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${out}/1-deploy.png` });
// Start the battle at 4x and let it run.
await page.click('#btnPause');
await page.click('#btnSpeed');
await page.click('#btnSpeed');
const steps = Number(process.argv[3] ?? 3);
for (let k = 0; k < steps; k++) {
  await new Promise((r) => setTimeout(r, 12000));
  await page.screenshot({ path: `${out}/${k + 2}-battle.png` });
}
console.log(errors.slice(0, 20).join('\n') || 'no errors');
await browser.close();
