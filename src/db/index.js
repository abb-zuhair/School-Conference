'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

const dbPath = path.resolve(config.databasePath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Add a column only if it isn't there yet — lets an existing database pick up new fields. */
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] added column ${table}.${column}`);
  }
}

function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);

  // Incremental changes to databases created by an earlier version.
  addColumn('events', 'allow_compare', 'INTEGER NOT NULL DEFAULT 1');
}

/**
 * True when the database file sits inside the deployed application directory,
 * which on Railway (or any container host) means it is wiped on every deploy.
 * A mounted volume lives outside the app directory, e.g. /data/app.db.
 */
function isEphemeralStorage() {
  const appDir = path.resolve(process.cwd());
  return dbPath.startsWith(`${appDir}${path.sep}`) || path.dirname(dbPath) === appDir;
}

/** Consistent point-in-time copy, safe to take while the app is serving traffic. */
async function backupTo(destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await db.backup(destination);
  return destination;
}

module.exports = { db, migrate, dbPath, isEphemeralStorage, backupTo };
