'use strict';
/**
 * End-to-end smoke test against a running server (default http://localhost:3000).
 * Exercises the parent flow, the booking rules, staff sign-in and admin exports.
 *   node test/smoke.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:3000';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** A tiny cookie jar so each "parent" is an independent session. */
function jar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
    },
  };
}

async function req(j, method, path, body) {
  const headers = { Cookie: j.header() };
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status === 302 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

async function follow(j, path) {
  let current = path;
  for (let i = 0; i < 5; i += 1) {
    const r = await req(j, 'GET', current);
    if (r.status === 302 && r.location) {
      current = r.location.replace(BASE, '');
      continue;
    }
    return r;
  }
  throw new Error('too many redirects');
}

/** Scrape slot ids out of the rendered slot picker. */
function slotIds(html) {
  return [...html.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]));
}

(async () => {
  console.log(`Smoke test against ${BASE}\n`);

  /* ---------------- public pages ---------------- */
  const p = jar();
  let r = await req(p, 'GET', '/');
  check('home page renders', r.status === 200 && r.text.includes('Book an appointment'));
  check('home lists a campus', r.text.includes('ACA Hawally'));

  r = await req(p, 'GET', '/e/ptc-term1-hawally');
  check('conference event shows departments', r.status === 200 && r.text.includes('Choose a department'));

  const deptId = (r.text.match(/\/d\/(\d+)/) || [])[1];
  check('a department link exists', Boolean(deptId));

  r = await req(p, 'GET', `/e/ptc-term1-hawally/d/${deptId}`);
  check('department page lists teachers', r.status === 200 && /Grade \d/.test(r.text));

  const schedIds = [...r.text.matchAll(/\/s\/(\d+)"/g)].map((m) => Number(m[1]));
  check('teacher schedules listed', schedIds.length >= 2, `found ${schedIds.length}`);

  /* ---------------- pick two slots ---------------- */
  r = await req(p, 'GET', `/e/ptc-term1-hawally/s/${schedIds[0]}`);
  const slotsA = slotIds(r.text);
  check('slot picker shows free times', slotsA.length > 5, `found ${slotsA.length}`);

  r = await req(p, 'GET', `/e/ptc-term1-hawally/s/${schedIds[1]}`);
  const slotsB = slotIds(r.text);

  await req(p, 'POST', '/e/ptc-term1-hawally/select', { slot_id: slotsA[0], action: 'add' });
  await req(p, 'POST', '/e/ptc-term1-hawally/select', { slot_id: slotsB[1], action: 'add' });

  r = await req(p, 'GET', '/e/ptc-term1-hawally/review');
  check('review page lists both selections', (r.text.match(/Remove<\/button>/g) || []).length === 2);

  /* ---------------- overlap rule ---------------- */
  const overlapJar = jar();
  await req(overlapJar, 'POST', '/e/ptc-term1-hawally/select', { slot_id: slotsA[0], action: 'add' });
  await req(overlapJar, 'POST', '/e/ptc-term1-hawally/select', { slot_id: slotsB[0], action: 'add' });
  r = await req(overlapJar, 'POST', '/e/ptc-term1-hawally/confirm', {
    parent_name: 'Overlap Tester',
    parent_email: 'overlap@example.com',
    parent_phone: '99000000',
    student_name: 'Overlap Child',
  });
  check('overlapping times are rejected', r.status === 400 && r.text.includes('same time'));

  /* ---------------- validation ---------------- */
  r = await req(p, 'POST', '/e/ptc-term1-hawally/confirm', {
    parent_name: '',
    parent_email: 'not-an-email',
    student_name: '',
  });
  check('missing details are rejected', r.status === 400 && r.text.includes('valid email'));

  /* ---------------- successful booking ---------------- */
  r = await req(p, 'POST', '/e/ptc-term1-hawally/confirm', {
    parent_name: 'Zuhair Test',
    parent_email: 'parent@example.com',
    parent_phone: '99112233',
    student_name: 'Yousef Test',
    student_grade: '5',
    notes: 'Reading progress',
  });
  check('booking submitted', r.status === 302 && String(r.location).includes('/confirmation/'));

  const confirmPath = String(r.location).replace(BASE, '');
  r = await req(p, 'GET', confirmPath);
  check('confirmation page renders', r.status === 200 && r.text.includes("You're booked"));
  check('confirmation shows both appointments', (r.text.match(/Manage this appointment/g) || []).length === 2);

  const manageToken = (r.text.match(/\/booking\/([A-Za-z0-9_-]+)"/) || [])[1];
  check('manage link present', Boolean(manageToken));

  /* ---------------- double-booking a taken slot ---------------- */
  const rival = jar();
  await req(rival, 'POST', '/e/ptc-term1-hawally/select', { slot_id: slotsA[0], action: 'add' });
  r = await req(rival, 'POST', '/e/ptc-term1-hawally/confirm', {
    parent_name: 'Rival Parent',
    parent_email: 'rival@example.com',
    parent_phone: '99445566',
    student_name: 'Rival Child',
  });
  check('a taken slot cannot be double-booked', r.status === 400 || r.status === 409, `status ${r.status}`);

  /* ---------------- same teacher twice ---------------- */
  const again = jar();
  await req(again, 'POST', '/e/ptc-term1-hawally/select', { slot_id: slotsA[3], action: 'add' });
  r = await req(again, 'POST', '/e/ptc-term1-hawally/confirm', {
    parent_name: 'Zuhair Test',
    parent_email: 'parent@example.com',
    parent_phone: '99112233',
    student_name: 'Yousef Test',
  });
  check('same student cannot book one teacher twice', r.status === 400 && r.text.includes('already have an appointment with one of these teachers'));

  /* ---------------- lookup ---------------- */
  r = await req(p, 'POST', '/lookup', { parent_email: 'parent@example.com' });
  check('lookup finds the bookings', r.status === 200 && r.text.includes('2 appointments found'));

  /* ---------------- cancel ---------------- */
  r = await req(p, 'GET', `/booking/${manageToken}`);
  check('manage page renders', r.status === 200 && r.text.includes('Cancel appointment'));
  r = await req(p, 'POST', `/booking/${manageToken}/cancel`);
  check('cancel redirects', r.status === 302);
  r = await follow(p, `/booking/${manageToken}`);
  check('booking now shows cancelled', r.text.includes('cancelled'));

  /* ---------------- the released slot is bookable again ---------------- */
  const second = jar();
  r = await req(second, 'GET', `/e/ptc-term1-hawally/s/${schedIds[0]}`);
  check('cancelled slot returns to the picker', slotIds(r.text).includes(slotsA[0]));

  /* ---------------- uniform event (capacity > 1) ---------------- */
  const u = jar();
  r = await req(u, 'GET', '/e/uniform-hawally');
  check('uniform event lists counters', r.status === 200 && r.text.includes('Uniform counter 1'));
  const uSched = Number((r.text.match(/\/s\/(\d+)/) || [])[1]);
  r = await req(u, 'GET', `/e/uniform-hawally/s/${uSched}`);
  const uSlots = slotIds(r.text);
  check('counter slots show remaining places', r.text.includes('left'));
  await req(u, 'POST', '/e/uniform-hawally/select', { slot_id: uSlots[0], action: 'add' });
  r = await req(u, 'POST', '/e/uniform-hawally/confirm', {
    parent_name: 'Uniform Parent',
    parent_email: 'uniform@example.com',
    parent_phone: '55667788',
    student_name: 'Uniform Child',
  });
  check('uniform booking succeeds', r.status === 302 && String(r.location).includes('/confirmation/'));

  const u2 = jar();
  await req(u2, 'POST', '/e/uniform-hawally/select', { slot_id: uSlots[0], action: 'add' });
  r = await req(u2, 'POST', '/e/uniform-hawally/confirm', {
    parent_name: 'Second Parent',
    parent_email: 'uniform2@example.com',
    parent_phone: '55667799',
    student_name: 'Second Child',
  });
  check('a second parent fits in the same counter slot', r.status === 302);

  /* ---------------- staff portal ---------------- */
  const s = jar();
  r = await req(s, 'POST', '/staff/login', { email: 'sara.mutairi@example.aca.edu.kw', password: 'Welcome123!' });
  check('teacher can sign in', r.status === 302);
  r = await follow(s, '/staff');
  check('teacher lands on password change (temp password)', r.text.includes('Change password'));
  r = await req(s, 'POST', '/staff/password', { new_password: 'TeacherPass1', confirm_password: 'TeacherPass1' });
  check('teacher sets a password', r.status === 302);
  r = await follow(s, '/staff');
  check('teacher dashboard lists schedules', r.text.includes('My schedules'));
  const teacherSchedule = Number((r.text.match(/\/staff\/schedule\/(\d+)/) || [])[1]);
  r = await req(s, 'GET', `/staff/schedule/${teacherSchedule}`);
  check('teacher schedule page renders', r.status === 200 && r.text.includes('Slots &amp; bookings'));
  r = await req(s, 'POST', `/staff/schedule/${teacherSchedule}/lock`, { locked: '1' });
  check('teacher can lock the sheet', r.status === 302);

  const locked = jar();
  r = await req(locked, 'GET', `/e/ptc-term1-hawally/s/${teacherSchedule}`);
  await req(locked, 'POST', '/e/ptc-term1-hawally/select', { slot_id: slotIds(r.text)[0], action: 'add' });
  r = await req(locked, 'POST', '/e/ptc-term1-hawally/confirm', {
    parent_name: 'Late Parent',
    parent_email: 'late@example.com',
    parent_phone: '99887766',
    student_name: 'Late Child',
  });
  check('locked schedule refuses new bookings', r.status === 400 && r.text.includes('closed their schedule'));
  await req(s, 'POST', `/staff/schedule/${teacherSchedule}/lock`, { locked: '0' });

  r = await req(s, 'GET', `/staff/schedule/${teacherSchedule}/export.csv`);
  check('teacher CSV export works', r.status === 200 && r.text.includes('Parent'));
  r = await req(s, 'GET', `/staff/schedule/${teacherSchedule}/print`);
  check('printable sheet renders', r.status === 200 && r.text.includes('Signature'));

  /* ---------------- admin ---------------- */
  const a = jar();
  r = await req(a, 'POST', '/staff/login', { email: process.env.ADMIN_EMAIL || 'zuhair@sama.com.kw', password: process.env.ADMIN_PASSWORD || 'Test1234!' });
  check('admin can sign in', r.status === 302);
  r = await follow(a, '/admin');
  check('temporary password blocks the admin area', r.text.includes('Change password'));
  await req(a, 'POST', '/staff/password', { new_password: 'AdminPass123', confirm_password: 'AdminPass123' });
  r = await follow(a, '/admin');
  check('admin dashboard renders', r.text.includes('Events'));
  r = await req(a, 'GET', '/admin/campuses');
  check('campuses page renders', r.status === 200 && r.text.includes('Departments'));
  r = await req(a, 'GET', '/admin/staff');
  check('staff page renders', r.status === 200 && r.text.includes('Add or update a staff member'));
  r = await req(a, 'GET', '/admin/events/1');
  check('event detail renders', r.status === 200 && r.text.includes('Generate slots across schedules'));
  r = await req(a, 'GET', '/admin/events/1/report');
  check('report renders', r.status === 200 && r.text.includes('Fill rate by schedule'));
  r = await req(a, 'GET', '/admin/events/1/export.csv');
  check('event CSV export works', r.status === 200 && r.text.includes('Parent'));
  r = await req(a, 'GET', '/admin/notifications');
  check('message log renders', r.status === 200 && r.text.includes('Message log'));

  /* ---------------- access control ---------------- */
  const anon = jar();
  r = await req(anon, 'GET', '/admin');
  check('admin area requires sign-in', r.status === 302 && String(r.location).includes('/staff/login'));
  r = await req(s, 'GET', '/admin/campuses');
  check('teacher cannot reach admin', r.status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
