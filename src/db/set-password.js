'use strict';
/**
 * Set (or reset) a staff password from the command line — the way back in when
 * an admin is locked out.
 *
 *   node src/db/set-password.js <email> <new-password> [role]
 *
 * If the email does not exist it is created as an admin (or the role you pass).
 * If it exists, only the password is changed; role, campus and classes are kept.
 * The account is left able to sign in straight away — no forced change.
 *
 * On Railway: open the service's Console tab and run it there. It writes to the
 * same DATABASE_PATH the app uses, so make sure your volume is mounted.
 */
const { db, migrate, dbPath } = require('./index');
const auth = require('../lib/auth');

const [, , emailArg, passwordArg, roleArg] = process.argv;

if (!emailArg || !passwordArg) {
  console.error('Usage: node src/db/set-password.js <email> <new-password> [role]');
  console.error('  role defaults to admin when creating a new account; ignored for existing ones.');
  process.exit(1);
}

const email = String(emailArg).trim();
const password = String(passwordArg);

if (password.length < 8) {
  console.error('Choose a password of at least 8 characters.');
  process.exit(1);
}

migrate();

const existing = auth.findByEmail(email);
const hash = auth.hashPassword(password);

if (existing) {
  db.prepare('UPDATE staff SET password_hash = ?, must_change_pw = 0, active = 1 WHERE id = ?').run(hash, existing.id);
  auth.audit(existing.id, 'password_reset_cli', { email });
  console.log(`Password updated for ${existing.name} <${existing.email}> (role: ${existing.role}).`);
} else {
  const role = auth.ROLES.includes(roleArg) ? roleArg : 'admin';
  const info = db
    .prepare(
      `INSERT INTO staff (name, email, role, password_hash, must_change_pw, active)
       VALUES (?, ?, ?, ?, 0, 1)`
    )
    .run(email.split('@')[0], email, role, hash);
  auth.audit(info.lastInsertRowid, 'account_created_cli', { email, role });
  console.log(`Created ${role} account ${email}.`);
}

console.log(`Database: ${dbPath}`);
console.log('You can now sign in at /staff/login.');
