'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const sched = require('../lib/scheduling');
const { notifyAsync } = require('../services/notify');
const { toCsv, formatDate, formatTime, MODES, asBool } = require('../lib/helpers');

const router = express.Router();

/* ------------------------------ auth ------------------------------- */

router.get('/login', (req, res) => {
  if (auth.currentUser(req)) return res.redirect('/staff');
  return res.render('staff/login', {
    title: 'Staff sign in',
    email: '',
    error: null,
    ssoEnabled: config.entra.enabled,
  });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const user = auth.findByEmail(email);
  if (!user || !user.active || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).render('staff/login', {
      title: 'Staff sign in',
      email,
      error: 'Wrong email or password.',
      ssoEnabled: config.entra.enabled,
    });
  }
  db.prepare("UPDATE staff SET last_login_at = datetime('now'), last_login_method = 'password' WHERE id = ?").run(user.id);
  req.session.staffId = user.id;
  auth.audit(user.id, 'login', { email: user.email });
  const dest = req.session.returnTo || (auth.ADMIN_ROLES.includes(user.role) ? '/admin' : '/staff');
  delete req.session.returnTo;
  if (user.must_change_pw) return res.redirect('/staff/password');
  return res.redirect(dest);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/staff/login'));
});

router.use(auth.requireLogin);

router.get('/password', (req, res) => {
  res.render('staff/password', { title: 'Change password', error: null });
});

router.post('/password', (req, res) => {
  const user = auth.currentUser(req);
  const { current_password: current, new_password: next, confirm_password: confirm } = req.body;
  const render = (error) => res.status(400).render('staff/password', { title: 'Change password', error });
  // An account that signs in with Microsoft has no password to confirm.
  const needsCurrent = !user.must_change_pw && Boolean(user.password_hash);
  if (needsCurrent && !auth.verifyPassword(current, user.password_hash)) return render('Your current password is not correct.');
  if (!next || String(next).length < 8) return render('Choose a password of at least 8 characters.');
  if (next !== confirm) return render('The two new passwords do not match.');
  db.prepare('UPDATE staff SET password_hash = ?, must_change_pw = 0 WHERE id = ?').run(auth.hashPassword(next), user.id);
  auth.audit(user.id, 'password_change', {});
  req.flash('success', 'Password updated.');
  return res.redirect('/staff');
});

/* ---------------------------- dashboard ---------------------------- */

function mySchedules(user) {
  const where =
    auth.ADMIN_ROLES.includes(user.role) && user.role === 'admin'
      ? 'WHERE 1=1'
      : 'WHERE s.staff_id = ?';
  const params = where === 'WHERE 1=1' ? [] : [user.id];
  return sched
    .listSchedules(`${where} AND e.status != 'archived' ORDER BY e.id DESC, s.id`, params)
    .map((s) => ({ ...s, stats: sched.scheduleStats(s.id) }));
}

router.get('/', (req, res) => {
  const user = auth.currentUser(req);
  const schedules = sched
    .listSchedules("WHERE s.staff_id = ? AND e.status != 'archived' ORDER BY e.id DESC, s.id", [user.id])
    .map((s) => ({ ...s, stats: sched.scheduleStats(s.id) }));
  const upcoming = db
    .prepare(
      `SELECT b.*, sl.slot_date, sl.start_time, sl.end_time, e.name AS event_name,
              COALESCE(sc.label, c.name) AS with_whom
       FROM bookings b
       JOIN slots sl ON sl.id = b.slot_id
       JOIN schedules sc ON sc.id = b.schedule_id
       JOIN events e ON e.id = b.event_id
       LEFT JOIN classes c ON c.id = sc.class_id
       WHERE sc.staff_id = ? AND b.status = 'booked' AND sl.slot_date >= date('now')
       ORDER BY sl.slot_date, sl.start_time LIMIT 20`
    )
    .all(user.id);
  res.render('staff/dashboard', { title: 'My schedules', schedules, upcoming });
});

/* ------------------------ one slot sheet --------------------------- */

function loadSchedule(req, res, next) {
  const user = auth.currentUser(req);
  const schedule = sched.getSchedule(Number(req.params.id));
  if (!schedule) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Schedule not found.' });
  }
  const isOwner = schedule.staff_id === user.id;
  const isAdmin = auth.ADMIN_ROLES.includes(user.role) && auth.canAccessCampus(user, schedule.campus_id);
  if (!isOwner && !isAdmin) {
    return res.status(403).render('error', { title: 'Not allowed', status: 403, message: 'That schedule belongs to another member of staff.' });
  }
  req.schedule = schedule;
  res.locals.schedule = schedule;
  return next();
}

