'use strict';
/**
 * Key/value settings held in the database, so an administrator can change
 * integration details from the admin screens without a redeploy.
 *
 * Precedence: a value saved here wins over the matching environment variable.
 * Clearing a field in the form falls back to the environment variable again,
 * which keeps an existing Railway setup working untouched.
 */
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');

let cache = null;

/* ---------------------- secrets are encrypted at rest ---------------------- *
 * Tokens and passwords entered on the admin screens are sealed with a key
 * derived from SESSION_SECRET before they reach the database, so a copied
 * backup file does not hand them over. Older plain values still read; they
 * are sealed the next time they are saved. Changing SESSION_SECRET means
 * re-entering them — the app says so on the page rather than failing quietly.
 * ------------------------------------------------------------------------- */

const SECRET_KEYS = new Set(['wati.token', 'mail.password']);
const PREFIX = 'enc:v1:';

function sealKey() {
  return crypto.createHash('sha256').update(`settings:${config.sessionSecret}`).digest();
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

function unseal(stored) {
  if (!stored || !String(stored).startsWith(PREFIX)) return stored; // a value saved before sealing existed
  try {
    const raw = Buffer.from(String(stored).slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (_) {
    // SESSION_SECRET has changed since this was saved: treat it as unset so the
    // admin page asks for it again instead of sending garbage to the provider.
    return '';
  }
}

function loadAll() {
  if (cache) return cache;
  cache = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    cache[row.key] = SECRET_KEYS.has(row.key) ? unseal(row.value) : row.value;
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
    ).run(key, SECRET_KEYS.has(key) ? seal(clean) : clean);
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

module.exports = { get, getBool, set, setMany, refresh, SECRET_KEYS, seal, unseal };
