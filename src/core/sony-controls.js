'use strict';
// Turns the raw numbers a Sony camera reports for its settings (aperture,
// shutter speed, ISO, ...) into the words a photographer reads, and back.
// The Sony helper sends each setting as { code, type, value, values,
// writable }; describe() turns that into a control the interface can show.

const ENUMS = require('./sony-enums.json');

// Sony's property codes (CrDeviceProperty.h).
const CODES = {
  mode: 0x105,
  fnumber: 0x100,
  shutter: 0x103,
  iso: 0x104,
  ev: 0x101,
  wb: 0x108,
  kelvin: 0x115,
  focus: 0x109,
  drive: 0x10e,
  bracketOrder: 0x1f8,
  battery: 0x702,
  shotsLeft: 0x709,
};
const NAMES = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k]));
// The order controls appear in, and their labels.
const CONTROLS = [
  ['mode', 'Mode'],
  ['fnumber', 'Aperture'],
  ['shutter', 'Shutter'],
  ['iso', 'ISO'],
  ['ev', 'Exposure comp'],
  ['wb', 'White balance'],
  ['kelvin', 'Kelvin'],
  ['focus', 'Focus'],
  ['drive', 'Drive'],
  ['bracketOrder', 'Bracket order'],
];
const INFO = ['battery', 'shotsLeft'];

const RANGE_BIT = 0x4000;

const trim = (n) => String(Number(n.toFixed(1)));

function fnumber(v) {
  if (v >= 0xfffd) return '--';
  const f = v / 100;
  return `f/${f >= 10 ? Math.round(f) : trim(f)}`;
}

function shutter(v) {
  if (v === 0) return 'BULB';
  if (v === 0xffffffff) return '--';
  const num = Math.floor(v / 0x10000);
  const den = v & 0xffff;
  if (!den) return '--';
  if (num === 1 && den > 1) return `1/${den}`;
  return `${trim(num / den)}"`;
}

function shutterSeconds(v) {
  const num = Math.floor(v / 0x10000);
  const den = v & 0xffff;
  return v && den ? num / den : 0;
}

function iso(v) {
  const value = v & 0xffffff;
  const mode = (v >>> 24) & 0x0f;
  if (value === 0xffffff) return mode ? 'AUTO (NR)' : 'AUTO';
  return mode ? `${value} (NR)` : String(value);
}

function ev(v) {
  const n = Math.round(v / 100) / 10;
  if (n === 0) return '0.0';
  return (n > 0 ? '+' : '−') + Math.abs(n).toFixed(1);
}

const WB = {
  AWB: 'Auto', Underwater_Auto: 'Underwater auto', Daylight: 'Daylight', Shadow: 'Shade', Cloudy: 'Cloudy',
  Tungsten: 'Tungsten', Fluorescent: 'Fluorescent', Fluorescent_WarmWhite: 'Fluor. warm white',
  Fluorescent_CoolWhite: 'Fluor. cool white', Fluorescent_DayWhite: 'Fluor. day white', Fluorescent_Daylight: 'Fluor. daylight',
  Flush: 'Flash', ColorTemp: 'Kelvin', Custom_1: 'Custom 1', Custom_2: 'Custom 2', Custom_3: 'Custom 3', Custom: 'Custom',
};

const FOCUS = { MF: 'Manual (MF)', AF_S: 'AF-S', AF_C: 'AF-C', AF_A: 'AF-A', AF_D: 'AF-D', DMF: 'DMF', PF: 'Preset focus' };

const MODE = {
  M_Manual: 'M  Manual', P_Auto: 'P  Program', A_AperturePriority: 'A  Aperture priority',
  S_ShutterSpeedPriority: 'S  Shutter priority', Auto: 'Auto', Auto_Plus: 'Auto+', MemoryRecall: 'MR  Memory recall',
};

const BRACKET_ORDER = { '0ToMinusToPlus': '0 → − → +', MinusTo0ToPlus: '− → 0 → +' };

