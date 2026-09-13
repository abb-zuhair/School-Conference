'use strict';
/**
 * Demo data so you can click through the whole flow straight away.
 *   npm run seed
 * Safe to run on an empty database only — it refuses if campuses already exist
 * unless you pass --force.
 */
const { db, migrate } = require('./index');
const auth = require('../lib/auth');
const sched = require('../lib/scheduling');
const { nowLocal } = require('../lib/helpers');

migrate();

const force = process.argv.includes('--force');
const existing = db.prepare('SELECT COUNT(*) AS n FROM campuses').get().n;
if (existing > 0 && !force) {
  console.log('Database already has campuses — nothing seeded. Re-run with --force to add demo data anyway.');
  process.exit(0);
}

const seed = db.transaction(() => {
  /* -------------------------- campuses -------------------------- */
  const campusIds = {};
  for (const [name, slug, address, sort] of [
    ['ACA Hawally', 'hawally', 'Hawally, Kuwait', 1],
    ['ACA Salmiya', 'salmiya', 'Salmiya, Kuwait', 2],
  ]) {
    const info = db
      .prepare('INSERT INTO campuses (name, slug, address, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, slug, address, sort);
    campusIds[slug] = info.lastInsertRowid;
  }

  /* ------------------------- departments ------------------------ */
  const deptIds = {};
  const depts = [
    ['hawally', 'Elementary — English', 1],
    ['hawally', 'Elementary — Mathematics', 2],
    ['hawally', 'Elementary — Arabic & Islamic', 3],
    ['hawally', 'Front Office', 9],
    ['salmiya', 'Middle School — Science', 1],
    ['salmiya', 'Middle School — Humanities', 2],
    ['salmiya', 'Front Office', 9],
  ];
  for (const [campus, name, sort] of depts) {
    const info = db
      .prepare('INSERT INTO departments (campus_id, name, sort_order) VALUES (?, ?, ?)')
      .run(campusIds[campus], name, sort);
    deptIds[`${campus}:${name}`] = info.lastInsertRowid;
  }

  /* ---------------------------- staff --------------------------- */
  const staffRows = [
    ['hawally', 'Elementary — English', 'Sara Al-Mutairi', 'sara.mutairi@example.aca.edu.kw', 'Grade 5 English', 'teacher', ['Grade 5A — English', 'Grade 5B — English']],
    ['hawally', 'Elementary — English', 'Laura Bennett', 'laura.bennett@example.aca.edu.kw', 'Grade 4 English', 'teacher', ['Grade 4A — English']],
    ['hawally', 'Elementary — Mathematics', 'Ahmad Al-Rashidi', 'ahmad.rashidi@example.aca.edu.kw', 'Grade 5 Mathematics', 'teacher', ['Grade 5A — Mathematics', 'Grade 5B — Mathematics']],
    ['hawally', 'Elementary — Arabic & Islamic', 'Fatima Al-Otaibi', 'fatima.otaibi@example.aca.edu.kw', 'Arabic', 'teacher', ['Grade 5 — Arabic']],
    ['hawally', 'Front Office', 'Uniform Counter', 'uniform.hawally@example.aca.edu.kw', 'Uniform shop', 'desk', []],
    ['hawally', 'Front Office', 'Admissions Desk', 'admissions.hawally@example.aca.edu.kw', 'Registration', 'desk', []],
    ['salmiya', 'Middle School — Science', 'Omar Khalid', 'omar.khalid@example.aca.edu.kw', 'Grade 7 Science', 'teacher', ['Grade 7A — Science', 'Grade 7B — Science']],
    ['salmiya', 'Middle School — Humanities', 'Noura Al-Sabah', 'noura.sabah@example.aca.edu.kw', 'Grade 7 Social Studies', 'teacher', ['Grade 7A — Social Studies']],
  ];

  const staffIds = {};
  for (const [campus, dept, name, email, title, role, classes] of staffRows) {
    const info = db
      .prepare(
        `INSERT INTO staff (campus_id, department_id, name, email, title, role, password_hash, must_change_pw)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(campusIds[campus], deptIds[`${campus}:${dept}`], name, email, title, role, auth.hashPassword('Welcome123!'));
    staffIds[email] = info.lastInsertRowid;
    for (const c of classes) {
      db.prepare('INSERT INTO classes (staff_id, name, grade_level) VALUES (?, ?, ?)').run(
        info.lastInsertRowid,
        c,
        (c.match(/Grade (\d+)/) || [])[1] || null
      );
    }
  }

  /* ---------------------------- events -------------------------- */
  const d1 = nowLocal().plus({ days: 14 }).toFormat('yyyy-MM-dd');
  const d2 = nowLocal().plus({ days: 15 }).toFormat('yyyy-MM-dd');
  const closes = nowLocal().plus({ days: 13 }).toFormat('yyyy-MM-dd HH:mm');

  const ptc = db
    .prepare(
      `INSERT INTO events (campus_id, type, name, slug, description, instructions, closes_at,
        max_per_student, prevent_overlap, status)
       VALUES (?, 'conference', ?, ?, ?, ?, ?, 6, 1, 'published')`
    )
    .run(
      campusIds.hawally,
      'Parent–Teacher Conference — Term 1',
      'ptc-term1-hawally',
      `Meet your child's teachers on ${d1} and ${d2}.`,
      'Please arrive five minutes before your slot and bring your civil ID for gate entry. Each meeting is 10 minutes.',
      closes
    ).lastInsertRowid;

  const uniform = db
    .prepare(
      `INSERT INTO events (campus_id, type, name, slug, description, instructions, max_per_student, status)
       VALUES (?, 'uniform', ?, ?, ?, ?, 1, 'published')`
    )
    .run(
      campusIds.hawally,
      'Uniform fitting & pick-up',
      'uniform-hawally',
      'Book a fitting slot at the uniform shop.',
      'Bring your receipt. Exchanges are handled at the same counter.'
    ).lastInsertRowid;

  const registration = db
    .prepare(
      `INSERT INTO events (campus_id, type, name, slug, description, instructions, max_per_student, status)
       VALUES (?, 'registration', ?, ?, ?, ?, 1, 'published')`
    )
    .run(
      campusIds.hawally,
      'Re-registration appointments',
      'registration-hawally',
      'Complete re-registration for the coming academic year.',
      'Bring the student’s civil ID, passport copy and the completed form.'
    ).lastInsertRowid;

  /* -------------------------- schedules ------------------------- */
  const classRows = db
    .prepare(
      `SELECT c.id AS class_id, c.staff_id, c.room, s.department_id
       FROM classes c JOIN staff s ON s.id = c.staff_id WHERE s.campus_id = ?`
    )
    .all(campusIds.hawally);

  const conferenceScheduleIds = [];
  for (const r of classRows) {
    const info = db
      .prepare(
        `INSERT INTO schedules (event_id, department_id, staff_id, class_id, mode, location)
         VALUES (?, ?, ?, ?, 'in_person', 'Classroom')`
      )
      .run(ptc, r.department_id, r.staff_id, r.class_id);
    conferenceScheduleIds.push(info.lastInsertRowid);
  }

  const uniformScheduleIds = ['Uniform counter 1', 'Uniform counter 2'].map(
    (label) =>
      db
        .prepare(
          `INSERT INTO schedules (event_id, department_id, staff_id, label, mode, location)
           VALUES (?, ?, ?, ?, 'in_person', 'Uniform shop, main building')`
        )
        .run(uniform, deptIds['hawally:Front Office'], staffIds['uniform.hawally@example.aca.edu.kw'], label)
        .lastInsertRowid
  );

  const registrationScheduleId = db
    .prepare(
      `INSERT INTO schedules (event_id, department_id, staff_id, label, mode, location)
       VALUES (?, ?, ?, 'Admissions desk', 'in_person', 'Administration building')`
    )
    .run(registration, deptIds['hawally:Front Office'], staffIds['admissions.hawally@example.aca.edu.kw'])
    .lastInsertRowid;

  /* ---------------------------- slots --------------------------- */
  const conferenceSlots = sched.buildSlots({
    dates: [d1, d2],
    startTime: '15:00',
    endTime: '18:00',
    duration: 10,
    gap: 0,
    capacity: 1,
    breaks: [{ start: '16:20', end: '16:40', label: 'Break' }],
  });
  for (const id of conferenceScheduleIds) sched.insertSlots(id, conferenceSlots);

  const counterSlots = sched.buildSlots({
    dates: [d1, d2],
    startTime: '09:00',
    endTime: '13:00',
    duration: 20,
    gap: 0,
    capacity: 3,
  });
  for (const id of uniformScheduleIds) sched.insertSlots(id, counterSlots);

  sched.insertSlots(
    registrationScheduleId,
    sched.buildSlots({ dates: [d1, d2], startTime: '08:30', endTime: '12:30', duration: 30, capacity: 1 })
  );
});

seed();
auth.ensureBootstrapAdmin();

console.log('Demo data created.');
console.log('  Campuses : ACA Hawally (/c/hawally), ACA Salmiya (/c/salmiya)');
console.log('  Events   : /e/ptc-term1-hawally, /e/uniform-hawally, /e/registration-hawally');
console.log('  Teachers : sign in with any seeded example.aca.edu.kw address, password Welcome123!');
console.log('  Admin    : from ADMIN_EMAIL / ADMIN_PASSWORD in your .env');
