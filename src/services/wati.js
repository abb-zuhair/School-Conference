'use strict';
// WATI WhatsApp Business sender.
// WATI only allows template messages outside a 24h service window, so every message
// here goes out as an approved template with positional {{1}}, {{2}} ... parameters.
const config = require('../config');
const { normalisePhone } = require('../lib/helpers');

/**
 * @param {string} phone   local or international number
 * @param {string} template  approved WATI template name
 * @param {string[]} params  ordered values for {{1}}, {{2}}, ...
 */
async function sendTemplate(phone, template, params = []) {
  if (!config.wati.enabled) return { status: 'skipped', detail: 'WATI not configured' };
  if (!template) return { status: 'skipped', detail: 'No WATI template name set for this message type' };

  const whatsappNumber = normalisePhone(phone);
  if (!whatsappNumber) return { status: 'skipped', detail: 'No phone number on the booking' };

  const url = `${config.wati.endpoint}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;
  const body = {
    template_name: template,
    broadcast_name: `${template}_${new Date().toISOString().slice(0, 10)}`,
    parameters: params.map((value, i) => ({ name: String(i + 1), value: String(value ?? '') })),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: config.wati.token.startsWith('Bearer ') ? config.wati.token : `Bearer ${config.wati.token}`,
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
    throw new Error(`WATI send failed (${res.status}): ${(data.info || text || '').toString().slice(0, 400)}`);
  }
  return { status: 'sent', detail: `to ${whatsappNumber} via ${template}` };
}

module.exports = { sendTemplate };
