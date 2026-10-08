'use strict';
/**
 * WhatsApp settings form and the single-summary message.
 *
 * Runs its own app instance on port 3200 against a throwaway database, with a
 * mock WATI server standing in for the real one, so the whole path — admin form
 * → stored settings → outgoing template call — is exercised without credentials.
 *
 *   node test/messaging.js
 */
const http = require('http');
const path = require('path');
const fs = require('fs');

const APP_PORT = 3200;
const WATI_PORT = 3201;
const BASE = `http://localhost:${APP_PORT}`;
const DB = path.join(__dirname, '..', 'data', 'messaging-test.db');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

/* ------------------------- mock WATI server ------------------------- */

const received = [];
let failNext = false;

const watiServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${WATI_PORT}`);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!url.pathname.endsWith('/sendTemplateMessage')) {
      res.writeHead(404);
      return res.end('not found');
    }
    let payload = {};
    try { payload = JSON.parse(body); } catch (_) { /* ignore */ }
    received.push({
      number: url.searchParams.get('whatsappNumber'),
      auth: req.headers.authorization,
      template: payload.template_name,
      params: (payload.parameters || []).map((p) => p.value),
    });
    if (failNext) {
      failNext = false;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: false, info: 'Template not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ result: true }));
  });
});

/* ----------------------------- client ------------------------------ */

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
      if (Array.isArray(v)) v.forEach((i) => params.append(k, String(i)));
      else params.append(k, String(v));
    }
    payload = params.toString();
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status === 302 ? '' : await res.text();
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

const settle = () => new Promise((r) => setTimeout(r, 600));

/* ------------------------------- run ------------------------------- */

(async () => {
  console.log('WhatsApp settings and summary message\n');

  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${DB}${suffix}`, { force: true });
  await new Promise((r) => watiServer.listen(WATI_PORT, r));

  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(APP_PORT),
    BASE_URL: BASE,
    DATABASE_PATH: DB,
    SESSION_SECRET: 'messaging-test-secret',
    ADMIN_EMAIL: 'admin@example.aca.edu.kw',
    ADMIN_PASSWORD: 'AdminPass123',
    REMINDERS_ENABLED: 'false',
    WATI_API_ENDPOINT: '',
    WATI_ACCESS_TOKEN: '',
    GRAPH_TENANT_ID: '',
  });

  require('../src/server');
  const { db } = require('../src/db');
  const settings = require('../src/lib/settings');
  await new Promise((r) => setTimeout(r, 400));

  // Minimal data: one campus, one event, two teachers with a class each.
  db.exec(`
    INSERT INTO campuses (id, name, slug) VALUES (1, 'ACA Hawally', 'hawally');
    INSERT INTO departments (id, campus_id, name) VALUES (1, 1, 'Elementary — English');
    INSERT INTO staff (id, campus_id, department_id, name, email, role) VALUES
      (2, 1, 1, 'Sara Al-Mutairi', 'sara@example.aca.edu.kw', 'teacher'),
      (3, 1, 1, 'Laura Bennett', 'laura@example.aca.edu.kw', 'teacher');
    INSERT INTO classes (id, staff_id, name) VALUES (1, 2, 'Grade 5A — English'), (2, 3, 'Grade 4A — English');
    INSERT INTO events (id, campus_id, type, name, slug, status, prevent_overlap, max_per_student)
      VALUES (1, 1, 'conference', 'PTC Term 1', 'ptc', 'published', 1, 0);
    INSERT INTO schedules (id, event_id, department_id, staff_id, class_id, location) VALUES
      (1, 1, 1, 2, 1, 'Room B-204'), (2, 1, 1, 3, 2, 'Room A-101');
  `);

  const day = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const insertSlot = db.prepare('INSERT INTO slots (schedule_id, slot_date, start_time, end_time, capacity) VALUES (?, ?, ?, ?, 1)');
  for (const scheduleId of [1, 2]) {
    for (const [s, e] of [['15:00', '15:10'], ['15:10', '15:20'], ['15:20', '15:30']]) {
      insertSlot.run(scheduleId, day, s, e);
    }
  }

  /* ---------- the form ---------- */
  const a = jar();
  let r = await req(a, 'POST', '/staff/login', { email: 'admin@example.aca.edu.kw', password: 'AdminPass123' });
  if (r.status === 302) await req(a, 'POST', '/staff/password', { new_password: 'AdminPass123', confirm_password: 'AdminPass123' });

  r = await follow(a, '/admin/messaging');
  check('messaging page renders', r.status === 200 && r.text.includes('WhatsApp messaging'));
  check('starts as not configured', r.text.includes('Not configured'));
  check('template parameter reference is shown', r.text.includes('The appointment(s), on one line'));
  check('the four-variable limit is explained', r.text.includes('same four variables'));
  check('the no-trailing-variable rule is explained', r.text.includes('ends') && r.text.includes('with a variable'));

  r = await req(a, 'POST', '/admin/messaging', {
    endpoint: `http://localhost:${WATI_PORT}/`,
    token: 'test-token-abcd',
    country_code: '965',
    template_summary: 'appointment_summary',
    template_cancellation: 'appointment_cancelled',
  });
  check('settings save', r.status === 302);

  r = await follow(a, '/admin/messaging');
  check('page now reports connected', r.text.includes('Connected'));
  check('trailing slash stripped from endpoint', settings.get('wati.endpoint', '') === `http://localhost:${WATI_PORT}`);
  check('token is masked, never echoed', !r.text.includes('test-token-abcd') && r.text.includes('••••'));

  // Saving again with an empty token box must not wipe the stored one.
  r = await req(a, 'POST', '/admin/messaging', {
    endpoint: `http://localhost:${WATI_PORT}`,
    token: '',
    country_code: '965',
    template_summary: 'appointment_summary',
  });
  settings.refresh();
  check('blank token box keeps the stored token', settings.get('wati.token', '') === 'test-token-abcd');

  /* ---------- test send ---------- */
  received.length = 0;
  r = await req(a, 'POST', '/admin/messaging/test', { test_phone: '99887766', test_template: 'appointment_summary' });
  check('test send reports success', r.text.includes('Test sent'));
  check('test reached the API', received.length === 1, `${received.length}`);
  check('country code was applied', received[0] && received[0].number === '96599887766');
  check('token sent as a bearer', received[0] && received[0].auth === 'Bearer test-token-abcd');

  received.length = 0;
  failNext = true;
  r = await req(a, 'POST', '/admin/messaging/test', { test_phone: '99887766', test_template: 'nope' });
  check('a rejected send is reported, not swallowed', r.text.includes('Test failed') && r.text.includes('Template not found'));

  /* ---------- one summary for a multi-teacher booking ---------- */
  received.length = 0;
  const parent = jar();
  r = await req(parent, 'GET', '/e/ptc/s/1');
  const slotsOne = [...r.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]));
  r = await req(parent, 'GET', '/e/ptc/s/2');
  const slotsTwo = [...r.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]));

  await req(parent, 'POST', '/e/ptc/select', { slot_id: slotsOne[0], action: 'add' });
  await req(parent, 'POST', '/e/ptc/select', { slot_id: slotsTwo[1], action: 'add' });
  await req(parent, 'POST', '/e/ptc/select', { slot_id: slotsTwo[2], action: 'add' });

  r = await req(parent, 'POST', '/e/ptc/confirm', {
    parent_name: 'Fatima Al-Otaibi',
    parent_email: 'fatima@example.com',
    parent_phone: '55667788',
    student_name: 'Yousef',
    student_grade: '5',
  });
  check('three appointments booked', r.status === 302 && String(r.location).includes('/confirmation/'));

  await settle();
  check('exactly one WhatsApp went out', received.length === 1, `${received.length} message(s)`);

  const msg = received[0] || { params: [] };
  check('summary template was used', msg.template === 'appointment_summary');
  check('exactly four parameters — WATI allows no more', msg.params.length === 4, `${msg.params.length}`);
  check('parent name is first', msg.params[0] === 'Fatima Al-Otaibi');
  check('event carries the campus', (msg.params[1] || '').includes('PTC Term 1') && (msg.params[1] || '').includes('ACA Hawally'));
  check('all three appointments are in one parameter',
    (msg.params[2] || '').split('·').length === 3, msg.params[2]);
  check('the list names both teachers', (msg.params[2] || '').includes('Sara Al-Mutairi') && (msg.params[2] || '').includes('Laura Bennett'));
  check('the room is included', (msg.params[2] || '').includes('Room B-204'));
  check('no newlines in any parameter', msg.params.every((p) => !/[\r\n\t]/.test(p)));
  check('last parameter links to all of them', /\/confirmation\/[A-Za-z0-9_-]+$/.test(msg.params[3] || ''));

  /* ---------- the log records it ---------- */
  r = await req(a, 'GET', '/admin/notifications');
  check('summary appears in the message log', r.text.includes('summary'));
  check('log shows the appointment count', r.text.includes('3 appointment(s)'));

  /* ---------- falling back when no summary template is set ---------- */
  received.length = 0;
  settings.set('wati.template.summary', '');
  settings.set('wati.template.confirmation', 'appointment_confirmed');

  const parent2 = jar();
  r = await req(parent2, 'GET', '/e/ptc/s/1');
  const more = [...r.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]));
  await req(parent2, 'POST', '/e/ptc/select', { slot_id: more[0], action: 'add' });
  await req(parent2, 'POST', '/e/ptc/select', { slot_id: more[1], action: 'add' });
  r = await req(parent2, 'POST', '/e/ptc/confirm', {
    parent_name: 'Second Parent',
    parent_email: 'second@example.com',
    parent_phone: '55111222',
    student_name: 'Noor',
  });
  check('second family booked two', r.status === 302);
  await settle();
  check('without a summary template it sends one each', received.length === 2, `${received.length}`);
  check('fallback uses the single-confirmation template', received.every((m) => m.template === 'appointment_confirmed'));
  check('per-appointment messages also use four parameters', received.every((m) => m.params.length === 4));
  check('each names one appointment only', received.every((m) => !(m.params[2] || '').includes('·')));
  check('each carries its own cancel link', received.every((m) => /\/booking\/[A-Za-z0-9_-]+$/.test(m.params[3] || '')));

  /* ---------- turning it off ---------- */
  received.length = 0;
  settings.set('wati.endpoint', '');
  settings.set('wati.token', '');
  const parent3 = jar();
  r = await req(parent3, 'GET', '/e/ptc/s/2');
  const last = [...r.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]));
  await req(parent3, 'POST', '/e/ptc/select', { slot_id: last[0], action: 'add' });
  r = await req(parent3, 'POST', '/e/ptc/confirm', {
    parent_name: 'Third Parent',
    parent_email: 'third@example.com',
    parent_phone: '55333444',
    student_name: 'Dana',
  });
  check('booking still works with WhatsApp off', r.status === 302);
  await settle();
  check('nothing was sent', received.length === 0);
  r = await req(a, 'GET', '/admin/notifications');
  check('the skip is recorded', r.text.includes('skipped'));

  /* ---------- access control ---------- */
  const anon = jar();
  r = await req(anon, 'GET', '/admin/messaging');
  check('settings page needs a sign-in', r.status === 302 && String(r.location).includes('/staff/login'));

  console.log(`\n${pass} passed, ${fail} failed`);
  watiServer.close();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nMessaging test crashed:', err);
  watiServer.close();
  process.exit(1);
});
