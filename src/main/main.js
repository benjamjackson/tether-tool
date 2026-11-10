'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron');

const { open } = require('../core/db');
const { Engine } = require('../core/engine');
const preview = require('../core/preview');
const { CameraMonitor, sonyCamera } = require('../core/cameras');
const { SonyTether } = require('./sony');
const { DEFAULT_FILE_TEMPLATE, DEFAULT_FOLDER_TEMPLATE, DATE_FORMATS, buildTarget, unknownTokens } = require('../core/naming');
const { DEFAULT_LABELS } = require('../core/xmp');

// Previews are served to the window from the app's cache folder only.
protocol.registerSchemesAsPrivileged([{ scheme: 'tether', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win = null;
let engine = null;
let cameras = null;
let sony = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#111214',
    title: 'Wrangle',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function wireEngine() {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const cacheDir = path.join(dataDir, 'previews');
  engine = new Engine({ db: open(path.join(dataDir, 'tether.db')), cacheDir });

  let statsTimer = null;
  const pushStats = () => {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      if (engine.session) send('stats', { stats: engine.stats(), locations: engine.locations() });
    }, 150);
  };
  engine.on('asset', (a) => { send('asset', a); pushStats(); });
  engine.on('queue', pushStats);
  engine.on('health', pushStats);
  engine.on('event', pushStats);
  engine.on('session', (s) => { send('session', s); pushStats(); });
  engine.on('cameras', (c) => { send('cameras', c); pushStats(); });

  // Cameras seen on USB, plus a Sony camera connected through Sony's SDK.
  let usbCameras = [];
  let sonyCam = null;
  const publishCameras = () => {
    const list = usbCameras.filter((c) => !sonyCam || c.key !== sonyCam.key);
    engine.updateCameras(sonyCam ? [...list, sonyCam] : list);
  };

  cameras = new CameraMonitor();
  cameras.on('change', (list) => { usbCameras = list; publishCameras(); });
  cameras.on('error', (err) => console.warn('Camera check failed:', err.message));
  cameras.start();

  // Frames shot on a tethered Sony land in this folder, which the session
  // watches like any other tether folder, and are also queued straight away.
  const sonyInbox = path.join(dataDir, 'Sony Tether Inbox');
  sony = new SonyTether({ saveDir: sonyInbox });
  sony.on('state', (st) => send('sony', st));
  sony.on('connected', (model) => {
    sonyCam = { ...sonyCamera(model), tethered: true };
    try {
      engine.setCameraFolder(sonyCam, sonyInbox);
    } catch (err) {
      send('sony', { ...sony.state, message: err.message });
    }
    publishCameras();
  });
  sony.on('disconnected', () => { sonyCam = null; publishCameras(); });
  sony.on('file', (file) => { if (engine.session) engine.enqueue(file); });
  sony.on('warning', (msg) => { if (engine.session) engine.logEvent('warning', `Sony: ${msg}`); });
  sony.on('log', (text) => console.warn('[sony-tether]', text.trim()));
  sony.start();

  protocol.handle('tether', (req) => {
    const file = new URL(req.url).searchParams.get('f') || '';
    if (!path.resolve(file).startsWith(path.resolve(cacheDir) + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('defaults', () => ({ fileTemplate: DEFAULT_FILE_TEMPLATE, folderTemplate: DEFAULT_FOLDER_TEMPLATE, dateFormats: DATE_FORMATS, labels: DEFAULT_LABELS }));
  handle('pickFolder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('previewName', (input) => {
    const bad = [...unknownTokens(input.fileTemplate || ''), ...unknownTokens(input.folderTemplate || '')];
    if (bad.length) return { error: `Unknown token ${bad.join(', ')}` };
    const location = (input.locations || [])[0] || 'Location';
    return buildTarget({ ...input, date: input.date || '2026-01-01' }, { location, sequence: Number(input.startSequence) || 1, sourcePath: 'IMG_0001.CR3' });
  });
  handle('sessions', () => engine.listSessions());
  handle('createSession', (input) => engine.createSession(input));
  handle('openSession', async (id) => {
    const s = await engine.openSession(id);
    return { session: s, locations: engine.locations(), stats: engine.stats(), assets: engine.assets() };
  });
  handle('closeSession', () => engine.close());
  handle('addLocation', (name) => engine.addLocation(name));
  handle('setActiveLocation', (name) => engine.setActiveLocation(name));
  handle('setReview', (id, review) => engine.setReview(id, review));
  handle('retry', (id) => engine.retry(id));
  handle('retryAll', () => engine.retryAllFailed());
  handle('clearEvents', () => engine.clearEvents());
  handle('analyze', async (id) => {
    const a = engine.asset(id);
    return a?.previewPath ? preview.analyze(a.previewPath) : null;
  });
  handle('clipMask', async (id) => {
    const a = engine.asset(id);
    if (!a?.previewPath) return null;
    return 'data:image/png;base64,' + (await preview.clippingMask(a.previewPath)).toString('base64');
  });
  handle('cameras', () => engine.cameraState());
  handle('sonyState', () => sony.state);
  handle('sonyShoot', () => sony.shoot());
  handle('chooseCameraFolder', async (cam) => {
    const r = await dialog.showOpenDialog(win, {
      title: `Folder where ${cam.name}'s tether program saves`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled) return engine.cameraState();
    engine.setCameraFolder(cam, r.filePaths[0]);
    return engine.cameraState();
  });
  handle('dismissMissingCamera', (key) => engine.dismissMissingCamera(key));
  handle('reveal', (id) => {
    const c = engine.asset(id)?.copies.find((x) => x.status === 'verified');
    if (c) shell.showItemInFolder(c.path);
  });
}

app.whenReady().then(() => {
  wireEngine();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', async () => {
  if (cameras) cameras.stop();
  if (sony) sony.stop();
  if (engine) await engine.close();
  await preview.closeExiftool();
});
