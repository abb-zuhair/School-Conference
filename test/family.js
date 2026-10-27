'use strict';
/**
 * One parent, several children, one visit.
 *
 * The rules scope two ways and the checks below hold them apart: the parent
 * cannot be in two rooms at once (every child, every earlier booking), while
 * "one appointment per teacher" and the per-student cap belong to each child
 * - so twins in the same class can both see the teacher.
 *
 * Run against a freshly seeded server: npm run seed && node test/family.js
 */
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:3000';
const EVENT = 'ptc-term1-hawally';

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

async function follow(j, p) {
  let cur = p;
  for (let i = 0; i < 5; i += 1) {
    const r = await req(j, 'GET', cur);
    if (r.status === 302 && r.location) { cur = r.location.replace(BASE, ''); continue; }
    return r;
  }
  throw new Error('too many redirects');
}

const slotIdsIn = (html) => [...html.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]));
const removes = (html) => (html.match(/Remove<\/button>/g) || []).length;

/** Name a child (or switch to one already named) for the picks that follow. */
const choose = (j, name, grade = '') =>
  req(j, 'POST', `/e/${EVENT}/child`, { student_name: name, student_grade: grade, back: `/e/${EVENT}` });

const add = (j, slotId) => req(j, 'POST', `/e/${EVENT}/select`, { slot_id: slotId, action: 'add' });

const confirm = (j, email) =>
  req(j, 'POST', `/e/${EVENT}/confirm`, {
    parent_name: 'Family Parent',
    parent_email: email,
    parent_phone: '99001122',
  });

