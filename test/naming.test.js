'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildTarget, formatDate, unknownTokens } = require('../src/core/naming');

const session = {
  client: 'Dun Diggin',
  job: 'Fall Campaign',
  jobNumber: 'J-118',
  date: '2026-10-16',
  dateFormat: 'YYYY-MM-DD',
  fileTemplate: '{date}_{client}_{location}_{sequence:4}{ext}',
  folderTemplate: '{client}/{location}',
};

test('folder drives the filename', () => {
  const t = buildTarget(session, { location: 'MainSalon', sequence: 42, sourcePath: '/card/DCIM/IMG_1234.cr3' });
  assert.equal(t.fileName, '2026-10-16_DunDiggin_MainSalon_0042.CR3');
  assert.equal(t.relPath, path.join('DunDiggin', 'MainSalon', '2026-10-16_DunDiggin_MainSalon_0042.CR3'));
});

test('date formats', () => {
  assert.equal(formatDate('2026-10-16', 'YYYYMMDD'), '20261016');
  assert.equal(formatDate('2026-10-16', 'YYMMDD'), '261016');
  assert.equal(formatDate('2026-10-16', 'DD-MM-YYYY'), '16-10-2026');
});

test('job tokens and padding', () => {
  const t = buildTarget({ ...session, fileTemplate: '{jobnumber}_{job}_{sequence:6}{ext}' }, { location: 'Lobby', sequence: 7, sourcePath: 'a.NEF' });
  assert.equal(t.fileName, 'J-118_FallCampaign_000007.NEF');
});

test('unsafe characters are removed from names and folders', () => {
  const t = buildTarget({ ...session, client: 'A/B: "C"' }, { location: 'Room 2/3', sequence: 1, sourcePath: 'x.arw' });
  assert.equal(t.fileName, '2026-10-16_ABC_Room23_0001.ARW');
  assert.equal(t.folder, path.join('ABC', 'Room23'));
});

test('unknown tokens are reported', () => {
  assert.deepEqual(unknownTokens('{date}_{camera}_{sequence}'), ['{camera}']);
});
