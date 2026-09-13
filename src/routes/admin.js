'use strict';
const express = require('express');
const { db } = require('../db');
const auth = require('../lib/auth');
const sched = require('../lib/scheduling');
const { parseCsvObjects } = require('../lib/csv');
const { notifyAsync } = require('../services/notify');
const { runReminders } = require('../services/reminders');
const {
  slugify,
  token,
  toCsv,
  formatDate,
  formatTime,
  asBool,
  EVENT_TYPES,
  MODES,
} = require('../lib/helpers');

const router = express.Router();
router.use(auth.requireAdmin);

/** campus_admin only ever sees their own campus. */
function campusFilter(req, alias = 'campus_id') {
  const scope = auth.campusScope(auth.currentUser(req));
  return scope === null ? { sql: '1=1', params: [] } : { sql: `${alias} = ?`, params: [scope] };
}

function campusesFor(req) {
  const f = campusFilter(req, 'id');
  return db.prepare(`SELECT * FROM campuses WHERE ${f.sql} ORDER BY sort_order, name`).all(...f.params);
}

/* --------------------------- dashboard ----------------------------- */

router.get('/', (req, res) => {
  const f = campusFilter(req, 'e.campus_id');
  const events = db
    .prepare(
      `SELECT e.*, cp.name AS campus_name,
              (SELECT COUNT(*) FROM schedules s WHERE s.event_id = e.id) AS schedules,
              (SELECT COUNT(*) FROM bookings b WHERE b.event_id = e.id AND b.status = 'booked') AS bookings,
              (SELECT COALESCE(SUM(sl.capacity),0) FROM slots sl JOIN schedules s2 ON s2.id = sl.schedule_id
                WHERE s2.event_id = e.id AND sl.blocked = 0) AS capacity
       FROM events e JOIN campuses cp ON cp.id = e.campus_id
       WHERE ${f.sql} AND e.status != 'archived'
       ORDER BY e.id DESC`
    )
    .all(...f.params);
  const counts = {
    campuses: campusesFor(req).length,
    staff: db.prepare(`SELECT COUNT(*) AS n FROM staff WHERE active = 1 AND ${campusFilter(req).sql}`).get(...campusFilter(req).params).n,
    bookings: events.reduce((a, e) => a + e.bookings, 0),
  };
  res.render('admin/dashboard', { title: 'Admin', events, counts, EVENT_TYPES });
});

/* ---------------------------- campuses ----------------------------- */

router.get('/campuses', (req, res) => {
  const campuses = campusesFor(req).map((c) => ({
    ...c,
    departments: db.prepare('SELECT * FROM departments WHERE campus_id = ? ORDER BY sort_order, name').all(c.id),
    staff_count: db.prepare('SELECT COUNT(*) AS n FROM staff WHERE campus_id = ? AND active = 1').get(c.id).n,
  }));
  res.render('admin/campuses', { title: 'Campuses & departments', campuses });
});

router.post('/campuses', auth.requireRole('admin'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    req.flash('error', 'Campus name is required.');
    return res.redirect('/admin/campuses');
  }
  let slug = slugify(req.body.slug || name, 'campus');
  if (db.prepare('SELECT 1 FROM campuses WHERE slug = ?').get(slug)) slug = `${slug}-${token(2)}`;
  db.prepare('INSERT INTO campuses (name, name_ar, slug, address, phone, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
    name,
    String(req.body.name_ar || '').trim() || null,
    slug,
    String(req.body.address || '').trim() || null,
    String(req.body.phone || '').trim() || null,
    Number(req.body.sort_order || 0)
  );
  auth.audit(auth.currentUser(req).id, 'campus_create', { name });
  req.flash('success', `Campus “${name}” added.`);
  return res.redirect('/admin/campuses');
});

