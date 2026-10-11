'use strict';
// Thin desktop shell: opens your deployed ColourBook Studio AI site in its own window.
// The URL comes from app-url.txt (written by the build workflow) or the APP_URL environment variable.
const { app, BrowserWindow, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.trim();
  try { return fs.readFileSync(path.join(__dirname, 'app-url.txt'), 'utf8').trim(); } catch { return 'http://localhost:3000'; }
}
const URL_ = appUrl();
const origin = new URL(URL_).origin;

function createWindow() {
  const win = new BrowserWindow({ width: 1200, height: 860, minWidth: 380, title: 'ColourBook Studio AI', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadURL(URL_).catch(() => dialog.showErrorBox('Cannot reach the app', `Could not open ${URL_}. Check your internet connection.`));
  // keep navigation inside the app; open everything else in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (new URL(url).origin === origin) return { action: 'allow' }; shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) { e.preventDefault(); shell.openExternal(url); } });
  // PDF/ZIP downloads: let the user choose where to save
  win.webContents.session.on('will-download', (_e, item) => { item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) }); });
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
