// Marine Monitor for Windows: the bundled app in a locked-down window (no Node in the page, sandboxed).
// Links that leave the app open in the normal browser.
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');

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
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // needs none
  createWindow();
});
app.on('window-all-closed', () => app.quit());
