'use strict';
const { db } = require('../db');
const {
  token,
  localDT,
  parseStamp,
  nowLocal,
  timeToMinutes,
  minutesToTime,
} = require('./helpers');

/* ------------------------------------------------------------------ *
 * Slot generation
 * ------------------------------------------------------------------ */

/**
 * Build slot rows for one schedule.
 * @param {object} opts
 * @param {string[]} opts.dates        ['2026-10-05', ...]
 * @param {string} opts.startTime      '15:00'
 * @param {string} opts.endTime        '18:00'
 * @param {number} opts.duration       minutes per appointment
 * @param {number} opts.gap            minutes between appointments
 * @param {number} opts.capacity       parents per slot (1 for conferences, >1 for a counter)
 * @param {Array<{start:string,end:string,label?:string}>} opts.breaks
 */
function buildSlots(opts) {
  const {
    dates = [],
    startTime = '15:00',
    endTime = '18:00',
    duration = 10,
    gap = 0,
    capacity = 1,
    breaks = [],
  } = opts;

  if (!dates.length) throw new Error('Pick at least one date.');
  if (!(duration > 0)) throw new Error('Appointment length must be greater than zero.');

  const dayStart = timeToMinutes(startTime);
  const dayEnd = timeToMinutes(endTime);
  if (!(dayEnd > dayStart)) throw new Error('End time must be after start time.');

  const breakRanges = breaks
    .filter((b) => b && b.start && b.end)
    .map((b) => ({ start: timeToMinutes(b.start), end: timeToMinutes(b.end), label: b.label || 'Break' }))
    .filter((b) => b.end > b.start);

  const rows = [];
  for (const date of dates) {
    for (let cursor = dayStart; cursor + duration <= dayEnd; cursor += duration + gap) {
      const slotStart = cursor;
      const slotEnd = cursor + duration;
      const clash = breakRanges.find((b) => slotStart < b.end && slotEnd > b.start);
      rows.push({
        slot_date: date,
        start_time: minutesToTime(slotStart),
        end_time: minutesToTime(slotEnd),
        capacity: clash ? 0 : Math.max(1, capacity),
        blocked: clash ? 1 : 0,
        note: clash ? clash.label : null,
      });
    }
  }
  return rows;
}

