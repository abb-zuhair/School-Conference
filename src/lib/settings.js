'use strict';
/**
 * Key/value settings held in the database, so an administrator can change
 * integration details from the admin screens without a redeploy.
 *
 * Precedence: a value saved here wins over the matching environment variable.
 * Clearing a field in the form falls back to the environment variable again,
 * which keeps an existing Railway setup working untouched.
 */
const { db } = require('../db');

let cache = null;

function loadAll() {
  if (cache) return cache;
  cache = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    cache[row.key] = row.value;
  }
  return cache;
}

function get(key, fallback = '') {
  const value = loadAll()[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function getBool(key, fallback) {
  const raw = loadAll()[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function set(key, value) {
  const clean = value === undefined || value === null ? '' : String(value).trim();
  if (clean === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, clean);
  }
  cache = null;
}

function setMany(pairs) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) set(k, v);
  });
  tx(Object.entries(pairs));
  cache = null;
}

/** Drop the cache — used after an external write, and by the tests. */
function refresh() {
  cache = null;
}

module.exports = { get, getBool, set, setMany, refresh };
