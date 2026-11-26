'use strict';
// Runs the Sony tether helper (native/sony) and turns its output into
// events: 'state' with { status, model, message }, 'file' with the path
// of each frame the camera hands over, and 'settings' with the camera's
// shooting settings (aperture, shutter, ...). Restarts the helper if it stops.

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { CODES, CONTROLS, INFO, describe, shotPlan } = require('../core/sony-controls');

const HELPER = path.join(__dirname, '..', '..', 'native', 'sony', 'bin', 'sony-tether');

class SonyTether extends EventEmitter {
  constructor({ saveDir, helper = HELPER, spawnFn = spawn }) {
    super();
    this.saveDir = saveDir;
    this.helper = helper;
    this.spawnFn = spawnFn;
    this.child = null;
    this.stopped = true;
    this.restartDelay = 1000;
    this.state = { status: 'off', model: null, message: null };
    this.props = new Map(); // raw settings from the camera, by code
  }

  available() {
    return fs.existsSync(this.helper);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.available()) {
      this.setState({ status: 'unavailable', model: null, message: null });
      return;
    }
    fs.mkdirSync(this.saveDir, { recursive: true });
    this.launch();
  }

  launch() {
    const child = this.spawnFn(this.helper, ['--save-dir', this.saveDir], {
      cwd: path.dirname(this.helper),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (d) => this.emit('log', d.toString()));
    child.on('error', (err) => this.setState({ status: 'error', model: null, message: err.message }));
    child.on('exit', () => {
      this.child = null;
      this.clearSettings();
      if (this.state.model) this.emit('disconnected', this.state.model);
      if (this.stopped) return;
      this.setState({ status: 'restarting', model: null, message: null });
      setTimeout(() => { if (!this.stopped) this.launch(); }, this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 15000);
    });
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.event) {
      case 'searching':
        this.restartDelay = 1000;
        this.setState({ status: 'searching', model: null, message: null });
        break;
      case 'connecting':
        this.setState({ status: 'connecting', model: msg.model, message: null });
        break;
      case 'connected':
        this.setState({ status: 'connected', model: msg.model, message: null });
        this.emit('connected', msg.model);
        break;
      case 'disconnected':
        this.clearSettings();
        this.emit('disconnected', msg.model);
        this.setState({ status: 'searching', model: null, message: null });
        break;
      case 'props':
        for (const p of msg.props || []) this.props.set(p.code, p);
        this.emit('settings', this.settings());
        break;
      case 'file':
        if (msg.path) this.emit('file', msg.path);
        break;
      case 'warning':
        this.emit('warning', msg.message);
        break;
      case 'error':
        this.setState({ ...this.state, message: msg.message });
        this.emit('warning', msg.message);
        break;
      default:
        break;
    }
  }

  setState(next) {
    this.state = next;
    this.emit('state', next);
  }

  // { controls: [...], info: { battery, shotsLeft } } for the interface.
  settings() {
    const byKey = {};
    for (const p of this.props.values()) {
      const d = describe(p);
      if (d) byKey[d.key] = d;
    }
    const controls = CONTROLS.filter(([key]) => byKey[key]).map(([key, label]) => ({ ...byKey[key], label }));
    // Kelvin only matters when white balance is set to it.
    const wb = byKey.wb;
    const shown = controls.filter((c) => c.key !== 'kelvin' || !wb || wb.display === 'Kelvin');
    const info = Object.fromEntries(INFO.filter((k) => byKey[k]).map((k) => [k, byKey[k].display]));
    return { controls: shown, info, plan: shotPlan(byKey) };
  }

  clearSettings() {
    if (!this.props.size) return;
    this.props.clear();
    this.emit('settings', this.settings());
  }

  setSetting(key, value) {
    const code = CODES[key];
    if (code === undefined || !Number.isInteger(value)) throw new Error(`Unknown camera setting ${key}`);
    if (!this.child || this.state.status !== 'connected') throw new Error('No Sony camera connected');
    this.child.stdin.write(`set ${code} ${value}\n`);
  }

  shoot() {
    if (!this.child || this.state.status !== 'connected') return;
    const { holdMs, count, gapMs } = this.settings().plan;
    this.child.stdin.write(`shoot ${holdMs} ${count} ${gapMs}\n`);
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      this.child.stdin.write('quit\n');
      const child = this.child;
      setTimeout(() => child.kill(), 3000).unref();
    }
  }
}

module.exports = { SonyTether, HELPER };
