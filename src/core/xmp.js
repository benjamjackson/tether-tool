'use strict';
// Star ratings and color labels, stored the way Adobe Bridge and Camera Raw
// read them: an .xmp sidecar next to each RAW, with xmp:Rating and xmp:Label.
//
// Bridge stores a color label as its *text name*. The color only shows when
// that text matches the label names in Bridge > Settings > Labels exactly,
// so the names are part of the session settings (defaults match Bridge's).

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_LABELS = {
  red: 'Select',
  yellow: 'Second',
  green: 'Approved',
  blue: 'Review',
  purple: 'To Do',
};
const LABEL_COLORS = Object.keys(DEFAULT_LABELS);

function sidecarPath(rawPath) {
  return path.join(path.dirname(rawPath), path.parse(rawPath).name + '.xmp');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function freshSidecar() {
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Wrangle">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '',
  ].join('\n');
}

// Sets or removes one xmp: property in an existing packet without touching
// anything else in it, so Camera Raw settings written later are never lost.
function setProperty(xml, name, value) {
  const attr = new RegExp(`\\s+xmp:${name}="[^"]*"`);
  const elem = new RegExp(`\\s*<xmp:${name}>[\\s\\S]*?</xmp:${name}>`);
  let out = xml.replace(attr, '').replace(elem, '');
  if (value === null || value === undefined || value === '') return out;

  if (!/xmlns:xmp="http:\/\/ns\.adobe\.com\/xap\/1\.0\/"/.test(out)) {
    out = out.replace(/<rdf:Description\b/, '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"');
  }
  // Add as an attribute on the first rdf:Description, before its closing > or />.
  return out.replace(/(<rdf:Description\b[^>]*?)(\s*\/?>)/, `$1\n    xmp:${name}="${escapeAttr(value)}"$2`);
}

function readProperty(xml, name) {
  const a = xml.match(new RegExp(`xmp:${name}="([^"]*)"`));
  if (a) return a[1];
  const e = xml.match(new RegExp(`<xmp:${name}>([\\s\\S]*?)</xmp:${name}>`));
  return e ? e[1].trim() : null;
}

// rating: 0 (none) to 5, or -1 for reject. labelText: Bridge label name or null.
async function writeSidecar(rawPath, { rating, labelText }) {
  const file = sidecarPath(rawPath);
  let xml;
  try {
    xml = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    xml = freshSidecar();
  }
  xml = setProperty(xml, 'Rating', rating ? String(rating) : null);
  xml = setProperty(xml, 'Label', labelText || null);
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, xml, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

async function readSidecar(rawPath) {
  try {
    const xml = await fs.readFile(sidecarPath(rawPath), 'utf8');
    const r = readProperty(xml, 'Rating');
    return { rating: r ? Number(r) : 0, labelText: readProperty(xml, 'Label') };
  } catch (err) {
    if (err.code === 'ENOENT') return { rating: 0, labelText: null };
    throw err;
  }
}

module.exports = { DEFAULT_LABELS, LABEL_COLORS, sidecarPath, setProperty, writeSidecar, readSidecar };