function bookingsForSchedule(scheduleId) {
  return db
    .prepare(
      `SELECT b.*, sl.slot_date, sl.start_time, sl.end_time
       FROM bookings b JOIN slots sl ON sl.id = b.slot_id
       WHERE b.schedule_id = ?
       ORDER BY sl.slot_date, sl.start_time`
    )
    .all(scheduleId);
}

router.get('/schedule/:id', loadSchedule, (req, res) => {
  const slots = sched.slotsForSchedule(req.schedule.id, { includeBlocked: true });
  const bookings = bookingsForSchedule(req.schedule.id);
  const bySlot = {};
  for (const b of bookings) (bySlot[b.slot_id] = bySlot[b.slot_id] || []).push(b);
  res.render('staff/schedule', {
    title: req.schedule.display_name,
    slots,
    bySlot,
    stats: sched.scheduleStats(req.schedule.id),
    modes: MODES,
  });
});

router.post('/schedule/:id/settings', loadSchedule, (req, res) => {
  db.prepare('UPDATE schedules SET mode = ?, location = ?, meeting_link = ?, notes = ?, label = ? WHERE id = ?').run(
    MODES[req.body.mode] ? req.body.mode : 'in_person',
    String(req.body.location || '').trim() || null,
    String(req.body.meeting_link || '').trim() || null,
    String(req.body.notes || '').trim() || null,
    String(req.body.label || '').trim() || null,
    req.schedule.id
  );
  auth.audit(auth.currentUser(req).id, 'schedule_settings', { scheduleId: req.schedule.id });
  req.flash('success', 'Schedule details saved.');
  res.redirect(`/staff/schedule/${req.schedule.id}`);
});

router.post('/schedule/:id/lock', loadSchedule, (req, res) => {
  const locked = asBool(req.body.locked) ? 1 : 0;
  db.prepare('UPDATE schedules SET locked = ? WHERE id = ?').run(locked, req.schedule.id);
  auth.audit(auth.currentUser(req).id, locked ? 'schedule_lock' : 'schedule_unlock', { scheduleId: req.schedule.id });
  req.flash('success', locked ? 'Schedule locked — parents can no longer sign up.' : 'Schedule unlocked.');
  res.redirect(`/staff/schedule/${req.schedule.id}`);
});

