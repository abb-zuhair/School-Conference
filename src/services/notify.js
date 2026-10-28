'use strict';
const { db } = require('../db');
const config = require('../config');
const mail = require('./mail');
const { sendMail } = mail;
const wati = require('./wati');

const { sendTemplate } = wati;
const { formatDate, formatShortDate, formatTime, escapeHtml, MODES, EVENT_TYPES } = require('../lib/helpers');

function log(bookingId, channel, kind, recipient, status, detail) {
  try {
    db.prepare(
      'INSERT INTO notifications (booking_id, channel, kind, recipient, status, detail) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(bookingId || null, channel, kind, recipient || null, status, String(detail || '').slice(0, 800));
  } catch (_) {
    /* non-fatal */
  }
}

function withWhom(b) {
  return b.staff_name || b.label || b.class_name || EVENT_TYPES[b.event_type]?.label || 'the school';
}

function whereLine(b) {
  const mode = MODES[b.mode] || 'In person';
  if (b.mode === 'video' && b.meeting_link) return `${mode} — ${b.meeting_link}`;
  if (b.mode === 'phone') return `${mode} — the school will call ${b.parent_phone || 'you'}`;
  return [mode, b.location || b.room].filter(Boolean).join(' — ');
}

function manageUrl(b) {
  return `${config.baseUrl}/booking/${b.token}`;
}

/* ------------------------- email templates ------------------------- */

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16232e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e2e8ef">
      <tr><td style="background:#0b3d5c;padding:20px 26px;color:#fff">
        <div style="font-size:17px;font-weight:600">${escapeHtml(config.schoolName)}</div>
        <div style="font-size:13px;opacity:.85">${escapeHtml(title)}</div>
      </td></tr>
      <tr><td style="padding:26px">${bodyHtml}</td></tr>
      <tr><td style="padding:16px 26px;background:#f7f9fb;font-size:12px;color:#6b7c8c">
        This is an automated message${config.supportEmail ? ` — questions? Write to <a href="mailto:${escapeHtml(config.supportEmail)}" style="color:#0b3d5c">${escapeHtml(config.supportEmail)}</a>` : ''}.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function detailTable(b) {
  const rows = [
    ['Appointment', escapeHtml(b.event_name)],
    ['With', escapeHtml(withWhom(b)) + (b.class_name ? ` — ${escapeHtml(b.class_name)}` : '')],
    ['Date', escapeHtml(formatDate(b.slot_date))],
    ['Time', `${escapeHtml(formatTime(b.start_time))} – ${escapeHtml(formatTime(b.end_time))}`],
    ['Where', escapeHtml(whereLine(b))],
    b.campus_name ? ['Campus', escapeHtml(b.campus_name)] : null,
    b.student_name ? ['Student', escapeHtml(b.student_name) + (b.student_grade ? ` (Grade ${escapeHtml(b.student_grade)})` : '')] : null,
  ].filter(Boolean);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;border-collapse:collapse">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:7px 0;color:#6b7c8c;width:110px;vertical-align:top">${k}</td><td style="padding:7px 0;font-weight:600">${v}</td></tr>`
      )
      .join('')}
  </table>`;
}

function confirmationEmail(b) {
  return {
    subject: `Confirmed: ${b.event_name} — ${formatDate(b.slot_date)} at ${formatTime(b.start_time)}`,
    html: shell(
      'Appointment confirmed',
      `<p style="margin:0 0 16px;font-size:15px">Dear ${escapeHtml(b.parent_name)}, your appointment is confirmed.</p>
       ${detailTable(b)}
       ${b.instructions ? `<div style="margin:18px 0;padding:12px 14px;background:#f1f6fa;border-radius:8px;font-size:13px;white-space:pre-wrap">${escapeHtml(b.instructions)}</div>` : ''}
       <p style="margin:20px 0 0"><a href="${manageUrl(b)}" style="display:inline-block;background:#0b3d5c;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px">View or cancel this appointment</a></p>
       <p style="margin:14px 0 0;font-size:12px;color:#6b7c8c">Keep this link — it is the only way to change the booking online.</p>`
    ),
  };
}

function cancellationEmail(b) {
  return {
    subject: `Cancelled: ${b.event_name} — ${formatDate(b.slot_date)} at ${formatTime(b.start_time)}`,
    html: shell(
      'Appointment cancelled',
      `<p style="margin:0 0 16px;font-size:15px">Dear ${escapeHtml(b.parent_name)}, the appointment below has been cancelled.</p>
       ${detailTable(b)}
       <p style="margin:20px 0 0;font-size:14px">If this was a mistake you can book another time from the campus booking page.</p>`
    ),
  };
}

/**
 * The appointment itself did not change — the school moved it. The old time is
 * spelled out above the new one so a parent who has it written down can see at
 * a glance what to cross out.
 */
function rescheduledEmail(b) {
  const was = b.was_date && b.was_start
    ? `<p style="margin:0 0 14px;font-size:14px;color:#6b7c8c">
         Previously <span style="text-decoration:line-through">${escapeHtml(formatDate(b.was_date))} at ${escapeHtml(formatTime(b.was_start))}</span>
       </p>`
    : '';
  return {
    subject: `New time: ${b.event_name} — ${formatDate(b.slot_date)} at ${formatTime(b.start_time)}`,
    html: shell(
      'Your appointment has moved',
      `<p style="margin:0 0 16px;font-size:15px">Dear ${escapeHtml(b.parent_name)}, the school has moved your appointment. You do not need to book again — the new time is below.</p>
       ${was}
       ${detailTable(b)}
       <p style="margin:20px 0 0"><a href="${manageUrl(b)}" style="display:inline-block;background:#0b3d5c;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px">View or cancel this appointment</a></p>
       <p style="margin:14px 0 0;font-size:12px;color:#6b7c8c">Your original link still works and now shows the new time. If it no longer suits you, you can cancel from there and pick another.</p>`
    ),
  };
}

function reminderEmail(b) {
  return {
    subject: `Reminder: ${b.event_name} tomorrow at ${formatTime(b.start_time)}`,
    html: shell(
      'Appointment reminder',
      `<p style="margin:0 0 16px;font-size:15px">Dear ${escapeHtml(b.parent_name)}, this is a reminder of your upcoming appointment.</p>
       ${detailTable(b)}
       <p style="margin:20px 0 0"><a href="${manageUrl(b)}" style="display:inline-block;background:#0b3d5c;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px">View appointment</a></p>`
    ),
  };
}

const EMAIL_BUILDERS = {
  confirmation: confirmationEmail,
  cancellation: cancellationEmail,
  reschedule: rescheduledEmail,
  reminder: reminderEmail,
};

/* --------------------------- WhatsApp ------------------------------ *
 * Every template — summary, confirmation, cancellation, reminder — uses the
 * same four parameters. WATI plans commonly cap a template at four, and the
 * body must not END with a variable, so the suggested wording on the admin
 * page closes with a static line.
 *
 *   {{1}} parent name
 *   {{2}} event name, with the campus
 *   {{3}} the appointment(s), on one line
 *   {{4}} link to view or cancel
 * ------------------------------------------------------------------- */

/** "Parent–Teacher Conference — Term 1 (ACA Hawally)" */
function eventLabel(b) {
  return b.campus_name ? `${b.event_name} (${b.campus_name})` : b.event_name;
}

/** "Sun 27 Sep 3:10 PM — Sara Al-Mutairi (Room B-204)", with the child in front when there is one: "Ahmed: Sun 27 Sep …" */
function appointmentLine(b) {
  const where = b.location || b.room || '';
  const child = b.student_name ? `${b.student_name}: ` : '';
  return `${child}${formatShortDate(b.slot_date)} ${formatTime(b.start_time)} — ${withWhom(b)}${where ? ` (${where})` : ''}`;
}

function whatsappParams(b) {
  return [b.parent_name, eventLabel(b), appointmentLine(b), manageUrl(b)];
}

/* --------------------------- dispatcher ---------------------------- */

/**
 * Fire-and-forget: never let a messaging outage break a parent's booking.
 * Every attempt is written to the notifications table for the admin log.
 */
async function notify(booking, kind) {
  if (!booking) return;
  const tasks = [];
  if (kind === 'cancellation') tasks.push(notifyStaffCancelled(booking));

  const builder = EMAIL_BUILDERS[kind];
  if (builder && booking.parent_email) {
    const mail = builder(booking);
    tasks.push(
      sendMail({ to: booking.parent_email, subject: mail.subject, html: mail.html, replyTo: booking.staff_email || config.supportEmail || undefined })
        .then((r) => log(booking.id, 'email', kind, booking.parent_email, r.status, r.detail))
        .catch((err) => log(booking.id, 'email', kind, booking.parent_email, 'failed', err.message))
    );
  }

  const template = wati.current().templates[kind];
  if (booking.parent_phone) {
    tasks.push(
      sendTemplate(booking.parent_phone, template, whatsappParams(booking))
        .then((r) => log(booking.id, 'whatsapp', kind, booking.parent_phone, r.status, r.detail))
        .catch((err) => log(booking.id, 'whatsapp', kind, booking.parent_phone, 'failed', err.message))
    );
  }

  await Promise.allSettled(tasks);
}

function notifyAsync(booking, kind) {
  notify(booking, kind).catch((err) => console.error('[notify]', err.message));
}

/* ------------------- one message for a whole booking ------------------- *
 * A parent who books four teachers should get four emails — each carries its
 * own cancel link — but only one WhatsApp, listing the lot. Same four
 * parameters as every other template.
 * ---------------------------------------------------------------------- */

/** WhatsApp template parameters cannot contain newlines, so this stays one line. */
function summaryLine(bookings) {
  return bookings.map(appointmentLine).join('  ·  ');
}

function summaryParams(bookings) {
  const first = bookings[0];
  return [
    first.parent_name,
    eventLabel(first),
    summaryLine(bookings),
    `${config.baseUrl}/confirmation/${first.group_token}`,
  ];
}

/**
 * Confirmation for one submission: an email per appointment, and a single
 * WhatsApp covering all of them. Falls back to per-appointment WhatsApp
 * messages when no summary template has been configured.
 */
async function notifyBookingGroup(bookings) {
  if (!bookings || !bookings.length) return;
  const cfg = wati.current();
  const summaryTemplate = cfg.templates.summary;
  const phone = bookings[0].parent_phone;

  const tasks = [];

  // Emails stay per appointment — each one carries its own cancel link.
  for (const booking of bookings) {
    const mail = EMAIL_BUILDERS.confirmation(booking);
    if (booking.parent_email) {
      tasks.push(
        sendMail({
          to: booking.parent_email,
          subject: mail.subject,
          html: mail.html,
          replyTo: booking.staff_email || config.supportEmail || undefined,
        })
          .then((r) => log(booking.id, 'email', 'confirmation', booking.parent_email, r.status, r.detail))
          .catch((err) => log(booking.id, 'email', 'confirmation', booking.parent_email, 'failed', err.message))
      );
    }
  }

  if (phone) {
    if (summaryTemplate) {
      tasks.push(
        sendTemplate(phone, summaryTemplate, summaryParams(bookings))
          .then((r) =>
            log(bookings[0].id, 'whatsapp', 'summary', phone, r.status, `${bookings.length} appointment(s) — ${r.detail}`)
          )
          .catch((err) => log(bookings[0].id, 'whatsapp', 'summary', phone, 'failed', err.message))
      );
    } else {
      for (const booking of bookings) {
        tasks.push(
          sendTemplate(phone, cfg.templates.confirmation, whatsappParams(booking))
            .then((r) => log(booking.id, 'whatsapp', 'confirmation', phone, r.status, r.detail))
            .catch((err) => log(booking.id, 'whatsapp', 'confirmation', phone, 'failed', err.message))
        );
      }
    }
  }

  await Promise.allSettled(tasks);
}

function notifyBookingGroupAsync(bookings) {
  notifyBookingGroup(bookings).catch((err) => console.error('[notify]', err.message));
}

/** Copy of the booking sheet for the teacher, sent when a parent books. */
async function notifyStaff(booking) {
  if (!booking || !booking.staff_email) return;
  const cfg = mail.current();
  if (!cfg.enabled || !cfg.teacherOnBooking) return;
  const msg = {
    to: booking.staff_email,
    subject: `New booking: ${booking.parent_name} — ${formatDate(booking.slot_date)} ${formatTime(booking.start_time)}`,
    html: shell(
      'New appointment booked',
      `<p style="margin:0 0 16px;font-size:15px">A parent has booked a slot on your schedule.</p>
       ${detailTable(booking)}
       ${booking.notes ? `<div style="margin:16px 0;padding:12px 14px;background:#f1f6fa;border-radius:8px;font-size:13px"><strong>Parent's note:</strong><br>${escapeHtml(booking.notes)}</div>` : ''}
       <p style="margin:18px 0 0"><a href="${config.baseUrl}/staff" style="color:#0b3d5c">Open your schedule</a></p>`
    ),
  };
  try {
    const r = await sendMail(msg);
    log(booking.id, 'email', 'staff_copy', booking.staff_email, r.status, r.detail);
  } catch (err) {
    log(booking.id, 'email', 'staff_copy', booking.staff_email, 'failed', err.message);
  }
}

/**
 * The teacher's copy of a cancellation. Only when someone else cancelled -
 * a teacher who pressed Cancel on their own sheet does not need telling.
 */
async function notifyStaffCancelled(booking) {
  if (!booking || !booking.staff_email) return;
  if (booking.cancelled_by === 'staff') return;
  const cfg = mail.current();
  if (!cfg.enabled || !cfg.teacherOnCancel) return;
  const by = booking.cancelled_by === 'admin' ? 'the office' : 'the parent';
  const msg = {
    to: booking.staff_email,
    subject: `Cancelled: ${booking.parent_name} — ${formatDate(booking.slot_date)} ${formatTime(booking.start_time)}`,
    html: shell(
      'Appointment cancelled',
      `<p style="margin:0 0 16px;font-size:15px">This appointment on your schedule was cancelled by ${by}. The time is free again for another family.</p>
       ${detailTable(booking)}
       <p style="margin:18px 0 0"><a href="${config.baseUrl}/staff" style="color:#0b3d5c">Open your schedule</a></p>`
    ),
  };
  try {
    const r = await sendMail(msg);
    log(booking.id, 'email', 'staff_cancel', booking.staff_email, r.status, r.detail);
  } catch (err) {
    log(booking.id, 'email', 'staff_cancel', booking.staff_email, 'failed', err.message);
  }
}

module.exports = {
  notify,
  notifyAsync,
  notifyBookingGroup,
  notifyBookingGroupAsync,
  summaryParams,
  summaryLine,
  notifyStaff,
  notifyStaffCancelled,
  log,
  whereLine,
  withWhom,
};
