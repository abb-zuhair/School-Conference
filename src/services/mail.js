'use strict';
/**
 * One place that sends email.
 *
 * Two ways out: an SMTP server the administrator entered on the Email page,
 * or Microsoft Graph from the environment. SMTP wins when it is configured,
 * because it was set deliberately in the console; Graph stays as the way a
 * Railway deploy that was set up with env vars keeps working. Neither
 * configured, and every send is recorded as skipped rather than failing.
 */
const nodemailer = require('nodemailer');
const config = require('../config');
const settings = require('../lib/settings');
const graph = require('./graph-mail');

const KEYS = {
  host: 'mail.host',
  port: 'mail.port',
  secure: 'mail.secure',
  user: 'mail.user',
  password: 'mail.password',
  from: 'mail.from',
  fromName: 'mail.from_name',
  teacherOnBooking: 'mail.teacher_on_booking',
  teacherOnCancel: 'mail.teacher_on_cancel',
};

let transporter = null;
let transporterKey = '';

/** The settings as they stand right now, with what they mean for sending. */
function current() {
  const host = settings.get(KEYS.host, '');
  const port = Number(settings.get(KEYS.port, '')) || (settings.getBool(KEYS.secure, false) ? 465 : 587);
  const smtp = {
    host,
    port,
    secure: settings.getBool(KEYS.secure, port === 465),
    user: settings.get(KEYS.user, ''),
    password: settings.get(KEYS.password, ''),
    from: settings.get(KEYS.from, '') || settings.get(KEYS.user, ''),
    fromName: settings.get(KEYS.fromName, '') || config.schoolName,
  };
  const smtpReady = Boolean(smtp.host && smtp.from);
  const provider = smtpReady ? 'smtp' : config.graph.enabled ? 'graph' : null;
  return {
    smtp,
    provider,
    enabled: Boolean(provider),
    source: provider === 'smtp' ? 'the admin console' : provider === 'graph' ? 'environment variables (Microsoft Graph)' : 'nothing yet',
    teacherOnBooking: settings.getBool(KEYS.teacherOnBooking, true),
    teacherOnCancel: settings.getBool(KEYS.teacherOnCancel, true),
  };
}

function getTransporter(smtp) {
  const key = JSON.stringify([smtp.host, smtp.port, smtp.secure, smtp.user, smtp.password]);
  if (transporter && transporterKey === key) return transporter;
  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    // Office 365 and Gmail want STARTTLS on 587; a self-hosted relay on the
    // school network may well present a certificate for a different name.
    tls: { rejectUnauthorized: settings.getBool('mail.verify_tls', true) },
  });
  transporterKey = key;
  return transporter;
}

/**
 * @param {object} msg { to, subject, html, replyTo?, cc? }
 * @returns {{status: 'sent'|'skipped', detail: string}}  throws on failure
 */
async function sendMail(msg) {
  const cfg = current();
  if (cfg.provider === 'graph') return graph.sendMail(msg);
  if (cfg.provider !== 'smtp') return { status: 'skipped', detail: 'Email is not configured' };
  if (!msg.to) return { status: 'skipped', detail: 'No email address on the booking' };

  const t = getTransporter(cfg.smtp);
  const info = await t.sendMail({
    from: { name: cfg.smtp.fromName, address: cfg.smtp.from },
    to: msg.to,
    cc: msg.cc && msg.cc.length ? msg.cc : undefined,
    replyTo: msg.replyTo || undefined,
    subject: msg.subject,
    html: msg.html,
  });
  return { status: 'sent', detail: `to ${msg.to} via ${cfg.smtp.host} (${info.messageId || 'no id'})` };
}

/** Open a connection and say hello, without sending anything. */
async function verify() {
  const cfg = current();
  if (cfg.provider !== 'smtp') throw new Error('SMTP is not configured');
  await getTransporter(cfg.smtp).verify();
  return true;
}

/** Forget the cached connection - after the settings change. */
function reset() {
  transporter = null;
  transporterKey = '';
}

module.exports = { KEYS, current, sendMail, verify, reset };