router.post('/schedule/:id/slots', loadSchedule, (req, res) => {
  const dates = (Array.isArray(req.body.dates) ? req.body.dates : String(req.body.dates || '').split(/[\s,]+/))
    .map((d) => String(d).trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const breaks = [];
  if (req.body.break_start && req.body.break_end) {
    breaks.push({ start: req.body.break_start, end: req.body.break_end, label: req.body.break_label || 'Break' });
  }
  try {
    const rows = sched.buildSlots({
      dates,
      startTime: req.body.start_time,
      endTime: req.body.end_time,
      duration: Number(req.body.duration),
      gap: Number(req.body.gap || 0),
      capacity: Number(req.body.capacity || 1),
      breaks,
    });
    const added = sched.insertSlots(req.schedule.id, rows);
    auth.audit(auth.currentUser(req).id, 'slots_generate', { scheduleId: req.schedule.id, added });
    req.flash('success', `${added} slot(s) added${rows.length - added > 0 ? `, ${rows.length - added} already existed` : ''}.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/staff/schedule/${req.schedule.id}`);
});

router.post('/slot/:slotId/:action', (req, res) => {
  const user = auth.currentUser(req);
  const slot = db
    .prepare('SELECT sl.*, sc.staff_id, sc.id AS schedule_id, e.campus_id FROM slots sl JOIN schedules sc ON sc.id = sl.schedule_id JOIN events e ON e.id = sc.event_id WHERE sl.id = ?')
    .get(Number(req.params.slotId));
  if (!slot) return res.status(404).send('Slot not found');
  const allowed = slot.staff_id === user.id || (auth.ADMIN_ROLES.includes(user.role) && auth.canAccessCampus(user, slot.campus_id));
  if (!allowed) return res.status(403).send('Not allowed');

  const booked = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ? AND status = 'booked'").get(slot.id).n;
  const action = req.params.action;

  if (action === 'block') {
    if (booked > 0) req.flash('error', 'That slot already has a booking — cancel it first.');
    else db.prepare('UPDATE slots SET blocked = 1 WHERE id = ?').run(slot.id);
  } else if (action === 'unblock') {
    db.prepare('UPDATE slots SET blocked = 0 WHERE id = ?').run(slot.id);
  } else if (action === 'delete') {
    if (booked > 0) req.flash('error', 'That slot already has a booking — cancel it first.');
    else db.prepare('DELETE FROM slots WHERE id = ?').run(slot.id);
  } else if (action === 'capacity') {
    const cap = Math.max(1, Number(req.body.capacity || 1));
    db.prepare('UPDATE slots SET capacity = ? WHERE id = ?').run(cap, slot.id);
  }
  res.redirect(`/staff/schedule/${slot.schedule_id}`);
});

router.post('/schedule/:id/clear', loadSchedule, (req, res) => {
  const removed = db
    .prepare(
      `DELETE FROM slots WHERE schedule_id = ?
       AND id NOT IN (SELECT slot_id FROM bookings WHERE status = 'booked')`
    )
    .run(req.schedule.id).changes;
  auth.audit(auth.currentUser(req).id, 'slots_clear', { scheduleId: req.schedule.id, removed });
  req.flash('success', `${removed} empty slot(s) removed.`);
  res.redirect(`/staff/schedule/${req.schedule.id}`);
});

/* --------------------------- bookings ------------------------------ */

router.post('/booking/:id/:action', (req, res) => {
  const user = auth.currentUser(req);
  const booking = sched.bookingById(Number(req.params.id));
  if (!booking) return res.status(404).send('Booking not found');
  const schedule = sched.getSchedule(booking.schedule_id);
  const allowed = schedule.staff_id === user.id || (auth.ADMIN_ROLES.includes(user.role) && auth.canAccessCampus(user, schedule.campus_id));
  if (!allowed) return res.status(403).send('Not allowed');

  const action = req.params.action;
  if (action === 'cancel') {
    sched.cancelBooking(booking.id, auth.ADMIN_ROLES.includes(user.role) ? 'admin' : 'staff');
    const updated = sched.bookingById(booking.id);
    notifyAsync(updated, 'cancellation');
    auth.audit(user.id, 'booking_cancel', { bookingId: booking.id });
    req.flash('success', 'Booking cancelled and the parent has been notified.');
  } else if (['attended', 'no_show', 'booked'].includes(action)) {
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(action, booking.id);
  }
  const back = req.get('referer') || `/staff/schedule/${booking.schedule_id}`;
  res.redirect(back);
});

/* ------------------------ print & export --------------------------- */

router.get('/schedule/:id/print', loadSchedule, (req, res) => {
  const slots = sched.slotsForSchedule(req.schedule.id, { includeBlocked: true });
  const bookings = bookingsForSchedule(req.schedule.id);
  const bySlot = {};
  for (const b of bookings) if (b.status === 'booked') (bySlot[b.slot_id] = bySlot[b.slot_id] || []).push(b);
  res.render('staff/print', {
    title: `${req.schedule.display_name} — appointment sheet`,
    slots,
    bySlot,
    layout: false,
  });
});

router.get('/schedule/:id/export.csv', loadSchedule, (req, res) => {
  const rows = bookingsForSchedule(req.schedule.id).filter((b) => b.status !== 'cancelled');
  const csv = toCsv(rows, [
    { label: 'Date', value: (r) => formatDate(r.slot_date) },
    { label: 'Start', value: (r) => formatTime(r.start_time) },
    { label: 'End', value: (r) => formatTime(r.end_time) },
    { label: 'Student', value: 'student_name' },
    { label: 'Grade', value: 'student_grade' },
    { label: 'Student ID', value: 'student_ref' },
    { label: 'Parent', value: 'parent_name' },
    { label: 'Email', value: 'parent_email' },
    { label: 'Phone', value: 'parent_phone' },
    { label: 'Status', value: 'status' },
    { label: 'Notes', value: 'notes' },
  ]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.schedule.display_name.replace(/[^\w-]+/g, '_')}.csv"`);
  res.send(csv);
});

void mySchedules;

module.exports = router;
