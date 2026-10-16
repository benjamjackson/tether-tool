'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Engine, sha256 } = require('../src/core/engine');
const { open } = require('../src/core/db');
const { readSidecar } = require('../src/core/xmp');
const preview = require('../src/core/preview');
const { fakeRaw, tempDir, waitFor } = require('./helpers');

async function setup(extra = {}) {
  const root = await tempDir();
  const card = path.join(root, 'card', 'DCIM');
  const main = path.join(root, 'SSD_Main');
  const backup = path.join(root, 'SSD_Backup');
  await Promise.all([card, main, backup].map((d) => fs.mkdir(d, { recursive: true })));
  const engine = new Engine({ db: open(path.join(root, 'tether.db')), cacheDir: path.join(root, 'cache') });
  const id = engine.createSession({
    client: 'Dun Diggin',
    job: 'Fall',
    date: '2026-10-16',
    sourceDir: card,
    destinations: [main, backup],
    locations: ['Main Salon', 'Lobby'],
    ...extra,
  });
  return { root, card, main, backup, engine, id };
}

test.after(() => preview.closeExiftool());

test('card in: renamed, copied to both drives, verified, previewed', async () => {
  const { card, main, backup, engine, id } = await setup();
  // Files already on the card ingest in shooting order.
  await fakeRaw(path.join(card, 'IMG_0002.CR3'), { color: '#336699' });
  await fakeRaw(path.join(card, 'IMG_0001.CR3'), { color: '#993333' });
  const t = new Date(Date.now() - 60000);
  await fs.utimes(path.join(card, 'IMG_0001.CR3'), t, t);
  await fs.writeFile(path.join(card, 'IMG_0001.JPG'), 'not a raw');

  await engine.openSession(id);
  await waitFor(() => engine.assets().filter((a) => a.status === 'backed_up' && a.thumbPath).length === 2);

  const [first, second] = engine.assets();
  assert.equal(first.originalName, 'IMG_0001.CR3');
  assert.equal(first.fileName, '2026-10-16_DunDiggin_MainSalon_0001.CR3');
  assert.equal(second.fileName, '2026-10-16_DunDiggin_MainSalon_0002.CR3');
  for (const dest of [main, backup]) {
    const p = path.join(dest, 'DunDiggin', 'MainSalon', first.fileName);
    assert.equal(await sha256(p), await sha256(path.join(card, 'IMG_0001.CR3')));
  }
  // Source untouched, JPG ignored, no temp files left behind.
  assert.deepEqual((await fs.readdir(card)).sort(), ['IMG_0001.CR3', 'IMG_0001.JPG', 'IMG_0002.CR3']);
  assert.deepEqual(await fs.readdir(path.join(main, 'DunDiggin', 'MainSalon')), [first.fileName, second.fileName]);
  assert.ok((await fs.stat(first.previewPath)).size > 0);

  // Switching location renames the next frame into the new folder.
  engine.setActiveLocation('Lobby');
  await fakeRaw(path.join(card, 'IMG_0003.CR3'));
  await waitFor(() => engine.assets({ location: 'Lobby' }).some((a) => a.status === 'backed_up'));
  const lobby = engine.assets({ location: 'Lobby' })[0];
  assert.equal(lobby.relPath, path.join('DunDiggin', 'Lobby', '2026-10-16_DunDiggin_Lobby_0003.CR3'));
  assert.deepEqual(engine.locations().map((l) => [l.name, l.count]), [['MainSalon', 2], ['Lobby', 1]]);

  const stats = engine.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.backedUp, 3);
  assert.equal(stats.errors, 0);
  await engine.close();
});

test('ratings and color labels land in sidecars on both drives', async () => {
  const { card, engine, id } = await setup();
  await fakeRaw(path.join(card, 'A.NEF'));
  await engine.openSession(id);
  await waitFor(() => engine.assets()[0]?.status === 'backed_up');
  const a = engine.assets()[0];
  await engine.setReview(a.id, { rating: 3, label: 'red' });
  for (const c of a.copies) assert.deepEqual(await readSidecar(c.path), { rating: 3, labelText: 'Select' });
  await engine.setReview(a.id, { label: null });
  for (const c of a.copies) assert.deepEqual(await readSidecar(c.path), { rating: 3, labelText: null });
  await engine.close();
});

