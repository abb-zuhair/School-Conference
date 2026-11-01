'use strict';
/**
 * The activity log, read side. Every change anyone makes — an admin, a
 * teacher, a department head, a parent — lands in audit_log through
 * auth.audit(); this turns those rows into something a person can read and
 * search, and answers "who changed this, and when?".
 */
const { db } = require('../db');

/** Human wording for each action key. Anything missing falls back to the key with spaces. */
const LABELS = {
  login: 'Signed in',
  login_microsoft: 'Signed in with Microsoft',
  sso_account_created: 'Account created at first Microsoft sign-in',
  sso_denied_unknown: 'Microsoft sign-in refused (no account)',
  sso_denied_inactive: 'Microsoft sign-in refused (account inactive)',
  password_change: 'Changed their password',
  password_reset_cli: 'Password reset from the command line',
  temp_password_dropped_at_sso: 'Temporary password dropped after Microsoft sign-in',
  account_created_cli: 'Account created from the command line',

  campus_create: 'Added a campus',
  campus_update: 'Edited a campus',
  department_create: 'Added a department',
  department_delete: 'Removed a department',

  staff_create: 'Added a staff account',
  staff_update: 'Edited a staff account',
  staff_activate: 'Activated a staff account',
  staff_deactivate: 'Deactivated a staff account',
  staff_password_reset: 'Reset a staff password',
  staff_import: 'Imported staff & classes from CSV',
  staff_bulk_campus: 'Moved staff to another campus',
  staff_bulk_department: 'Moved staff to another department',
  staff_bulk_activate: 'Activated staff (bulk)',
  staff_bulk_deactivate: 'Deactivated staff (bulk)',
  staff_bulk_delete: 'Deleted staff (bulk)',

  class_create: 'Added a class',
  class_delete: 'Removed a class',
  classes_bulk_reassign: 'Moved classes to another teacher',
  classes_bulk_delete: 'Deleted classes',

  event_create: 'Created an event',
  event_update: 'Edited event settings',
  event_window: 'Changed the booking window',
  event_status: 'Changed event status',
  event_delete: 'Deleted an event',

  schedules_generate: 'Generated schedules for an event',
  schedule_create: 'Added a schedule',
  schedule_settings: 'Changed schedule settings',
  schedule_lock: 'Locked a schedule',
  schedule_unlock: 'Unlocked a schedule',
  schedule_move: 'Moved a schedule to another department',
  schedule_transfer: 'Handed a schedule to another teacher',
  schedule_delete: 'Deleted a schedule',

  slots_generate: 'Generated slots',
  slots_clear: 'Cleared slots',
  slot_block: 'Closed a slot',
  slot_unblock: 'Reopened a slot',
  slot_delete: 'Deleted a slot',
  slot_capacity: 'Changed a slot capacity',
  slots_bulk: 'Bulk slot change',
  slots_bulk_delete: 'Deleted slots (bulk)',
  slots_bulk_block: 'Closed slots (bulk)',
  slots_bulk_unblock: 'Reopened slots (bulk)',
  slots_bulk_move: 'Moved slots (bulk)',
  slots_bulk_move_failed: 'Bulk slot move failed',

  booking_create: 'Booked an appointment',
  booking_cancel: 'Cancelled an appointment',
  booking_status: 'Marked attendance',
  booking_resend: 'Re-sent a confirmation',

  messaging_settings: 'Changed WhatsApp settings',
  email_settings: 'Changed email settings',
  backup_download: 'Downloaded a database backup',
  activity_export: 'Exported the activity log',
};

/** Filter groups for the page, by action prefix. */
const GROUPS = [
  { key: 'signin', label: 'Sign-ins & passwords', prefixes: ['login', 'sso_', 'password_', 'temp_password', 'account_created'] },
  { key: 'bookings', label: 'Bookings', prefixes: ['booking_'] },
  { key: 'slots', label: 'Slots', prefixes: ['slot_', 'slots_'] },
  { key: 'schedules', label: 'Events & schedules', prefixes: ['event_', 'schedule'] },
  { key: 'staff', label: 'Staff & classes', prefixes: ['staff_', 'class'] },
  { key: 'setup', label: 'Campuses & departments', prefixes: ['campus_', 'department_'] },
  { key: 'settings', label: 'Settings & backups', prefixes: ['messaging_', 'email_', 'backup_', 'activity_'] },
];

function inGroup(action, g) {
  return g.prefixes.some((p) => String(action).startsWith(p));
}

function label(action) {
  return LABELS[action] || String(action || '').replace(/_/g, ' ');
}

function groupOf(action) {
  const g = GROUPS.find((x) => inGroup(action, x));
  return g ? g.key : 'other';
}

