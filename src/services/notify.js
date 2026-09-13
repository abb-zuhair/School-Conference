'use strict';
const { db } = require('../db');
const config = require('../config');
const { sendMail } = require('./graph-mail');
const { sendTemplate } = require('./wati');
const { formatDate, formatTime, escapeHtml, MODES, EVENT_TYPES } = require('../lib/helpers');

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
  reminder: reminderEmail,
};

/* --------------------------- WhatsApp ------------------------------ *
 * Template parameter order (document this when you submit the templates to WATI):
 *   {{1}} parent name
 *   {{2}} event name
 *   {{3}} who the appointment is with
 *   {{4}} date
 *   {{5}} time
 *   {{6}} location / link
 *   {{7}} manage-booking URL
 * ------------------------------------------------------------------- */
function whatsappParams(b) {
  return [
    b.parent_name,
    b.event_name,
    withWhom(b),
    formatDate(b.slot_date),
    formatTime(b.start_time),
    whereLine(b) || '-',
    manageUrl(b),
  ];
}

/* --------------------------- dispatcher ---------------------------- */

/**
 * Fire-and-forget: never let a messaging outage break a parent's booking.
 * Every attempt is written to the notifications table for the admin log.
 */
async function notify(booking, kind) {
  if (!booking) return;
  const tasks = [];

  const builder = EMAIL_BUILDERS[kind];
  if (builder && booking.parent_email) {
    const mail = builder(booking);
    tasks.push(
      sendMail({ to: booking.parent_email, subject: mail.subject, html: mail.html, replyTo: booking.staff_email || config.supportEmail || undefined })
        .then((r) => log(booking.id, 'email', kind, booking.parent_email, r.status, r.detail))
        .catch((err) => log(booking.id, 'email', kind, booking.parent_email, 'failed', err.message))
    );
  }

  const template = config.wati.templates[kind];
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

/** Copy of the booking sheet for the teacher, sent when a parent books. */
async function notifyStaff(booking) {
  if (!booking || !booking.staff_email || !config.graph.enabled) return;
  const mail = {
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
    const r = await sendMail(mail);
    log(booking.id, 'email', 'staff_copy', booking.staff_email, r.status, r.detail);
  } catch (err) {
    log(booking.id, 'email', 'staff_copy', booking.staff_email, 'failed', err.message);
  }
}

module.exports = { notify, notifyAsync, notifyStaff, log, whereLine, withWhom };
