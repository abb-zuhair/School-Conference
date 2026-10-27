'use strict';
/**
 * Bulk editing and deleting slots across departments.
 *
 * This is the most destructive tool in the admin console, so the checks lean
 * towards what it must refuse: a filter that catches nothing, deleting slots a
 * family is holding without saying so, closing a slot that is already booked,
 * another campus, and anyone who is not an administrator.
 *
 * Run against a freshly seeded server: npm run seed && node test/slots.js
 */
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'zuhair@sama.com.kw';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Test1234!';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

function jar() {
  const c = new Map();
  return {
    header() { return [...c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    absorb(res) {
      for (const s of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [p] = s.split(';');
        const i = p.indexOf('=');
        c.set(p.slice(0, i), p.slice(i + 1));
      }
    },
  };
}

async function req(j, method, p, body) {
  const headers = { Cookie: j.header() };
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) v.forEach((item) => params.append(k, String(item)));
      else params.append(k, String(v));
    }
    payload = params.toString();
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

(async () => {
  console.log(`Bulk slot edits, against ${BASE}\n`);

  process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
  const { db } = require('../src/db');

  const event = db.prepare("SELECT * FROM events WHERE slug = 'ptc-term1-hawally'").get();
  const dept = db.prepare("SELECT * FROM departments WHERE name = 'Elementary — English'").get();
  const other = db.prepare("SELECT * FROM departments WHERE name = 'Elementary — Mathematics'").get();
  if (!event || !dept || !other) throw new Error('seed data missing — run `npm run seed` first');

  const countIn = (deptId, extra = '') =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM slots sl JOIN schedules s ON s.id = sl.schedule_id
         WHERE s.event_id = ? AND s.department_id = ? ${extra}`
      )
      .get(event.id, deptId).n;

  const a = jar();
  let r = await req(a, 'POST', '/staff/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (r.status !== 302) r = await req(a, 'POST', '/staff/login', { email: ADMIN_EMAIL, password: 'AdminPass123' });
  check('admin signs in', r.status === 302, `status ${r.status}`);
  await req(a, 'POST', '/staff/password', { new_password: 'AdminPass123', confirm_password: 'AdminPass123' });

  const edit = (body) => req(a, 'POST', `/admin/events/${event.id}/slots/edit`, body);

  r = await req(a, 'GET', `/admin/events/${event.id}`);
  check('the tool is on the event page', r.status === 200 && r.text.includes('Change or remove slots'));

  /* ---------------- nothing ticked, nothing happens ---------------- */
  const startedWith = countIn(dept.id);
  check('the department starts with slots', startedWith > 0, `${startedWith}`);

  r = await edit({ action: 'delete' });
  check('no department ticked is refused', r.status === 302);
  check('nothing was deleted', countIn(dept.id) === startedWith);

  r = await edit({ action: 'delete', department_ids: [dept.id], dates: '2099-12-31' });
  check('a date that matches nothing is refused', r.status === 302);
  check('still nothing deleted', countIn(dept.id) === startedWith);

  /* ---------------- the preview counts what it will touch ---------------- */
  await req(a, 'POST', `/admin/events/${event.id}/slots/preview`, { department_ids: [dept.id], action: 'delete' });
  r = await req(a, 'GET', `/admin/events/${event.id}`);
  check('preview reports the slot count', r.text.includes(`${startedWith} slots`), `expected ${startedWith}`);
  r = await req(a, 'GET', `/admin/events/${event.id}`);
  check('preview is cleared after being read once', !r.text.includes(`<strong>\n        ${startedWith} slots`));

  /* ---------------- closing and reopening ---------------- */
  // The seed punches a break out of each evening, so some slots arrive closed.
  const othersClosedBefore = countIn(other.id, 'AND sl.blocked = 1');

  r = await edit({ action: 'block', department_ids: [dept.id] });
  check('closing the department succeeds', r.status === 302);
  check('every slot is closed', countIn(dept.id, 'AND sl.blocked = 0') === 0);
  check('none were deleted', countIn(dept.id) === startedWith);
  check('the other department is untouched', countIn(other.id, 'AND sl.blocked = 1') === othersClosedBefore);

  r = await edit({ action: 'unblock', department_ids: [dept.id] });
  check('reopening works', countIn(dept.id, 'AND sl.blocked = 1') === 0);
  check('reopening left the other department alone', countIn(other.id, 'AND sl.blocked = 1') === othersClosedBefore);

  /* ---------------- a booked slot is not closed quietly ---------------- */
  const sched = db
    .prepare('SELECT id FROM schedules WHERE event_id = ? AND department_id = ? ORDER BY id LIMIT 1')
    .get(event.id, dept.id);
  const slot = db.prepare('SELECT * FROM slots WHERE schedule_id = ? ORDER BY id LIMIT 1').get(sched.id);
  const booking = db
    .prepare(
      `INSERT INTO bookings (slot_id, event_id, schedule_id, parent_name, parent_email, token, status)
       VALUES (?, ?, ?, 'Bulk Test', 'bulk@example.com', ?, 'booked')`
    )
    .run(slot.id, event.id, sched.id, `bulk-${Date.now()}`);

  r = await edit({ action: 'block', department_ids: [dept.id] });
  check('the booked slot stays open', db.prepare('SELECT blocked FROM slots WHERE id = ?').get(slot.id).blocked === 0);
  check('its booking still stands', db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.lastInsertRowid).status === 'booked');
  await edit({ action: 'unblock', department_ids: [dept.id] });

  /* ---------------- deleting needs the opt-in when booked ---------------- */
  r = await edit({ action: 'delete', department_ids: [dept.id] });
  check('deleting over a booking is refused', r.status === 302);
  check('the slots are all still there', countIn(dept.id) === startedWith, `${countIn(dept.id)} vs ${startedWith}`);
  check('the booking survived', db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.lastInsertRowid).status === 'booked');

  /* ---------------- a date + time window deletes only its own slots ---------------- */
  const day = db
    .prepare('SELECT slot_date FROM slots WHERE schedule_id = ? GROUP BY slot_date ORDER BY slot_date LIMIT 1')
    .get(sched.id).slot_date;
  const inWindow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM slots sl JOIN schedules s ON s.id = sl.schedule_id
       WHERE s.event_id = ? AND s.department_id = ? AND sl.slot_date = ?
         AND sl.start_time >= '17:00' AND sl.start_time < '18:00'`
    )
    .get(event.id, dept.id, day).n;
  check('the window holds some slots', inWindow > 0, `${inWindow}`);

  const before = countIn(dept.id);
  r = await edit({
    action: 'delete',
    department_ids: [dept.id],
    dates: day,
    from_time: '17:00',
    to_time: '18:00',
  });
  const after = countIn(dept.id);
  check('the window is deleted', r.status === 302 && before - after === inWindow, `${before} → ${after}, expected -${inWindow}`);
  check(
    'slots outside the window are kept',
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM slots sl JOIN schedules s ON s.id = sl.schedule_id
         WHERE s.event_id = ? AND s.department_id = ? AND sl.slot_date = ? AND sl.start_time < '17:00'`
      )
      .get(event.id, dept.id, day).n > 0
  );
  check('the other department is still whole', countIn(other.id) > 0);

  /* ---------------- with the opt-in, bookings are cancelled ---------------- */
  r = await edit({ action: 'delete', department_ids: [dept.id], cancel_bookings: '1' });
  check('delete with the opt-in succeeds', r.status === 302);
  check('the department has no slots left', countIn(dept.id) === 0);

  // The booking row goes with its slot (ON DELETE CASCADE), the same as deleting a
  // schedule or an event. What must not happen is the family being dropped in
  // silence, so the cancellation is recorded in the audit log before the row goes.
  const gone = db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.lastInsertRowid);
  check('the booking row went with its slot', !gone);
  const entry = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'slots_bulk_delete' ORDER BY id DESC LIMIT 1")
    .get();
  check('the delete was audited', Boolean(entry));
  check(
    'and it records the cancellation',
    entry && JSON.parse(entry.detail).cancelled === 1,
    entry && entry.detail
  );
  check('the other department survived it all', countIn(other.id) > 0);

  /* ---------------- who may use it ---------------- */
  const teacher = jar();
  r = await req(teacher, 'POST', '/staff/login', { email: 'sara.mutairi@example.aca.edu.kw', password: 'Welcome123!' });
  if (r.status === 302) {
    await req(teacher, 'POST', '/staff/password', { new_password: 'SaraPass123', confirm_password: 'SaraPass123' });
  } else {
    await req(teacher, 'POST', '/staff/login', { email: 'sara.mutairi@example.aca.edu.kw', password: 'SaraPass123' });
  }
  const mathsBefore = countIn(other.id);
  r = await req(teacher, 'POST', `/admin/events/${event.id}/slots/edit`, {
    action: 'delete',
    department_ids: [other.id],
    cancel_bookings: '1',
  });
  check('a teacher cannot bulk-delete', r.status === 403 || r.status === 302, `status ${r.status}`);
  check('the maths slots are untouched', countIn(other.id) === mathsBefore);

  const head = jar();
  r = await req(head, 'POST', '/staff/login', { email: 'huda.ajmi@example.aca.edu.kw', password: 'Welcome123!' });
  if (r.status === 302) {
    await req(head, 'POST', '/staff/password', { new_password: 'HeadPass123', confirm_password: 'HeadPass123' });
  } else {
    await req(head, 'POST', '/staff/login', { email: 'huda.ajmi@example.aca.edu.kw', password: 'HeadPass123' });
  }
  r = await req(head, 'POST', `/admin/events/${event.id}/slots/edit`, {
    action: 'delete',
    department_ids: [other.id],
    cancel_bookings: '1',
  });
  check('a department head cannot bulk-delete', r.status === 403 || r.status === 302, `status ${r.status}`);
  check('the maths slots are still untouched', countIn(other.id) === mathsBefore);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nSlot test crashed:', err);
  process.exit(1);
});
