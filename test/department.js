'use strict';
/**
 * Department heads, and the teacher search parents use.
 *
 * The point of most of these checks is the second half: a head gets real power
 * over their own department, so the tests that matter are the ones proving the
 * power stops at its edge — another department, another campus, and the whole
 * of /admin.
 *
 * Run against a freshly seeded server: npm run seed && node test/department.js
 */
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:3000';
const HEAD = 'huda.ajmi@example.aca.edu.kw';       // head of Elementary — English (Hawally)
const TEACHER = 'sara.mutairi@example.aca.edu.kw'; // in her department
const OUTSIDER = 'ahmad.rashidi@example.aca.edu.kw'; // Mathematics, same campus
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
  return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
}

/** Sign in and clear the first-run password prompt so the session is usable. */
async function signIn(email, newPassword) {
  const j = jar();
  const r = await req(j, 'POST', '/staff/login', { email, password: SEED_PW });
  if (r.status !== 302) {
    // A previous run already changed it.
    const again = await req(j, 'POST', '/staff/login', { email, password: newPassword });
    if (again.status !== 302) throw new Error(`cannot sign in as ${email}`);
    return j;
  }
  await req(j, 'POST', '/staff/password', { new_password: newPassword, confirm_password: newPassword });
  return j;
}

/** Blocked means blocked — 403, or bounced somewhere that is not the page itself. */
function refused(r) {
  return r.status === 403 || (r.status === 302 && !String(r.location || '').includes('/admin/'));
}

