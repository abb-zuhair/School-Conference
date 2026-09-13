'use strict';
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const config = require('../config');

const ROLES = ['admin', 'campus_admin', 'teacher', 'desk'];
const ADMIN_ROLES = ['admin', 'campus_admin'];

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 12);
}

function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(plain), hash);
  } catch (_) {
    return false;
  }
}

function findByEmail(email) {
  return db.prepare('SELECT * FROM staff WHERE lower(email) = lower(?)').get(String(email || '').trim());
}

function findById(id) {
  return db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
}

/** Creates the bootstrap admin from env on first boot. Never overwrites an existing account. */
function ensureBootstrapAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin'").get().n;
  if (count > 0) return null;
  if (!config.admin.email || !config.admin.password) {
    console.warn('[auth] No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set — run `npm run seed` or set them in .env');
    return null;
  }
  const info = db
    .prepare(
      `INSERT INTO staff (name, email, role, password_hash, must_change_pw, active)
       VALUES (?, ?, 'admin', ?, 1, 1)`
    )
    .run(config.admin.name, config.admin.email.trim(), hashPassword(config.admin.password));
  console.log(`[auth] Created bootstrap admin ${config.admin.email} (id ${info.lastInsertRowid})`);
  return findById(info.lastInsertRowid);
}

function currentUser(req) {
  if (!req.session || !req.session.staffId) return null;
  if (req._user) return req._user;
  const user = findById(req.session.staffId);
  if (!user || !user.active) return null;
  req._user = user;
  return user;
}

function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/staff/login');
  }
  res.locals.user = user;
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/staff/login');
    }
    if (!roles.includes(user.role)) {
      return res.status(403).render('error', {
        title: 'Not allowed',
        message: 'Your account does not have access to this page.',
        status: 403,
      });
    }
    res.locals.user = user;
    return next();
  };
}

const requireAdmin = requireRole(...ADMIN_ROLES);

/** campus_admin is scoped to their own campus; admin sees everything. */
function campusScope(user) {
  if (!user) return null;
  return user.role === 'admin' ? null : user.campus_id;
}

function canAccessCampus(user, campusId) {
  const scope = campusScope(user);
  return scope === null || Number(scope) === Number(campusId);
}

function audit(staffId, action, detail) {
  try {
    db.prepare('INSERT INTO audit_log (staff_id, action, detail) VALUES (?, ?, ?)').run(
      staffId || null,
      action,
      typeof detail === 'string' ? detail : JSON.stringify(detail || {})
    );
  } catch (_) {
    /* non-fatal */
  }
}

module.exports = {
  ROLES,
  ADMIN_ROLES,
  hashPassword,
  verifyPassword,
  findByEmail,
  findById,
  ensureBootstrapAdmin,
  currentUser,
  requireLogin,
  requireRole,
  requireAdmin,
  campusScope,
  canAccessCampus,
  audit,
};
