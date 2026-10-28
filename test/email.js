'use strict';
/**
 * SMTP settings from the admin console, and who gets mail when.
 *
 * Runs its own app instance against a local SMTP sink, so nothing leaves the
 * machine. Checks the form (password masked, blank box keeps it), the test
 * send, and the rule that matters: parents always, teachers on a booking and
 * on a cancellation by someone else - never for one they made themselves.
 *
 *   node test/email.js
 */
const path = require('path');
const fs = require('fs');
const { SMTPServer } = require('smtp-server');

const APP_PORT = 3300;
const SMTP_PORT = 3301;
const BASE = `http://localhost:${APP_PORT}`;
const DB = path.join(__dirname, '..', 'data', 'email-test.db');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

/* ---------------------- the SMTP sink ---------------------- */

const inbox = []; // { to, from, subject, auth }
let lastAuth = null;
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  authOptional: true,
  onAuth(auth, session, cb) {
    lastAuth = { user: auth.username, pass: auth.password };
    if (auth.username === 'mailer@example.aca.edu.kw' && auth.password === 'app-pass-1234') return cb(null, { user: auth.username });
    return cb(new Error('Invalid login'));
  },
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => { raw += c; });
    stream.on('end', () => {
      const subject = (raw.match(/^Subject: (.*)$/m) || [])[1] || '';
      // The body arrives quoted-printable: undo the soft line breaks and =XX
      // escapes so a phrase can be searched for as written.
      const body = raw
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
      inbox.push({
        to: session.envelope.rcptTo.map((r) => r.address),
        from: session.envelope.mailFrom.address,
        subject: subject.replace(/=\?utf-8\?Q\?(.*)\?=/i, (m, q) => q.replace(/_/g, ' ')),
        body,
      });
      cb();
    });
  },
});

/* ---------------------------- client ---------------------------- */

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

async function pick(j, slug, slotId, child) {
  const r = await req(j, 'POST', `/e/${slug}/select`, { slot_id: slotId, action: 'add' });
  if (r.status === 302 && String(r.location).includes('/child')) {
    await req(j, 'POST', `/e/${slug}/child`, { slot_id: slotId, student_name: child, back: `/e/${slug}` });
  }
  return r;
}

/** Mail is sent after the response; give it a moment. */
async function settle(expected, tries = 30) {
  for (let i = 0; i < tries && inbox.length < expected; i += 1) await new Promise((r) => setTimeout(r, 150));
}
const mailTo = (addr) => inbox.filter((m) => m.to.includes(addr));

/* ------------------------------ run ------------------------------ */

