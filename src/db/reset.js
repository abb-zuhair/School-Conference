'use strict';
/** Danger: wipes every table. `npm run reset` then `npm run seed`. */
const { db, migrate, dbPath } = require('./index');

if (!process.argv.includes('--yes')) {
  console.log(`This deletes ALL data in ${dbPath}. Re-run with --yes to confirm.`);
  process.exit(1);
}

migrate();
db.pragma('foreign_keys = OFF');
for (const t of ['notifications', 'bookings', 'slots', 'schedules', 'events', 'classes', 'staff', 'departments', 'campuses', 'audit_log', 'sessions', 'settings']) {
  db.prepare(`DELETE FROM ${t}`).run();
}
db.pragma('foreign_keys = ON');
console.log('Database cleared.');
