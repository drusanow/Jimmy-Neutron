// Standalone desktop wrapper (macOS app) for the Neutron Editor web app.
// The web app is served from the app bundle over a private secure scheme (app://), so
// Web MIDI, WebUSB and the microphone work like on https.
const { app, BrowserWindow, protocol, session, net, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, 'web');
const STM32_DFU = { vendorId: 0x0483, productId: 0xDF11 };
const ALLOWED_PERMISSIONS = new Set(['midi', 'midiSysex', 'media', 'usb']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function serveApp() {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(WEB_ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(WEB_ROOT)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function setupPermissions() {
  const ses = session.defaultSession;
  const fromApp = (url) => (url || '').startsWith('app://');
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(fromApp(details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => fromApp(origin) && ALLOWED_PERMISSIONS.has(permission));
  // WebUSB: only the STM32 ROM bootloader may be used
  ses.setDevicePermissionHandler((details) => details.deviceType === 'usb'
    && details.device.vendorId === STM32_DFU.vendorId && details.device.productId === STM32_DFU.productId);
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const dev = details.deviceList.find((d) => d.vendorId === STM32_DFU.vendorId && d.productId === STM32_DFU.productId);
    callback(dev ? dev.deviceId : '');
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    title: 'Neutron Editor',
    backgroundColor: '#121417',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL('app://neutron/index.html');
  // external links open in the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  serveApp();
  setupPermissions();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
