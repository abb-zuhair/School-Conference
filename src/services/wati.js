'use strict';
// WATI WhatsApp Business sender.
//
// Outside the 24-hour service window WhatsApp only accepts approved templates,
// so every message here goes out as one, with positional {{1}}, {{2}} ... values.
//
// Settings come from the admin form first (Messaging page) and fall back to the
// WATI_* environment variables, so an existing deployment keeps working.
const config = require('../config');
const settings = require('../lib/settings');
const { normalisePhone } = require('../lib/helpers');

/** Live configuration: database values win, environment is the fallback. */
function current() {
  const endpoint = settings.get('wati.endpoint', config.wati.endpoint).replace(/\/+$/, '');
  const token = settings.get('wati.token', config.wati.token);
  return {
    endpoint,
    token,
    countryCode: settings.get('wati.country_code', config.wati.countryCode).replace(/\D/g, '') || '965',
    templates: {
      confirmation: settings.get('wati.template.confirmation', config.wati.templates.confirmation),
      summary: settings.get('wati.template.summary', ''),
      cancellation: settings.get('wati.template.cancellation', config.wati.templates.cancellation),
      reminder: settings.get('wati.template.reminder', config.wati.templates.reminder),
    },
    enabled: Boolean(endpoint && token),
    source: settings.get('wati.endpoint', '') ? 'admin form' : 'environment variables',
  };
}

/** WhatsApp rejects newlines and tabs inside template parameters. */
function sanitiseParam(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * @param {string} phone      local or international number
 * @param {string} template   approved WATI template name
 * @param {string[]} params   ordered values for {{1}}, {{2}}, ...
 */
async function sendTemplate(phone, template, params = []) {
  const cfg = current();
  if (!cfg.enabled) return { status: 'skipped', detail: 'WhatsApp is not configured' };
  if (!template) return { status: 'skipped', detail: 'No template name set for this message type' };

  const whatsappNumber = normalisePhone(phone, cfg.countryCode);
  if (!whatsappNumber) return { status: 'skipped', detail: 'No phone number on the booking' };

  const url = `${cfg.endpoint}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
  const body = {
    template_name: template,
    broadcast_name: `${template}_${new Date().toISOString().slice(0, 10)}`,
    parameters: params.map((value, i) => ({ name: String(i + 1), value: sanitiseParam(value) })),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: cfg.token.startsWith('Bearer ') ? cfg.token : `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {
    /* WATI occasionally returns plain text */
  }

  if (!res.ok || data.result === false) {
    throw new Error(`WATI send failed (${res.status}): ${(data.info || data.message || text || '').toString().slice(0, 400)}`);
  }
  return { status: 'sent', detail: `to ${whatsappNumber} via ${template}` };
}

module.exports = { sendTemplate, current, sanitiseParam };
