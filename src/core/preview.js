'use strict';
// Previews come from the JPEG the camera already embeds in every RAW, so
// they're instant and nothing here ever decodes or "develops" the RAW.
// Histogram and clipping numbers are measured on that camera JPEG, which
// clips slightly before the RAW data does: a warning means "check this
// frame", which errs on the safe side during a shoot.

const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

let exiftool = null;
function getExiftool() {
  if (!exiftool) exiftool = require('exiftool-vendored').exiftool;
  return exiftool;
}

async function closeExiftool() {
  if (exiftool) await exiftool.end();
  exiftool = null;
}

// Fallback for files exiftool can't read: take the largest JPEG stream
// (FFD8 ... FFD9) found inside the RAW. A JPEG can carry its own small
// thumbnail inside it, so a stream runs to the last end marker before the
// next JPEG that starts after its first end marker.
const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);

function largestEmbeddedJpeg(buf) {
  let best = null;
  let start = buf.indexOf(SOI);
  while (start !== -1) {
    const firstEnd = buf.indexOf(EOI, start + 3);
    if (firstEnd === -1) break;
    const nextStart = buf.indexOf(SOI, firstEnd + 2);
    const limit = nextStart === -1 ? buf.length : nextStart;
    const end = buf.lastIndexOf(EOI, limit - 2);
    const slice = buf.subarray(start, end + 2);
    if (!best || slice.length > best.length) best = slice;
    start = nextStart;
  }
  return best;
}

async function extractJpeg(rawPath, outFile) {
  const et = getExiftool();
  for (const tag of ['JpgFromRaw', 'PreviewImage']) {
    try {
      await fs.rm(outFile, { force: true });
      await et.extractBinaryTag(tag, rawPath, outFile);
      const stat = await fs.stat(outFile);
      if (stat.size > 1024) return outFile;
    } catch {
      // try the next tag
    }
  }
  const jpeg = largestEmbeddedJpeg(await fs.readFile(rawPath));
  if (!jpeg) throw new Error('No embedded preview found in this RAW');
  await fs.writeFile(outFile, jpeg);
  return outFile;
}

// Writes a viewing JPEG and a small thumbnail into the app's cache folder
// (never into the shoot folders).
async function makePreviews(rawPath, cacheDir, id) {
  await fs.mkdir(cacheDir, { recursive: true });
  const extracted = path.join(cacheDir, `${id}.embedded.jpg`);
  const preview = path.join(cacheDir, `${id}.jpg`);
  const thumb = path.join(cacheDir, `${id}.thumb.jpg`);
  await extractJpeg(rawPath, extracted);
  // rotate() applies the camera's orientation flag so portrait frames stand up.
  await sharp(extracted).rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 }).toFile(preview);
  await sharp(extracted).rotate().resize({ width: 360, height: 360, fit: 'inside' }).jpeg({ quality: 78 }).toFile(thumb);
  await fs.rm(extracted, { force: true });
  return { preview, thumb };
}

// Luminance histogram (256 bins) plus the share of pixels at the extremes.
async function analyze(previewPath) {
  const { data, info } = await sharp(previewPath)
    .resize({ width: 800, height: 800, fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = { r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0), l: new Array(256).fill(0) };
  let highlights = 0;
  let shadows = 0;
  const px = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    bins.r[r]++; bins.g[g]++; bins.b[b]++;
    bins.l[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    if (r >= 254 || g >= 254 || b >= 254) highlights++;
    if (r <= 1 && g <= 1 && b <= 1) shadows++;
  }
  return {
    bins,
    highlightClipPct: (highlights / px) * 100,
    shadowClipPct: (shadows / px) * 100,
  };
}

// Mask image (PNG) of clipped areas for the viewer overlay: red = blown
// highlights, blue = blocked shadows, transparent elsewhere.
async function clippingMask(previewPath) {
  const { data, info } = await sharp(previewPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let p = 0, i = 0; i < data.length; i += info.channels, p += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r >= 254 || g >= 254 || b >= 254) { out[p] = 255; out[p + 3] = 200; }
    else if (r <= 1 && g <= 1 && b <= 1) { out[p + 2] = 255; out[p + 3] = 200; }
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

module.exports = { analyze, clippingMask, closeExiftool, extractJpeg, largestEmbeddedJpeg, makePreviews };