(async () => {
  console.log(`Department head & teacher search, against ${BASE}\n`);

  process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
  const { db } = require('../src/db');
  const helpers = require('../src/lib/helpers');

  const schedOf = (email) =>
    db
      .prepare(
        `SELECT s.id FROM schedules s JOIN staff st ON st.id = s.staff_id
         JOIN events e ON e.id = s.event_id
         WHERE st.email = ? AND e.slug = 'ptc-term1-hawally' ORDER BY s.id LIMIT 1`
      )
      .get(email);

  const mine = schedOf(TEACHER);              // in the head's department
  const theirs = schedOf(OUTSIDER);           // another department, same campus
  if (!mine || !theirs) throw new Error('seed data missing — run `npm run seed` first');

  // The seed only builds Hawally events, so make one on the other campus to
  // prove the campus edge holds as well as the department one.
  const omar = db.prepare('SELECT * FROM staff WHERE email = ?').get('omar.khalid@example.aca.edu.kw');
  if (!omar) throw new Error('seed data missing — run `npm run seed` first');
  let otherCampus = db
    .prepare('SELECT s.id FROM schedules s WHERE s.staff_id = ? ORDER BY s.id LIMIT 1')
    .get(omar.id);
  if (!otherCampus) {
    const ev = db
      .prepare(
        `INSERT INTO events (campus_id, type, name, slug, status)
         VALUES (?, 'conference', 'Salmiya conference (test)', 'salmiya-test-${Date.now()}', 'published')`
      )
      .run(omar.campus_id);
    const sc = db
      .prepare('INSERT INTO schedules (event_id, department_id, staff_id, label) VALUES (?, ?, ?, ?)')
      .run(ev.lastInsertRowid, omar.department_id, omar.id, 'Omar Khalid');
    otherCampus = { id: sc.lastInsertRowid };
  }

  /* ------------------- the head's own area ------------------- */
  const head = await signIn(HEAD, 'HeadPass123');

  let r = await req(head, 'GET', '/staff');
  check('head signs in', r.status === 200);
  check('dashboard offers the department', r.text.includes('/staff/department'));

  r = await req(head, 'GET', '/staff/department');
  check('department page opens', r.status === 200, `status ${r.status}`);
  check('it lists a teacher from the department', r.text.includes('Sara Al-Mutairi'));
  check('it lists their class', r.text.includes('Grade 5A — English'));
  check('it leaves other departments out', !r.text.includes('Ahmad Al-Rashidi'));
  check('it leaves the other campus out', !r.text.includes('Omar Khalid'));

  r = await req(head, 'GET', '/staff/department/export.csv');
  check('department CSV exports', r.status === 200 && /Teacher/.test(r.text), `status ${r.status}`);

  /* ------------- managing a teacher in the department ------------- */
  r = await req(head, 'GET', `/staff/schedule/${mine.id}`);
  check('head opens a teacher’s sheet', r.status === 200, `status ${r.status}`);

  r = await req(head, 'GET', `/staff/schedule/${mine.id}/print`);
  check('head prints that sheet', r.status === 200);
  r = await req(head, 'GET', `/staff/schedule/${mine.id}/export.csv`);
  check('head exports that sheet', r.status === 200);

  const before = db.prepare('SELECT COUNT(*) AS n FROM slots WHERE schedule_id = ?').get(mine.id).n;
  r = await req(head, 'POST', `/staff/schedule/${mine.id}/slots`, {
    dates: '2099-03-01',
    start_time: '09:00',
    end_time: '09:30',
    duration: '10',
    gap: '0',
    capacity: '1',
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM slots WHERE schedule_id = ?').get(mine.id).n;
  check('head adds slots for that teacher', r.status === 302 && after > before, `${before} → ${after}`);

  const freeSlot = db
    .prepare("SELECT id FROM slots WHERE schedule_id = ? AND blocked = 0 ORDER BY id DESC LIMIT 1")
    .get(mine.id);
  r = await req(head, 'POST', `/staff/slot/${freeSlot.id}/block`);
  const blocked = db.prepare('SELECT blocked FROM slots WHERE id = ?').get(freeSlot.id).blocked;
  check('head blocks a slot', r.status === 302 && blocked === 1);

  // A booking on that teacher's sheet, cancelled by the head.
  const bookable = db
    .prepare("SELECT id FROM slots WHERE schedule_id = ? AND blocked = 0 ORDER BY id LIMIT 1")
    .get(mine.id);
  const evId = db.prepare('SELECT event_id FROM schedules WHERE id = ?').get(mine.id).event_id;
  const ins = db
    .prepare(
      `INSERT INTO bookings (slot_id, event_id, schedule_id, student_name, parent_name, parent_email, token, status)
       VALUES (?, ?, ?, 'Test Child', 'Test Parent', 'depttest@example.com', ?, 'booked')`
    )
    .run(bookable.id, evId, mine.id, `dept-test-${Date.now()}`);

  r = await req(head, 'POST', `/staff/booking/${ins.lastInsertRowid}/cancel`);
  const status = db.prepare('SELECT status FROM bookings WHERE id = ?').get(ins.lastInsertRowid).status;
  check('head cancels a booking in the department', r.status === 302 && status === 'cancelled', status);

  /* ---------------- where the power stops ---------------- */
  r = await req(head, 'GET', `/staff/schedule/${theirs.id}`);
  check('another department’s sheet is refused', r.status === 403, `status ${r.status}`);

  r = await req(head, 'GET', `/staff/schedule/${otherCampus.id}`);
  check('the other campus is refused', r.status === 403, `status ${r.status}`);

  const theirSlot = db.prepare('SELECT id FROM slots WHERE schedule_id = ? LIMIT 1').get(theirs.id);
  r = await req(head, 'POST', `/staff/slot/${theirSlot.id}/block`);
  check('blocking another department’s slot is refused', r.status === 403, `status ${r.status}`);
  check(
    'that slot was left alone',
    db.prepare('SELECT blocked FROM slots WHERE id = ?').get(theirSlot.id).blocked === 0
  );

  const theirBooking = db
    .prepare(
      `INSERT INTO bookings (slot_id, event_id, schedule_id, parent_name, parent_email, token, status)
       VALUES (?, ?, ?, 'Other Parent', 'other@example.com', ?, 'booked')`
    )
    .run(theirSlot.id, evId, theirs.id, `dept-test-other-${Date.now()}`);
  r = await req(head, 'POST', `/staff/booking/${theirBooking.lastInsertRowid}/cancel`);
  check('cancelling outside the department is refused', r.status === 403, `status ${r.status}`);
  check(
    'that booking still stands',
    db.prepare('SELECT status FROM bookings WHERE id = ?').get(theirBooking.lastInsertRowid).status === 'booked'
  );

  r = await req(head, 'GET', `/staff/schedule/${theirs.id}/export.csv`);
  check('no export of another department', r.status === 403);

  for (const p of ['/admin', '/admin/staff', '/admin/events/1', '/admin/classes', '/admin/messaging', '/admin/backup.db']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await req(head, 'GET', p);
    check(`head cannot reach ${p}`, refused(res), `status ${res.status}`);
  }

  /* ---------------- moving a schedule between departments ---------------- */
  // Sara's second class goes to Mathematics. Parents should find it there, the
  // Maths head should gain it, the English head should lose it, and the booking
  // on it should not notice.
  const admin = jar();
  r = await req(admin, 'POST', '/staff/login', { email: process.env.ADMIN_EMAIL || 'zuhair@sama.com.kw', password: process.env.ADMIN_PASSWORD || 'Test1234!' });
  if (r.status !== 302) r = await req(admin, 'POST', '/staff/login', { email: process.env.ADMIN_EMAIL || 'zuhair@sama.com.kw', password: 'AdminPass123' });
  await req(admin, 'POST', '/staff/password', { new_password: 'AdminPass123', confirm_password: 'AdminPass123' });

  const maths = db.prepare("SELECT id FROM departments WHERE name = 'Elementary — Mathematics'").get();
  const english = db.prepare("SELECT id FROM departments WHERE name = 'Elementary — English'").get();
  const moving = db
    .prepare(
      `SELECT s.id, s.event_id FROM schedules s JOIN staff st ON st.id = s.staff_id JOIN classes c ON c.id = s.class_id
       WHERE st.email = ? AND c.name = 'Grade 5B — English'`
    )
    .get(TEACHER);
  check('there is a schedule to move', Boolean(moving));
  const movingSlot = db.prepare('SELECT id FROM slots WHERE schedule_id = ? AND blocked = 0 ORDER BY id DESC LIMIT 1').get(moving.id);
  const held = db
    .prepare(
      `INSERT INTO bookings (slot_id, event_id, schedule_id, parent_name, parent_email, token, status)
       VALUES (?, ?, ?, 'Move Parent', 'moveparent@example.com', ?, 'booked')`
    )
    .run(movingSlot.id, moving.event_id, moving.id, `move-dept-${Date.now()}`);

  r = await req(admin, 'GET', `/admin/events/${moving.event_id}`);
  check('the event page offers a department picker per schedule', r.text.includes(`/admin/schedules/${moving.id}/move`));

  r = await req(admin, 'POST', `/admin/schedules/${moving.id}/move`, { department_id: String(maths.id) });
  check('the move is accepted', r.status === 302, `status ${r.status}`);
  check('the schedule now sits in Mathematics', db.prepare('SELECT department_id FROM schedules WHERE id = ?').get(moving.id).department_id === maths.id);
  check('its booking is untouched', db.prepare('SELECT status FROM bookings WHERE id = ?').get(held.lastInsertRowid).status === 'booked');

  r = await req(jar(), 'GET', `/e/ptc-term1-hawally/d/${maths.id}`);
  check('parents now find it under Mathematics', r.text.includes('Grade 5B — English'));
  r = await req(jar(), 'GET', `/e/ptc-term1-hawally/d/${english.id}`);
  check('and no longer under English', !r.text.includes('Grade 5B — English'));

  r = await req(head, 'GET', `/staff/schedule/${moving.id}`);
  check('the English head can no longer open it', r.status === 403, `status ${r.status}`);
  r = await req(head, 'GET', '/staff/department');
  check('and it has left her department page', !r.text.includes('Grade 5B — English'));

  // The other campus's department is refused.
  const salmiya = db.prepare("SELECT d.id FROM departments d JOIN campuses c ON c.id = d.campus_id WHERE c.slug = 'salmiya' LIMIT 1").get();
  r = await req(admin, 'POST', `/admin/schedules/${moving.id}/move`, { department_id: String(salmiya.id) });
  check('a department on the other campus is refused', db.prepare('SELECT department_id FROM schedules WHERE id = ?').get(moving.id).department_id === maths.id);

  // Put it back so the rest of the suite sees the seed as it was.
  await req(admin, 'POST', `/admin/schedules/${moving.id}/move`, { department_id: String(english.id) });
  r = await req(head, 'GET', `/staff/schedule/${moving.id}`);
  check('moved back, the English head has it again', r.status === 200, `status ${r.status}`);

  /* ---------------- an ordinary teacher is unchanged ---------------- */
  const teacher = await signIn(TEACHER, 'SaraPass123');
  r = await req(teacher, 'GET', '/staff/department');
  check('a teacher cannot open the department view', r.status === 403, `status ${r.status}`);
  r = await req(teacher, 'GET', `/staff/schedule/${theirs.id}`);
  check('a teacher cannot open another sheet', r.status === 403, `status ${r.status}`);
  r = await req(teacher, 'GET', `/staff/schedule/${mine.id}`);
  check('a teacher still opens their own sheet', r.status === 200, `status ${r.status}`);

  /* ---------------- the parent-facing teacher search ---------------- */
  const deptId = db
    .prepare("SELECT id FROM departments WHERE name = 'Elementary — English'")
    .get().id;
  const parent = jar();
  const dept = `/e/ptc-term1-hawally/d/${deptId}`;

  r = await req(parent, 'GET', dept);
  check('department page shows the search box', r.status === 200 && r.text.includes('name="q"'));
  check('and everyone by default', r.text.includes('Sara Al-Mutairi') && r.text.includes('Laura Bennett'));

  r = await req(parent, 'GET', `${dept}?q=Laura`);
  check('searching a name narrows the list', r.text.includes('Laura Bennett') && !r.text.includes('Sara Al-Mutairi'));

  r = await req(parent, 'GET', `${dept}?q=${encodeURIComponent('Grade 5A')}`);
  check('searching a class finds its teacher', r.text.includes('Sara Al-Mutairi'));

  r = await req(parent, 'GET', `${dept}?q=sara`);
  check('search ignores capitals', r.text.includes('Sara Al-Mutairi'));

  r = await req(parent, 'GET', `${dept}?q=zzzznobody`);
  check('a miss says so', r.text.includes('No teacher in this department matches'));
  check('and offers the way back', r.text.includes('show everyone'));

  r = await req(parent, 'GET', `${dept}?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
  check('a typed script tag is escaped', r.status === 200 && !r.text.includes('<script>alert(1)'));

  // Arabic: the spellings people actually type should all land on the same name.
  check('Arabic ة and ه match', helpers.searchKey('فاطمة') === helpers.searchKey('فاطمه'));
  check('Arabic أ and ا match', helpers.searchKey('أحمد') === helpers.searchKey('احمد'));
  check('harakat are ignored', helpers.searchKey('مُحَمَّد') === helpers.searchKey('محمد'));

  const arabic = db.prepare("SELECT id FROM staff WHERE email = ?").get(TEACHER);
  db.prepare('UPDATE staff SET name_ar = ? WHERE id = ?').run('سارة المطيري', arabic.id);
  r = await req(parent, 'GET', `${dept}?q=${encodeURIComponent('ساره')}`);
  check('an Arabic name is found when spelled either way', r.text.includes('Sara Al-Mutairi'));
  db.prepare('UPDATE staff SET name_ar = NULL WHERE id = ?').run(arabic.id);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nDepartment test crashed:', err);
  process.exit(1);
});
