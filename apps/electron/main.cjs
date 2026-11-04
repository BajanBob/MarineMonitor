// Marine Monitor for Windows: the bundled app in a locked-down window (no Node in the page, sandboxed).
// The app is served from a private app:// scheme (ES modules don't load reliably from file://).
// Links that leave the app open in the normal browser.
const { app, BrowserWindow, shell, session, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WWW = path.join(__dirname, '..', 'www');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();
let win = null;
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 860, minWidth: 380, minHeight: 600,
    backgroundColor: '#06141f', title: 'Marine Monitor', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon-only.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged },
  });
  win.loadURL('app://local/index.html');
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://local/')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(WWW, p === '/' ? 'index.html' : p));
    if (!file.startsWith(WWW)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // needs none
  createWindow();
});
app.on('window-all-closed', () => app.quit());