/** Insert generated slots, skipping any (date,start) that already exists on the schedule. */
const insertSlots = db.transaction((scheduleId, rows) => {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO slots (schedule_id, slot_date, start_time, end_time, capacity, blocked, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  for (const r of rows) {
    const info = stmt.run(scheduleId, r.slot_date, r.start_time, r.end_time, r.capacity, r.blocked, r.note);
    added += info.changes;
  }
  return added;
});

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

const SCHEDULE_SELECT = `
  SELECT s.*,
         e.name  AS event_name, e.type AS event_type, e.slug AS event_slug,
         e.status AS event_status, e.campus_id,
         c.name  AS class_name, c.grade_level, c.room,
         st.name AS staff_name, st.name_ar AS staff_name_ar, st.email AS staff_email, st.title AS staff_title,
         d.name  AS department_name,
         cp.name AS campus_name, cp.slug AS campus_slug
  FROM schedules s
  JOIN events e       ON e.id = s.event_id
  LEFT JOIN classes c ON c.id = s.class_id
  LEFT JOIN staff st  ON st.id = s.staff_id
  LEFT JOIN departments d ON d.id = s.department_id
  LEFT JOIN campuses cp ON cp.id = e.campus_id
`;

function getSchedule(id) {
  const row = db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(id);
  return row ? decorateSchedule(row) : null;
}

function listSchedules(where, params = []) {
  const rows = db.prepare(`${SCHEDULE_SELECT} ${where}`).all(...params);
  return rows.map(decorateSchedule);
}

function decorateSchedule(row) {
  row.display_name = row.label || row.class_name || row.staff_name || 'Appointments';
  row.owner_name = row.staff_name || '';
  return row;
}

/** Slots for a schedule with live availability. */
function slotsForSchedule(scheduleId, { includeBlocked = false } = {}) {
  const rows = db
    .prepare(
      `SELECT sl.*,
              (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = sl.id AND b.status = 'booked') AS booked
       FROM slots sl
       WHERE sl.schedule_id = ?
       ${includeBlocked ? '' : 'AND sl.blocked = 0'}
       ORDER BY sl.slot_date, sl.start_time`
    )
    .all(scheduleId);
  for (const r of rows) {
    r.remaining = Math.max(0, r.capacity - r.booked);
    r.is_full = r.remaining <= 0;
    r.starts_at = localDT(r.slot_date, r.start_time);
    r.is_past = r.starts_at < nowLocal();
  }
  return rows;
}

function scheduleStats(scheduleId) {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS total_slots,
         COALESCE(SUM(CASE WHEN blocked = 0 THEN capacity ELSE 0 END), 0) AS capacity,
         (SELECT COUNT(*) FROM bookings b
            JOIN slots s2 ON s2.id = b.slot_id
           WHERE s2.schedule_id = ? AND b.status = 'booked') AS booked
       FROM slots WHERE schedule_id = ?`
    )
    .get(scheduleId, scheduleId);
}

/* ------------------------------------------------------------------ *
 * Event windows
 * ------------------------------------------------------------------ */

function eventWindow(event) {
  const now = nowLocal();
  const opens = parseStamp(event.opens_at);
  const closes = parseStamp(event.closes_at);
  const published = event.status === 'published';
  let state = 'open';
  if (!published) state = event.status === 'closed' ? 'closed' : 'unpublished';
  else if (opens && now < opens) state = 'not_yet';
  else if (closes && now > closes) state = 'closed';
  return { state, opens, closes, isOpen: state === 'open' };
}

/* ------------------------------------------------------------------ *
 * Booking rules
 * ------------------------------------------------------------------ */

function studentKey(event, { studentName, parentEmail }) {
  const email = String(parentEmail || '').trim().toLowerCase();
  if (!event.collect_student) return email;
  return `${email}|${String(studentName || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/** Every live booking this family (one parent email) holds in this event. */
function familyBookings(event, identity) {
  const email = String(identity.parentEmail || '').trim().toLowerCase();
  return db
    .prepare(
      `SELECT b.*, sl.slot_date, sl.start_time, sl.end_time, sc.label, sc.class_id, sc.staff_id
       FROM bookings b
       JOIN slots sl ON sl.id = b.slot_id
       JOIN schedules sc ON sc.id = b.schedule_id
       WHERE b.event_id = ? AND b.status = 'booked' AND lower(b.parent_email) = ?`
    )
    .all(event.id, email);
}

/** Existing 'booked' rows for this one student in this event. */
function existingBookings(event, identity) {
  const rows = familyBookings(event, identity);
  if (!event.collect_student) return rows;
  const key = studentKey(event, identity);
  return rows.filter((r) => studentKey(event, { studentName: r.student_name, parentEmail: r.parent_email }) === key);
}

function overlaps(a, b) {
  if (a.slot_date !== b.slot_date) return false;
  return timeToMinutes(a.start_time) < timeToMinutes(b.end_time) &&
    timeToMinutes(b.start_time) < timeToMinutes(a.end_time);
}

/**
 * Normalise what the routes hand us. A basket item is a slot id plus the
 * student it is for; a bare list of ids means every slot is for the one
 * student named in `identity` — which is how a single-child booking, and
 * every event that does not collect a student at all, still arrives.
 */
function normaliseItems(slotIds, identity) {
  return slotIds
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? { slotId: Number(entry.slotId), student: entry.student || {} }
        : {
            slotId: Number(entry),
            student: { name: identity.studentName, grade: identity.studentGrade, ref: identity.studentRef },
          }
    )
    .filter((it) => it.slotId);
}

/**
 * Validate a whole basket for one family in one event.
 *
 * Two kinds of rule live here and they scope differently. "You cannot be in
 * two places at once" is about the parent, so it runs across every child in
 * the basket and every booking already on the parent's email. "One
 * appointment per teacher" and the per-student cap are about a child, so
 * twins in the same class can each see the teacher.
 *
 * Returns { ok, errors: [], slots: [...] }
 */
function validateBasket(event, slotIds, identity) {
  const errors = [];
  const items = normaliseItems(slotIds, identity);
  const seen = new Set();
  const unique = items.filter((it) => (seen.has(it.slotId) ? false : seen.add(it.slotId)));
  if (!unique.length) return { ok: false, errors: ['Choose at least one time slot.'], slots: [] };

  const slots = unique.map((it) => {
    const row = db
      .prepare(
        `SELECT sl.*, sc.id AS schedule_id, sc.locked, sc.published, sc.event_id,
                sc.label, sc.class_id, sc.staff_id,
                (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = sl.id AND b.status = 'booked') AS booked
         FROM slots sl JOIN schedules sc ON sc.id = sl.schedule_id
         WHERE sl.id = ?`
      )
      .get(it.slotId);
    return row ? { ...row, student: it.student } : null;
  });

  const now = nowLocal();
  slots.forEach((slot) => {
    if (!slot) {
      errors.push('One of the selected times no longer exists.');
      return;
    }
    if (slot.event_id !== event.id) errors.push('A selected time belongs to a different event.');
    if (slot.blocked) errors.push('A selected time is not available for booking.');
    if (slot.locked) errors.push('That teacher has closed their schedule to new sign-ups.');
    if (!slot.published) errors.push('A selected schedule is not published.');
    if (slot.capacity - slot.booked <= 0) errors.push(`${slot.start_time} on ${slot.slot_date} was just taken.`);
    if (localDT(slot.slot_date, slot.start_time) < now) errors.push('A selected time is in the past.');
    if (event.collect_student && !String(slot.student.name || '').trim()) {
      errors.push('Every appointment needs the name of the child it is for.');
    }
  });
  if (errors.length) return { ok: false, errors: [...new Set(errors)], slots };

  const keyOf = (student) => studentKey(event, { studentName: student.name, parentEmail: identity.parentEmail });
  const who = (student) => (event.collect_student && student.name ? ` for ${student.name}` : '');

  // The parent cannot be in two rooms at once - whichever child each is for.
  if (event.prevent_overlap) {
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        if (overlaps(slots[i], slots[j])) {
          errors.push(
            `Two of your choices are at the same time (${slots[i].slot_date} ${slots[i].start_time}${who(slots[i].student)} and${who(slots[j].student)}). You cannot be in two places at once - pick a different slot for one of them.`
          );
        }
      }
    }
  }

  const family = familyBookings(event, identity);

  if (event.prevent_overlap) {
    for (const s of slots) {
      const clash = family.find((e) => overlaps(s, e));
      if (clash) {
        const theirs = event.collect_student && clash.student_name ? ` for ${clash.student_name}` : '';
        errors.push(
          `You already have an appointment at ${clash.start_time} on ${clash.slot_date}${theirs}. Choose another time.`
        );
      }
    }
  }

  // One appointment per teacher per child - against earlier bookings and
  // against the rest of this basket.
  const perChild = new Map(); // studentKey -> { existing: [], basket: [] }
  for (const s of slots) {
    const k = keyOf(s.student);
    if (!perChild.has(k)) {
      perChild.set(k, {
        existing: family.filter(
          (e) => studentKey(event, { studentName: e.student_name, parentEmail: e.parent_email }) === k
        ),
        basket: [],
      });
    }
    perChild.get(k).basket.push(s);
  }
  for (const [, group] of perChild) {
    const schedulesSeen = new Set(group.existing.map((e) => e.schedule_id));
    for (const s of group.basket) {
      if (schedulesSeen.has(s.schedule_id)) {
        errors.push(
          `You already have an appointment with one of these teachers${who(s.student)} - one time per teacher per child.`
        );
      }
      schedulesSeen.add(s.schedule_id);
    }
    if (event.max_per_student > 0 && group.existing.length + group.basket.length > event.max_per_student) {
      const name = group.basket[0].student.name;
      errors.push(
        `This event allows ${event.max_per_student} appointment(s) per student${name ? ` - ${name} would have ${group.existing.length + group.basket.length}` : ''}.`
      );
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], slots, existing: family };
}

const createBookings = db.transaction((event, slotIds, details) => {
  const items = normaliseItems(slotIds, details);
  const groupToken = token(12);
  const created = [];
  const capStmt = db.prepare(
    `SELECT sl.capacity, sl.blocked, sc.locked,
            (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = sl.id AND b.status = 'booked') AS booked,
            sl.schedule_id
     FROM slots sl JOIN schedules sc ON sc.id = sl.schedule_id WHERE sl.id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO bookings
      (slot_id, event_id, schedule_id, student_name, student_grade, student_ref,
       parent_name, parent_email, parent_phone, notes, status, token, group_token, language)
     VALUES (@slot_id, @event_id, @schedule_id, @student_name, @student_grade, @student_ref,
       @parent_name, @parent_email, @parent_phone, @notes, 'booked', @token, @group_token, @language)`
  );

  for (const { slotId, student } of items) {
    const row = capStmt.get(slotId);
    if (!row) throw new Error('That time slot no longer exists.');
    if (row.blocked || row.locked) throw new Error('That time slot is no longer open.');
    if (row.capacity - row.booked <= 0) throw new Error('Sorry — one of your chosen times was just booked by someone else.');
    const info = insert.run({
      slot_id: slotId,
      event_id: event.id,
      schedule_id: row.schedule_id,
      student_name: String(student.name || '').trim() || null,
      student_grade: String(student.grade || '').trim() || null,
      student_ref: String(student.ref || '').trim() || null,
      parent_name: details.parentName,
      parent_email: details.parentEmail,
      parent_phone: details.parentPhone || null,
      notes: details.notes || null,
      token: token(16),
      group_token: groupToken,
      language: details.language || 'en',
    });
    created.push(info.lastInsertRowid);
  }
  return { groupToken, ids: created };
});

/** Full booking record for confirmation pages, emails and WhatsApp. */
function getBooking(where, param) {
  return db
    .prepare(
      `SELECT b.*,
              sl.slot_date, sl.start_time, sl.end_time,
              sc.label, sc.mode, sc.location, sc.meeting_link, sc.notes AS schedule_notes,
              c.name AS class_name, c.grade_level AS class_grade, c.room,
              st.name AS staff_name, st.email AS staff_email, st.title AS staff_title,
              d.name AS department_name,
              e.name AS event_name, e.type AS event_type, e.slug AS event_slug,
              e.allow_cancel, e.cancel_cutoff_hrs, e.instructions,
              cp.name AS campus_name, cp.slug AS campus_slug
       FROM bookings b
       JOIN slots sl ON sl.id = b.slot_id
       JOIN schedules sc ON sc.id = b.schedule_id
       JOIN events e ON e.id = b.event_id
       LEFT JOIN classes c ON c.id = sc.class_id
       LEFT JOIN staff st ON st.id = sc.staff_id
       LEFT JOIN departments d ON d.id = sc.department_id
       LEFT JOIN campuses cp ON cp.id = e.campus_id
       WHERE ${where}`
    )
    [Array.isArray(param) ? 'all' : 'get'](...(Array.isArray(param) ? param : [param]));
}

function bookingByToken(tok) {
  return getBooking('b.token = ?', tok);
}

function bookingsByGroup(groupToken) {
  return db
    .prepare(
      `SELECT b.*, sl.slot_date, sl.start_time, sl.end_time,
              sc.label, sc.mode, sc.location, sc.meeting_link,
              c.name AS class_name, st.name AS staff_name, d.name AS department_name,
              e.name AS event_name, e.type AS event_type, cp.name AS campus_name
       FROM bookings b
       JOIN slots sl ON sl.id = b.slot_id
       JOIN schedules sc ON sc.id = b.schedule_id
       JOIN events e ON e.id = b.event_id
       LEFT JOIN classes c ON c.id = sc.class_id
       LEFT JOIN staff st ON st.id = sc.staff_id
       LEFT JOIN departments d ON d.id = sc.department_id
       LEFT JOIN campuses cp ON cp.id = e.campus_id
       WHERE b.group_token = ?
       ORDER BY b.student_name, sl.slot_date, sl.start_time`
    )
    .all(groupToken);
}

function bookingById(id) {
  return getBooking('b.id = ?', id);
}

function canParentCancel(booking) {
  if (booking.status !== 'booked') return { ok: false, reason: 'This appointment is already cancelled.' };
  if (!booking.allow_cancel) return { ok: false, reason: 'Online cancellation is turned off for this event. Please contact the school office.' };
  const starts = localDT(booking.slot_date, booking.start_time);
  const cutoff = starts.minus({ hours: booking.cancel_cutoff_hrs || 0 });
  if (nowLocal() > cutoff) {
    return {
      ok: false,
      reason: `Appointments can no longer be cancelled online within ${booking.cancel_cutoff_hrs} hour(s) of the start time. Please call the school office.`,
    };
  }
  return { ok: true };
}

function cancelBooking(bookingId, by = 'parent') {
  return db
    .prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = ?
       WHERE id = ? AND status = 'booked'`
    )
    .run(by, bookingId).changes > 0;
}

module.exports = {
  buildSlots,
  insertSlots,
  getSchedule,
  listSchedules,
  slotsForSchedule,
  scheduleStats,
  eventWindow,
  validateBasket,
  createBookings,
  bookingByToken,
  bookingsByGroup,
  bookingById,
  existingBookings,
  familyBookings,
  canParentCancel,
  cancelBooking,
  overlaps,
};