router.post('/campuses/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!auth.canAccessCampus(auth.currentUser(req), id)) return res.status(403).send('Not allowed');
  db.prepare('UPDATE campuses SET name = ?, name_ar = ?, address = ?, phone = ?, active = ?, sort_order = ? WHERE id = ?').run(
    String(req.body.name || '').trim(),
    String(req.body.name_ar || '').trim() || null,
    String(req.body.address || '').trim() || null,
    String(req.body.phone || '').trim() || null,
    asBool(req.body.active) ? 1 : 0,
    Number(req.body.sort_order || 0),
    id
  );
  req.flash('success', 'Campus updated.');
  res.redirect('/admin/campuses');
});

router.post('/departments', (req, res) => {
  const campusId = Number(req.body.campus_id);
  if (!auth.canAccessCampus(auth.currentUser(req), campusId)) return res.status(403).send('Not allowed');
  const name = String(req.body.name || '').trim();
  if (!name) {
    req.flash('error', 'Department name is required.');
    return res.redirect('/admin/campuses');
  }
  db.prepare('INSERT INTO departments (campus_id, name, name_ar, sort_order) VALUES (?, ?, ?, ?)').run(
    campusId,
    name,
    String(req.body.name_ar || '').trim() || null,
    Number(req.body.sort_order || 0)
  );
  req.flash('success', `Department “${name}” added.`);
  return res.redirect('/admin/campuses');
});

router.post('/departments/:id/delete', (req, res) => {
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(Number(req.params.id));
  if (!dept) return res.redirect('/admin/campuses');
  if (!auth.canAccessCampus(auth.currentUser(req), dept.campus_id)) return res.status(403).send('Not allowed');
  db.prepare('DELETE FROM departments WHERE id = ?').run(dept.id);
  req.flash('success', 'Department removed.');
  return res.redirect('/admin/campuses');
});

/* ------------------------------ staff ------------------------------ */

router.get('/staff', (req, res) => {
  const f = campusFilter(req, 's.campus_id');
  const q = String(req.query.q || '').trim();
  const rows = db
    .prepare(
      `SELECT s.*, cp.name AS campus_name, d.name AS department_name,
              (SELECT COUNT(*) FROM classes c WHERE c.staff_id = s.id AND c.active = 1) AS class_count
       FROM staff s
       LEFT JOIN campuses cp ON cp.id = s.campus_id
       LEFT JOIN departments d ON d.id = s.department_id
       WHERE ${f.sql}
       ORDER BY s.active DESC, s.name`
    )
    .all(...f.params);
  const filtered = q
    ? rows.filter((r) => `${r.name} ${r.email}`.toLowerCase().includes(q.toLowerCase()))
    : rows;
  res.render('admin/staff', {
    title: 'Staff',
    staff: filtered,
    campuses: campusesFor(req),
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    q,
    roles: auth.ROLES,
  });
});

function upsertStaff(body, actorId) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) throw new Error('Email is required.');
  const existing = auth.findByEmail(email);
  const payload = {
    campus_id: Number(body.campus_id) || null,
    department_id: Number(body.department_id) || null,
    name: String(body.name || '').trim(),
    name_ar: String(body.name_ar || '').trim() || null,
    email,
    phone: String(body.phone || '').trim() || null,
    title: String(body.title || '').trim() || null,
    role: auth.ROLES.includes(body.role) ? body.role : 'teacher',
  };
  if (existing) {
    db.prepare(
      `UPDATE staff SET campus_id=@campus_id, department_id=@department_id, name=@name, name_ar=@name_ar,
       phone=@phone, title=@title, role=@role WHERE id=@id`
    ).run({ ...payload, id: existing.id });
    return { id: existing.id, created: false, tempPassword: null };
  }
  const temp = token(6);
  const info = db
    .prepare(
      `INSERT INTO staff (campus_id, department_id, name, name_ar, email, phone, title, role, password_hash, must_change_pw)
       VALUES (@campus_id, @department_id, @name, @name_ar, @email, @phone, @title, @role, @hash, 1)`
    )
    .run({ ...payload, hash: auth.hashPassword(temp) });
  auth.audit(actorId, 'staff_create', { email });
  return { id: info.lastInsertRowid, created: true, tempPassword: temp };
}

