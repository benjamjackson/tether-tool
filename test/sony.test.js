'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SonyTether } = require('../src/main/sony');
const { sonyCamera } = require('../src/core/cameras');
const { tempDir, waitFor } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-sony-tether.js');
const spawnFake = (_helper, args, opts) => spawn(process.execPath, [FAKE, ...args], opts);

test('Sony helper: connects, reports frames, and notices an unplug', async () => {
  const saveDir = await tempDir();
  const sony = new SonyTether({ saveDir, helper: __filename, spawnFn: spawnFake });
  const states = [];
  const files = [];
  const gone = [];
  sony.on('state', (s) => states.push(s.status));
  sony.on('file', (f) => files.push(f));
  sony.on('disconnected', (m) => gone.push(m));
  sony.start();
  await waitFor(() => sony.state.status === 'connected');
  assert.equal(sony.state.model, 'ILCE-7M4');
  assert.deepEqual(states, ['searching', 'connecting', 'connected']);

  sony.shoot();
  await waitFor(() => files.length === 1);
  assert.equal(files[0], `${saveDir}/DSC00001.ARW`);

  sony.child.stdin.write('unplug\n');
  await waitFor(() => gone.length === 1);
  assert.equal(sony.state.status, 'searching');
  sony.shoot(); // ignored while no camera is connected
  sony.stop();
  await waitFor(() => sony.child === null);
  assert.equal(files.length, 1);
});

test('Sony helper: reports unavailable when it has not been built', () => {
  const sony = new SonyTether({ saveDir: '/tmp/x', helper: '/nonexistent/sony-tether' });
  sony.start();
  assert.equal(sony.state.status, 'unavailable');
});

test('Sony model codes become readable names', () => {
  assert.equal(sonyCamera('ILCE-7M4').name, 'Sony a7 IV');
  assert.equal(sonyCamera('ILCE-7M4').key, 'Sony:ILCE-7M4');
});

test('Sony helper: shows camera settings and changes them', async () => {
  const saveDir = await tempDir();
  const sony = new SonyTether({ saveDir, helper: __filename, spawnFn: spawnFake });
  let latest = null;
  const warnings = [];
  sony.on('settings', (s) => { latest = s; });
  sony.on('warning', (w) => warnings.push(w));
  sony.start();
  await waitFor(() => latest && latest.controls.length === 4);
  const byKey = Object.fromEntries(latest.controls.map((c) => [c.key, c]));
  assert.deepEqual(latest.controls.map((c) => c.label), ['Mode', 'Aperture', 'Shutter', 'Drive']);
  assert.equal(byKey.fnumber.display, 'f/5.6');
  assert.deepEqual(byKey.fnumber.options.map((o) => o.label), ['f/4', 'f/5.6', 'f/8']);
  assert.equal(byKey.shutter.display, '1/125');
  assert.equal(byKey.mode.display, 'M  Manual');
  assert.equal(byKey.mode.writable, false);

  sony.setSetting('fnumber', 800);
  await waitFor(() => latest.controls.find((c) => c.key === 'fnumber').display === 'f/8');
  assert.throws(() => sony.setSetting('nonsense', 1));

  // A one-press bracket holds the shutter down long enough for every frame.
  sony.setSetting('drive', 0x40301);
  await waitFor(() => latest.controls.find((c) => c.key === 'drive').value === 0x40301);
  assert.equal(latest.controls.find((c) => c.key === 'drive').display, 'Cont. bracket 3 × 0.3 EV');
  sony.shoot();
  await waitFor(() => warnings.length === 1);
  const [hold, count] = warnings[0].replace('pressed ', '').split(' ').map(Number);
  assert.ok(hold > 35 && count === 1);

  sony.child.stdin.write('unplug\n');
  await waitFor(() => latest.controls.length === 0);
  sony.stop();
  await waitFor(() => sony.child === null);
});
