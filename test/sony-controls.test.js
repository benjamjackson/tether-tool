'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, driveInfo, shotPlan, fnumber, shutter, iso, ev } = require('../src/core/sony-controls');

test('Sony settings read the way the camera shows them', () => {
  assert.equal(fnumber(140), 'f/1.4');
  assert.equal(fnumber(800), 'f/8');
  assert.equal(fnumber(1100), 'f/11');
  assert.equal(fnumber(0xfffe), '--');
  assert.equal(shutter((1 << 16) | 8000), '1/8000');
  assert.equal(shutter((30 << 16) | 1), '30"');
  assert.equal(shutter((13 << 16) | 10), '1.3"');
  assert.equal(shutter((10 << 16) | 10), '1"');
  assert.equal(shutter(0), 'BULB');
  assert.equal(iso(100), '100');
  assert.equal(iso(0xffffff), 'AUTO');
  assert.equal(iso((1 << 24) | 6400), '6400 (NR)');
  assert.equal(ev(-333), '−0.3');
  assert.equal(ev(1667), '+1.7');
  assert.equal(ev(0), '0.0');
});

test('Drive modes name their brackets', () => {
  assert.deepEqual(driveInfo(0x40301), { group: 'Cont. bracket (one press)', label: 'Cont. bracket 3 × 0.3 EV', bracket: 'continuous', frames: 3 });
  assert.equal(driveInfo(0x50001).group, 'Single bracket (press per frame)');
  assert.equal(driveInfo(0x5003c).label, 'Single bracket 2 × 3.0 EV (− side)');
  assert.equal(driveInfo(1).label, 'Single shot');
  assert.equal(driveInfo(0x10001).label, 'Continuous Hi');
  assert.equal(driveInfo(0x30002).label, 'Timer 5 s');
});

test('Shutter presses suit the drive mode', () => {
  const s = (drive, shutterValue = (1 << 16) | 125) => shotPlan({ drive: { value: drive }, shutter: { value: shutterValue } });
  assert.deepEqual(s(1), { holdMs: 35, count: 1, gapMs: 0 });
  const one = s(0x40302); // 5 frames, one press
  assert.equal(one.count, 1);
  assert.ok(one.holdMs > 600);
  const per = s(0x50002); // 5 frames, press per frame
  assert.equal(per.count, 5);
  assert.ok(per.gapMs >= 700);
  assert.ok(s(0x40302, (30 << 16) | 1).holdMs <= 60000);
});

test('Ranges become a list, and the current value is always offered', () => {
  const k = describe({ code: 0x115, type: 0x4002, value: 5500, writable: true, values: [2500, 2800, 100] });
  assert.deepEqual(k.options.map((o) => o.label), ['5500 K', '2500 K', '2600 K', '2700 K', '2800 K']);
  const evs = describe({ code: 0x101, type: 0x1002, value: 0, writable: true, values: [333, -333, 0] });
  assert.deepEqual(evs.options.map((o) => o.label), ['−0.3', '0.0', '+0.3']);
  const only = describe({ code: 0x100, type: 2, value: 560, writable: true, values: [] });
  assert.equal(only.writable, false); // nothing to choose from
});
