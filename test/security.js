'use strict';
/**
 * Security checks: headers, cross-site requests, sign-in throttling, session
 * renewal, the campus-admin boundary, upload sniffing, escaped output and the
 * parent lookup not handing one family's links to another.
 *
 * Run against a freshly seeded server: npm run seed && node test/security.js
 */
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'zuhair@sama.com.kw';
const TEACHER = 'sara.mutairi@example.aca.edu.kw';

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
    get(name) { return c.get(name); },
    absorb(res) {
      for (const s of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [p] = s.split(';');
        const i = p.indexOf('=');
        c.set(p.slice(0, i), p.slice(i + 1));
      }
    },
  };
}

async function req(j, method, p, body, extraHeaders = {}) {
  const headers = { Cookie: j.header(), ...extraHeaders };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
}

async function signIn(email, firstPw, newPassword) {
  const j = jar();
  let r = await req(j, 'POST', '/staff/login', { email, password: firstPw });
  if (r.status !== 302) {
    r = await req(j, 'POST', '/staff/login', { email, password: newPassword });
    if (r.status !== 302) throw new Error(`cannot sign in as ${email} (${r.status})`);
    return j;
  }
  if (String(r.location).includes('/staff/password')) {
    await req(j, 'POST', '/staff/password', { new_password: newPassword, confirm_password: newPassword });
  }
  return j;
}

const refused = (r) => r.status === 403 || r.status === 429 || (r.status === 302 && /\/staff\/login|\/admin\/staff$|\/admin$/.test(String(r.location)) && false);

