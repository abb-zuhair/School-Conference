'use strict';
// Tiny express-session store backed by the same SQLite file — no extra native deps,
// and sessions survive a Railway restart as long as the volume does.
const session = require('express-session');
const { db } = require('./index');

class SqliteStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.ttl = options.ttl || 1000 * 60 * 60 * 12;
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        'INSERT INTO sessions (sid, data, expires_at) VALUES (@sid, @data, @expires_at) ' +
          'ON CONFLICT(sid) DO UPDATE SET data = @data, expires_at = @expires_at'
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions'),
      clear: db.prepare('DELETE FROM sessions'),
    };
    this.sweepTimer = setInterval(() => this.sweep(), 1000 * 60 * 30);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  sweep() {
    try {
      this.stmts.sweep.run(Date.now());
    } catch (_) {
      /* ignore */
    }
  }

  expiry(sess) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge;
    return Date.now() + (maxAge || this.ttl);
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at < Date.now()) {
        this.stmts.destroy.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.stmts.set.run({ sid, data: JSON.stringify(sess), expires_at: this.expiry(sess) });
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.stmts.touch.run(this.expiry(sess), sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.stmts.destroy.run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  length(cb = () => {}) {
    try {
      return cb(null, this.stmts.length.get().n);
    } catch (err) {
      return cb(err);
    }
  }

  clear(cb = () => {}) {
    try {
      this.stmts.clear.run();
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }
}

module.exports = SqliteStore;
