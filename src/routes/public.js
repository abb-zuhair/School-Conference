'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const sched = require('../lib/scheduling');
const { notifyAsync, notifyStaff } = require('../services/notify');
const {
  isEmail,
  nowLocal,
  formatDate,
  formatTime,
  EVENT_TYPES,
  MODES,
  toCsv,
} = require('../lib/helpers');

const router = express.Router();

/* ----------------------------- helpers ----------------------------- */

function openEventsForCampus(campusId) {
  const rows = db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM schedules s WHERE s.event_id = e.id AND s.published = 1) AS schedule_count
       FROM events e
       WHERE e.campus_id = ? AND e.status IN ('published','closed')
       ORDER BY e.opens_at IS NULL, e.opens_at, e.id DESC`
    )
    .all(campusId);
  return rows.map((e) => ({ ...e, window: sched.eventWindow(e), meta: EVENT_TYPES[e.type] || EVENT_TYPES.other }));
}

function loadEvent(req, res, next) {
  const event = db.prepare('SELECT * FROM events WHERE slug = ?').get(req.params.slug);
  if (!event) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'That booking page does not exist.' });
  }
  const campus = db.prepare('SELECT * FROM campuses WHERE id = ?').get(event.campus_id);
  req.event = event;
  req.campus = campus;
  res.locals.event = event;
  res.locals.campus = campus;
  res.locals.eventMeta = EVENT_TYPES[event.type] || EVENT_TYPES.other;
  res.locals.window = sched.eventWindow(event);
  return next();
}

function requireOpenEvent(req, res, next) {
  const w = sched.eventWindow(req.event);
  if (!w.isOpen) {
    return res.status(403).render('public/closed', { title: req.event.name, window: w });
  }
  return next();
}

function basket(req, eventId) {
  if (!req.session.basket || req.session.basket.eventId !== eventId) {
    req.session.basket = { eventId, slotIds: [] };
  }
  return req.session.basket;
}

function basketDetail(slotIds) {
  if (!slotIds.length) return [];
  const placeholders = slotIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT sl.id, sl.slot_date, sl.start_time, sl.end_time,
              sc.id AS schedule_id, sc.label, sc.mode, sc.location, sc.meeting_link,
              c.name AS class_name, c.room, st.name AS staff_name, d.name AS department_name
       FROM slots sl
       JOIN schedules sc ON sc.id = sl.schedule_id
       LEFT JOIN classes c ON c.id = sc.class_id
       LEFT JOIN staff st ON st.id = sc.staff_id
       LEFT JOIN departments d ON d.id = sc.department_id
       WHERE sl.id IN (${placeholders})
       ORDER BY sl.slot_date, sl.start_time`
    )
    .all(...slotIds);
  return rows.map((r) => ({ ...r, display_name: r.label || r.class_name || r.staff_name || 'Appointment' }));
}

/* ------------------------------ home ------------------------------- */

router.get('/', (req, res) => {
  const campuses = db.prepare('SELECT * FROM campuses WHERE active = 1 ORDER BY sort_order, name').all();
  const withEvents = campuses.map((c) => ({ ...c, events: openEventsForCampus(c.id) }));
  res.render('public/home', { title: `${config.schoolName} — Appointments`, campuses: withEvents });
});

router.get('/c/:slug', (req, res) => {
  const campus = db.prepare('SELECT * FROM campuses WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!campus) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'That campus does not exist.' });
  }
  return res.render('public/campus', {
    title: `${campus.name} — Appointments`,
    campus,
    events: openEventsForCampus(campus.id),
  });
});

/* ------------------------- event → browse -------------------------- */