(async () => {
  console.log(`Security checks, against ${BASE}\n`);

  process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
  const { db } = require('../src/db');
  const { hashPassword } = require('../src/lib/auth');

  /* ------------------------------ headers ------------------------------ */
  let r = await req(jar(), 'GET', '/');
  check('Content-Security-Policy is set', String(r.headers.get('content-security-policy')).includes("frame-ancestors 'none'"));
  check('X-Frame-Options denies framing', r.headers.get('x-frame-options') === 'DENY');
  check('nosniff is set', r.headers.get('x-content-type-options') === 'nosniff');
  check('a referrer policy is set', Boolean(r.headers.get('referrer-policy')));
  check('nothing identifies the framework', !r.headers.get('x-powered-by'));
  check('the session cookie is HttpOnly and SameSite', (() => {
    const set = r.headers.getSetCookie ? r.headers.getSetCookie().join(' ') : '';
    return !set || (/HttpOnly/i.test(set) && /SameSite=Lax/i.test(set));
  })());

  /* --------------------- cross-site requests refused --------------------- */
  const anon = jar();
  r = await req(anon, 'POST', '/lookup', { parent_email: 'parent@example.com' }, { Origin: 'https://evil.example' });
  check('a POST from another site is refused', r.status === 403, `status ${r.status}`);
  r = await req(anon, 'POST', '/lookup', { parent_email: 'parent@example.com' }, { Referer: 'https://evil.example/page' });
  check('a POST with a foreign Referer is refused', r.status === 403, `status ${r.status}`);
  r = await req(anon, 'POST', '/lookup', { parent_email: 'parent@example.com' }, { Origin: 'null' });
  check('an opaque Origin is refused', r.status === 403, `status ${r.status}`);
  r = await req(anon, 'POST', '/lookup', { parent_email: 'parent@example.com' }, { Origin: BASE });
  check('the same site goes through', r.status === 200, `status ${r.status}`);
  r = await req(anon, 'GET', '/lookup', null, { Origin: 'https://evil.example' });
  check('GET is never blocked by it', r.status === 200);

  /* ---------------------- sign-in throttling & session ---------------------- */
  const probe = jar();
  await req(probe, 'GET', '/staff/login');
  const sidBefore = probe.get('aca.sid');
  let last;
  const victim = `nobody.${Date.now()}@example.aca.edu.kw`; // fresh each run: the limiter lives in server memory
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await req(probe, 'POST', '/staff/login', { email: victim, password: 'wrong' });
  }
  check('wrong passwords are refused', last.status === 401);
  r = await req(probe, 'POST', '/staff/login', { email: victim, password: 'wrong' });
  check('the account is throttled after ten failures', r.status === 429 && r.headers.get('retry-after'), `status ${r.status}`);
  check('the throttling is on the record', Boolean(db.prepare("SELECT id FROM audit_log WHERE action = 'login_throttled' ORDER BY id DESC LIMIT 1").get()));
  check('and so is each failure', db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login_failed'").get().n >= 10);

  r = await req(probe, 'POST', '/staff/login', { email: TEACHER, password: 'Welcome123!' });
  if (r.status !== 302) r = await req(probe, 'POST', '/staff/login', { email: TEACHER, password: 'SaraPass123' });
  check('another account still signs in from the same address', r.status === 302, `status ${r.status}`);
  check('the session id changes at sign-in', probe.get('aca.sid') && probe.get('aca.sid') !== sidBefore);
  r = await req(probe, 'GET', '/staff');
  check('and the new session is signed in', r.status === 200 || (r.status === 302 && String(r.location).includes('/staff/password')));

  /* ------------------------ the campus-admin boundary ------------------------ */
  const admin = await signIn(ADMIN_EMAIL, process.env.ADMIN_PASSWORD || 'Test1234!', 'AdminPass123');
  const adminRow = db.prepare('SELECT * FROM staff WHERE email = ?').get(ADMIN_EMAIL.toLowerCase());
  const hawally = db.prepare("SELECT id FROM campuses WHERE slug = 'hawally'").get().id;
  const salmiya = db.prepare("SELECT id FROM campuses WHERE slug = 'salmiya'").get().id;
  db.prepare('DELETE FROM staff WHERE email = ?').run('campusadmin.sec@example.aca.edu.kw');
  db.prepare(
    `INSERT INTO staff (campus_id, name, email, role, password_hash, must_change_pw, active)
     VALUES (?, 'Salmiya Admin (sec)', 'campusadmin.sec@example.aca.edu.kw', 'campus_admin', ?, 0, 1)`
  ).run(salmiya, hashPassword('CampusPass123'));
  const campusAdmin = await signIn('campusadmin.sec@example.aca.edu.kw', 'CampusPass123', 'CampusPass123');
  const sara = db.prepare('SELECT * FROM staff WHERE email = ?').get(TEACHER); // Hawally
  const omar = db.prepare('SELECT * FROM staff WHERE email = ?').get('omar.khalid@example.aca.edu.kw'); // Salmiya

  const hashBefore = adminRow.password_hash;
  r = await req(campusAdmin, 'POST', `/admin/staff/${adminRow.id}/reset-password`);
  check('a campus admin cannot reset the administrator’s password', r.status === 403 && db.prepare('SELECT password_hash FROM staff WHERE id = ?').get(adminRow.id).password_hash === hashBefore, `status ${r.status}`);
  r = await req(campusAdmin, 'POST', `/admin/staff/${sara.id}/reset-password`);
  check('nor a password on another campus', r.status === 403 && db.prepare('SELECT password_hash FROM staff WHERE id = ?').get(sara.id).password_hash === sara.password_hash, `status ${r.status}`);
  r = await req(campusAdmin, 'POST', `/admin/staff/${omar.id}/reset-password`);
  check('but can on their own campus', r.status === 302 && db.prepare('SELECT password_hash FROM staff WHERE id = ?').get(omar.id).password_hash !== omar.password_hash, `status ${r.status}`);
  db.prepare('UPDATE staff SET password_hash = ?, must_change_pw = 0 WHERE id = ?').run(omar.password_hash, omar.id);

  r = await req(campusAdmin, 'POST', '/admin/staff', { email: 'newadmin.sec@example.aca.edu.kw', name: 'Sneaky', role: 'admin', campus_id: String(salmiya) });
  check('a campus admin cannot create an administrator', !db.prepare('SELECT id FROM staff WHERE email = ?').get('newadmin.sec@example.aca.edu.kw'));
  r = await req(campusAdmin, 'POST', '/admin/staff', { email: 'newteacher.sec@example.aca.edu.kw', name: 'Elsewhere', role: 'teacher', campus_id: String(hawally) });
  check('nor a teacher on another campus', !db.prepare('SELECT id FROM staff WHERE email = ?').get('newteacher.sec@example.aca.edu.kw'));
  r = await req(campusAdmin, 'POST', '/admin/staff', { email: ADMIN_EMAIL, name: 'Renamed', role: 'teacher', campus_id: String(salmiya) });
  check('nor demote or move the administrator', db.prepare('SELECT role, name FROM staff WHERE id = ?').get(adminRow.id).role === 'admin');
  r = await req(campusAdmin, 'POST', '/admin/staff', { email: 'newteacher.sec@example.aca.edu.kw', name: 'Mine', role: 'teacher', campus_id: String(salmiya) });
  check('but can add a teacher on their own campus', Boolean(db.prepare('SELECT id FROM staff WHERE email = ?').get('newteacher.sec@example.aca.edu.kw')));
  db.prepare('DELETE FROM staff WHERE email = ?').run('newteacher.sec@example.aca.edu.kw');

  r = await req(campusAdmin, 'GET', `/admin/staff/${sara.id}`);
  check('a staff page on another campus is refused', r.status === 403, `status ${r.status}`);
  r = await req(campusAdmin, 'POST', `/admin/staff/${sara.id}/toggle`);
  check('deactivating across campuses is refused', r.status === 403 && db.prepare('SELECT active FROM staff WHERE id = ?').get(sara.id).active === 1);
  r = await req(campusAdmin, 'POST', '/admin/classes', { staff_id: String(sara.id), name: 'Smuggled class' });
  check('adding a class to another campus’s teacher is refused', r.status === 403 && !db.prepare("SELECT id FROM classes WHERE name = 'Smuggled class'").get());
  const saraClass = db.prepare('SELECT id FROM classes WHERE staff_id = ? LIMIT 1').get(sara.id);
  r = await req(campusAdmin, 'POST', `/admin/classes/${saraClass.id}/delete`);
  check('deleting another campus’s class is refused', r.status === 403 && Boolean(db.prepare('SELECT id FROM classes WHERE id = ?').get(saraClass.id)));

  const hawallyBooking = db
    .prepare(`SELECT b.id FROM bookings b JOIN events e ON e.id = b.event_id WHERE e.campus_id = ? AND b.status = 'booked' LIMIT 1`)
    .get(hawally);
  if (hawallyBooking) {
    r = await req(campusAdmin, 'POST', `/admin/bookings/${hawallyBooking.id}/resend`);
    check('re-sending another campus’s confirmation is refused', r.status === 403, `status ${r.status}`);
  }
  r = await req(campusAdmin, 'GET', '/admin/notifications');
  check('the message log hides other campuses', r.status === 200 && !r.text.includes('parent@example.com'));
  r = await req(campusAdmin, 'GET', '/admin/backup.db');
  check('a campus admin cannot download the database', r.status === 403 || (r.status === 302), `status ${r.status}`);
  r = await req(campusAdmin, 'GET', '/admin/branding');
  check('nor change the branding', r.status === 403, `status ${r.status}`);
  db.prepare('DELETE FROM staff WHERE email = ?').run('campusadmin.sec@example.aca.edu.kw');

  const teacher = await signIn(TEACHER, 'Welcome123!', 'SaraPass123');
  for (const p of ['/admin', '/admin/staff', '/admin/activity', '/admin/backup.db', '/admin/email']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await req(teacher, 'GET', p);
    check(`a teacher cannot reach ${p}`, res.status === 403 || (res.status === 302 && !String(res.location).startsWith('/admin')), `status ${res.status}`);
  }

  /* ------------------------------ uploads ------------------------------ */
  const upload = (name, type, bytes) => {
    const fd = new FormData();
    fd.append('name', 'American Creativity Academy');
    fd.append('logo', new Blob([bytes], { type }), name);
    return fd;
  };
  const branding = require('../src/services/branding');
  const settings = require('../src/lib/settings');
  r = await req(admin, 'POST', '/admin/branding', upload('logo.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>')));
  settings.refresh();
  check('a file that only claims to be a PNG is refused', !branding.logoPath());
  r = await req(admin, 'POST', '/admin/branding', upload('logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>')));
  settings.refresh();
  check('an SVG with scripts is refused', !branding.logoPath());
  r = await req(admin, 'POST', '/admin/branding', upload('logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>')));
  settings.refresh();
  check('a plain SVG is accepted', Boolean(branding.logoPath()));
  r = await req(jar(), 'GET', '/branding/logo');
  check('the logo is served with a no-script policy', r.status === 200 && String(r.headers.get('content-security-policy')).includes("default-src 'none'"));
  await req(admin, 'POST', '/admin/branding', (() => { const fd = new FormData(); fd.append('name', ''); fd.append('remove_logo', '1'); return fd; })());

  /* --------------------------- escaped output --------------------------- */
  const csv = 'name,email,phone,title,role,department,grade,room,classes\n' +
    'XSS Test,"</script><script>alert(1)</script>@example.aca.edu.kw",,,teacher,Elementary — English,,,\n';
  const fd = new FormData();
  fd.append('campus_id', String(hawally));
  fd.append('csv', csv);
  r = await req(admin, 'POST', '/admin/staff/import', fd);
  check('the import went through', r.status === 200 && Boolean(db.prepare("SELECT id FROM staff WHERE email LIKE '%alert(1)%'").get()));
  check('the import result page cannot be broken out of', !r.text.includes('</script><script>alert(1)') && r.text.includes('\\u003c/script>'));
  db.prepare("DELETE FROM staff WHERE email LIKE '%alert(1)%'").run();

  r = await req(admin, 'POST', '/admin/classes', { staff_id: String(sara.id), name: 'Redirect test' }, { Referer: 'https://evil.example/phish' });
  check('a foreign Referer is refused outright', r.status === 403, `status ${r.status}`);
  db.prepare("DELETE FROM classes WHERE name = 'Redirect test'").run();

  /* ----------------------------- the lookup ----------------------------- */
  const mail = require('../src/services/mail');
  r = await req(jar(), 'POST', '/lookup', { parent_email: 'parent@example.com' });
  if (mail.current().enabled) {
    check('lookup emails the list instead of showing it', r.status === 200 && r.text.includes('Check your inbox') && !r.text.includes('/booking/'));
    r = await req(jar(), 'POST', '/lookup', { parent_email: 'nobody-here@example.com' });
    check('and says the same for an unknown address', r.text.includes('Check your inbox'));
  } else {
    check('without email, lookup shows no links and no child names', r.status === 200 && !r.text.includes('/booking/') && !r.text.includes('name="student_name"'));
  }

  /* ------------------------ secrets at rest ------------------------ */
  settings.set('wati.token', 'test-token-SECRET-1234');
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'wati.token'").get().value;
  check('a stored token is sealed in the database', stored.startsWith('enc:v1:') && !stored.includes('SECRET'));
  settings.refresh();
  check('and reads back as itself', settings.get('wati.token') === 'test-token-SECRET-1234');
  db.prepare("UPDATE settings SET value = 'plain-old-token' WHERE key = 'wati.token'").run();
  settings.refresh();
  check('a value saved before sealing still reads', settings.get('wati.token') === 'plain-old-token');
  check('a sealed value from another secret reads as unset', settings.unseal('enc:v1:' + Buffer.from('garbage-garbage-garbage-garbage-garbage').toString('base64')) === '');
  settings.set('wati.token', '');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nSecurity test crashed:', err);
  process.exit(1);
});
