'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const sched = require('../lib/scheduling');
const { notifyAsync, notifyBookingGroupAsync, notifyStaff } = require('../services/notify');
const h = require('../lib/helpers');
const {
  isEmail,
  nowLocal,
  formatDate,
  formatTime,
  EVENT_TYPES,
  MODES,
  toCsv,
} = h;

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

/*
 * The basket is one family's picks for one event. `slotIds` is what is held;
 * `children` is every child the parent has named so far; `forChild` says
 * which of them each slot is for; `current` is the child new picks go to.
 * Events that do not collect a student never touch the last three.
 */
function basket(req, eventId) {
  const b = req.session.basket;
  if (!b || b.eventId !== eventId) {
    req.session.basket = { eventId, slotIds: [], children: [], forChild: {}, current: null };
  } else {
    // A session that began before children were part of the basket.
    if (!b.children) b.children = [];
    if (!b.forChild) b.forChild = {};
    if (b.current === undefined) b.current = null;
  }
  return req.session.basket;
}

function childOf(b, slotId) {
  const idx = b.forChild[String(slotId)];
  return Number.isInteger(idx) && b.children[idx] ? b.children[idx] : null;
}

/** What the booking rules and the insert want: a slot and who it is for. */
function basketItems(b) {
  return b.slotIds.map((slotId) => {
    const child = childOf(b, slotId) || {};
    return { slotId, student: { name: child.name, grade: child.grade, ref: child.ref } };
  });
}

