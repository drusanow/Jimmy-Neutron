// Renders icons/icon.svg to the PNG sizes the web app manifest needs (uses Playwright's Chromium).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(join(execSync('npm root -g').toString().trim(), 'x'));
const { chromium } = require('playwright');
const icons = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const svg = readFileSync(join(icons, 'icon.svg'), 'utf8');

const browser = await chromium.launch();
for (const size of [192, 512, 1024]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: join(icons, `icon-${size}.png`), omitBackground: true });
}
await browser.close();