router.post('/staff', (req, res) => {
  try {
    const result = upsertStaff(req.body, auth.currentUser(req).id);
    req.flash(
      'success',
      result.created
        ? `Staff account created. Temporary password: ${result.tempPassword} — they must change it at first sign-in.`
        : 'Staff record updated.'
    );
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/admin/staff');
});

router.post('/staff/:id/reset-password', (req, res) => {
  const temp = token(6);
  db.prepare('UPDATE staff SET password_hash = ?, must_change_pw = 1 WHERE id = ?').run(auth.hashPassword(temp), Number(req.params.id));
  auth.audit(auth.currentUser(req).id, 'staff_password_reset', { staffId: req.params.id });
  req.flash('success', `New temporary password: ${temp}`);
  res.redirect('/admin/staff');
});

router.post('/staff/:id/toggle', (req, res) => {
  db.prepare('UPDATE staff SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(Number(req.params.id));
  res.redirect('/admin/staff');
});

router.get('/staff/import', (req, res) => {
  res.render('admin/staff-import', { title: 'Import staff & classes', result: null, campuses: campusesFor(req) });
});

router.post('/staff/import', (req, res) => {
  const campusId = Number(req.body.campus_id) || null;
  const rows = parseCsvObjects(req.body.csv || '');
  const result = { created: 0, updated: 0, classes: 0, errors: [], passwords: [] };
  const actorId = auth.currentUser(req).id;

  for (const [i, row] of rows.entries()) {
    try {
      if (!row.email) throw new Error('missing email');
      let departmentId = null;
      if (row.department) {
        const dept =
          db.prepare('SELECT * FROM departments WHERE campus_id = ? AND lower(name) = lower(?)').get(campusId, row.department) ||
          (() => {
            const info = db.prepare('INSERT INTO departments (campus_id, name) VALUES (?, ?)').run(campusId, row.department);
            return { id: info.lastInsertRowid };
          })();
        departmentId = dept.id;
      }
      const out = upsertStaff(
        {
          ...row,
          campus_id: campusId,
          department_id: departmentId,
          role: row.role || 'teacher',
        },
        actorId
      );
      if (out.created) {
        result.created += 1;
        result.passwords.push({ email: row.email, password: out.tempPassword });
      } else {
        result.updated += 1;
      }

      const classNames = String(row.classes || '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      for (const name of classNames) {
        const exists = db.prepare('SELECT 1 FROM classes WHERE staff_id = ? AND name = ?').get(out.id, name);
        if (!exists) {
          db.prepare('INSERT INTO classes (staff_id, name, grade_level, room) VALUES (?, ?, ?, ?)').run(
            out.id,
            name,
            row.grade || null,
            row.room || null
          );
          result.classes += 1;
        }
      }
    } catch (err) {
      result.errors.push(`Row ${i + 2}: ${err.message}`);
    }
  }
  res.render('admin/staff-import', { title: 'Import staff & classes', result, campuses: campusesFor(req) });
});

/* ----------------------------- classes ----------------------------- */

router.post('/classes', (req, res) => {
  const staffId = Number(req.body.staff_id);
  const name = String(req.body.name || '').trim();
  if (!staffId || !name) {
    req.flash('error', 'Pick a teacher and enter a class name.');
    return res.redirect('/admin/staff');
  }
  db.prepare('INSERT INTO classes (staff_id, name, grade_level, room, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    staffId,
    name,
    String(req.body.grade_level || '').trim() || null,
    String(req.body.room || '').trim() || null,
    Number(req.body.sort_order || 0)
  );
  req.flash('success', `Class “${name}” added.`);
  return res.redirect(req.get('referer') || '/admin/staff');
});

router.post('/classes/:id/delete', (req, res) => {
  db.prepare('DELETE FROM classes WHERE id = ?').run(Number(req.params.id));
  req.flash('success', 'Class removed.');
  res.redirect(req.get('referer') || '/admin/staff');
});

router.get('/staff/:id', (req, res) => {
  const member = auth.findById(Number(req.params.id));
  if (!member) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Staff member not found.' });
  const classes = db.prepare('SELECT * FROM classes WHERE staff_id = ? ORDER BY sort_order, name').all(member.id);
  const schedules = sched.listSchedules('WHERE s.staff_id = ? ORDER BY s.id DESC', [member.id]);
  return res.render('admin/staff-detail', {
    title: member.name,
    member,
    classes,
    schedules,
    campuses: campusesFor(req),
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    roles: auth.ROLES,
  });
});

/* ------------------------------ events ----------------------------- */

router.get('/events/new', (req, res) => {
  res.render('admin/event-form', {
    title: 'New event',
    event: null,
    campuses: campusesFor(req),
    EVENT_TYPES,
  });
});

router.post('/events', (req, res) => {
  const campusId = Number(req.body.campus_id);
  if (!auth.canAccessCampus(auth.currentUser(req), campusId)) return res.status(403).send('Not allowed');
  const name = String(req.body.name || '').trim();
  if (!name || !campusId) {
    req.flash('error', 'Event name and campus are required.');
    return res.redirect('/admin/events/new');
  }
  let slug = slugify(req.body.slug || name, 'event');
  if (db.prepare('SELECT 1 FROM events WHERE slug = ?').get(slug)) slug = `${slug}-${token(2)}`;
  const info = db
    .prepare(
      `INSERT INTO events (campus_id, type, name, name_ar, slug, description, instructions, instructions_ar,
        opens_at, closes_at, max_per_student, prevent_overlap, allow_cancel, cancel_cutoff_hrs,
        require_phone, collect_student, status)
       VALUES (@campus_id, @type, @name, @name_ar, @slug, @description, @instructions, @instructions_ar,
        @opens_at, @closes_at, @max_per_student, @prevent_overlap, @allow_cancel, @cancel_cutoff_hrs,
        @require_phone, @collect_student, @status)`
    )
    .run({
      campus_id: campusId,
      type: EVENT_TYPES[req.body.type] ? req.body.type : 'conference',
      name,
      name_ar: String(req.body.name_ar || '').trim() || null,
      slug,
      description: String(req.body.description || '').trim() || null,
      instructions: String(req.body.instructions || '').trim() || null,
      instructions_ar: String(req.body.instructions_ar || '').trim() || null,
      opens_at: String(req.body.opens_at || '').replace('T', ' ') || null,
      closes_at: String(req.body.closes_at || '').replace('T', ' ') || null,
      max_per_student: Number(req.body.max_per_student || 0),
      prevent_overlap: asBool(req.body.prevent_overlap) ? 1 : 0,
      allow_cancel: asBool(req.body.allow_cancel) ? 1 : 0,
      cancel_cutoff_hrs: Number(req.body.cancel_cutoff_hrs || 2),
      require_phone: asBool(req.body.require_phone) ? 1 : 0,
      collect_student: asBool(req.body.collect_student) ? 1 : 0,
      status: 'draft',
    });
  auth.audit(auth.currentUser(req).id, 'event_create', { name, slug });
  req.flash('success', 'Event created — now add the schedules parents will book against.');
  return res.redirect(`/admin/events/${info.lastInsertRowid}`);
});

function loadEvent(req, res, next) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id));
  if (!event) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Event not found.' });
  if (!auth.canAccessCampus(auth.currentUser(req), event.campus_id)) return res.status(403).send('Not allowed');
  req.event = event;
  res.locals.event = event;
  return next();
}

