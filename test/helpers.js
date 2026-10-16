'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

async function tempDir(prefix = 'tether-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// A stand-in RAW: some header bytes, a small embedded thumbnail, then a
// larger embedded JPEG preview, the way most RAW formats carry them.
async function fakeRaw(file, { color = '#808080', width = 600, height = 400, blownTop = false } = {}) {
  const thumb = await sharp({ create: { width: 160, height: 120, channels: 3, background: color } }).jpeg().toBuffer();
  let img = sharp({ create: { width, height, channels: 3, background: color } });
  if (blownTop) {
    const white = await sharp({ create: { width, height: Math.floor(height / 4), channels: 3, background: '#ffffff' } }).png().toBuffer();
    img = img.composite([{ input: white, top: 0, left: 0 }]);
  }
  const big = await img.jpeg({ quality: 95 }).toBuffer();
  const header = Buffer.from('FAKE-RAW-HEADER\0' + 'x'.repeat(200));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([header, thumb, Buffer.alloc(300, 7), big, Buffer.alloc(500, 9)]));
  return file;
}

function waitFor(predicate, { timeout = 15000, interval = 50 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const v = await predicate();
        if (v) return resolve(v);
      } catch {
        // keep waiting
      }
      if (Date.now() - start > timeout) return reject(new Error('Timed out waiting'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

module.exports = { fakeRaw, tempDir, waitFor };