router.get('/e/:slug', loadEvent, (req, res) => {
  const { event } = req;
  const w = sched.eventWindow(event);
  if (!w.isOpen && w.state !== 'closed') {
    return res.status(403).render('public/closed', { title: event.name, window: w });
  }

  if (event.type === 'conference') {
    const departments = db
      .prepare(
        `SELECT d.id, d.name, d.name_ar, COUNT(DISTINCT s.id) AS schedule_count,
                COUNT(DISTINCT s.staff_id) AS teacher_count
         FROM schedules s
         LEFT JOIN departments d ON d.id = s.department_id
         WHERE s.event_id = ? AND s.published = 1
         GROUP BY d.id
         ORDER BY d.sort_order, d.name`
      )
      .all(event.id);
    return res.render('public/event-departments', {
      title: event.name,
      departments,
      basketCount: (req.session.basket && req.session.basket.eventId === event.id ? req.session.basket.slotIds.length : 0),
      window: w,
    });
  }

  // Service-desk style events: go straight to the list of counters/desks
  const schedules = sched
    .listSchedules('WHERE s.event_id = ? AND s.published = 1 ORDER BY COALESCE(s.label, st.name)', [event.id])
    .map((s) => ({ ...s, stats: sched.scheduleStats(s.id) }));
  return res.render('public/event-desks', {
    title: event.name,
    schedules,
    basketCount: (req.session.basket && req.session.basket.eventId === event.id ? req.session.basket.slotIds.length : 0),
    window: w,
  });
});

router.get('/e/:slug/d/:deptId', loadEvent, (req, res) => {
  const { event } = req;
  const deptId = req.params.deptId === 'none' ? null : Number(req.params.deptId);
  const department = deptId ? db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId) : null;
  const where = deptId
    ? 'WHERE s.event_id = ? AND s.published = 1 AND s.department_id = ? ORDER BY st.name, c.name'
    : 'WHERE s.event_id = ? AND s.published = 1 AND s.department_id IS NULL ORDER BY st.name, c.name';
  const params = deptId ? [event.id, deptId] : [event.id];
  const schedules = sched.listSchedules(where, params).map((s) => ({ ...s, stats: sched.scheduleStats(s.id) }));

  // group by teacher so a teacher with several classes shows once
  const teachers = [];
  for (const s of schedules) {
    let t = teachers.find((x) => x.staff_id === s.staff_id && s.staff_id !== null);
    if (!t) {
      t = { staff_id: s.staff_id, name: s.staff_name || s.label, title: s.staff_title, schedules: [] };
      teachers.push(t);
    }
    t.schedules.push(s);
  }

  res.render('public/event-teachers', {
    title: `${department ? department.name : 'Staff'} — ${event.name}`,
    department,
    teachers,
    basketCount: (req.session.basket && req.session.basket.eventId === event.id ? req.session.basket.slotIds.length : 0),
    window: sched.eventWindow(event),
  });
});

/* ------------------------- slot selection -------------------------- */

router.get('/e/:slug/s/:scheduleId', loadEvent, requireOpenEvent, (req, res) => {
  const schedule = sched.getSchedule(Number(req.params.scheduleId));
  if (!schedule || schedule.event_id !== req.event.id) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'That schedule does not exist.' });
  }
  const slots = sched.slotsForSchedule(schedule.id);
  const byDate = {};
  for (const s of slots) {
    if (s.is_past) continue;
    (byDate[s.slot_date] = byDate[s.slot_date] || []).push(s);
  }
  const b = basket(req, req.event.id);
  return res.render('public/slots', {
    title: `${schedule.display_name} — ${req.event.name}`,
    schedule,
    byDate,
    selected: b.slotIds,
    modes: MODES,
  });
});

/** Side-by-side view of several teachers, the way MyConferenceTime lets you line up a family's evening. */
router.get('/e/:slug/compare', loadEvent, requireOpenEvent, (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(Number)
    .filter(Boolean)
    .slice(0, 6);
  if (!ids.length) return res.redirect(`/e/${req.event.slug}`);

  const schedules = ids
    .map((id) => sched.getSchedule(id))
    .filter((s) => s && s.event_id === req.event.id)
    .map((s) => ({ ...s, slots: sched.slotsForSchedule(s.id).filter((x) => !x.is_past) }));

  const dates = [...new Set(schedules.flatMap((s) => s.slots.map((x) => x.slot_date)))].sort();
  const activeDate = dates.includes(req.query.date) ? req.query.date : dates[0];
  const times = [
    ...new Set(
      schedules.flatMap((s) => s.slots.filter((x) => x.slot_date === activeDate).map((x) => x.start_time))
    ),
  ].sort();

  const b = basket(req, req.event.id);
  return res.render('public/compare', {
    title: `Compare schedules — ${req.event.name}`,
    schedules,
    dates,
    activeDate,
    times,
    selected: b.slotIds,
  });
});

