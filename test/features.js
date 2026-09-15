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
    // Repeat the key for arrays, the way a browser posts several checkboxes —
    // URLSearchParams would otherwise join them into one comma-separated value.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) v.forEach((item) => params.append(k, String(item)));
      else params.append(k, String(v));
    }
    payload = params.toString();
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

  // A previous run may already have changed the bootstrap password; accept either.
  let r = await req(a, 'POST', '/staff/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (r.status !== 302) r = await req(a, 'POST', '/staff/login', { email: ADMIN_EMAIL, password: 'AdminPass123' });
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

  /* ---------------- slots by department ---------------- */
  r = await req(a, 'GET', '/admin/events/1');
  check('slot picker groups by department', r.text.includes('name="slot_department_ids"'));
  check('department groups show teacher counts', /teacher\(s\)/.test(r.text));

  // Find a department that has schedules on this event, and count its slots before.
  const deptOpt = [...r.text.matchAll(/name="slot_department_ids" value="(\d+)"/g)].map((m) => Number(m[1]));
  check('a department is tickable', deptOpt.length > 0, `found ${deptOpt.length}`);

  const targetDept = deptOpt[0];
  const before = await req(a, 'GET', `/admin/events/1/unbooked.csv`);
  const beforeRows = before.text.split('\n').length;

  // One new date, applied to a whole department rather than individual schedules.
  const newDate = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  r = await req(a, 'POST', '/admin/events/1/slots/bulk', {
    slot_department_ids: String(targetDept),
    dates: newDate,
    start_time: '16:00',
    end_time: '17:00',
    duration: '15',
    gap: '0',
    capacity: '1',
  });
  check('department generation submits', r.status === 302);

  r = await follow(a, '/admin/events/1');
  check('department generation reports departments', /\d+ slot\(s\) added across \d+ schedule\(s\) \(1 department\)/.test(r.text), 'flash message');

  const after = await req(a, 'GET', '/admin/events/1/unbooked.csv');
  check('slots were actually created', after.text.split('\n').length > beforeRows);
  check('new slots landed on the new date', after.text.includes(newDate.slice(0, 4)) && after.text.split('\n').some((l) => l.includes('4:00 PM')));

  // Every schedule in that department should now carry the new date — that's the point.
  r = await req(a, 'GET', '/admin/events/1');
  const deptScheduleIds = [...r.text.matchAll(/name="schedule_ids" value="(\d+)" data-in-dept="(\d+)"/g)]
    .filter((m) => Number(m[2]) === targetDept)
    .map((m) => Number(m[1]));
  check('department has more than one schedule', deptScheduleIds.length > 1, `${deptScheduleIds.length}`);

  let everyone = true;
  for (const sid of deptScheduleIds) {
    // eslint-disable-next-line no-await-in-loop
    const sr = await req(a, 'GET', `/staff/schedule/${sid}`);
    if (!sr.text.includes('4:00 PM')) everyone = false;
  }
  check('every teacher in the department got the slots', everyone);

  // A department with no schedules is reported, not silently ignored.
  r = await req(a, 'POST', '/admin/events/1/slots/bulk', {
    slot_department_ids: '99999',
    dates: newDate,
    start_time: '16:00',
    end_time: '17:00',
    duration: '15',
  });
  r = await follow(a, '/admin/events/1');
  check('empty department is reported', r.text.includes('no schedules yet'));

  r = await req(a, 'POST', '/admin/events/1/slots/bulk', {
    dates: newDate, start_time: '16:00', end_time: '17:00', duration: '15',
  });
  r = await follow(a, '/admin/events/1');
  check('no selection is reported', r.text.includes('Select at least one department or schedule'));

  /* ---------------- bulk staff actions ---------------- */
  r = await req(a, 'GET', '/admin/staff');
  check('staff list has selection checkboxes', r.text.includes('name="staff_ids"'));
  check('staff list has a bulk bar', r.text.includes('id="staff-bulk-bar"'));

  const staffIds = [...r.text.matchAll(/name="staff_ids" value="(\d+)"/g)].map((m) => Number(m[1]));
  check('staff rows are selectable', staffIds.length > 3, `${staffIds.length}`);

  const pickValues = (html, selectName) => {
    const block = html.match(new RegExp(`name="${selectName}"[\\s\\S]*?<\\/select>`));
    return block ? (block[0].match(/value="(\d+)"/g) || []).map((v) => Number(v.match(/\d+/)[0])) : [];
  };
  const campusIds = pickValues(r.text, 'campus_id');
  const salmiya = campusIds[1];

  // Two imported teachers we can shuffle freely — never the signed-in admin,
  // and never anyone the booking tests below rely on.
  const idFor = (email) => {
    const i = r.text.indexOf(email);
    if (i === -1) return null;
    const before = r.text.slice(Math.max(0, i - 1200), i);
    const m = [...before.matchAll(/name="staff_ids" value="(\d+)"/g)].pop();
    return m ? Number(m[1]) : null;
  };
  const movable = [idFor('import.tester@example.aca.edu.kw'), idFor('nadia.test@example.aca.edu.kw')].filter(Boolean);
  check('two imported teachers found to move', movable.length === 2, `${movable.length}`);
  check('the signed-in admin is not among them', !movable.includes(1));

  r = await req(a, 'POST', '/admin/staff/bulk', {
    staff_ids: movable, action: 'campus', campus_id: String(salmiya),
  });
  check('bulk campus change submits', r.status === 302);
  r = await follow(a, '/admin/staff');
  check('campus change is reported', r.text.includes('2 staff moved'));

  const rowFor = (html, id) => {
    const i = html.indexOf(`name="staff_ids" value="${id}"`);
    return i === -1 ? '' : html.slice(i, i + 900);
  };
  check('first staff member moved campus', rowFor(r.text, movable[0]).includes('ACA Salmiya'));
  check('second staff member moved campus', rowFor(r.text, movable[1]).includes('ACA Salmiya'));
  check('cross-campus department was cleared', /<td class="small">—<\/td>/.test(rowFor(r.text, movable[0])));

  // Move them into a department — the department's campus should follow.
  const deptIds2 = pickValues(r.text, 'department_id');
  r = await req(a, 'POST', '/admin/staff/bulk', {
    staff_ids: movable, action: 'department', department_id: String(deptIds2[0]),
  });
  r = await follow(a, '/admin/staff');
  check('bulk department change is reported', /staff moved to /.test(r.text));
  check('campus followed the department back', rowFor(r.text, movable[0]).includes('ACA Hawally'));

  r = await req(a, 'POST', '/admin/staff/bulk', { staff_ids: movable, action: 'deactivate' });
  r = await follow(a, '/admin/staff');
  check('bulk deactivate is reported', r.text.includes('2 staff deactivated'));
  r = await req(a, 'POST', '/admin/staff/bulk', { staff_ids: movable, action: 'activate' });
  r = await follow(a, '/admin/staff');
  check('bulk activate is reported', r.text.includes('2 staff activated'));

  r = await req(a, 'POST', '/admin/staff/bulk', { staff_ids: [], action: 'deactivate' });
  r = await follow(a, '/admin/staff');
  check('empty selection is refused', r.text.includes('Tick at least one'));

  // Safety rails around the signed-in admin
  const adminId = staffIds.find((id) => rowFor(r.text, id).includes('zuhair@sama.com.kw'));
  check('the admin row was located', Boolean(adminId));

  r = await req(a, 'POST', '/admin/staff/bulk', { staff_ids: [adminId], action: 'deactivate' });
  r = await follow(a, '/admin/staff');
  check('cannot deactivate yourself', r.text.includes('cannot deactivate your own account'));
  check('still signed in after that refusal', r.text.includes('Add or update a staff member'));

  r = await req(a, 'POST', '/admin/staff/bulk', { staff_ids: [adminId], action: 'delete' });
  r = await follow(a, '/admin/staff');
  check('cannot delete your own account', r.text.includes('cannot delete your own account'));

  r = await req(a, 'POST', '/admin/staff/bulk', { staff_ids: staffIds.filter((id) => id !== adminId), action: 'deactivate' });
  r = await follow(a, '/admin/staff');
  check('can deactivate everyone else', /staff deactivated/.test(r.text));
  await req(a, 'POST', '/admin/staff/bulk', { staff_ids: staffIds.filter((id) => id !== adminId), action: 'activate' });

  // Delete a teacher with no bookings.
  r = await req(a, 'POST', '/admin/staff/bulk', { staff_ids: [movable[0]], action: 'delete' });
  r = await follow(a, '/admin/staff');
  check('bulk delete removes staff', r.text.includes('1 staff deleted'));
  check('deleted staff is gone from the list', !r.text.includes(`name="staff_ids" value="${movable[0]}"`));

  /* ---------------- classes page & bulk ---------------- */
  r = await req(a, 'GET', '/admin/classes');
  check('classes page renders', r.status === 200 && r.text.includes('name="class_ids"'));
  const classIds = [...r.text.matchAll(/name="class_ids" value="(\d+)"/g)].map((m) => Number(m[1]));
  check('classes are listed', classIds.length > 2, `${classIds.length}`);
  check('classes page shows booked counts', r.text.includes('Booked'));

  r = await req(a, 'GET', `/admin/classes?campus=${salmiya}`);
  const salmiyaClasses = [...r.text.matchAll(/name="class_ids" value="(\d+)"/g)].length;
  r = await req(a, 'GET', '/admin/classes');
  const allClasses = [...r.text.matchAll(/name="class_ids" value="(\d+)"/g)].length;
  check('campus filter narrows the list', salmiyaClasses < allClasses, `${salmiyaClasses} of ${allClasses}`);

  r = await req(a, 'GET', '/admin/classes?q=Arabic');
  check('search filter works', [...r.text.matchAll(/name="class_ids" value="(\d+)"/g)].length < allClasses);

  // Reassign a class to another teacher.
  r = await req(a, 'GET', '/admin/classes');
  const teacherOptions = pickValues(r.text, 'staff_id');
  const moveTo = teacherOptions[0];
  r = await req(a, 'POST', '/admin/classes/bulk', {
    class_ids: [classIds[0]], action: 'reassign', staff_id: String(moveTo),
  });
  check('bulk reassign submits', r.status === 302);
  r = await follow(a, '/admin/classes');
  check('reassign is reported', /class\(es\) moved to /.test(r.text));

  r = await req(a, 'POST', '/admin/classes/bulk', { class_ids: [classIds[0]], action: 'reassign' });
  r = await follow(a, '/admin/classes');
  check('reassign without a teacher is refused', r.text.includes('Choose the teacher'));

  // Delete two classes that hold no bookings.
  const doomed = [classIds[classIds.length - 1], classIds[classIds.length - 2]];
  r = await req(a, 'POST', '/admin/classes/bulk', { class_ids: doomed, action: 'delete' });
  check('bulk class delete submits', r.status === 302);
  r = await follow(a, '/admin/classes');
  check('class deletion is reported', /2 class\(es\) deleted/.test(r.text));
  check('deleted classes are gone', !r.text.includes(`name="class_ids" value="${doomed[0]}"`));

  /* ---------------- deleting schedules ---------------- */
  r = await req(a, 'GET', '/admin/events/1');
  const allScheduleIds = [...r.text.matchAll(/name="schedule_ids" value="(\d+)"/g)].map((m) => Number(m[1]));
  const emptySchedule = allScheduleIds[allScheduleIds.length - 1];

  r = await req(a, 'POST', `/admin/schedules/${emptySchedule}/delete`);
  check('empty schedule deletes', r.status === 302);
  r = await req(a, 'GET', '/admin/events/1');
  check('deleted schedule is gone', !r.text.includes(`name="schedule_ids" value="${emptySchedule}"`));

  // Book a conference slot so a schedule has something to guard.
  const confParent = jar();
  r = await req(confParent, 'GET', '/e/ptc-term1-hawally');
  const confDept = (r.text.match(/\/d\/(\d+)/) || [])[1];
  r = await req(confParent, 'GET', `/e/ptc-term1-hawally/d/${confDept}`);
  const confSchedule = [...r.text.matchAll(/\/s\/(\d+)"/g)].map((m) => Number(m[1]))[0];
  r = await req(confParent, 'GET', `/e/ptc-term1-hawally/s/${confSchedule}`);
  const confSlot = [...r.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]))[0];
  await req(confParent, 'POST', '/e/ptc-term1-hawally/select', { slot_id: confSlot, action: 'add' });
  r = await req(confParent, 'POST', '/e/ptc-term1-hawally/confirm', {
    parent_name: 'Guard Test', parent_email: 'guard@example.com',
    parent_phone: '55990011', student_name: 'Guard Child',
  });
  check('a conference booking exists to guard', r.status === 302, `status ${r.status}`);

  // Find a schedule that actually holds a booking.
  r = await req(a, 'GET', '/admin/events/1');
  const deleteFormsWithBookings = [...r.text.matchAll(/action="\/admin\/schedules\/(\d+)\/delete"[\s\S]{0,400}?cancel_bookings/g)]
    .map((m) => Number(m[1]));
  check('a booked schedule offers the guarded delete', deleteFormsWithBookings.length > 0, `${deleteFormsWithBookings.length}`);

  if (deleteFormsWithBookings.length) {
    const target = deleteFormsWithBookings[0];
    r = await req(a, 'POST', `/admin/schedules/${target}/delete`); // no opt-in
    r = await follow(a, '/admin/events/1');
    check('booked schedule refuses a bare delete', r.text.includes('live booking'));
    check('booked schedule survived the refusal', r.text.includes(`/admin/schedules/${target}/delete`));

    r = await req(a, 'POST', `/admin/schedules/${target}/delete`, { cancel_bookings: '1', notify: '' });
    check('booked schedule deletes with the opt-in', r.status === 302);
    r = await follow(a, '/admin/events/1');
    check('cancellation is reported', /booking\(s\) were cancelled/.test(r.text));
    check('booked schedule is gone', !r.text.includes(`action="/admin/schedules/${target}/delete"`));
  }
  /* ---------------- deleting events ---------------- */
  r = await req(a, 'GET', '/admin/events/2/delete');
  check('delete confirmation page renders', r.status === 200 && r.text.includes('cannot be undone'));
  check('confirmation shows what is lost', /<div class="l">Schedules<\/div>/.test(r.text));
  check('confirmation suggests closing instead', r.text.includes('Consider closing it instead'));

  r = await req(a, 'POST', '/admin/events/2/delete', { confirm_name: 'wrong name' });
  check('wrong name is refused', r.status === 400 && r.text.includes('does not match'));

  r = await req(a, 'GET', '/admin/events/2');
  check('event survived the wrong name', r.status === 200);

  const unescape = (s) =>
    String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const ev2 = await req(a, 'GET', '/admin/events/2');
  const ev2Name = unescape((ev2.text.match(/<input name="name" value="([^"]+)"/) || [])[1]);
  check('event name read back for confirmation', Boolean(ev2Name));

  // Book a slot on event 2 so the live-booking guard has something to catch.
  const parent = jar();
  r = await req(parent, 'GET', '/e/uniform-hawally');
  const uSched2 = Number((r.text.match(/\/s\/(\d+)/) || [])[1]);
  r = await req(parent, 'GET', `/e/uniform-hawally/s/${uSched2}`);
  const uSlot2 = [...r.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => Number(m[1]))[0];
  await req(parent, 'POST', '/e/uniform-hawally/select', { slot_id: uSlot2, action: 'add' });
  r = await req(parent, 'POST', '/e/uniform-hawally/confirm', {
    parent_name: 'Delete Test', parent_email: 'deletetest@example.com',
    parent_phone: '55112233', student_name: 'Delete Child',
  });
  check('a booking exists on the event to be deleted', r.status === 302);

  r = await req(a, 'POST', '/admin/events/2/delete', { confirm_name: ev2Name });
  check('live bookings block deletion', r.status === 400 && r.text.includes('live booking'));

  r = await req(a, 'POST', '/admin/events/2/delete', { confirm_name: ev2Name, cancel_bookings: '1' });
  check('event deletes with the opt-in', r.status === 302 && String(r.location).includes('/admin'));

  r = await req(a, 'GET', '/admin/events/2');
  check('deleted event is gone from admin', r.status === 404);
  r = await req(jar(), 'GET', '/e/uniform-hawally');
  check('deleted event is gone for parents', r.status === 404);
  r = await req(parent, 'POST', '/lookup', { parent_email: 'deletetest@example.com' });
  check('its bookings went with it', r.status === 200 && !r.text.includes('Delete Child'));

  /* ---------------- non-admins cannot delete ---------------- */
  const teacher2 = jar();
  await req(teacher2, 'POST', '/staff/login', { email: 'laura.bennett@example.aca.edu.kw', password: 'Welcome123!' });
  await req(teacher2, 'POST', '/staff/password', { new_password: 'LauraPass123', confirm_password: 'LauraPass123' });
  r = await req(teacher2, 'GET', '/admin/events/1/delete');
  check('teacher cannot open event delete', r.status === 403 || r.status === 302, `status ${r.status}`);

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
