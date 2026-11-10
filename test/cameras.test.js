'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CameraMonitor, parseMac, parseWindows } = require('../src/core/cameras');
const { Engine } = require('../src/core/engine');
const { open } = require('../src/core/db');
const preview = require('../src/core/preview');
const { fakeRaw, tempDir, waitFor } = require('./helpers');

test.after(() => preview.closeExiftool());

test('Windows: finds the Sony and Fuji, ignores other devices', () => {
  const json = JSON.stringify([
    { FriendlyName: 'ILCE-7M4', InstanceId: 'USB\\VID_054C&PID_0DA7\\D1234567' },
    { FriendlyName: 'GFX 50R', InstanceId: 'USB\\VID_04CB&PID_02D3\\5A8B9C' },
    { FriendlyName: 'Integrated Webcam', InstanceId: 'USB\\VID_0C45&PID_6A10\\SN0001' },
    { FriendlyName: 'Phone', InstanceId: 'SWD\\WPDBUSENUM\\{abc}' },
  ]);
  const cams = parseWindows(json);
  assert.deepEqual(cams.map((c) => c.name), ['Sony a7 IV', 'Fujifilm GFX 50R']);
  assert.equal(cams[0].key, 'Sony:ILCE-7M4');
  assert.equal(cams[0].serial, 'D1234567');
});

test('Windows: a single device comes back as an object, nothing as empty output', () => {
  assert.equal(parseWindows(JSON.stringify({ FriendlyName: 'GFX 50R', InstanceId: 'USB\\VID_04CB&PID_02D3\\X' }))[0].name, 'Fujifilm GFX 50R');
  assert.deepEqual(parseWindows(''), []);
});

test('macOS: reads cameras from the USB registry', () => {
  const ioreg = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 25>
  +-o ILCE-7M4@01100000  <class IOUSBHostDevice, id 0x100001234, registered, matched, active, busy 0 (1 ms), retain 30>
  | {
  |   "idProduct" = 3495
  |   "USB Product Name" = "ILCE-7M4"
  |   "USB Vendor Name" = "Sony"
  |   "idVendor" = 1356
  |   "USB Serial Number" = "D1234567"
  | }
  +-o Magic Keyboard@01200000  <class IOUSBHostDevice, id 0x100001240>
  | {
  |   "idVendor" = 1452
  |   "USB Product Name" = "Magic Keyboard"
  | }
  +-o GFX 50R@01300000  <class IOUSBHostDevice, id 0x100001250>
    {
      "kUSBProductString" = "GFX 50R"
      "idVendor" = 1227
    }
`;
  assert.deepEqual(parseMac(ioreg).map((c) => c.name), ['Sony a7 IV', 'Fujifilm GFX 50R']);
});

test('monitor reports cameras coming and going, and ignores a failed check', async () => {
  const sony = { key: 'Sony:ILCE-7M4', name: 'Sony a7 IV', serial: '1' };
  const answers = [[], [sony], new Error('powershell busy'), []];
  const m = new CameraMonitor({ list: async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; } });
  const events = [];
  m.on('connected', (c) => events.push('+' + c.name));
  m.on('disconnected', (c) => events.push('-' + c.name));
  m.on('error', () => events.push('error'));
  for (let i = 0; i < 4; i++) await m.poll();
  assert.deepEqual(events, ['+Sony a7 IV', 'error', '-Sony a7 IV']);
});

test('a camera folder brings in new frames only, and a dropped camera is flagged', async () => {
  const root = await tempDir();
  const card = path.join(root, 'card');
  const tether = path.join(root, 'Imaging Edge');
  const main = path.join(root, 'Main');
  const backup = path.join(root, 'Backup');
  await Promise.all([card, tether, main, backup].map((d) => fs.mkdir(d, { recursive: true })));
  await fakeRaw(path.join(tether, 'OLD_JOB_0001.ARW')); // left over from another shoot

  const engine = new Engine({ db: open(path.join(root, 'db.sqlite')), cacheDir: path.join(root, 'cache') });
  const id = engine.createSession({ client: 'Acme', date: '2026-11-10', sourceDir: card, destinations: [main, backup], locations: ['Studio'] });
  await engine.openSession(id);
  const sony = { key: 'Sony:ILCE-7M4', vendor: 'Sony', model: 'ILCE-7M4', name: 'Sony a7 IV', serial: '1' };
  engine.updateCameras([sony]);
  assert.equal(engine.cameraState().connected[0].folder, null);

  assert.throws(() => engine.setCameraFolder(sony, main), /separate/);
  engine.setCameraFolder(sony, tether);
  assert.equal(engine.cameraState().connected[0].folder, tether);
  await new Promise((r) => setTimeout(r, 500));

  await fakeRaw(path.join(tether, 'DSC00001.ARW'));
  await waitFor(() => engine.assets()[0]?.status === 'backed_up');
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(engine.assets().map((a) => a.originalName), ['DSC00001.ARW']);

  engine.updateCameras([]);
  assert.equal(engine.cameraState().missing[0].name, 'Sony a7 IV');
  assert.ok(engine.events().some((e) => e.message === 'Sony a7 IV disconnected'));
  engine.updateCameras([sony]);
  assert.equal(engine.cameraState().missing.length, 0);
  await engine.close();
});
