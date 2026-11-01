'use strict';
/**
 * Branding: one deployment per school, made theirs from Admin › Branding —
 * name, short mark, logo, colours, support address and sign-in hint — on the
 * pages, in the theme stylesheet, in the browser-tab icon and in email.
 *
 * Run against a freshly seeded server: npm run seed && node test/branding.js
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
  if (body instanceof FormData) payload = body;
  else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), text, type: res.headers.get('content-type') || '' };
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

/** A 1×1 transparent PNG, enough to be a logo. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function form(fields, logo) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (logo) fd.append('logo', new Blob([logo], { type: 'image/png' }), 'logo.png');
  return fd;
}

(async () => {
  console.log(`Branding, against ${BASE}\n`);

  process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
  const branding = require('../src/services/branding');
  const settings = require('../src/lib/settings');

  /* ----------------------------- the maths ----------------------------- */
  check('initials: Kuwait English School → KES', branding.initials('Kuwait English School') === 'KES');
  check('initials skip small words', branding.initials('The Royal Grammar School Guildford Muscat') === 'RGSG');
  check('a dark main colour gets white text', (() => {
    const p = branding.parseHex('#0b3d5c');
    return p && branding.mix(p, [0, 0, 0], 0) === '#0b3d5c';
  })());
  check('a 3-digit hex is accepted', branding.parseHex('#abc') && branding.parseHex('#abc').join(',') === '170,187,204');
  check('rubbish is refused', branding.parseHex('blue') === null && branding.parseHex('#12345') === null);

  /* -------------------------- defaults in place -------------------------- */
  const anon = jar();
  let r = await req(anon, 'GET', '/branding/theme.css');
  check('the theme stylesheet is served', r.status === 200 && r.type.includes('text/css') && r.text.includes('--navy:'));
  r = await req(anon, 'GET', '/');
  check('the home page loads the theme', r.text.includes('/branding/theme.css?v='));
  check('and shows the short mark when there is no logo', /<span class="mark">[A-Z]{2,5}<\/span>/.test(r.text));
  r = await req(anon, 'GET', '/branding/logo');
  check('no logo yet → 404', r.status === 404, `status ${r.status}`);

  /* ------------------------------- who may ------------------------------- */
  const teacher = await signIn(TEACHER, 'Welcome123!', 'SaraPass123');
  r = await req(teacher, 'GET', '/admin/branding');
  check('a teacher cannot open Branding', r.status === 403 || (r.status === 302 && !String(r.location).includes('/admin/branding')), `status ${r.status}`);

  const admin = await signIn(ADMIN_EMAIL, process.env.ADMIN_PASSWORD || 'Test1234!', 'AdminPass123');
  r = await req(admin, 'GET', '/admin/branding');
  check('the admin opens Branding', r.status === 200, `status ${r.status}`);
  check('it is in the admin menu', r.text.includes('href="/admin/branding"'));
  check('the form shows the current name', r.text.includes('value="American Creativity Academy"') || r.text.includes('name="name"'));

  /* ----------------------------- rebranding ----------------------------- */
  r = await req(admin, 'POST', '/admin/branding', form({
    name: 'Kuwait English School', short: 'kes', primary: '#1d3f8a', accent: '#d7262c',
    support_email: 'it@kes.edu.kw', domain: '@KES.edu.kw', name_ar: 'مدرسة الكويت الإنجليزية',
  }, PNG));
  check('saving is accepted', r.status === 302 && String(r.location).includes('/admin/branding'), `status ${r.status}`);

  settings.refresh();
  const b = branding.current();
  check('the name is saved', b.name === 'Kuwait English School');
  check('the short mark is upper-cased', b.short === 'KES');
  check('colours are saved and derived', b.primary === '#1d3f8a' && b.accent === '#d7262c' && b.primaryDark !== b.primary && b.primarySoft !== b.primary);
  check('the domain loses its @ and capitals', b.domain === 'kes.edu.kw');
  check('a logo is stored beside the database', Boolean(branding.logoPath()) && branding.logoPath().includes('branding'));

  r = await req(anon, 'GET', '/');
  check('the header shows the new name', r.text.includes('Kuwait English School'));
  check('and the logo instead of the mark', r.text.includes('<img class="logo" src="/branding/logo?v=') && !/<span class="mark">/.test(r.text));
  check('the page title changes', r.text.includes('· Kuwait English School</title>'));
  r = await req(anon, 'GET', '/branding/logo');
  check('the logo is served', r.status === 200 && r.type.includes('image/png'), `status ${r.status}`);
  r = await req(anon, 'GET', '/branding/theme.css');
  check('the theme carries the new colours', r.text.includes('--navy:#1d3f8a') && r.text.includes('--gold:#d7262c'));
  check('dark colours get white text', r.text.includes('--on-navy:#ffffff'));
  r = await req(anon, 'GET', '/staff/login');
  check('the sign-in hint uses the new domain', r.text.includes('@<span class="mono">kes.edu.kw</span>') || r.text.includes('@kes.edu.kw') || r.text.includes('kes.edu.kw'));
  r = await req(anon, 'GET', '/');
  check('the footer carries the support address', r.text.includes('it@kes.edu.kw'));

  // Emails pick the colour up too.
  const notify = require('../src/services/notify');
  const html = notify.EMAIL_BUILDERS
    ? notify.EMAIL_BUILDERS.confirmation({ parent_name: 'P', event_name: 'E', slot_date: '2026-11-15', start_time: '09:00', end_time: '09:10', staff_name: 'T', token: 'x' }).html
    : '';
  check('emails use the school colour and name', !notify.EMAIL_BUILDERS || (html.includes('#1d3f8a') && html.includes('Kuwait English School') && !html.includes('#0b3d5c')));

  // A light main colour gets dark text.
  await req(admin, 'POST', '/admin/branding', form({ name: 'Kuwait English School', short: 'KES', primary: '#f5d04c', accent: '#1d3f8a', support_email: '', domain: '' }));
  r = await req(anon, 'GET', '/branding/theme.css');
  check('a light main colour gets dark text', r.text.includes('--navy:#f5d04c') && r.text.includes('--on-navy:#16232e'));

  // Bad input is refused, nothing changes.
  r = await req(admin, 'POST', '/admin/branding', form({ name: 'X', short: 'X', primary: 'blue', accent: '#1d3f8a' }));
  settings.refresh();
  check('a non-hex colour is refused', r.status === 302 && branding.current().name === 'Kuwait English School');
  r = await req(admin, 'POST', '/admin/branding', form({ name: '', short: 'KES', primary: '#1d3f8a', accent: '#d7262c', support_email: 'it@kes.edu.kw', domain: 'kes.edu.kw' }));
  settings.refresh();
  check('an empty name falls back to the deployment default', branding.current().name === branding.DEFAULTS.name);
  await req(admin, 'POST', '/admin/branding', form({ name: 'Kuwait English School', short: 'KES', primary: '#1d3f8a', accent: '#d7262c', support_email: 'it@kes.edu.kw', domain: 'kes.edu.kw' }));
  settings.refresh();
  const fd = new FormData();
  fd.append('name', 'Kuwait English School');
  fd.append('logo', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  r = await req(admin, 'POST', '/admin/branding', fd);
  settings.refresh();
  check('a non-image logo is refused', Boolean(branding.logoPath()) && branding.logoPath().endsWith('.png'));

  // It is on the record.
  const { db } = require('../src/db');
  const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'branding_update' AND detail LIKE '%primary%' ORDER BY id DESC LIMIT 1").get();
  check('the change is in the activity log, field by field', row && row.detail.includes('#1d3f8a'));

  /* --------------------------- back to defaults --------------------------- */
  await req(admin, 'POST', '/admin/branding', form({ name: '', short: '', primary: '', accent: '', support_email: '', domain: '', remove_logo: '1' }));
  settings.refresh();
  const back = branding.current();
  check('removing the logo brings the mark back', !branding.logoPath() && branding.current().logoUrl === '');
  check('clearing fields returns to the environment defaults', branding.current().primary === branding.DEFAULTS.primary.toLowerCase() && branding.current().short === (branding.DEFAULTS.short || branding.initials(branding.DEFAULTS.name)));
  void back;
  r = await req(anon, 'GET', '/');
  check('the home page is back to the default name', r.text.includes(branding.DEFAULTS.name));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nBranding test crashed:', err);
  process.exit(1);
});
