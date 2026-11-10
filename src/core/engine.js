'use strict';
// The ingest loop: RAW lands in the watched folder -> named from the active
// location -> copied to every destination in parallel -> each copy
// checksum-verified -> preview made -> status reported.
//
// The source file is never moved or deleted. A copy is only given its final
// name after its checksum matches the source, and an existing file is never
// overwritten.

const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const chokidar = require('chokidar');

const { buildTarget, cleanPart, DEFAULT_FILE_TEMPLATE, DEFAULT_FOLDER_TEMPLATE, unknownTokens } = require('./naming');
const { DEFAULT_LABELS, LABEL_COLORS, writeSidecar } = require('./xmp');
const preview = require('./preview');

const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2',
  '.pef', '.iiq', '.3fr', '.fff', '.srw', '.x3f', '.rwl', '.mos', '.erf', '.kdc', '.dcr',
]);

function isRaw(file) {
  return RAW_EXTENSIONS.has(path.extname(file).toLowerCase());
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

class Engine extends EventEmitter {
  constructor({ db, cacheDir }) {
    super();
    this.db = db;
    this.cacheDir = cacheDir;
    this.session = null;
    this.watcher = null;
    this.queue = [];
    this.queued = new Set();
    this.busy = false;
    this.healthTimer = null;
    this.health = [];
    this.cameraWatcher = null;
    this.cameraFolderList = [];
    this.connectedCameras = [];
    this.missingCameras = new Map(); // key -> camera that dropped off mid-session
  }

  // ---------- sessions ----------

  validateSessionInput(input) {
    const problems = [];
    if (!cleanPart(input.client)) problems.push('Client name is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) problems.push('Shoot date must be YYYY-MM-DD.');
    if (!input.sourceDir) problems.push('Pick the folder to watch for incoming RAWs.');
    const dests = (input.destinations || []).filter(Boolean);
    if (dests.length < 2) problems.push('Pick a main destination and at least one backup.');
    if (new Set(dests.map((d) => path.resolve(d))).size !== dests.length) problems.push('Each destination must be a different folder.');
    if (dests.some((d) => input.sourceDir && path.resolve(d).startsWith(path.resolve(input.sourceDir) + path.sep))) {
      problems.push('A destination cannot be inside the watched folder.');
    }
    for (const t of [input.fileTemplate, input.folderTemplate]) {
      const bad = t ? unknownTokens(t) : [];
      if (bad.length) problems.push(`Unknown naming token ${bad.join(', ')}.`);
    }
    if (input.fileTemplate && !/\{sequence(:\d+)?\}/i.test(input.fileTemplate)) {
      problems.push('The file name template needs {sequence} so names never repeat.');
    }
    if (!(input.locations || []).map(cleanPart).filter(Boolean).length) problems.push('Add at least one location.');
    return problems;
  }

  createSession(input) {
    const problems = this.validateSessionInput(input);
    if (problems.length) throw new Error(problems.join('\n'));
    const locations = [...new Set(input.locations.map(cleanPart).filter(Boolean))];
    const db = this.db;
    db.exec('BEGIN');
    try {
      const { lastInsertRowid: id } = db.prepare(`
        INSERT INTO sessions (client, job, job_number, shoot_date, date_format, file_template, folder_template,
                              source_dir, active_location, next_sequence, labels_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.client.trim(), (input.job || '').trim(), (input.jobNumber || '').trim(), input.date,
        input.dateFormat || 'YYYY-MM-DD', input.fileTemplate || DEFAULT_FILE_TEMPLATE,
        input.folderTemplate || DEFAULT_FOLDER_TEMPLATE, path.resolve(input.sourceDir), locations[0],
        Number(input.startSequence) > 0 ? Number(input.startSequence) : 1,
        JSON.stringify({ ...DEFAULT_LABELS, ...(input.labels || {}) }),
      );
      input.destinations.filter(Boolean).forEach((root, i) => {
        db.prepare('INSERT INTO destinations (session_id, root, role, position) VALUES (?, ?, ?, ?)')
          .run(id, path.resolve(root), i === 0 ? 'primary' : 'backup', i);
      });
      for (const name of locations) db.prepare('INSERT INTO locations (session_id, name) VALUES (?, ?)').run(id, name);
      db.exec('COMMIT');
      return Number(id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  listSessions() {
    return this.db.prepare(`
      SELECT s.id, s.client, s.job, s.shoot_date AS date, s.created_at AS createdAt,
             (SELECT COUNT(*) FROM assets a WHERE a.session_id = s.id) AS assetCount
      FROM sessions s ORDER BY s.id DESC`).all();
  }

  loadSessionRow(id) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    return {
      id: s.id,
      client: s.client,
      job: s.job,
      jobNumber: s.job_number,
      date: s.shoot_date,
      dateFormat: s.date_format,
      fileTemplate: s.file_template,
      folderTemplate: s.folder_template,
      sourceDir: s.source_dir,
      activeLocation: s.active_location,
      nextSequence: s.next_sequence,
      labels: JSON.parse(s.labels_json),
      destinations: this.db.prepare('SELECT id, root, role FROM destinations WHERE session_id = ? ORDER BY position').all(id),
    };
  }

  async openSession(id) {
    await this.close();
    this.session = this.loadSessionRow(id);
    await this.checkHealth();
    this.healthTimer = setInterval(() => this.checkHealth().catch(() => {}), 5000);
    this.startWatching();
    this.emit('session', this.session);
    return this.session;
  }

  // ---------- locations ----------

  locations() {
    if (!this.session) return [];
    return this.db.prepare(`
      SELECT l.name,
             (SELECT COUNT(*) FROM assets a WHERE a.session_id = l.session_id AND a.location = l.name) AS count
      FROM locations l WHERE l.session_id = ? ORDER BY l.id`).all(this.session.id);
  }

  addLocation(rawName) {
    const name = cleanPart(rawName);
    if (!name) throw new Error('Location name is empty.');
    this.db.prepare('INSERT OR IGNORE INTO locations (session_id, name) VALUES (?, ?)').run(this.session.id, name);
    this.setActiveLocation(name);
    return name;
  }

  setActiveLocation(name) {
    const row = this.db.prepare('SELECT name FROM locations WHERE session_id = ? AND name = ?').get(this.session.id, name);
    if (!row) throw new Error(`No location called ${name}`);
    this.db.prepare('UPDATE sessions SET active_location = ? WHERE id = ?').run(name, this.session.id);
    this.session.activeLocation = name;
    this.logEvent('info', `Capturing into ${name}`);
    this.emit('session', this.session);
  }

  // ---------- watching ----------

  startWatching() {
    const { sourceDir } = this.session;
    const initial = [];
    let ready = false;
    this.watcher = chokidar.watch(sourceDir, {
      ignoreInitial: false,
      depth: 4,
      ignored: (p) => path.basename(p).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
    });
    this.watcher.on('add', (file, stat) => {
      if (!isRaw(file)) return;
      if (ready) this.enqueue(file);
      else initial.push({ file, mtime: stat ? stat.mtimeMs : 0 });
    });
    this.watcher.on('ready', () => {
      ready = true;
      // Files already on the card ingest in shooting order.
      initial.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file, undefined, { numeric: true }));
      for (const { file } of initial) this.enqueue(file);
      this.emit('watching', sourceDir);
    });
    this.watcher.on('error', (err) => this.logEvent('error', `Watching ${sourceDir} failed: ${err.message}`));
    this.watchCameraFolders();
  }

  // ---------- cameras ----------
  // Each camera model remembers the folder its tether program saves into.
  // Those folders are watched for the whole session, for new files only, so
  // older shots already sitting there from other jobs are never pulled in.

  cameraFolders() {
    return this.db.prepare('SELECT camera_key AS key, name, folder FROM camera_folders ORDER BY name').all();
  }

  setCameraFolder(cam, folder) {
    const dir = path.resolve(folder);
    const inside = (a, b) => a === b || a.startsWith(b + path.sep);
    if (this.session) {
      for (const d of this.session.destinations) {
        if (inside(path.resolve(d.root), dir) || inside(dir, path.resolve(d.root))) {
          throw new Error('The tether folder must be separate from the main and backup folders.');
        }
      }
    }
    this.db.prepare(`
      INSERT INTO camera_folders (camera_key, name, folder, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(camera_key) DO UPDATE SET name = excluded.name, folder = excluded.folder, updated_at = excluded.updated_at`)
      .run(cam.key, cam.name, dir);
    if (this.session) {
      this.logEvent('info', `${cam.name}: watching ${dir}`);
      this.watchCameraFolders();
    }
    this.emit('cameras', this.cameraState());
  }

  watchCameraFolders() {
    if (!this.session) return;
    const folders = [...new Set(this.cameraFolders().map((c) => c.folder))]
      .filter((f) => path.resolve(f) !== path.resolve(this.session.sourceDir));
    if (this.cameraWatcher) {
      const add = folders.filter((f) => !this.cameraFolderList.includes(f));
      if (add.length) this.cameraWatcher.add(add);
      this.cameraFolderList.push(...add);
      return;
    }
    if (!folders.length) return;
    this.cameraFolderList = folders;
    this.cameraWatcher = chokidar.watch(folders, {
      ignoreInitial: true,
      depth: 4,
      ignored: (p) => path.basename(p).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
    });
    this.cameraWatcher.on('add', (file) => {
      if (isRaw(file)) this.enqueue(file);
    });
    this.cameraWatcher.on('error', (err) => this.logEvent('error', `Watching a tether folder failed: ${err.message}`));
  }

  // Called by the camera monitor with the cameras connected right now.
  updateCameras(list) {
    const before = new Map(this.connectedCameras.map((c) => [c.key, c]));
    const now = new Map(list.map((c) => [c.key, c]));
    for (const c of list) {
      if (!before.has(c.key) && this.session) this.logEvent('info', `${c.name} connected`);
      this.missingCameras.delete(c.key);
    }
    for (const c of this.connectedCameras) {
      if (!now.has(c.key) && this.session) {
        this.logEvent('warning', `${c.name} disconnected`);
        this.missingCameras.set(c.key, c);
      }
    }
    this.connectedCameras = list;
    this.emit('cameras', this.cameraState());
  }

  dismissMissingCamera(key) {
    this.missingCameras.delete(key);
    this.emit('cameras', this.cameraState());
  }

  cameraState() {
    const folders = new Map(this.cameraFolders().map((c) => [c.key, c.folder]));
    return {
      connected: this.connectedCameras.map((c) => ({ ...c, folder: folders.get(c.key) || null })),
      missing: [...this.missingCameras.values()],
    };
  }

  enqueue(file) {
    if (this.queued.has(file)) return;
    const done = this.db.prepare('SELECT id FROM assets WHERE session_id = ? AND source_path = ?').get(this.session.id, file);
    if (done) return;
    this.queued.add(file);
    this.queue.push(file);
    this.emit('queue', this.queue.length);
    this.drain();
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && this.session) {
        const file = this.queue.shift();
        try {
          await this.ingest(file);
        } catch (err) {
          this.logEvent('error', `${path.basename(file)}: ${err.message}`);
        } finally {
          this.queued.delete(file);
          this.emit('queue', this.queue.length);
        }
      }
    } finally {
      this.busy = false;
      this.emit('idle');
    }
  }

  // ---------- ingest ----------

  async ingest(sourcePath) {
    const session = this.session;
    const stat = await fsp.stat(sourcePath);
    const sourceHash = await sha256(sourcePath);
    const location = session.activeLocation;

    // Claim a sequence number and record the asset in one step.
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    let assetId, target, sequence;
    try {
      sequence = db.prepare('SELECT next_sequence FROM sessions WHERE id = ?').get(session.id).next_sequence;
      target = buildTarget(session, { location, sequence, sourcePath });
      ({ lastInsertRowid: assetId } = db.prepare(`
        INSERT INTO assets (session_id, source_path, original_name, location, sequence, rel_path, size_bytes, sha256, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ingesting')`).run(
        session.id, sourcePath, path.basename(sourcePath), location, sequence, target.relPath, stat.size, sourceHash,
      ));
      db.prepare('UPDATE sessions SET next_sequence = ? WHERE id = ?').run(sequence + 1, session.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    assetId = Number(assetId);
    session.nextSequence = sequence + 1;
    this.emit('asset', this.asset(assetId));

    await this.copyToDestinations(assetId, sourcePath, sourceHash, target.relPath);
    const asset = this.asset(assetId);

    if (asset.status !== 'error' || asset.copies.some((c) => c.status === 'verified')) {
      const from = asset.copies.find((c) => c.status === 'verified')?.path || sourcePath;
      try {
        const { preview: p, thumb } = await preview.makePreviews(from, path.join(this.cacheDir, String(session.id)), assetId);
        db.prepare('UPDATE assets SET preview_path = ?, thumb_path = ? WHERE id = ?').run(p, thumb, assetId);
      } catch (err) {
        this.logEvent('warning', `${target.fileName}: no preview (${err.message}). The RAW itself is safe.`, assetId);
      }
    }
    const final = this.asset(assetId);
    this.emit('asset', final);
    return final;
  }

  async copyToDestinations(assetId, sourcePath, sourceHash, relPath) {
    const dests = this.session.destinations;
    const results = await Promise.all(dests.map((d) => this.copyOne(assetId, d, sourcePath, sourceHash, relPath)));
    const failed = dests.filter((_, i) => !results[i]);
    this.db.prepare('UPDATE assets SET status = ?, error = ? WHERE id = ?').run(
      failed.length ? 'error' : 'backed_up',
      failed.length ? `Not safely copied to: ${failed.map((d) => d.root).join(', ')}` : null,
      assetId,
    );
  }

  async copyOne(assetId, dest, sourcePath, sourceHash, relPath) {
    const finalPath = path.join(dest.root, relPath);
    const tmpPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.tetherpart`);
    const db = this.db;
    db.prepare(`INSERT INTO asset_copies (asset_id, destination_id, path, status) VALUES (?, ?, ?, 'copying')
                ON CONFLICT(asset_id, destination_id) DO UPDATE SET status = 'copying', error = NULL`)
      .run(assetId, dest.id, finalPath);
    try {
      if (!(await exists(dest.root))) throw new Error(`Drive or folder is missing: ${dest.root}`);
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      if (await exists(finalPath)) throw new Error(`A file named ${path.basename(finalPath)} already exists there; it was not overwritten`);
      await fsp.copyFile(sourcePath, tmpPath, fs.constants.COPYFILE_EXCL);
      const fh = await fsp.open(tmpPath, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      const copyHash = await sha256(tmpPath);
      if (copyHash !== sourceHash) throw new Error('Checksum mismatch after copy');
      if (await exists(finalPath)) throw new Error(`A file named ${path.basename(finalPath)} appeared during copy; it was not overwritten`);
      await fsp.rename(tmpPath, finalPath);
      db.prepare(`UPDATE asset_copies SET status = 'verified', path = ?, verified_at = datetime('now')
                  WHERE asset_id = ? AND destination_id = ?`).run(finalPath, assetId, dest.id);
      return true;
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      db.prepare(`UPDATE asset_copies SET status = 'error', error = ? WHERE asset_id = ? AND destination_id = ?`)
        .run(err.message, assetId, dest.id);
      this.logEvent('error', `${path.basename(finalPath)} -> ${dest.root}: ${err.message}`, assetId);
      return false;
    }
  }

  // Re-copies a frame to any destination where it failed (e.g. after a
  // drive is plugged back in). Uses the same name and sequence number.
  async retry(assetId) {
    const a = this.asset(assetId);
    if (!a) throw new Error('Unknown frame');
    if (!(await exists(a.sourcePath))) throw new Error('The original file is no longer in the watched folder');
    const hash = await sha256(a.sourcePath);
    if (hash !== a.sha256) throw new Error('The original file has changed since it was first ingested');
    const failed = this.session.destinations.filter((d) => a.copies.find((c) => c.destinationId === d.id)?.status !== 'verified');
    await Promise.all(failed.map((d) => this.copyOne(assetId, d, a.sourcePath, hash, a.relPath)));
    const copies = this.asset(assetId).copies;
    const allOk = this.session.destinations.every((d) => copies.find((c) => c.destinationId === d.id)?.status === 'verified');
    this.db.prepare('UPDATE assets SET status = ?, error = ? WHERE id = ?').run(allOk ? 'backed_up' : 'error', allOk ? null : a.error, assetId);
    if (allOk) await this.writeReview(assetId);
    const updated = this.asset(assetId);
    this.emit('asset', updated);
    return updated;
  }

  async retryAllFailed() {
    const ids = this.db.prepare("SELECT id FROM assets WHERE session_id = ? AND status = 'error' ORDER BY sequence").all(this.session.id);
    for (const { id } of ids) {
      try {
        await this.retry(id);
      } catch (err) {
        this.logEvent('error', `Retry failed: ${err.message}`, id);
      }
    }
  }

  // ---------- review: stars and color labels, written for Bridge ----------

  async setReview(assetId, { rating, label }) {
    const current = this.asset(assetId);
    if (!current) throw new Error('Unknown frame');
    const nextRating = rating === undefined ? current.rating : Math.max(0, Math.min(5, Number(rating) || 0));
    let nextLabel = label === undefined ? current.label : label;
    if (nextLabel && !LABEL_COLORS.includes(nextLabel)) throw new Error(`Unknown label ${nextLabel}`);
    if (!nextLabel) nextLabel = null;
    this.db.prepare(`
      INSERT INTO asset_review (asset_id, rating, label, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET rating = excluded.rating, label = excluded.label, updated_at = excluded.updated_at`)
      .run(assetId, nextRating, nextLabel);
    await this.writeReview(assetId);
    const updated = this.asset(assetId);
    this.emit('asset', updated);
    return updated;
  }

  async writeReview(assetId) {
    const a = this.asset(assetId);
    const labelText = a.label ? this.session.labels[a.label] : null;
    for (const c of a.copies.filter((x) => x.status === 'verified')) {
      try {
        await writeSidecar(c.path, { rating: a.rating, labelText });
      } catch (err) {
        this.logEvent('error', `Could not save rating for ${path.basename(c.path)}: ${err.message}`, assetId);
      }
    }
  }

  // ---------- reading state ----------

  asset(id) {
    const a = this.db.prepare(`
      SELECT a.*, COALESCE(r.rating, 0) AS rating, r.label AS label
      FROM assets a LEFT JOIN asset_review r ON r.asset_id = a.id WHERE a.id = ?`).get(id);
    if (!a) return null;
    const copies = this.db.prepare(`
      SELECT c.destination_id AS destinationId, d.role, d.root, c.path, c.status, c.error
      FROM asset_copies c JOIN destinations d ON d.id = c.destination_id WHERE c.asset_id = ? ORDER BY d.position`).all(id);
    return {
      id: a.id,
      sourcePath: a.source_path,
      originalName: a.original_name,
      fileName: path.basename(a.rel_path),
      relPath: a.rel_path,
      location: a.location,
      sequence: a.sequence,
      sizeBytes: a.size_bytes,
      sha256: a.sha256,
      status: a.status,
      error: a.error,
      previewPath: a.preview_path,
      thumbPath: a.thumb_path,
      ingestedAt: a.ingested_at,
      rating: a.rating,
      label: a.label,
      copies,
    };
  }

  assets({ location } = {}) {
    const rows = location
      ? this.db.prepare('SELECT id FROM assets WHERE session_id = ? AND location = ? ORDER BY sequence').all(this.session.id, location)
      : this.db.prepare('SELECT id FROM assets WHERE session_id = ? ORDER BY sequence').all(this.session.id);
    return rows.map((r) => this.asset(r.id));
  }

  stats() {
    const id = this.session.id;
    const byStatus = Object.fromEntries(
      this.db.prepare('SELECT status, COUNT(*) AS n FROM assets WHERE session_id = ? GROUP BY status').all(id).map((r) => [r.status, r.n]),
    );
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const lastTen = this.db.prepare(`
      SELECT COUNT(*) AS n FROM assets WHERE session_id = ? AND ingested_at >= datetime('now', '-10 minutes')`).get(id).n;
    const bytes = this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS b FROM assets WHERE session_id = ?').get(id).b;
    return {
      total,
      backedUp: byStatus.backed_up || 0,
      ingesting: (byStatus.ingesting || 0) + this.queue.length,
      errors: byStatus.error || 0,
      perMinute: Math.round((lastTen / 10) * 10) / 10,
      bytes,
      health: this.health,
      cameras: this.cameraState(),
      lastEvents: this.events(20),
    };
  }

  // ---------- health and events ----------

  async checkHealth() {
    const list = [];
    const check = async (label, dir, needWrite) => {
      try {
        await fsp.access(dir, needWrite ? fs.constants.W_OK : fs.constants.R_OK);
        const s = await fsp.statfs(dir);
        const freeBytes = s.bavail * s.bsize;
        list.push({ label, dir, ok: true, freeBytes, lowSpace: needWrite && freeBytes < 5 * 1024 ** 3 });
      } catch (err) {
        list.push({ label, dir, ok: false, error: err.code === 'ENOENT' ? 'Not connected or missing' : err.message });
      }
    };
    await check('Watched folder', this.session.sourceDir, false);
    for (const d of this.session.destinations) await check(d.role === 'primary' ? 'Main' : 'Backup', d.root, true);
    const changed = JSON.stringify(list.map((h) => [h.ok, h.lowSpace])) !== JSON.stringify(this.health.map((h) => [h.ok, h.lowSpace]));
    this.health = list;
    if (changed) {
      for (const h of list.filter((x) => !x.ok)) this.logEvent('error', `${h.label} (${h.dir}): ${h.error}`);
      this.emit('health', list);
    }
    return list;
  }

  logEvent(level, message, assetId = null) {
    if (!this.session) return;
    this.db.prepare('INSERT INTO integrity_events (session_id, asset_id, level, message) VALUES (?, ?, ?, ?)')
      .run(this.session.id, assetId, level, message);
    this.emit('event', { level, message, assetId });
  }

  events(limit = 50) {
    return this.db.prepare(`
      SELECT id, asset_id AS assetId, level, message, created_at AS createdAt
      FROM integrity_events WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(this.session.id, limit);
  }

  clearEvents() {
    this.db.prepare('DELETE FROM integrity_events WHERE session_id = ?').run(this.session.id);
  }

  async close() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    if (this.cameraWatcher) await this.cameraWatcher.close();
    this.cameraWatcher = null;
    this.cameraFolderList = [];
    this.missingCameras.clear();
    this.queue = [];
    this.queued.clear();
    this.session = null;
  }
}

module.exports = { Engine, RAW_EXTENSIONS, isRaw, sha256 };