test('custom Bridge label names are used', async () => {
  const { card, engine, id } = await setup({ labels: { green: 'Client Pick' } });
  await fakeRaw(path.join(card, 'A.ARW'));
  await engine.openSession(id);
  await waitFor(() => engine.assets()[0]?.status === 'backed_up');
  const a = await engine.setReview(engine.assets()[0].id, { label: 'green' });
  assert.equal((await readSidecar(a.copies[1].path)).labelText, 'Client Pick');
  await engine.close();
});

test('missing backup drive is an error, and retry fixes it once it is back', async () => {
  const { card, backup, engine, id } = await setup();
  await engine.openSession(id);
  await fs.rm(backup, { recursive: true });
  await fakeRaw(path.join(card, 'B.CR3'));
  await waitFor(() => engine.assets()[0]?.status === 'error');
  const bad = engine.assets()[0];
  assert.equal(bad.copies[0].status, 'verified');
  assert.equal(bad.copies[1].status, 'error');
  assert.match(bad.error, /SSD_Backup/);
  assert.equal(engine.stats().errors, 1);
  await engine.setReview(bad.id, { rating: 2 });

  await fs.mkdir(backup);
  const fixed = await engine.retry(bad.id);
  assert.equal(fixed.status, 'backed_up');
  // The rating set while the drive was missing reaches the backup too.
  assert.equal((await readSidecar(fixed.copies[1].path)).rating, 2);
  await engine.close();
});

test('never overwrites an existing file', async () => {
  const { card, main, engine, id } = await setup();
  const clash = path.join(main, 'DunDiggin', 'MainSalon', '2026-10-16_DunDiggin_MainSalon_0001.CR3');
  await fs.mkdir(path.dirname(clash), { recursive: true });
  await fs.writeFile(clash, 'precious');
  await fakeRaw(path.join(card, 'C.CR3'));
  await engine.openSession(id);
  await waitFor(() => engine.assets()[0]?.status === 'error');
  assert.equal(await fs.readFile(clash, 'utf8'), 'precious');
  await engine.close();
});

test('reopening a session does not ingest the same file twice and keeps counting', async () => {
  const { card, engine, id } = await setup();
  await fakeRaw(path.join(card, 'D.CR3'));
  await engine.openSession(id);
  await waitFor(() => engine.assets()[0]?.status === 'backed_up');
  await engine.close();
  await engine.openSession(id);
  await fakeRaw(path.join(card, 'E.CR3'));
  await waitFor(() => engine.assets().length === 2 && engine.assets()[1].status === 'backed_up');
  assert.deepEqual(engine.assets().map((a) => a.sequence), [1, 2]);
  await engine.close();
});

test('session setup catches mistakes', async () => {
  const { engine, card, main } = await setup();
  assert.throws(() => engine.createSession({ client: '', date: 'x', sourceDir: card, destinations: [main], locations: [] }), (err) => {
    assert.match(err.message, /Client name/);
    assert.match(err.message, /backup/);
    assert.match(err.message, /location/);
    return true;
  });
  assert.throws(
    () => engine.createSession({ client: 'A', date: '2026-01-01', sourceDir: card, destinations: [main, main + '2'], locations: ['X'], fileTemplate: '{date}{ext}' }),
    /needs \{sequence\}/,
  );
});

test('clipping is measured from the preview', async () => {
  const dir = await tempDir();
  const raw = await fakeRaw(path.join(dir, 'clip.CR3'), { color: '#606060', blownTop: true });
  const { preview: p } = await preview.makePreviews(raw, path.join(dir, 'cache'), 1);
  const a = await preview.analyze(p);
  assert.ok(a.highlightClipPct > 20 && a.highlightClipPct < 30, `highlights ${a.highlightClipPct}`);
  assert.equal(a.shadowClipPct, 0);
});
