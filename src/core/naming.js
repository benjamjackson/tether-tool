'use strict';
// Turns a naming template like "{date}_{client}_{location}_{sequence:4}{ext}"
// into a real filename. The active location folder supplies {location},
// so naming a folder once names every frame that lands in it.

const path = require('node:path');

const DEFAULT_FILE_TEMPLATE = '{date}_{client}_{location}_{sequence:4}{ext}';
const DEFAULT_FOLDER_TEMPLATE = '{client}/{location}';
const DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'YYMMDD', 'DD-MM-YYYY', 'MM-DD-YYYY'];

const TOKEN = /\{(\w+)(?::(\d+))?\}/g;
const KNOWN = new Set(['client', 'job', 'jobnumber', 'date', 'location', 'sequence', 'ext']);

function formatDate(isoDate, format) {
  // isoDate is "YYYY-MM-DD" as entered in session setup.
  const [y, m, d] = isoDate.split('-');
  return (format || 'YYYY-MM-DD')
    .replace('YYYY', y)
    .replace('YY', y.slice(2))
    .replace('MM', m)
    .replace('DD', d);
}

// Keeps names safe for macOS, Windows and Bridge: no slashes, colons or
// other reserved characters, spaces collapsed.
function cleanPart(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '')
    .replace(/^\.+/, '');
}

function unknownTokens(template) {
  const bad = [];
  for (const m of template.matchAll(TOKEN)) if (!KNOWN.has(m[1].toLowerCase())) bad.push(m[0]);
  return bad;
}

function render(template, values) {
  return template.replace(TOKEN, (whole, name, width) => {
    const key = name.toLowerCase();
    if (key === 'sequence') return String(values.sequence).padStart(Number(width || 4), '0');
    if (key === 'ext') return values.ext; // keeps the leading dot and original case
    if (key === 'date') return formatDate(values.date, values.dateFormat);
    if (!KNOWN.has(key)) return whole;
    return cleanPart(values[key]);
  });
}

// session: { client, job, jobNumber, date, dateFormat, fileTemplate, folderTemplate }
function buildTarget(session, { location, sequence, sourcePath }) {
  const values = {
    client: session.client,
    job: session.job,
    jobnumber: session.jobNumber,
    date: session.date,
    dateFormat: session.dateFormat,
    location,
    sequence,
    ext: path.extname(sourcePath).toUpperCase(),
  };
  const fileName = render(session.fileTemplate || DEFAULT_FILE_TEMPLATE, values);
  const folder = render(session.folderTemplate || DEFAULT_FOLDER_TEMPLATE, values)
    .split('/')
    .map(cleanPart)
    .filter(Boolean)
    .join(path.sep);
  return { folder, fileName, relPath: path.join(folder, fileName) };
}

module.exports = {
  DEFAULT_FILE_TEMPLATE,
  DEFAULT_FOLDER_TEMPLATE,
  DATE_FORMATS,
  buildTarget,
  cleanPart,
  formatDate,
  render,
  unknownTokens,
};
