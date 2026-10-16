'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readSidecar, sidecarPath, writeSidecar } = require('../src/core/xmp');
const { tempDir } = require('./helpers');

test('sidecar sits next to the RAW with the same base name', () => {
  assert.equal(sidecarPath('/a/b/2026_X_0001.CR3'), path.join('/a/b', '2026_X_0001.xmp'));
});

test('writes rating and label Bridge can read, then updates and clears them', async () => {
  const dir = await tempDir();
  const raw = path.join(dir, 'F_0001.CR3');
  await writeSidecar(raw, { rating: 3, labelText: 'Select' });
  let xml = await fs.readFile(sidecarPath(raw), 'utf8');
  assert.match(xml, /xmlns:xmp="http:\/\/ns\.adobe\.com\/xap\/1\.0\/"/);
  assert.match(xml, /xmp:Rating="3"/);
  assert.match(xml, /xmp:Label="Select"/);

  await writeSidecar(raw, { rating: 1, labelText: 'To Do' });
  assert.deepEqual(await readSidecar(raw), { rating: 1, labelText: 'To Do' });

  await writeSidecar(raw, { rating: 0, labelText: null });
  xml = await fs.readFile(sidecarPath(raw), 'utf8');
  assert.doesNotMatch(xml, /xmp:Rating/);
  assert.doesNotMatch(xml, /xmp:Label/);
});

test('keeps Camera Raw settings already in the sidecar', async () => {
  const dir = await tempDir();
  const raw = path.join(dir, 'F_0002.NEF');
  await fs.writeFile(sidecarPath(raw), `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="5"
   crs:Exposure2012="+0.35">
   <xmp:Label>Old</xmp:Label>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`);
  await writeSidecar(raw, { rating: 2, labelText: 'Approved' });
  const xml = await fs.readFile(sidecarPath(raw), 'utf8');
  assert.match(xml, /crs:Exposure2012="\+0\.35"/);
  assert.match(xml, /xmp:Rating="2"/);
  assert.match(xml, /xmp:Label="Approved"/);
  assert.doesNotMatch(xml, /Old/);
  assert.equal((xml.match(/xmp:Rating/g) || []).length, 1);
});