(async () => {
  console.log(`Families with more than one child, against ${BASE}\n`);

  process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
  const { db } = require('../src/db');

  // Two teachers in one department, each with a sheet in the event.
  const sched = (email) =>
    db
      .prepare(
        `SELECT s.id FROM schedules s JOIN staff st ON st.id = s.staff_id JOIN events e ON e.id = s.event_id
         WHERE st.email = ? AND e.slug = ? ORDER BY s.id LIMIT 1`
      )
      .get(email, EVENT);
  const sara = sched('sara.mutairi@example.aca.edu.kw');
  const laura = sched('laura.bennett@example.aca.edu.kw');
  if (!sara || !laura) throw new Error('seed data missing — run `npm run seed` first');

  const p = jar();
  let r = await req(p, 'GET', `/e/${EVENT}/s/${sara.id}`);
  const saraSlots = slotIdsIn(r.text);
  r = await req(p, 'GET', `/e/${EVENT}/s/${laura.id}`);
  const lauraSlots = slotIdsIn(r.text);
  check('both sheets have free times', saraSlots.length > 4 && lauraSlots.length > 4);

  /* ---------------- the first pick asks who it is for ---------------- */
  r = await add(p, saraSlots[0]);
  check('first pick asks which child', r.status === 302 && String(r.location).includes('/child?slot_id='));
  r = await req(p, 'GET', String(r.location).replace(BASE, ''));
  check('the question page names the time', r.status === 200 && r.text.includes('Who is this appointment for?'));

  r = await req(p, 'POST', `/e/${EVENT}/child`, { slot_id: saraSlots[0], student_name: '', back: `/e/${EVENT}` });
  check('a blank name is refused', r.status === 400 && r.text.includes('enter the child'));

  r = await req(p, 'POST', `/e/${EVENT}/child`, {
    slot_id: saraSlots[0],
    student_name: 'Ahmed Family',
    student_grade: 'Grade 5A',
    back: `/e/${EVENT}/s/${sara.id}`,
  });
  check('naming the child completes the pick', r.status === 302 && String(r.location).endsWith(`/s/${sara.id}`));

  r = await req(p, 'GET', `/e/${EVENT}/s/${sara.id}`);
  check('the picker says who times are for', r.text.includes('Choosing times for') && r.text.includes('Ahmed Family'));
  check('and the held time is marked with the child', /for Ahmed Family/.test(r.text));

  /* ---------------- second pick goes to the same child without asking ---------------- */
  r = await add(p, lauraSlots[2]);
  check('next pick does not ask again', r.status === 302 && !String(r.location).includes('/child'));
  r = await req(p, 'GET', `/e/${EVENT}/review`);
  check('review holds two for the first child', removes(r.text) === 2 && (r.text.match(/Ahmed Family/g) || []).length >= 1);

  /* ---------------- second child ---------------- */
  r = await choose(p, 'Layla Family', 'Grade 4A');
  check('a second child can be named', r.status === 302);
  r = await add(p, lauraSlots[4]);
  r = await req(p, 'GET', `/e/${EVENT}/review`);
  check('review groups by child', r.text.includes('Ahmed Family') && r.text.includes('Layla Family'));
  check('three appointments held', removes(r.text) === 3);
  check('each appointment can be reassigned', r.text.includes('action="/e/' + EVENT + '/assign"'));

  /* ---------------- the same teacher for two children is fine ---------------- */
  r = await add(p, saraSlots[3]); // Sara again, now for Layla
  r = await req(p, 'GET', `/e/${EVENT}/review`);
  check('twins can each see the same teacher', removes(r.text) === 4);

  /* ---------------- but the parent cannot be in two rooms ---------------- */
  // Ahmed holds saraSlots[0]; the same clock time on Laura's sheet, for Layla, must be refused.
  const sameTime = db
    .prepare(
      `SELECT l.id FROM slots l JOIN slots s ON s.slot_date = l.slot_date AND s.start_time = l.start_time
       WHERE s.id = ? AND l.schedule_id = ? AND l.blocked = 0`
    )
    .get(saraSlots[0], laura.id);
  check('there is a matching time on the other sheet', Boolean(sameTime));
  r = await add(p, sameTime.id);
  r = await follow(p, `/e/${EVENT}/review`);
  check('a clash between two children is refused', r.text.includes('You have already chosen') && r.text.includes('for Ahmed Family'));
  check('and nothing was added', removes(r.text) === 4);

  /* ---------------- reassigning ---------------- */
  r = await req(p, 'POST', `/e/${EVENT}/assign`, { slot_id: saraSlots[3], child: '0' });
  r = await req(p, 'GET', `/e/${EVENT}/review`);
  check('reassign moves a time to the other child', r.status === 200);
  // Now Ahmed would see Sara twice - the confirm must say so.
  r = await confirm(p, 'family@example.com');
  check('same teacher twice for one child is refused at confirm',
    r.status === 400 && r.text.includes('one of these teachers for Ahmed Family'), `status ${r.status}`);
  await req(p, 'POST', `/e/${EVENT}/assign`, { slot_id: saraSlots[3], child: '1' });

  /* ---------------- one submission, one confirmation ---------------- */
  r = await confirm(p, 'family@example.com');
  check('the family books in one go', r.status === 302 && String(r.location).includes('/confirmation/'), `status ${r.status}`);
  r = await req(p, 'GET', String(r.location).replace(BASE, ''));
  check('confirmation lists four appointments', (r.text.match(/Manage this appointment/g) || []).length === 4);
  check('confirmation is grouped by child', r.text.includes('Ahmed Family') && r.text.includes('Layla Family'));

  const rows = db
    .prepare("SELECT student_name, student_grade FROM bookings WHERE parent_email = 'family@example.com' AND status = 'booked' ORDER BY student_name")
    .all();
  check('each booking carries its own child', rows.length === 4 && rows.filter((x) => x.student_name === 'Ahmed Family').length === 2);
  check('the grade travelled with the child', rows.some((x) => x.student_grade === 'Grade 5A') && rows.some((x) => x.student_grade === 'Grade 4A'));

  /* ---------------- across submissions, the clash guard is family-wide ---------------- */
  // Come back later for a third child and try to book the time Ahmed already holds.
  const later = jar();
  await choose(later, 'Omar Family');
  r = await add(later, sameTime.id);
  r = await confirm(later, 'family@example.com');
  check('a clash with an earlier booking for a sibling is refused',
    r.status === 400 && r.text.includes('already have an appointment at') && r.text.includes('for Ahmed Family'), `status ${r.status}`);

  // A different time for Omar is fine, and the lookup shows the whole family.
  const free = lauraSlots.find((id) => id !== sameTime.id && id !== lauraSlots[2] && id !== lauraSlots[4]);
  const later2 = jar();
  await choose(later2, 'Omar Family');
  await add(later2, free);
  r = await confirm(later2, 'family@example.com');
  check('a third child can be added in a later visit', r.status === 302, `status ${r.status}`);
  r = await req(jar(), 'POST', '/lookup', { parent_email: 'family@example.com' });
  check('lookup shows the whole family', r.text.includes('5 appointments found'));

  /* ---------------- a teacher sees the right child on each line ---------------- */
  const teacher = jar();
  r = await req(teacher, 'POST', '/staff/login', { email: 'sara.mutairi@example.aca.edu.kw', password: 'Welcome123!' });
  if (r.status === 302) {
    await req(teacher, 'POST', '/staff/password', { new_password: 'SaraPass123', confirm_password: 'SaraPass123' });
  } else {
    await req(teacher, 'POST', '/staff/login', { email: 'sara.mutairi@example.aca.edu.kw', password: 'SaraPass123' });
  }
  r = await req(teacher, 'GET', `/staff/schedule/${sara.id}`);
  check("the teacher's sheet shows both children", r.text.includes('Ahmed Family') && r.text.includes('Layla Family'));

  /* ---------------- an event that collects no student never asks ---------------- */
  const u = jar();
  r = await req(u, 'GET', '/e/uniform-hawally');
  const uSched = Number((r.text.match(/\/s\/(\d+)/) || [])[1]);
  r = await req(u, 'GET', `/e/uniform-hawally/s/${uSched}`);
  const uSlot = slotIdsIn(r.text)[0];
  const collects = db.prepare("SELECT collect_student FROM events WHERE slug = 'uniform-hawally'").get().collect_student;
  r = await req(u, 'POST', '/e/uniform-hawally/select', { slot_id: uSlot, action: 'add' });
  if (collects) {
    check('uniform booking asks for the child because the event collects one', String(r.location).includes('/child'));
  } else {
    check('a counter booking never asks which child', r.status === 302 && !String(r.location).includes('/child'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nFamily test crashed:', err);
  process.exit(1);
});