// What a drive mode does when the shutter is pressed.
function driveInfo(v) {
  const name = ENUMS.CrDriveMode[v] || '';
  let m = name.match(/^(Continuous|Single)_Bracket_(\d)(\d)Ev_(\d)pics(?:_(Plus|Minus))?$/);
  if (m) {
    const kind = m[1] === 'Continuous' ? 'continuous' : 'single';
    const step = `${m[2]}.${m[3]}`;
    const frames = Number(m[4]);
    const dir = m[5] ? (m[5] === 'Plus' ? ' (+ side)' : ' (− side)') : '';
    // Sony's own names: Cont. Bracket fires the set in one press, Single
    // Bracket takes one frame per press.
    return {
      group: kind === 'continuous' ? 'Cont. bracket (one press)' : 'Single bracket (press per frame)',
      label: `${kind === 'continuous' ? 'Cont.' : 'Single'} bracket ${frames} × ${step} EV${dir}`,
      bracket: kind, frames,
    };
  }
  if (name === 'Single') return { group: 'Single', label: 'Single shot' };
  m = name.match(/^Continuous_(.+)$/);
  if (m && !/Timer/.test(name)) {
    const speed = m[1].replace('SpeedPriority', 'speed priority').replace(/_/g, ' ').replace('Plus', '+');
    return { group: 'Continuous', label: `Continuous ${speed}`, continuous: true };
  }
  if (name === 'Continuous') return { group: 'Continuous', label: 'Continuous', continuous: true };
  m = name.match(/^Timer_(\d+)s$/);
  if (m) return { group: 'Self-timer', label: `Timer ${m[1]} s` };
  m = name.match(/^Continuous_Timer_(?:(\d+)s_)?(\d)pics$/);
  if (m) return { group: 'Self-timer', label: `Timer ${m[1] || 10} s · ${m[2]} frames` };
  if (/^WB_Bracket_(Lo|Hi)$/.test(name)) return { group: 'Other brackets', label: `White balance bracket ${name.endsWith('Lo') ? 'Lo' : 'Hi'}` };
  if (/^DRO_Bracket_(Lo|Hi)$/.test(name)) return { group: 'Other brackets', label: `DRO bracket ${name.endsWith('Lo') ? 'Lo' : 'Hi'}` };
  if (name === 'FocusBracket') return { group: 'Other brackets', label: 'Focus bracket' };
  if (name) return { group: 'Other', label: name.replace(/_/g, ' ') };
  return { group: 'Other', label: `Drive ${v.toString(16)}` };
}

const enumLabel = (table, map, v) => {
  const name = ENUMS[table][v];
  return (name && map[name]) || (name ? name.replace(/_/g, ' ') : String(v));
};

const FORMAT = {
  mode: (v) => enumLabel('CrExposureProgram', MODE, v),
  fnumber,
  shutter,
  iso,
  ev,
  wb: (v) => enumLabel('CrWhiteBalanceSetting', WB, v),
  kelvin: (v) => `${v} K`,
  focus: (v) => enumLabel('CrFocusMode', FOCUS, v),
  drive: (v) => driveInfo(v).label,
  bracketOrder: (v) => enumLabel('CrBracketOrder', BRACKET_ORDER, v),
  battery: (v) => (v > 100 ? '--' : `${v}%`),
  shotsLeft: (v) => (v === 0xffffffff ? '--' : String(v)),
};

// A range comes as [min, max, step]; anything else is a plain list.
function expand(prop) {
  const values = prop.values || [];
  if (prop.type & RANGE_BIT && values.length >= 3) {
    const [min, max, step] = values;
    if (step <= 0 || (max - min) / step > 2000) return [];
    const out = [];
    for (let v = min; v <= max; v += step) out.push(v);
    return out;
  }
  return values;
}

// Shutter speeds and ISOs come from the camera in its own order; show them
// the way they're laid out on the dial.
function sortValues(key, values) {
  const list = [...values];
  if (key === 'shutter') list.sort((a, b) => (shutterSeconds(b) || 1e9) - (shutterSeconds(a) || 1e9));
  else if (key === 'iso') list.sort((a, b) => (a & 0xffffff) - (b & 0xffffff) || a - b);
  else if (['fnumber', 'ev', 'kelvin'].includes(key)) list.sort((a, b) => a - b);
  return list;
}

function describe(prop) {
  const key = NAMES[prop.code];
  if (!key) return null;
  const format = FORMAT[key];
  const values = sortValues(key, expand(prop));
  const options = values.map((v) => {
    const o = { value: v, label: format(v) };
    if (key === 'drive') o.group = driveInfo(v).group;
    return o;
  });
  if (!options.some((o) => o.value === prop.value)) options.unshift({ value: prop.value, label: format(prop.value), group: key === 'drive' ? driveInfo(prop.value).group : undefined });
  return {
    key,
    code: prop.code,
    value: prop.value,
    display: format(prop.value),
    options,
    writable: Boolean(prop.writable) && options.length > 1,
  };
}

// How to press the shutter for the current drive mode: a one-press bracket
// needs the button held until every frame is taken, and a press-per-frame
// bracket gets pressed once for each frame so one click gives the full set.
function shotPlan(settings) {
  const drive = settings.drive ? driveInfo(settings.drive.value) : {};
  const secs = settings.shutter ? shutterSeconds(settings.shutter.value) : 0;
  const perFrame = Math.max(secs, 1 / 60) * 1000;
  if (drive.bracket === 'continuous') {
    // Brackets go up to several stops longer than the base exposure.
    return { holdMs: Math.min(60000, Math.round(drive.frames * perFrame * 4 + 600)), count: 1, gapMs: 0 };
  }
  if (drive.bracket === 'single') {
    return { holdMs: 35, count: drive.frames, gapMs: Math.min(60000, Math.round(perFrame * 4 + 700)) };
  }
  return { holdMs: 35, count: 1, gapMs: 0 };
}

module.exports = { CODES, CONTROLS, INFO, describe, driveInfo, shotPlan, fnumber, shutter, iso, ev };
