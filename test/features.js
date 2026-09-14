'use strict';
/**
 * Checks for the admin-side additions: CSV file upload, the optional compare grid,
 * the backup download, and the ephemeral-storage warning.
 * Run against a freshly seeded server: node test/features.js
 */
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

async function req(j, method, path, body, isForm) {
  const headers = { Cookie: j.header() };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  void isForm;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status === 302 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
}

async function follow(j, path) {
  let cur = path;
  for (let i = 0; i < 5; i += 1) {
    const r = await req(j, 'GET', cur);
    if (r.status === 302 && r.location) { cur = r.location.replace(BASE, ''); continue; }
    return r;
  }
  throw new Error('too many redirects');
}

(async () => {
  console.log(`Feature test against ${BASE}\n`);
  const a = jar();

  let r = await req(a, 'POST', '/staff/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check('admin signs in', r.status === 302);
  r = await follow(a, '/admin');
  if (r.text.includes('Change password')) {
    await req(a, 'POST', '/staff/password', { new_password: 'AdminPass123', confirm_password: 'AdminPass123' });
    r = await follow(a, '/admin');
  }
  check('dashboard loads', r.text.includes('Events'));
  check('ephemeral-storage warning shows', r.text.includes('lost on the next deploy'));
  check('backup link present', r.text.includes('/admin/backup.db'));

  /* ---------------- CSV template + file upload ---------------- */
  r = await req(a, 'GET', '/admin/staff/import/template.csv');
  check('CSV template downloads', r.status === 200 && r.text.includes('name,email,phone'));

  r = await req(a, 'GET', '/admin/staff/import');
  check('import page has a file input', r.text.includes('type="file"'));
  const campusId = Number((r.text.match(/<option value="(\d+)"/) || [])[1]);
  check('a campus is selectable', Boolean(campusId));

  const csv = [
    'name,email,phone,title,role,department,grade,room,classes',
    'Import Tester,import.tester@example.aca.edu.kw,99001122,Grade 3 Science,teacher,Elementary — Science,3,C-101,Grade 3A — Science|Grade 3B — Science',
    'Nadia عبدالله,nadia.test@example.aca.edu.kw,99003344,Arabic,teacher,Elementary — Arabic,4,,Grade 4 — Arabic',
    'Front Desk,desk.test@example.aca.edu.kw,,,desk,Front Office,,,',
  ].join('\n');

  const form = new FormData();
  form.set('campus_id', String(campusId));
  form.set('csv_file', new Blob([csv], { type: 'text/csv' }), 'staff.csv');
  r = await req(a, 'POST', '/admin/staff/import', form);
  check('file upload imports rows', r.status === 200 && r.text.includes('Import result'));
  check('three accounts created', /<div class="n">3<\/div>\s*<div class="l">Created/.test(r.text), 'created count');
  check('three classes added', /<div class="n">3<\/div>\s*<div class="l">Classes added/.test(r.text));
  check('no import errors', /<div class="n">0<\/div>\s*<div class="l">Errors/.test(r.text));
  check('temporary passwords listed', r.text.includes('import.tester@example.aca.edu.kw'));

  r = await req(a, 'GET', '/admin/staff');
  check('imported teacher appears in staff list', r.text.includes('Import Tester'));
  check('Arabic name survived the upload', r.text.includes('Nadia عبدالله'));

  // Re-importing the same file updates rather than duplicates
  const form2 = new FormData();
  form2.set('campus_id', String(campusId));
  form2.set('csv_file', new Blob([csv], { type: 'text/csv' }), 'staff.csv');
  r = await req(a, 'POST', '/admin/staff/import', form2);
  check('re-import updates instead of duplicating', /<div class="n">3<\/div>\s*<div class="l">Updated/.test(r.text));

  // Empty upload is rejected politely
  const form3 = new FormData();
  form3.set('campus_id', String(campusId));
  r = await req(a, 'POST', '/admin/staff/import', form3);
  check('empty submission is rejected', r.text.includes('No rows found'));

  /* ---------------- compare toggle ---------------- */
  r = await req(a, 'GET', '/admin/events/1');
  check('event settings expose the compare toggle', r.text.includes('name="allow_compare"'));
  check('compare is on by default', /id="e_cmp" name="allow_compare" checked/.test(r.text));

  const p = jar();
  r = await req(p, 'GET', '/e/ptc-term1-hawally');
  const deptId = (r.text.match(/\/d\/(\d+)/) || [])[1];
  r = await req(p, 'GET', `/e/ptc-term1-hawally/d/${deptId}`);
  check('compare form shown while enabled', r.text.includes('Compare selected schedules'));

  // Turn it off
  await req(a, 'POST', '/admin/events/1', {
    name: 'Parent–Teacher Conference — Term 1',
    max_per_student: '6',
    cancel_cutoff_hrs: '2',
    prevent_overlap: 'on',
    allow_cancel: 'on',
    require_phone: 'on',
    collect_student: 'on',
    // allow_compare deliberately omitted = unchecked
  });

  r = await req(p, 'GET', `/e/ptc-term1-hawally/d/${deptId}`);
  check('compare form hidden when disabled', !r.text.includes('Compare selected schedules'));
  r = await req(p, 'GET', '/e/ptc-term1-hawally/compare?ids=1,2');
  check('compare URL redirects away when disabled', r.status === 302 && String(r.location).includes('/e/ptc-term1-hawally'));

  // Turn it back on
  await req(a, 'POST', '/admin/events/1', {
    name: 'Parent–Teacher Conference — Term 1',
    max_per_student: '6',
    cancel_cutoff_hrs: '2',
    prevent_overlap: 'on',
    allow_cancel: 'on',
    require_phone: 'on',
    collect_student: 'on',
    allow_compare: 'on',
  });
  r = await req(p, 'GET', '/e/ptc-term1-hawally/compare?ids=1,2');
  check('compare works again once re-enabled', r.status === 200 && r.text.includes('Compare schedules'));

  /* ---------------- backup download ---------------- */
  r = await req(a, 'GET', '/admin/backup.db');
  check('backup downloads', r.status === 200, `status ${r.status}`);
  check('backup is a SQLite file', r.text.startsWith('SQLite format 3'), r.text.slice(0, 20));
  check('backup has a filename', /attachment; filename=/.test(r.headers.get('content-disposition') || ''));

  const teacher = jar();
  r = await req(teacher, 'POST', '/staff/login', { email: 'sara.mutairi@example.aca.edu.kw', password: 'Welcome123!' });
  await req(teacher, 'POST', '/staff/password', { new_password: 'TeacherPass1', confirm_password: 'TeacherPass1' });
  r = await req(teacher, 'GET', '/admin/backup.db');
  check('teacher cannot download the backup', r.status === 403 || r.status === 302, `status ${r.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nFeature test crashed:', err);
  process.exit(1);
});
