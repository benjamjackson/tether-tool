'use strict';
// Used by the automatic build to check that the packaged app really works:
// the window loads, the image and metadata tools start, and the Sony helper
// is inside the app. Run with WRANGLE_SMOKE_TEST=1; prints the result and quits.
const fs = require('node:fs');
const { app } = require('electron');
const sharp = require('sharp');
const { HELPER } = require('./sony');

async function checks(win) {
  await new Promise((resolve, reject) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`window failed to load: ${desc} (${code})`)));
  });
  // React draws the interface a moment after the page loads, so wait for it.
  let rendered = 0;
  for (let i = 0; i < 60 && !rendered; i++) {
    rendered = await win.webContents.executeJavaScript('document.getElementById("root").childElementCount');
    if (!rendered) await new Promise((r) => setTimeout(r, 250));
  }
  if (!rendered) throw new Error('the interface did not render');

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toBuffer();
  if (!png.length) throw new Error('sharp made an empty image');

  const { exiftool } = require('exiftool-vendored');
  const version = await exiftool.version();
  await exiftool.end();

  if (process.platform === 'darwin' && app.isPackaged && !fs.existsSync(HELPER)) {
    throw new Error(`Sony helper missing at ${HELPER}`);
  }
  return `window ok, sharp ok, exiftool ${version}, sony helper ${fs.existsSync(HELPER) ? HELPER : 'not included'}`;
}

function run(win) {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[window ${e.level}] ${e.message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error(`window crashed: ${d.reason}`));
  const timer = setTimeout(() => { console.error('SMOKE TEST FAILED: timed out'); app.exit(1); }, 60000);
  checks(win).then(
    (msg) => { clearTimeout(timer); console.log(`SMOKE TEST OK: ${msg}`); app.exit(0); },
    (err) => { clearTimeout(timer); console.error(`SMOKE TEST FAILED: ${err.stack || err.message}`); app.exit(1); },
  );
}

module.exports = { run };