router.post('/e/:slug/select', loadEvent, requireOpenEvent, (req, res) => {
  const b = basket(req, req.event.id);
  const slotId = Number(req.body.slot_id);
  const action = req.body.action === 'remove' ? 'remove' : 'add';

  if (slotId) {
    if (action === 'remove') {
      b.slotIds = b.slotIds.filter((id) => id !== slotId);
    } else if (!b.slotIds.includes(slotId)) {
      b.slotIds.push(slotId);
    }
  }

  if (req.body.redirect === 'basket') return res.redirect(`/e/${req.event.slug}/review`);
  const back = req.get('referer') || `/e/${req.event.slug}`;
  return res.redirect(back);
});

router.get('/e/:slug/review', loadEvent, requireOpenEvent, (req, res) => {
  const b = basket(req, req.event.id);
  res.render('public/review', {
    title: `Your selections — ${req.event.name}`,
    items: basketDetail(b.slotIds),
    form: req.session.parentDetails || {},
    errors: [],
  });
});

router.post('/e/:slug/confirm', loadEvent, requireOpenEvent, async (req, res, next) => {
  try {
    const { event } = req;
    const b = basket(req, event.id);
    const details = {
      parentName: String(req.body.parent_name || '').trim(),
      parentEmail: String(req.body.parent_email || '').trim().toLowerCase(),
      parentPhone: String(req.body.parent_phone || '').trim(),
      studentName: String(req.body.student_name || '').trim(),
      studentGrade: String(req.body.student_grade || '').trim(),
      studentRef: String(req.body.student_ref || '').trim(),
      notes: String(req.body.notes || '').trim().slice(0, 1000),
      language: 'en',
    };
    req.session.parentDetails = details;

    const errors = [];
    if (!b.slotIds.length) errors.push('You have not selected any time slots yet.');
    if (!details.parentName) errors.push('Please enter your name.');
    if (!isEmail(details.parentEmail)) errors.push('Please enter a valid email address.');
    if (event.require_phone && !details.parentPhone) errors.push('Please enter a mobile number — confirmations are sent on WhatsApp.');
    if (event.collect_student && !details.studentName) errors.push("Please enter the student's name.");
    if (req.body.website) errors.push('Submission rejected.'); // honeypot

    if (!errors.length) {
      const check = sched.validateBasket(event, b.slotIds, details);
      errors.push(...check.errors);
    }

    if (errors.length) {
      return res.status(400).render('public/review', {
        title: `Your selections — ${event.name}`,
        items: basketDetail(b.slotIds),
        form: details,
        errors,
      });
    }

    let result;
    try {
      result = sched.createBookings(event, b.slotIds, details);
    } catch (err) {
      return res.status(409).render('public/review', {
        title: `Your selections — ${event.name}`,
        items: basketDetail(b.slotIds),
        form: details,
        errors: [err.message],
      });
    }

    req.session.basket = { eventId: event.id, slotIds: [] };

    for (const id of result.ids) {
      const booking = sched.bookingById(id);
      notifyAsync(booking, 'confirmation');
      notifyStaff(booking).catch(() => {});
    }

    return res.redirect(`/confirmation/${result.groupToken}`);
  } catch (err) {
    return next(err);
  }
});

/* ------------------------- confirmation ---------------------------- */