/** Name, grade and ID as typed, trimmed; null when there is no name. */
function readChild(body) {
  const name = String(body.student_name || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  return {
    name,
    grade: String(body.student_grade || '').trim() || '',
    ref: String(body.student_ref || '').trim() || '',
  };
}

/** Add a child to the basket, or return the index of one already named the same. */
function rememberChild(b, child) {
  const key = child.name.toLowerCase();
  const found = b.children.findIndex((c) => c.name.toLowerCase() === key);
  if (found !== -1) {
    if (child.grade && !b.children[found].grade) b.children[found].grade = child.grade;
    if (child.ref && !b.children[found].ref) b.children[found].ref = child.ref;
    return found;
  }
  b.children.push(child);
  return b.children.length - 1;
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

/** basketDetail plus the child each slot is for. */
function basketDetailFor(b) {
  return basketDetail(b.slotIds).map((r) => ({ ...r, child: childOf(b, r.id) }));
}

/** The basket entry that overlaps `slotId`, or null if the time is free. */
function findClash(basketSlotIds, slotId) {
  if (!basketSlotIds.length) return null;
  const incoming = basketDetail([slotId])[0];
  if (!incoming) return null;
  const existing = basketDetail(basketSlotIds).find((e) => e.id !== slotId && sched.overlaps(e, incoming));
  return existing ? { existing, incoming } : null;
}

/** Ids among `slots` that collide with something the parent already holds. */
function clashingSlotIds(basketSlotIds, slots) {
  const out = new Set();
  if (!basketSlotIds.length) return out;
  const held = basketDetail(basketSlotIds);
  for (const s of slots) {
    if (basketSlotIds.includes(s.id)) continue;
    const hit = held.find((h) => sched.overlaps(h, s));
    if (hit) out.add(s.id);
  }
  return out;
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
      t = {
        staff_id: s.staff_id,
        name: s.staff_name || s.label,
        name_ar: s.staff_name_ar,
        title: s.staff_title,
        schedules: [],
      };
      teachers.push(t);
    }
    t.schedules.push(s);
  }

  // Everything a parent might type to find their teacher: either spelling of the
  // name, the job title, and the class names — a parent often knows "Grade 5A"
  // and not who teaches it.
  for (const t of teachers) {
    t.search = h.searchKey(
      [t.name, t.name_ar, t.title, ...t.schedules.map((s) => s.display_name), ...t.schedules.map((s) => s.class_name)]
        .filter(Boolean)
        .join(' ')
    );
  }

  const q = String(req.query.q || '').trim();
  const needle = h.searchKey(q);
  const shown = needle ? teachers.filter((t) => t.search.includes(needle)) : teachers;

  res.render('public/event-teachers', {
    title: `${department ? department.name : 'Staff'} — ${event.name}`,
    department,
    teachers: shown,
    totalTeachers: teachers.length,
    q,
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
  const clashes = req.event.prevent_overlap ? clashingSlotIds(b.slotIds, slots) : new Set();
  return res.render('public/slots', {
    title: `${schedule.display_name} — ${req.event.name}`,
    schedule,
    byDate,
    selected: b.slotIds,
    clashes,
    held: basketDetailFor(b),
    children: b.children,
    currentChild: Number.isInteger(b.current) ? b.children[b.current] : null,
    modes: MODES,
  });
});

/** Side-by-side view of several teachers, the way MyConferenceTime lets you line up a family's evening. */
router.get('/e/:slug/compare', loadEvent, requireOpenEvent, (req, res) => {
  if (!req.event.allow_compare) return res.redirect(`/e/${req.event.slug}`);

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
  const allSlots = schedules.flatMap((s) => s.slots);
  return res.render('public/compare', {
    title: `Compare schedules — ${req.event.name}`,
    schedules,
    dates,
    activeDate,
    times,
    selected: b.slotIds,
    clashes: req.event.prevent_overlap ? clashingSlotIds(b.slotIds, allSlots) : new Set(),
  });
});

/**
 * Put a slot in the basket for the current child, refusing a clash on the
 * spot rather than letting the parent fill in the whole form and be refused
 * at the end. Returns true when it went in.
 */
function addToBasket(req, b, slotId) {
  if (b.slotIds.includes(slotId)) return true;
  const clash = req.event.prevent_overlap ? findClash(b.slotIds, slotId) : null;
  if (clash) {
    const held = childOf(b, clash.existing.id);
    const whose = held ? ` for ${held.name}` : '';
    req.flash(
      'error',
      `You have already chosen ${formatTime(clash.existing.start_time)} on ${formatDate(clash.existing.slot_date)} ` +
        `with ${clash.existing.display_name}${whose}. You cannot be in two places at once - remove that one first, or pick another time.`
    );
    return false;
  }
  b.slotIds.push(slotId);
  if (req.event.collect_student && Number.isInteger(b.current)) b.forChild[String(slotId)] = b.current;
  return true;
}

/** Where to send the parent after an add: back where they were, or the slot's own page. */
function afterSelect(req, slotId) {
  if (req.body.redirect === 'basket') return `/e/${req.event.slug}/review`;
  const referer = req.get('referer');
  if (referer) {
    // Keep it as a path on this site, so it can be carried through the
    // "which child?" page and still pass that page's same-site check.
    try {
      const u = new URL(referer, config.baseUrl);
      return `${u.pathname}${u.search}`;
    } catch (_) {
      /* fall through */
    }
  }
  const row = slotId ? db.prepare('SELECT schedule_id FROM slots WHERE id = ?').get(slotId) : null;
  return row ? `/e/${req.event.slug}/s/${row.schedule_id}` : `/e/${req.event.slug}`;
}

router.post('/e/:slug/select', loadEvent, requireOpenEvent, (req, res) => {
  const b = basket(req, req.event.id);
  const slotId = Number(req.body.slot_id);
  const action = req.body.action === 'remove' ? 'remove' : 'add';

  if (slotId && action === 'remove') {
    b.slotIds = b.slotIds.filter((id) => id !== slotId);
    delete b.forChild[String(slotId)];
  } else if (slotId) {
    // The first pick in a conference needs to know which child it is for.
    if (req.event.collect_student && !Number.isInteger(b.current)) {
      const back = afterSelect(req, slotId);
      return res.redirect(
        `/e/${req.event.slug}/child?slot_id=${slotId}&back=${encodeURIComponent(back)}`
      );
    }
    addToBasket(req, b, slotId);
  }

  return res.redirect(afterSelect(req, slotId));
});

/* ----------------------------- children ---------------------------- *
 * Which child is an appointment for? Asked once, the first time a parent
 * picks a slot; after that the picker shows who times are being chosen for
 * and offers to switch. A parent with three children names each once.
 * ------------------------------------------------------------------- */

router.get('/e/:slug/child', loadEvent, requireOpenEvent, (req, res) => {
  const b = basket(req, req.event.id);
  const pendingSlot = Number(req.query.slot_id) || null;
  const pending = pendingSlot ? basketDetail([pendingSlot])[0] : null;
  res.render('public/child', {
    title: `Who is this for? - ${req.event.name}`,
    children: b.children,
    current: b.current,
    pending,
    back: String(req.query.back || `/e/${req.event.slug}`),
    form: {},
    error: null,
  });
});

router.post('/e/:slug/child', loadEvent, requireOpenEvent, (req, res) => {
  const b = basket(req, req.event.id);
  const pendingSlot = Number(req.body.slot_id) || null;
  const back = String(req.body.back || `/e/${req.event.slug}`);

  let idx = null;
  if (req.body.child !== undefined && req.body.child !== '' && req.body.child !== 'new') {
    idx = Number(req.body.child);
    if (!b.children[idx]) idx = null;
  }
  if (idx === null) {
    const child = readChild(req.body);
    if (!child) {
      const pending = pendingSlot ? basketDetail([pendingSlot])[0] : null;
      return res.status(400).render('public/child', {
        title: `Who is this for? - ${req.event.name}`,
        children: b.children,
        current: b.current,
        pending,
        back,
        form: req.body,
        error: "Please enter the child's name.",
      });
    }
    idx = rememberChild(b, child);
  }
  b.current = idx;

  // Anything held with no child yet - a basket from before this question was
  // asked - belongs to the child just named. That is what the parent means.
  for (const slotId of b.slotIds) {
    if (!Number.isInteger(b.forChild[String(slotId)])) b.forChild[String(slotId)] = idx;
  }

  if (pendingSlot) {
    // Finish the add that brought them here.
    req.body.redirect = '';
    addToBasket(req, b, pendingSlot);
  }
  // Only ever go back to a page on this site.
  const safeBack = /^\/(?!\/)/.test(back) ? back : `/e/${req.event.slug}`;
  return res.redirect(safeBack);
});

/** Change which child a held slot is for - from the review page. */
router.post('/e/:slug/assign', loadEvent, requireOpenEvent, (req, res) => {
  const b = basket(req, req.event.id);
  const slotId = Number(req.body.slot_id);
  const idx = Number(req.body.child);
  if (b.slotIds.includes(slotId) && b.children[idx]) {
    b.forChild[String(slotId)] = idx;
    b.current = idx;
  }
  return res.redirect(`/e/${req.event.slug}/review`);
});

function renderReview(req, res, { errors = [], form = null, status = 200 } = {}) {
  const b = basket(req, req.event.id);
  return res.status(status).render('public/review', {
    title: `Your selections — ${req.event.name}`,
    items: basketDetailFor(b),
    children: b.children,
    form: form || req.session.parentDetails || {},
    errors,
  });
}

router.get('/e/:slug/review', loadEvent, requireOpenEvent, (req, res) => renderReview(req, res));

router.post('/e/:slug/confirm', loadEvent, requireOpenEvent, async (req, res, next) => {
  try {
    const { event } = req;
    const b = basket(req, event.id);
    const details = {
      parentName: String(req.body.parent_name || '').trim(),
      parentEmail: String(req.body.parent_email || '').trim().toLowerCase(),
      parentPhone: String(req.body.parent_phone || '').trim(),
      notes: String(req.body.notes || '').trim().slice(0, 1000),
      language: 'en',
    };
    req.session.parentDetails = details;

    // Each appointment carries the child it is for; the parent's details are
    // entered once for the lot.
    const items = basketItems(b);

    const errors = [];
    if (!b.slotIds.length) errors.push('You have not selected any time slots yet.');
    if (!details.parentName) errors.push('Please enter your name.');
    if (!isEmail(details.parentEmail)) errors.push('Please enter a valid email address.');
    if (event.require_phone && !details.parentPhone) errors.push('Please enter a mobile number — confirmations are sent on WhatsApp.');
    if (event.collect_student && items.some((it) => !it.student.name)) {
      errors.push('One of your appointments is not assigned to a child yet - use "for" next to it above.');
    }
    if (req.body.website) errors.push('Submission rejected.'); // honeypot

    if (!errors.length) {
      const check = sched.validateBasket(event, items, details);
      errors.push(...check.errors);
    }

    if (errors.length) return renderReview(req, res, { errors, form: details, status: 400 });

    let result;
    try {
      result = sched.createBookings(event, items, details);
    } catch (err) {
      return renderReview(req, res, { errors: [err.message], form: details, status: 409 });
    }

    req.session.basket = { eventId: event.id, slotIds: [], children: b.children, forChild: {}, current: b.current };

    // One WhatsApp covering the whole submission, one email per appointment.
    const created = result.ids.map((id) => sched.bookingById(id)).filter(Boolean);
    notifyBookingGroupAsync(created);
    for (const booking of created) notifyStaff(booking).catch(() => {});

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
