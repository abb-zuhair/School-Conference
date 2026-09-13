'use strict';
const cron = require('node-cron');
const { db } = require('../db');
const config = require('../config');
const { notify } = require('./notify');
const { bookingById } = require('../lib/scheduling');
const { nowLocal, localDT } = require('../lib/helpers');

/** Bookings starting inside the reminder window that have not had a reminder yet. */
function dueBookings() {
  const now = nowLocal();
  const until = now.plus({ hours: config.reminders.hoursBefore });
  const rows = db
    .prepare(
      `SELECT b.id, sl.slot_date, sl.start_time
       FROM bookings b
       JOIN slots sl ON sl.id = b.slot_id
       WHERE b.status = 'booked'
         AND sl.slot_date BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.booking_id = b.id AND n.kind = 'reminder' AND n.status = 'sent'
         )`
    )
    .all(now.toFormat('yyyy-MM-dd'), until.plus({ days: 1 }).toFormat('yyyy-MM-dd'));

  return rows.filter((r) => {
    const starts = localDT(r.slot_date, r.start_time);
    return starts > now && starts <= until;
  });
}

async function runReminders() {
  const due = dueBookings();
  if (!due.length) return { sent: 0 };
  let sent = 0;
  for (const row of due) {
    const booking = bookingById(row.id);
    if (!booking) continue;
    // eslint-disable-next-line no-await-in-loop
    await notify(booking, 'reminder');
    sent += 1;
  }
  console.log(`[reminders] processed ${sent} booking(s)`);
  return { sent };
}

function start() {
  if (!config.reminders.enabled) return null;
  if (!cron.validate(config.reminders.cron)) {
    console.warn(`[reminders] invalid REMINDER_CRON "${config.reminders.cron}" — reminders disabled`);
    return null;
  }
  const task = cron.schedule(config.reminders.cron, () => {
    runReminders().catch((err) => console.error('[reminders]', err.message));
  }, { timezone: config.timezone });
  console.log(`[reminders] scheduled "${config.reminders.cron}" (${config.timezone}), ${config.reminders.hoursBefore}h before`);
  return task;
}

module.exports = { start, runReminders, dueBookings };
