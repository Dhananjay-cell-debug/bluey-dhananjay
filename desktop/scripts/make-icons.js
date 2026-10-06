// Renders Bluey's icons (app icon and tray icon) with the same drawing code the app uses.
// Run: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'src', 'assets');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'common', f), 'utf8');
  await win.webContents.executeJavaScript(read('palette.js') + ';' + read('face.js'));
  for (const [name, size] of [['icon.png', 256], ['tray.png', 32], ['tray@2x.png', 64]]) {
    const data = await win.webContents.executeJavaScript(`(() => {
      const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size};
      const x = c.getContext('2d'); const s = ${size};
      BlueyFace.mini(x, s * 0.06, s * 0.14, s * 0.88, s * 0.78, { x: 0.15, y: 0.3 });
      return c.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(out, name), Buffer.from(data.split(',')[1], 'base64'));
  }
  // A .ico for the installer (PNG-compressed 256px entry).
  const png = fs.readFileSync(path.join(out, 'icon.png'));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6); header.writeUInt8(0, 7); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, png]));
  console.log('icons written');
  app.quit();
});