/** Field names as they appear in change lists. */
const FIELD = {
  campus_id: 'campus',
  department_id: 'department',
  name_ar: 'Arabic name',
  opens_at: 'opens',
  closes_at: 'closes',
  max_per_student: 'max per student',
  prevent_overlap: 'prevent overlap',
  allow_cancel: 'parents may cancel',
  cancel_cutoff_hrs: 'cancel cut-off (hours)',
  require_phone: 'phone required',
  collect_student: 'ask for student',
  allow_compare: 'compare teachers',
  instructions_ar: 'Arabic instructions',
};

function short(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** The detail JSON as readable "key: value" pairs, with change lists as "field: old → new". */
function facts(row) {
  let d = {};
  try {
    d = row.detail ? JSON.parse(row.detail) : {};
  } catch (_) {
    return row.detail ? [{ k: 'detail', v: String(row.detail) }] : [];
  }
  if (typeof d !== 'object' || d === null) return [{ k: 'detail', v: String(d) }];
  const out = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'changes' && v && typeof v === 'object') {
      for (const [f, ch] of Object.entries(v)) {
        if (ch && typeof ch === 'object' && ('from' in ch || 'to' in ch)) out.push({ k: FIELD[f] || f.replace(/_/g, ' '), v: `${short(ch.from)} → ${short(ch.to)}`, change: true });
        else out.push({ k: FIELD[f] || f, v: short(ch) });
      }
      continue;
    }
    if (k === 'from' && 'to' in d) {
      out.push({ k: 'change', v: `${short(d.from)} → ${short(d.to)}`, change: true });
      continue;
    }
    if (k === 'to' && 'from' in d) continue;
    if (Array.isArray(v)) {
      out.push({ k: k.replace(/_/g, ' '), v: v.length > 8 ? `${v.length} items` : v.map(short).join(', ') });
      continue;
    }
    out.push({ k: k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim(), v: short(v) });
  }
  return out;
}

const PAGE = 100;

/**
 * Query the log. `filters`: { who: staffId | 'parents' | 'staff', group, action, from, to, q, page }.
 * `scope`: null for everyone, or a campus id to confine the view to that campus.
 */
function query(filters = {}, scope = null) {
  const where = [];
  const params = [];

  if (scope !== null) {
    // Staff on that campus, plus parents booking that campus's events.
    where.push(
      `((a.staff_id IS NOT NULL AND st.campus_id = ?) OR
        (a.staff_id IS NULL AND json_valid(a.detail) AND json_extract(a.detail, '$.eventId') IN (SELECT id FROM events WHERE campus_id = ?)))`
    );
    params.push(scope, scope);
  }
  if (filters.who === 'parents') where.push('a.staff_id IS NULL AND a.actor LIKE ? ') && params.push('%(parent)');
  else if (filters.who === 'staff') where.push('a.staff_id IS NOT NULL');
  else if (Number(filters.who)) where.push('a.staff_id = ?') && params.push(Number(filters.who));

  if (filters.action) where.push('a.action = ?') && params.push(String(filters.action));
  else if (filters.group) {
    const g = GROUPS.find((x) => x.key === filters.group);
    const likes = (grp) => grp.prefixes.map(() => 'a.action LIKE ?').join(' OR ');
    if (g) {
      where.push(`(${likes(g)})`);
      params.push(...g.prefixes.map((p) => `${p}%`));
    } else if (filters.group === 'other') {
      where.push(`NOT (${GROUPS.map(likes).join(' OR ')})`);
      params.push(...GROUPS.flatMap((grp) => grp.prefixes.map((p) => `${p}%`)));
    }
  }
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) where.push('a.created_at >= ?') && params.push(`${filters.from} 00:00:00`);
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) where.push('a.created_at <= ?') && params.push(`${filters.to} 23:59:59`);
  if (filters.q) {
    const like = `%${String(filters.q).trim()}%`;
    where.push('(a.actor LIKE ? OR a.action LIKE ? OR a.detail LIKE ? OR st.email LIKE ?)');
    params.push(like, like, like, like);
  }

  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Number(filters.page) || 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a LEFT JOIN staff st ON st.id = a.staff_id ${sql}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT a.*, st.email AS staff_email, st.role AS staff_role, st.name AS staff_name_now
       FROM audit_log a LEFT JOIN staff st ON st.id = a.staff_id
       ${sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, PAGE, (page - 1) * PAGE)
    .map(decorate);
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / PAGE)), perPage: PAGE };
}

/** Same filters, every row (capped), for the CSV. */
function exportRows(filters = {}, scope = null) {
  const all = [];
  let page = 1;
  for (;;) {
    const r = query({ ...filters, page }, scope);
    all.push(...r.rows);
    if (page >= r.pages || all.length >= 5000) break;
    page += 1;
  }
  return all;
}

function decorate(row) {
  return {
    ...row,
    label: label(row.action),
    group: groupOf(row.action),
    who: row.actor || row.staff_name_now || row.staff_email || (row.staff_id ? `staff #${row.staff_id}` : 'system'),
    facts: facts(row),
  };
}

module.exports = { LABELS, GROUPS, label, groupOf, facts, query, exportRows, PAGE };
