'use strict';
// Notices cameras plugged in by USB, on Windows and macOS, by polling the
// system's device list. This only detects the camera; the frames still
// arrive through the brand's tether program (Fujifilm X Acquire, Sony
// Imaging Edge) saving into a folder that the app watches.

const EventEmitter = require('node:events');
const { execFile } = require('node:child_process');

const VENDORS = {
  0x04a9: 'Canon',
  0x04b0: 'Nikon',
  0x054c: 'Sony',
  0x04cb: 'Fujifilm',
  0x04da: 'Panasonic',
  0x07b4: 'Olympus',
  0x1a98: 'Leica',
  0x25fb: 'Pentax',
  0x1003: 'Sigma',
};

// Sony reports model codes rather than marketing names.
const SONY_MODELS = {
  'ILCE-7M4': 'a7 IV',
  'ILCE-7M3': 'a7 III',
  'ILCE-7RM4': 'a7R IV',
  'ILCE-7RM4A': 'a7R IVA',
  'ILCE-7RM5': 'a7R V',
  'ILCE-7SM3': 'a7S III',
  'ILCE-7CR': 'a7CR',
  'ILCE-7CM2': 'a7C II',
  'ILCE-1': 'a1',
  'ILCE-1M2': 'a1 II',
  'ILCE-9M3': 'a9 III',
};

function displayName(vendor, product) {
  let model = String(product || '').trim();
  const code = model.toUpperCase().replace(/\s+/g, '');
  if (vendor === 'Sony' && SONY_MODELS[code]) model = SONY_MODELS[code];
  if (!model) model = 'camera';
  if (model.toLowerCase().startsWith(vendor.toLowerCase())) return model;
  return `${vendor} ${model}`;
}

// A stable key per camera model, used to remember its tether folder.
function cameraKey(vendor, product) {
  return `${vendor}:${String(product || '').trim().toUpperCase()}`;
}

function camera(vendorId, product, serial) {
  const vendor = VENDORS[vendorId];
  if (!vendor) return null;
  return { key: cameraKey(vendor, product), vendor, model: String(product || '').trim(), name: displayName(vendor, product), serial: serial || null };
}

// ---------- Windows: Get-PnpDevice, imaging and portable devices only ----------

const WINDOWS_COMMAND = [
  "Get-PnpDevice -PresentOnly -Class WPD,Image -ErrorAction SilentlyContinue",
  "Where-Object { $_.InstanceId -like 'USB*' }",
  'Select-Object FriendlyName,InstanceId',
  'ConvertTo-Json -Compress',
].join(' | ');

function parseWindows(json) {
  if (!json || !json.trim()) return [];
  let rows = JSON.parse(json);
  if (!Array.isArray(rows)) rows = [rows];
  const out = [];
  for (const r of rows) {
    const m = /VID_([0-9A-F]{4})&PID_[0-9A-F]{4}\\([^\\]*)/i.exec(r.InstanceId || '');
    if (!m) continue;
    const c = camera(parseInt(m[1], 16), r.FriendlyName, m[2]);
    if (c) out.push(c);
  }
  return dedupe(out);
}

// ---------- macOS: the IOUSB registry ----------

function parseMac(text) {
  const out = [];
  // Each device is a block starting with "+-o Name@..."; properties follow as "key" = value.
  for (const block of String(text || '').split(/\n(?=[\s|]*\+-o )/)) {
    const vid = /"idVendor"\s*=\s*(\d+)/.exec(block);
    if (!vid) continue;
    const product = /"USB Product Name"\s*=\s*"([^"]*)"/.exec(block) || /"kUSBProductString"\s*=\s*"([^"]*)"/.exec(block);
    const serial = /"USB Serial Number"\s*=\s*"([^"]*)"/.exec(block) || /"kUSBSerialNumberString"\s*=\s*"([^"]*)"/.exec(block);
    const c = camera(Number(vid[1]), product && product[1], serial && serial[1]);
    if (c) out.push(c);
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    const id = c.key + '|' + (c.serial || '');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function listCameras(platform = process.platform) {
  if (platform === 'win32') return parseWindows(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_COMMAND]));
  if (platform === 'darwin') return parseMac(await run('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w0']));
  return [];
}

// Polls every few seconds and emits 'change' with the connected cameras,
// 'connected' and 'disconnected' with the camera that came or went.
class CameraMonitor extends EventEmitter {
  constructor({ interval = 3000, list = listCameras } = {}) {
    super();
    this.interval = interval;
    this.list = list;
    this.cameras = [];
    this.timer = null;
    this.failed = false;
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      await this.poll();
      if (this.timer) this.timer = setTimeout(tick, this.interval);
    };
    this.timer = setTimeout(tick, 0);
  }

  async poll() {
    let next;
    try {
      next = await this.list();
      this.failed = false;
    } catch (err) {
      // A slow or failed check should not look like a camera unplugging.
      if (!this.failed) this.emit('error', err);
      this.failed = true;
      return this.cameras;
    }
    const id = (c) => c.key + '|' + (c.serial || '');
    const before = new Map(this.cameras.map((c) => [id(c), c]));
    const after = new Map(next.map((c) => [id(c), c]));
    const added = next.filter((c) => !before.has(id(c)));
    const removed = this.cameras.filter((c) => !after.has(id(c)));
    this.cameras = next;
    for (const c of added) this.emit('connected', c);
    for (const c of removed) this.emit('disconnected', c);
    if (added.length || removed.length) this.emit('change', next);
    return next;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// A Sony camera reported by Sony's own SDK, by model code (e.g. ILCE-7M4).
function sonyCamera(model) {
  return camera(0x054c, model, null);
}

module.exports = { CameraMonitor, cameraKey, sonyCamera, displayName, listCameras, parseMac, parseWindows, VENDORS };