router.get('/events/:id', loadEvent, (req, res) => {
  const schedules = sched
    .listSchedules('WHERE s.event_id = ? ORDER BY d.sort_order, d.name, st.name, c.name', [req.event.id])
    .map((s) => ({ ...s, stats: sched.scheduleStats(s.id) }));
  const departments = db.prepare('SELECT * FROM departments WHERE campus_id = ? ORDER BY sort_order, name').all(req.event.campus_id);
  const teachers = db
    .prepare("SELECT * FROM staff WHERE campus_id = ? AND active = 1 AND role IN ('teacher','desk','campus_admin') ORDER BY name")
    .all(req.event.campus_id);
  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM bookings WHERE event_id = ? AND status = 'booked') AS booked,
              (SELECT COUNT(*) FROM bookings WHERE event_id = ? AND status = 'cancelled') AS cancelled,
              (SELECT COALESCE(SUM(sl.capacity),0) FROM slots sl JOIN schedules s ON s.id = sl.schedule_id
                WHERE s.event_id = ? AND sl.blocked = 0) AS capacity`
    )
    .get(req.event.id, req.event.id, req.event.id);
  res.render('admin/event-detail', {
    title: req.event.name,
    schedules,
    departments,
    teachers,
    stats,
    EVENT_TYPES,
    MODES,
    window: sched.eventWindow(req.event),
  });
});

router.post('/events/:id', loadEvent, (req, res) => {
  db.prepare(
    `UPDATE events SET name=@name, name_ar=@name_ar, description=@description, instructions=@instructions,
      instructions_ar=@instructions_ar, opens_at=@opens_at, closes_at=@closes_at, max_per_student=@max_per_student,
      prevent_overlap=@prevent_overlap, allow_cancel=@allow_cancel, cancel_cutoff_hrs=@cancel_cutoff_hrs,
      require_phone=@require_phone, collect_student=@collect_student WHERE id=@id`
  ).run({
    id: req.event.id,
    name: String(req.body.name || '').trim(),
    name_ar: String(req.body.name_ar || '').trim() || null,
    description: String(req.body.description || '').trim() || null,
    instructions: String(req.body.instructions || '').trim() || null,
    instructions_ar: String(req.body.instructions_ar || '').trim() || null,
    opens_at: String(req.body.opens_at || '').replace('T', ' ') || null,
    closes_at: String(req.body.closes_at || '').replace('T', ' ') || null,
    max_per_student: Number(req.body.max_per_student || 0),
    prevent_overlap: asBool(req.body.prevent_overlap) ? 1 : 0,
    allow_cancel: asBool(req.body.allow_cancel) ? 1 : 0,
    cancel_cutoff_hrs: Number(req.body.cancel_cutoff_hrs || 2),
    require_phone: asBool(req.body.require_phone) ? 1 : 0,
    collect_student: asBool(req.body.collect_student) ? 1 : 0,
  });
  req.flash('success', 'Event settings saved.');
  res.redirect(`/admin/events/${req.event.id}`);
});

router.post('/events/:id/status', loadEvent, (req, res) => {
  const status = ['draft', 'published', 'closed', 'archived'].includes(req.body.status) ? req.body.status : 'draft';
  db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, req.event.id);
  auth.audit(auth.currentUser(req).id, 'event_status', { eventId: req.event.id, status });
  req.flash('success', `Event is now ${status}.`);
  res.redirect(`/admin/events/${req.event.id}`);
});

/* --------------------------- schedules ----------------------------- */

/** Create one schedule per active class for the chosen departments (conference events). */
router.post('/events/:id/schedules/generate', loadEvent, (req, res) => {
  const deptIds = (Array.isArray(req.body.department_ids) ? req.body.department_ids : [req.body.department_ids])
    .map(Number)
    .filter(Boolean);
  if (!deptIds.length) {
    req.flash('error', 'Select at least one department.');
    return res.redirect(`/admin/events/${req.event.id}`);
  }
  const rows = db
    .prepare(
      `SELECT c.id AS class_id, c.staff_id, s.department_id
       FROM classes c JOIN staff s ON s.id = c.staff_id
       WHERE c.active = 1 AND s.active = 1 AND s.campus_id = ?
         AND s.department_id IN (${deptIds.map(() => '?').join(',')})`
    )
    .all(req.event.campus_id, ...deptIds);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO schedules (event_id, department_id, staff_id, class_id, mode, location)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const run = db.transaction(() => {
    let added = 0;
    for (const r of rows) {
      added += insert.run(req.event.id, r.department_id, r.staff_id, r.class_id, req.body.mode || 'in_person', String(req.body.location || '').trim() || null).changes;
    }
    return added;
  });
  const added = run();
  auth.audit(auth.currentUser(req).id, 'schedules_generate', { eventId: req.event.id, added });
  req.flash('success', `${added} schedule(s) created from ${rows.length} class(es).`);
  return res.redirect(`/admin/events/${req.event.id}`);
});

/** Add one schedule by hand — a uniform counter, an admissions desk, a single teacher. */
router.post('/events/:id/schedules', loadEvent, (req, res) => {
  const staffId = Number(req.body.staff_id) || null;
  const classId = Number(req.body.class_id) || null;
  const departmentId =
    Number(req.body.department_id) ||
    (staffId ? (auth.findById(staffId) || {}).department_id : null) ||
    null;
  db.prepare(
    `INSERT INTO schedules (event_id, department_id, staff_id, class_id, label, mode, location, meeting_link, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.event.id,
    departmentId,
    staffId,
    classId,
    String(req.body.label || '').trim() || null,
    MODES[req.body.mode] ? req.body.mode : 'in_person',
    String(req.body.location || '').trim() || null,
    String(req.body.meeting_link || '').trim() || null,
    String(req.body.notes || '').trim() || null
  );
  req.flash('success', 'Schedule added.');
  res.redirect(`/admin/events/${req.event.id}`);
});

