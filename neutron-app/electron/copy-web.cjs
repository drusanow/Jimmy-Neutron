// copies the web app into electron/web, which is packed into the desktop app
const fs = require('node:fs');
const path = require('node:path');
const src = path.join(__dirname, '..');
const dst = path.join(__dirname, 'web');
fs.rmSync(dst, { recursive: true, force: true });
for (const item of ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons', 'firmware']) {
  fs.cpSync(path.join(src, item), path.join(dst, item), { recursive: true });
}
console.log('web app copied to', dst);