router.get('/confirmation/:groupToken', (req, res) => {
  const bookings = sched.bookingsByGroup(req.params.groupToken);
  if (!bookings.length) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'We could not find that confirmation.' });
  }
  return res.render('public/confirmation', {
    title: 'Appointment confirmed',
    bookings,
    modes: MODES,
  });
});

/* --------------------- manage a single booking --------------------- */

router.get('/booking/:token', (req, res) => {
  const booking = sched.bookingByToken(req.params.token);
  if (!booking) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'We could not find that appointment.' });
  }
  return res.render('public/booking', {
    title: 'Your appointment',
    booking,
    cancellable: sched.canParentCancel(booking),
    modes: MODES,
  });
});

router.post('/booking/:token/cancel', (req, res) => {
  const booking = sched.bookingByToken(req.params.token);
  if (!booking) {
    return res.status(404).render('error', { title: 'Not found', status: 404, message: 'We could not find that appointment.' });
  }
  const check = sched.canParentCancel(booking);
  if (!check.ok) {
    req.flash('error', check.reason);
    return res.redirect(`/booking/${booking.token}`);
  }
  sched.cancelBooking(booking.id, 'parent');
  const updated = sched.bookingByToken(booking.token);
  notifyAsync(updated, 'cancellation');
  req.flash('success', 'Your appointment has been cancelled.');
  return res.redirect(`/booking/${booking.token}`);
});

/* --------------------------- lookup -------------------------------- */

router.get('/lookup', (req, res) => {
  res.render('public/lookup', { title: 'Find my appointments', results: null, email: '' });
});

router.post('/lookup', (req, res) => {
  const email = String(req.body.parent_email || '').trim().toLowerCase();
  if (!isEmail(email)) {
    return res.status(400).render('public/lookup', {
      title: 'Find my appointments',
      results: null,
      email,
      error: 'Please enter a valid email address.',
    });
  }
  const results = db
    .prepare(
      `SELECT b.token, b.student_name, b.status, sl.slot_date, sl.start_time, sl.end_time,
              e.name AS event_name, cp.name AS campus_name,
              COALESCE(sc.label, c.name, st.name) AS with_whom
       FROM bookings b
       JOIN slots sl ON sl.id = b.slot_id
       JOIN schedules sc ON sc.id = b.schedule_id
       JOIN events e ON e.id = b.event_id
       LEFT JOIN classes c ON c.id = sc.class_id
       LEFT JOIN staff st ON st.id = sc.staff_id
       LEFT JOIN campuses cp ON cp.id = e.campus_id
       WHERE lower(b.parent_email) = ?
       ORDER BY sl.slot_date DESC, sl.start_time DESC
       LIMIT 100`
    )
    .all(email);
  return res.render('public/lookup', { title: 'Find my appointments', results, email });
});

/* ------------------ printable public day sheet --------------------- */

router.get('/booking/:token/calendar.ics', (req, res) => {
  const booking = sched.bookingByToken(req.params.token);
  if (!booking) return res.status(404).send('Not found');
  const start = `${booking.slot_date.replace(/-/g, '')}T${booking.start_time.replace(':', '')}00`;
  const end = `${booking.slot_date.replace(/-/g, '')}T${booking.end_time.replace(':', '')}00`;
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ACA Appointments//EN',
    'BEGIN:VEVENT',
    `UID:${booking.token}@aca`,
    `DTSTAMP:${nowLocal().toFormat("yyyyLLdd'T'HHmmss")}`,
    `DTSTART;TZID=${config.timezone}:${start}`,
    `DTEND;TZID=${config.timezone}:${end}`,
    `SUMMARY:${booking.event_name} — ${booking.staff_name || booking.label || ''}`,
    `LOCATION:${(booking.location || booking.room || booking.campus_name || '').replace(/,/g, '\\,')}`,
    `DESCRIPTION:${formatDate(booking.slot_date)} ${formatTime(booking.start_time)} — manage at ${config.baseUrl}/booking/${booking.token}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="appointment-${booking.slot_date}.ics"`);
  res.send(ics);
});

void toCsv;

module.exports = router;