router.post('/schedules/:id/delete', (req, res) => {
  const schedule = sched.getSchedule(Number(req.params.id));
  if (!schedule) return res.redirect('/admin');
  if (!auth.canAccessCampus(auth.currentUser(req), schedule.campus_id)) return res.status(403).send('Not allowed');
  const booked = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE schedule_id = ? AND status = 'booked'").get(schedule.id).n;
  if (booked > 0) {
    req.flash('error', 'That schedule has live bookings — cancel them first.');
  } else {
    db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule.id);
    req.flash('success', 'Schedule deleted.');
  }
  return res.redirect(`/admin/events/${schedule.event_id}`);
});

/** Roll the same slot pattern across many schedules at once. */
router.post('/events/:id/slots/bulk', loadEvent, (req, res) => {
  const ids = (Array.isArray(req.body.schedule_ids) ? req.body.schedule_ids : [req.body.schedule_ids])
    .map(Number)
    .filter(Boolean);
  const dates = String(req.body.dates || '')
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const breaks = [];
  if (req.body.break_start && req.body.break_end) {
    breaks.push({ start: req.body.break_start, end: req.body.break_end, label: req.body.break_label || 'Break' });
  }
  try {
    if (!ids.length) throw new Error('Select at least one schedule.');
    const rows = sched.buildSlots({
      dates,
      startTime: req.body.start_time,
      endTime: req.body.end_time,
      duration: Number(req.body.duration),
      gap: Number(req.body.gap || 0),
      capacity: Number(req.body.capacity || 1),
      breaks,
    });
    let added = 0;
    for (const id of ids) added += sched.insertSlots(id, rows);
    auth.audit(auth.currentUser(req).id, 'slots_bulk', { eventId: req.event.id, schedules: ids.length, added });
    req.flash('success', `${added} slot(s) added across ${ids.length} schedule(s).`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/admin/events/${req.event.id}`);
});

/* ---------------------------- reports ------------------------------ */

function eventBookings(eventId) {
  return db
    .prepare(
      `SELECT b.*, sl.slot_date, sl.start_time, sl.end_time,
              COALESCE(sc.label, c.name, st.name) AS with_whom,
              st.name AS staff_name, d.name AS department_name, sc.location, sc.mode
       FROM bookings b
       JOIN slots sl ON sl.id = b.slot_id
       JOIN schedules sc ON sc.id = b.schedule_id
       LEFT JOIN classes c ON c.id = sc.class_id
       LEFT JOIN staff st ON st.id = sc.staff_id
       LEFT JOIN departments d ON d.id = sc.department_id
       WHERE b.event_id = ?
       ORDER BY sl.slot_date, sl.start_time, with_whom`
    )
    .all(eventId);
}

router.get('/events/:id/report', loadEvent, (req, res) => {
  const bookings = eventBookings(req.event.id);
  const schedules = sched
    .listSchedules('WHERE s.event_id = ? ORDER BY d.name, st.name, c.name', [req.event.id])
    .map((s) => ({ ...s, stats: sched.scheduleStats(s.id) }));
  res.render('admin/report', {
    title: `${req.event.name} — report`,
    bookings,
    schedules,
    EVENT_TYPES,
  });
});

router.get('/events/:id/export.csv', loadEvent, (req, res) => {
  const csv = toCsv(eventBookings(req.event.id), [
    { label: 'Date', value: (r) => formatDate(r.slot_date) },
    { label: 'Start', value: (r) => formatTime(r.start_time) },
    { label: 'End', value: (r) => formatTime(r.end_time) },
    { label: 'Department', value: 'department_name' },
    { label: 'With', value: 'with_whom' },
    { label: 'Teacher', value: 'staff_name' },
    { label: 'Location', value: 'location' },
    { label: 'Mode', value: (r) => MODES[r.mode] || r.mode },
    { label: 'Student', value: 'student_name' },
    { label: 'Grade', value: 'student_grade' },
    { label: 'Student ID', value: 'student_ref' },
    { label: 'Parent', value: 'parent_name' },
    { label: 'Email', value: 'parent_email' },
    { label: 'Phone', value: 'parent_phone' },
    { label: 'Status', value: 'status' },
    { label: 'Booked at', value: 'created_at' },
    { label: 'Notes', value: 'notes' },
  ]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.event.slug}-bookings.csv"`);
  res.send(csv);
});

router.get('/events/:id/unbooked.csv', loadEvent, (req, res) => {
  const rows = db
    .prepare(
      `SELECT COALESCE(sc.label, c.name, st.name) AS with_whom, d.name AS department_name,
              sl.slot_date, sl.start_time, sl.end_time
       FROM slots sl
       JOIN schedules sc ON sc.id = sl.schedule_id
       LEFT JOIN classes c ON c.id = sc.class_id
       LEFT JOIN staff st ON st.id = sc.staff_id
       LEFT JOIN departments d ON d.id = sc.department_id
       WHERE sc.event_id = ? AND sl.blocked = 0
         AND (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = sl.id AND b.status='booked') < sl.capacity
       ORDER BY d.name, with_whom, sl.slot_date, sl.start_time`
    )
    .all(req.event.id);
  const csv = toCsv(rows, [
    { label: 'Department', value: 'department_name' },
    { label: 'With', value: 'with_whom' },
    { label: 'Date', value: (r) => formatDate(r.slot_date) },
    { label: 'Start', value: (r) => formatTime(r.start_time) },
    { label: 'End', value: (r) => formatTime(r.end_time) },
  ]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.event.slug}-open-slots.csv"`);
  res.send(csv);
});

/* ------------------------- notifications --------------------------- */

router.get('/notifications', (req, res) => {
  const rows = db
    .prepare(
      `SELECT n.*, b.parent_name, b.parent_email, e.name AS event_name
       FROM notifications n
       LEFT JOIN bookings b ON b.id = n.booking_id
       LEFT JOIN events e ON e.id = b.event_id
       ORDER BY n.id DESC LIMIT 300`
    )
    .all();
  res.render('admin/notifications', { title: 'Message log', rows });
});

router.post('/notifications/test-reminders', auth.requireRole('admin'), async (req, res) => {
  const out = await runReminders();
  req.flash('success', `Reminder run finished — ${out.sent} message set(s) processed.`);
  res.redirect('/admin/notifications');
});

router.post('/bookings/:id/resend', (req, res) => {
  const booking = sched.bookingById(Number(req.params.id));
  if (!booking) return res.status(404).send('Not found');
  notifyAsync(booking, 'confirmation');
  req.flash('success', 'Confirmation re-sent.');
  return res.redirect(req.get('referer') || '/admin');
});

module.exports = router;
