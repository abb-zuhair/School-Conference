'use strict';
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const config = require('../config');

const ROLES = ['admin', 'campus_admin', 'dept_head', 'teacher', 'desk'];
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

/**
 * A department head runs one department on one campus.
 *
 * A schedule belongs to that department if the schedule itself says so; when it
 * says nothing, the owning teacher's department decides. That is the same rule
 * the SQL in the staff routes uses, and the two must not drift apart.
 */
function headsThisSchedule(user, schedule) {
  if (!user || user.role !== 'dept_head' || !user.department_id) return false;
  if (!canAccessCampus(user, schedule.campus_id)) return false;
  if (schedule.department_id) return Number(schedule.department_id) === Number(user.department_id);
  if (!schedule.staff_id) return false;
  const owner = findById(schedule.staff_id);
  return Boolean(owner && Number(owner.department_id) === Number(user.department_id));
}

/**
 * The one answer to "may this person change this schedule?" — its owner, an
 * administrator over its campus, or the head of its department. Every route
 * that touches a schedule, a slot or a booking asks this and nothing else.
 */
function canManageSchedule(user, schedule) {
  if (!user || !schedule) return false;
  if (schedule.staff_id && Number(schedule.staff_id) === Number(user.id)) return true;
  if (ADMIN_ROLES.includes(user.role)) return canAccessCampus(user, schedule.campus_id);
  return headsThisSchedule(user, schedule);
}

/** The department a head is confined to — null for everyone else. */
function departmentScope(user) {
  return user && user.role === 'dept_head' ? user.department_id || null : null;
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
  canManageSchedule,
  headsThisSchedule,
  departmentScope,
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
