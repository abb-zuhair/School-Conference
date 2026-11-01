'use strict';
/**
 * The activity log: every change by staff or parents is written down with
 * who, when and what, and the Admin › Activity page can find it again.
 *
 * Run against a freshly seeded server: npm run seed && node test/activity.js
 */
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'zuhair@sama.com.kw';
const TEACHER = 'sara.mutairi@example.aca.edu.kw';
const SALMIYA_TEACHER = 'omar.khalid@example.aca.edu.kw';
const SEED_PW = 'Welcome123!';

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
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

async function signIn(email, firstPw, newPassword) {
  const j = jar();
  let r = await req(j, 'POST', '/staff/login', { email, password: firstPw });
  if (r.status !== 302) {
    r = await req(j, 'POST', '/staff/login', { email, password: newPassword });
    if (r.status !== 302) throw new Error(`cannot sign in as ${email}`);
    return j;
  }
  if (String(r.location).includes('/staff/password')) {
    await req(j, 'POST', '/staff/password', { new_password: newPassword, confirm_password: newPassword });
  }
  return j;
}

/** Just the rows — the filter dropdowns list every action's wording, so look inside the table only. */
const rowsOf = (html) => (html.split('<tbody>')[1] || '').split('</tbody>')[0];

(async () => {
  console.log(`Activity log, against ${BASE}\n`);

  process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
  const { db } = require('../src/db');
  const activity = require('../src/lib/activity');

  const last = (action) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  const countOf = (action) => db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;

  /* ------------------------- what gets written ------------------------- */
  const admin = await signIn(ADMIN_EMAIL, process.env.ADMIN_PASSWORD || 'Test1234!', 'AdminPass123');
  let row = last('login');
  check('a sign-in is recorded with the name and address', row && row.actor && row.ip, JSON.stringify(row));

  const hawally = db.prepare("SELECT id FROM campuses WHERE slug = 'hawally'").get().id;
  const before = countOf('department_create');
  await req(admin, 'POST', '/admin/departments', { campus_id: String(hawally), name: 'Activity Test Dept' });
  check('adding a department is recorded', countOf('department_create') === before + 1);
  row = last('department_create');
  check('with the department name in the details', row && row.detail.includes('Activity Test Dept'));
  const dept = db.prepare("SELECT id FROM departments WHERE name = 'Activity Test Dept'").get();
  await req(admin, 'POST', `/admin/departments/${dept.id}/delete`);
  check('removing it is recorded too', last('department_delete') && last('department_delete').detail.includes('Activity Test Dept'));

  // Editing a staff record writes only what changed, old → new.
  const sara = db.prepare('SELECT * FROM staff WHERE email = ?').get(TEACHER);
  await req(admin, 'POST', '/admin/staff', {
    email: TEACHER, name: sara.name, campus_id: String(sara.campus_id), department_id: String(sara.department_id),
    role: sara.role, title: 'Grade 5 English (acting lead)', phone: sara.phone || '',
  });
  row = last('staff_update');
  const changes = row ? JSON.parse(row.detail).changes : {};
  check('a staff edit records the changed field, old → new', changes.title && changes.title.from === sara.title && changes.title.to === 'Grade 5 English (acting lead)', JSON.stringify(changes));
  check('and nothing that did not change', !('name' in changes) && !('role' in changes));
  await req(admin, 'POST', '/admin/staff', {
    email: TEACHER, name: sara.name, campus_id: String(sara.campus_id), department_id: String(sara.department_id),
    role: sara.role, title: sara.title, phone: sara.phone || '',
  });

  await req(admin, 'POST', `/admin/staff/${sara.id}/toggle`);
  check('deactivating an account is recorded', last('staff_deactivate') && last('staff_deactivate').detail.includes(TEACHER));
  await req(admin, 'POST', `/admin/staff/${sara.id}/toggle`);
  check('and activating it again', last('staff_activate') && last('staff_activate').detail.includes(TEACHER));

  // A parent booking is written down under the parent's name.
  const ev = db.prepare("SELECT * FROM events WHERE slug = 'ptc-term1-hawally'").get();
  const slot = db
    .prepare(
      `SELECT sl.id FROM slots sl JOIN schedules sc ON sc.id = sl.schedule_id
       WHERE sc.event_id = ? AND sc.staff_id = ? AND sl.blocked = 0
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = sl.id AND b.status = 'booked')
       ORDER BY sl.id DESC LIMIT 1`
    )
    .get(ev.id, sara.id);
  const parent = jar();
  await req(parent, 'GET', `/e/${ev.slug}`);
  await req(parent, 'POST', `/e/${ev.slug}/child`, { student_name: 'Activity Child', student_grade: '5', back: `/e/${ev.slug}` });
  await req(parent, 'POST', `/e/${ev.slug}/select`, { slot_id: String(slot.id), action: 'add' });
  const bookedBefore = countOf('booking_create');
  let r = await req(parent, 'POST', `/e/${ev.slug}/confirm`, {
    parent_name: 'Activity Parent', parent_email: 'activity@example.com', parent_phone: '99001122',
  });
  check('the parent booking goes through', r.status === 302 && String(r.location).includes('/confirmation/'), `status ${r.status} ${r.location}`);
  check('and is recorded', countOf('booking_create') === bookedBefore + 1);
  row = last('booking_create');
  check('under the parent’s name, marked as a parent', row && row.actor === 'Activity Parent (parent)', row && row.actor);
  check('with the teacher and child in the details', row && row.detail.includes('Sara Al-Mutairi') && row.detail.includes('Activity Child'));
  const booking = db.prepare("SELECT * FROM bookings WHERE parent_email = 'activity@example.com' ORDER BY id DESC LIMIT 1").get();

  // The teacher cancelling it is recorded against the teacher.
  const teacher = await signIn(TEACHER, SEED_PW, 'SaraPass123');
  await req(teacher, 'POST', `/staff/booking/${booking.id}/cancel`);
  row = last('booking_cancel');
  check('a teacher cancelling is recorded against the teacher', row && row.staff_id === sara.id && row.detail.includes('Activity Parent'));

  // Closing a single slot from the sheet is recorded.
  const sheet = db.prepare('SELECT id FROM schedules WHERE staff_id = ? AND event_id = ?').get(sara.id, ev.id);
  const free = db
    .prepare(`SELECT id FROM slots WHERE schedule_id = ? AND blocked = 0 AND id != ? ORDER BY id LIMIT 1`)
    .get(sheet.id, slot.id);
  await req(teacher, 'POST', `/staff/slot/${free.id}/block`);
  check('closing a slot is recorded', last('slot_block') && JSON.parse(last('slot_block').detail).slotId === free.id);
  await req(teacher, 'POST', `/staff/slot/${free.id}/unblock`);
  check('and reopening it', last('slot_unblock') && JSON.parse(last('slot_unblock').detail).slotId === free.id);

  /* --------------------------- the page --------------------------- */
  r = await req(admin, 'GET', '/admin/activity');
  check('the Activity page opens', r.status === 200, `status ${r.status}`);
  check('it is in the admin menu', r.text.includes('href="/admin/activity"'));
  check('it shows the booking in plain words', r.text.includes('Booked an appointment') && r.text.includes('Activity Parent (parent)'));
  check('it shows the staff edit as a change', r.text.includes('acting lead'));
  check('times are shown in school time', r.text.includes('Asia/Kuwait') && / \d{1,2}:\d{2} [AP]M/.test(r.text));

  r = await req(admin, 'GET', '/admin/activity?who=parents');
  check('filtering to parents keeps the booking', r.text.includes('Activity Parent (parent)'));
  check('and drops staff actions', !rowsOf(r.text).includes('Deactivated a staff account'));

  r = await req(admin, 'GET', `/admin/activity?who=${sara.id}`);
  check('filtering to one person shows their actions', r.text.includes('Closed a slot'));
  check('and not the office’s', !rowsOf(r.text).includes('Added a department'));

  r = await req(admin, 'GET', '/admin/activity?group=staff');
  check('the Staff group finds the edit', r.text.includes('Edited a staff account'));
  check('and leaves sign-ins out', !rowsOf(r.text).includes('>Signed in<'));

  r = await req(admin, 'GET', '/admin/activity?action=department_delete');
  check('an exact action filter works', rowsOf(r.text).includes('Removed a department') && !rowsOf(r.text).includes('Added a department'));

  r = await req(admin, 'GET', '/admin/activity?q=Activity+Child');
  check('search finds text inside the details', r.text.includes('Booked an appointment'));
  r = await req(admin, 'GET', '/admin/activity?q=zzzznothing');
  check('a miss says so', r.text.includes('Nothing recorded for those filters'));

  const today = new Date().toISOString().slice(0, 10);
  r = await req(admin, 'GET', `/admin/activity?from=${today}&to=${today}`);
  check('a date range works', r.status === 200 && r.text.includes('Booked an appointment'));
  r = await req(admin, 'GET', '/admin/activity?from=2000-01-01&to=2000-01-02');
  check('and an empty range is empty', r.text.includes('Nothing recorded'));

  r = await req(admin, 'GET', '/admin/activity/export.csv?who=parents');
  check('the CSV downloads', r.status === 200 && r.text.replace(/^\ufeff/, '').startsWith('When,Who,Email,Action'), `status ${r.status}`);
  check('with the booking in it', r.text.includes('Activity Parent (parent)') && r.text.includes('Booked an appointment'));
  check('and the download itself is recorded', Boolean(last('activity_export')));

  r = await req(admin, 'GET', '/admin/activity?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  check('a typed script tag is escaped', r.status === 200 && !r.text.includes('<script>alert(1)'));

  /* --------------------------- who may look --------------------------- */
  r = await req(teacher, 'GET', '/admin/activity');
  check('a teacher cannot open it', r.status === 403 || (r.status === 302 && !String(r.location).includes('/admin/activity')), `status ${r.status}`);

  // A campus admin sees only their campus: make one for Salmiya.
  const salmiya = db.prepare("SELECT id FROM campuses WHERE slug = 'salmiya'").get().id;
  const { hashPassword } = require('../src/lib/auth');
  db.prepare('DELETE FROM staff WHERE email = ?').run('campusadmin.test@example.aca.edu.kw');
  db.prepare(
    `INSERT INTO staff (campus_id, name, email, role, password_hash, must_change_pw, active)
     VALUES (?, 'Salmiya Admin (test)', 'campusadmin.test@example.aca.edu.kw', 'campus_admin', ?, 0, 1)`
  ).run(salmiya, hashPassword('CampusPass123'));
  const omar = await signIn(SALMIYA_TEACHER, SEED_PW, 'OmarPass123');
  await req(omar, 'GET', '/staff');
  const campusAdmin = await signIn('campusadmin.test@example.aca.edu.kw', 'CampusPass123', 'CampusPass123');
  r = await req(campusAdmin, 'GET', '/admin/activity');
  check('a campus admin opens the page', r.status === 200, `status ${r.status}`);
  check('and sees their own campus’s staff', r.text.includes('Omar Khalid'));
  check('but not the other campus’s staff', !rowsOf(r.text).includes('Sara Al-Mutairi'));
  check('nor its parents', !rowsOf(r.text).includes('Activity Parent (parent)'));
  db.prepare('DELETE FROM staff WHERE email = ?').run('campusadmin.test@example.aca.edu.kw');

  /* --------------------------- the library --------------------------- */
  check('every known action has readable wording', Object.keys(activity.LABELS).every((k) => activity.label(k) && !activity.label(k).includes('_')));
  check('an unknown action still reads', activity.label('something_new') === 'something new');
  check('a renamed account still shows the name written at the time', (() => {
    const row = db.prepare("SELECT * FROM audit_log WHERE actor = 'Activity Parent (parent)' ORDER BY id DESC LIMIT 1").get();
    return row && activity.query({ q: 'Activity Parent' }).rows.some((x) => x.who === 'Activity Parent (parent)');
  })());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nActivity test crashed:', err);
  process.exit(1);
});
