'use strict';
// Reads the value lists Wrangle needs out of Sony's SDK header and writes
// them to src/core/sony-enums.json, so the app can name camera settings
// (drive modes, white balance, ...) without the SDK being present.
// Run again only when the SDK is updated:  node scripts/sony-enums.js
const fs = require('node:fs');
const path = require('node:path');

const HEADER = path.join(__dirname, '..', 'native', 'sony', 'sdk', 'include', 'CrDeviceProperty.h');
const OUT = path.join(__dirname, '..', 'src', 'core', 'sony-enums.json');
const WANTED = { CrDriveMode: 'CrDrive_', CrWhiteBalanceSetting: 'CrWhiteBalance_', CrExposureProgram: 'CrExposure_', CrFocusMode: 'CrFocus_', CrBracketOrder: 'CrBracketOrder_' };

const src = fs.readFileSync(HEADER, 'utf8');
const result = {};
for (const [name, prefix] of Object.entries(WANTED)) {
  const m = src.match(new RegExp(`enum ${name}\\s*:[^{]*\\{([\\s\\S]*?)\\};`));
  if (!m) throw new Error(`${name} not found in ${HEADER}`);
  const byName = {};
  const values = {};
  let next = 0;
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/\/\*.*?\*\/|\/\/.*$/g, '').trim().replace(/,$/, '');
    if (!line) continue;
    const [key, expr] = line.split('=').map((s) => s.trim());
    let v;
    if (expr === undefined) v = next;
    else if (/^(0x[0-9a-f]+|\d+)$/i.test(expr)) v = Number(expr);
    else if (expr in byName) { byName[key] = byName[expr]; continue; } // an alias
    else throw new Error(`Can't read ${line}`);
    byName[key] = v;
    if (!(String(v) in values) && !/Sprots|Do not use/.test(raw)) values[v] = key.replace(prefix, '');
    next = v + 1;
  }
  result[name] = values;
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n');
console.log(`Wrote ${OUT}`);