(async () => {
  console.log('Email settings and teacher notifications\n');

  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${DB}${suffix}`, { force: true });
  await new Promise((r) => smtp.listen(SMTP_PORT, r));

  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(APP_PORT),
    BASE_URL: BASE,
    DATABASE_PATH: DB,
    SESSION_SECRET: 'email-test-secret',
    ADMIN_EMAIL: 'admin@example.aca.edu.kw',
    ADMIN_PASSWORD: 'AdminPass123',
    REMINDERS_ENABLED: 'false',
    WATI_API_ENDPOINT: '',
    WATI_ACCESS_TOKEN: '',
    GRAPH_TENANT_ID: '',
    GRAPH_CLIENT_ID: '',
    GRAPH_CLIENT_SECRET: '',
    GRAPH_SENDER: '',
  });

  require('../src/server');
  const { db } = require('../src/db');
  const settings = require('../src/lib/settings');
  await new Promise((r) => setTimeout(r, 400));

  db.exec(`
    INSERT INTO campuses (id, name, slug) VALUES (1, 'ACA Hawally', 'hawally');
    INSERT INTO departments (id, campus_id, name) VALUES (1, 1, 'Elementary — English');
    INSERT INTO staff (id, campus_id, department_id, name, email, role, password_hash, active) VALUES
      (2, 1, 1, 'Sara Al-Mutairi', 'sara@example.aca.edu.kw', 'teacher', NULL, 1);
    INSERT INTO classes (id, staff_id, name) VALUES (1, 2, 'Grade 5A — English');
    INSERT INTO events (id, campus_id, type, name, slug, status, prevent_overlap, max_per_student, allow_cancel, cancel_cutoff_hrs)
      VALUES (1, 1, 'conference', 'PTC Term 1', 'ptc', 'published', 1, 0, 1, 0);
    INSERT INTO schedules (id, event_id, department_id, staff_id, class_id, location) VALUES (1, 1, 1, 2, 1, 'Room B-204');
  `);
  const day = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const ins = db.prepare('INSERT INTO slots (schedule_id, slot_date, start_time, end_time, capacity) VALUES (1, ?, ?, ?, 1)');
  for (const [s, e] of [['15:00', '15:10'], ['15:10', '15:20'], ['15:20', '15:30'], ['15:30', '15:40']]) ins.run(day, s, e);

  /* ---------- the page, before anything is set ---------- */
  const a = jar();
  let r = await req(a, 'POST', '/staff/login', { email: 'admin@example.aca.edu.kw', password: 'AdminPass123' });
  if (r.status === 302) await req(a, 'POST', '/staff/password', { new_password: 'AdminPass123', confirm_password: 'AdminPass123' });

  r = await follow(a, '/admin/email');
  check('email page renders', r.status === 200 && r.text.includes('Mail server (SMTP)'));
  check('starts as not configured', r.text.includes('Not configured'));
  check('the nav links to it', r.text.includes('href="/admin/email"'));

  /* ---------- a booking with no mail set up is still a booking ---------- */
  const early = jar();
  r = await req(early, 'GET', '/e/ptc/s/1');
  const slots = [...r.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]));
  await pick(early, 'ptc', slots[3], 'Early Child');
  r = await req(early, 'POST', '/e/ptc/confirm', { parent_name: 'Early Parent', parent_email: 'early@example.com', parent_phone: '99000000' });
  check('booking works with email off', r.status === 302);
  await new Promise((x) => setTimeout(x, 500));
  const skipped = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE channel = 'email' AND status = 'skipped'").get().n;
  check('and the email is logged as skipped, not failed', skipped >= 1);
  check('nothing reached the server', inbox.length === 0);

  /* ---------- save the settings ---------- */
  r = await req(a, 'POST', '/admin/email', {
    host: 'localhost',
    port: String(SMTP_PORT),
    user: 'mailer@example.aca.edu.kw',
    password: 'app-pass-1234',
    from: 'appointments@example.aca.edu.kw',
    from_name: 'ACA Appointments',
    teacher_on_booking: '1',
    teacher_on_cancel: '1',
  });
  check('settings save', r.status === 302);
  r = await follow(a, '/admin/email');
  check('page reports SMTP in use', r.text.includes('Sending through') && r.text.includes('localhost'));
  check('the password is never echoed', !r.text.includes('app-pass-1234'));
  check('but is known to be stored', r.text.includes('Stored'));

  // A save with the password box left blank keeps the stored one.
  r = await req(a, 'POST', '/admin/email', {
    host: 'localhost', port: String(SMTP_PORT), user: 'mailer@example.aca.edu.kw', password: '',
    from: 'appointments@example.aca.edu.kw', from_name: 'ACA Appointments', teacher_on_booking: '1', teacher_on_cancel: '1',
  });
  settings.refresh();
  check('blank password box keeps the stored one', settings.get('mail.password', '') === 'app-pass-1234');

  /* ---------- test send ---------- */
  r = await req(a, 'POST', '/admin/email/test', { test_to: 'me@example.com' });
  check('test send reports success', r.text.includes('Test sent'), (r.text.match(/Test \w+\.<\/strong> [^<]*/) || [''])[0]);
  await settle(1);
  check('the test reached the server', inbox.length === 1 && inbox[0].to.includes('me@example.com'));
  check('it signed in with the stored credentials', lastAuth && lastAuth.user === 'mailer@example.aca.edu.kw' && lastAuth.pass === 'app-pass-1234');
  check('sent from the configured address', inbox[0] && inbox[0].from === 'appointments@example.aca.edu.kw');

  /* ---------- a real booking: parent and teacher ---------- */
  inbox.length = 0;
  const parent = jar();
  await pick(parent, 'ptc', slots[0], 'Yousef');
  r = await req(parent, 'POST', '/e/ptc/confirm', {
    parent_name: 'Fatima Al-Otaibi', parent_email: 'fatima@example.com', parent_phone: '55667788', notes: 'Reading progress',
  });
  check('booking confirmed', r.status === 302 && String(r.location).includes('/confirmation/'));
  await settle(2);
  check('the parent got a confirmation', mailTo('fatima@example.com').length === 1, `${mailTo('fatima@example.com').length}`);
  check('the teacher got a copy', mailTo('sara@example.aca.edu.kw').length === 1, `${mailTo('sara@example.aca.edu.kw').length}`);
  const teacherMail = mailTo('sara@example.aca.edu.kw')[0] || { subject: '', body: '' };
  check('the copy names the parent', /Fatima/.test(teacherMail.subject));
  check("and carries the parent's note", /Reading progress/.test(teacherMail.body));
  check('and is logged for the admin', db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'staff_copy' AND status = 'sent'").get().n === 1);

  /* ---------- the parent cancels: teacher is told ---------- */
  inbox.length = 0;
  const token = db.prepare("SELECT token FROM bookings WHERE parent_email = 'fatima@example.com'").get().token;
  r = await req(parent, 'POST', `/booking/${token}/cancel`);
  check('parent cancels', r.status === 302 || r.status === 200);
  await settle(2);
  check('the parent gets the cancellation', mailTo('fatima@example.com').length === 1);
  check('and so does the teacher', mailTo('sara@example.aca.edu.kw').length === 1, `${mailTo('sara@example.aca.edu.kw').length}`);
  check('which says the parent did it', /cancelled by the parent/.test((mailTo('sara@example.aca.edu.kw')[0] || {}).body || ''));

  /* ---------- the teacher cancels: not told about their own action ---------- */
  inbox.length = 0;
  const second = jar();
  await pick(second, 'ptc', slots[1], 'Noor');
  await req(second, 'POST', '/e/ptc/confirm', { parent_name: 'Second Parent', parent_email: 'second@example.com', parent_phone: '55111222' });
  await settle(2);
  inbox.length = 0;

  db.prepare("UPDATE staff SET password_hash = ? WHERE id = 2").run(require('../src/lib/auth').hashPassword('SaraPass123'));
  const teacher = jar();
  r = await req(teacher, 'POST', '/staff/login', { email: 'sara@example.aca.edu.kw', password: 'SaraPass123' });
  check('teacher signs in', r.status === 302, `status ${r.status}`);
  const bid = db.prepare("SELECT id FROM bookings WHERE parent_email = 'second@example.com'").get().id;
  r = await req(teacher, 'POST', `/staff/booking/${bid}/cancel`);
  await settle(1);
  check('the parent is told', mailTo('second@example.com').length === 1);
  check('the teacher is not emailed about their own cancellation', mailTo('sara@example.aca.edu.kw').length === 0, `${mailTo('sara@example.aca.edu.kw').length}`);

  /* ---------- the office cancels: teacher is told ---------- */
  inbox.length = 0;
  const third = jar();
  await pick(third, 'ptc', slots[2], 'Dana');
  await req(third, 'POST', '/e/ptc/confirm', { parent_name: 'Third Parent', parent_email: 'third@example.com', parent_phone: '55333444' });
  await settle(2);
  inbox.length = 0;
  const bid3 = db.prepare("SELECT id FROM bookings WHERE parent_email = 'third@example.com'").get().id;
  await req(a, 'POST', `/staff/booking/${bid3}/cancel`);
  await settle(2);
  check('an office cancellation reaches the teacher', mailTo('sara@example.aca.edu.kw').length === 1);
  check('and says the office did it', /cancelled by the office/.test((mailTo('sara@example.aca.edu.kw')[0] || {}).body || ''));

  /* ---------- switch the teacher copy off ---------- */
  await req(a, 'POST', '/admin/email', {
    host: 'localhost', port: String(SMTP_PORT), user: 'mailer@example.aca.edu.kw', password: '',
    from: 'appointments@example.aca.edu.kw', from_name: 'ACA Appointments', teacher_on_booking: '', teacher_on_cancel: '',
  });
  inbox.length = 0;
  const fourth = jar();
  await pick(fourth, 'ptc', slots[3], 'Lina');
  // slots[3] is held by the early booking; cancel it first so the time is free
  const earlyToken = db.prepare("SELECT token FROM bookings WHERE parent_email = 'early@example.com'").get().token;
  await req(early, 'POST', `/booking/${earlyToken}/cancel`);
  await settle(1);
  inbox.length = 0;
  r = await req(fourth, 'POST', '/e/ptc/confirm', { parent_name: 'Fourth Parent', parent_email: 'fourth@example.com', parent_phone: '55444555' });
  await settle(1);
  await new Promise((x) => setTimeout(x, 400));
  check('with the switch off, the parent still gets mail', mailTo('fourth@example.com').length === 1, `${mailTo('fourth@example.com').length}`);
  check('but the teacher does not', mailTo('sara@example.aca.edu.kw').length === 0, `${mailTo('sara@example.aca.edu.kw').length}`);

  /* ---------- wrong password is reported, not hidden ---------- */
  await req(a, 'POST', '/admin/email', {
    host: 'localhost', port: String(SMTP_PORT), user: 'mailer@example.aca.edu.kw', password: 'wrong',
    from: 'appointments@example.aca.edu.kw', from_name: 'ACA Appointments',
  });
  r = await req(a, 'POST', '/admin/email/test', { test_to: 'me@example.com' });
  check('a rejected login is shown on the page', r.text.includes('Test failed') && /Invalid login/i.test(r.text));

  /* ---------- only an admin ---------- */
  r = await req(teacher, 'GET', '/admin/email');
  check('a teacher cannot open the email settings', r.status === 403 || r.status === 302);

  console.log(`\n${pass} passed, ${fail} failed`);
  smtp.close();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nEmail test crashed:', err);
  smtp.close();
  process.exit(1);
});
