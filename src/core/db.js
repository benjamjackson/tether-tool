'use strict';
// The app's working index. The files, folders and .xmp sidecars on disk are
// the real record; this database only makes browsing and status fast.

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  client TEXT NOT NULL,
  job TEXT NOT NULL DEFAULT '',
  job_number TEXT NOT NULL DEFAULT '',
  shoot_date TEXT NOT NULL,            -- YYYY-MM-DD
  date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
  file_template TEXT NOT NULL,
  folder_template TEXT NOT NULL,
  source_dir TEXT NOT NULL,            -- watched folder the camera/tether app drops RAWs into
  active_location TEXT,
  next_sequence INTEGER NOT NULL DEFAULT 1,
  labels_json TEXT NOT NULL,           -- color -> Bridge label name
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  root TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary','backup')),
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, name)
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  source_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  location TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  rel_path TEXT NOT NULL,              -- path under each destination root
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('ingesting','verified','backed_up','error')),
  error TEXT,
  preview_path TEXT,
  thumb_path TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, source_path)
);
CREATE TABLE IF NOT EXISTS asset_copies (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  destination_id INTEGER NOT NULL REFERENCES destinations(id),
  path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('copying','verified','error')),
  error TEXT,
  verified_at TEXT,
  UNIQUE (asset_id, destination_id)
);
CREATE TABLE IF NOT EXISTS asset_review (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id),
  rating INTEGER NOT NULL DEFAULT 0,   -- 0 none, 1-5 stars
  label TEXT,                          -- color key: red/yellow/green/blue/purple
  flagged INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS camera_folders (
  camera_key TEXT PRIMARY KEY,         -- e.g. "Sony:ILCE-7M4"; shared by every session
  name TEXT NOT NULL,
  folder TEXT NOT NULL,                -- where that camera's tether program saves
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS integrity_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  asset_id INTEGER REFERENCES assets(id),
  level TEXT NOT NULL CHECK (level IN ('info','warning','error')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
