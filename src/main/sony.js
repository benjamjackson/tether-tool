'use strict';
// Runs the Sony tether helper (native/sony) and turns its output into
// events: 'state' with { status, model, message }, and 'file' with the path
// of each frame the camera hands over. Restarts the helper if it stops.

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

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
        this.emit('disconnected', msg.model);
        this.setState({ status: 'searching', model: null, message: null });
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

  shoot() {
    if (this.child && this.state.status === 'connected') this.child.stdin.write('shoot\n');
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
