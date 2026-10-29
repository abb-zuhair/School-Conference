'use strict';
// Microsoft Graph app-only mail sender.
// Entra app registration needs the APPLICATION permission Mail.Send with admin consent,
// and GRAPH_SENDER must be a real mailbox in the tenant.
const config = require('../config');

let cachedToken = null; // { value, expiresAt }

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const url = `${config.graph.authorityHost}/${config.graph.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.graph.clientId,
    client_secret: config.graph.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Graph token request failed (${res.status}): ${data.error_description || data.error || 'unknown'}`);
  }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/**
 * @param {object} msg { to, subject, html, replyTo?, cc? }
 */
async function sendMail(msg, sender = config.graph.sender) {
  if (!config.graph.hasApp || !sender) {
    return { status: 'skipped', detail: 'Graph mail not configured' };
  }
  const accessToken = await getToken();
  const payload = {
    message: {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.html },
      toRecipients: [{ emailAddress: { address: msg.to } }],
      ccRecipients: (msg.cc || []).map((a) => ({ emailAddress: { address: a } })),
      replyTo: msg.replyTo ? [{ emailAddress: { address: msg.replyTo } }] : undefined,
    },
    saveToSentItems: false,
  };

  const res = await fetch(
    `${config.graph.host}/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );

  if (res.status === 202) return { status: 'sent', detail: `to ${msg.to} via Microsoft 365 as ${sender}` };
  const text = await res.text().catch(() => '');
  // The two mistakes everyone makes, said in words rather than codes.
  if (res.status === 403) {
    throw new Error(
      `Microsoft refused (403). The app has not been granted the Mail.Send APPLICATION permission with admin consent, ` +
        `or an access policy keeps it away from ${sender}.`
    );
  }
  if (res.status === 404) {
    throw new Error(`Microsoft could not find a mailbox called ${sender} (404). It must be a real, licensed mailbox in the tenant.`);
  }
  throw new Error(`Graph sendMail failed (${res.status}): ${text.slice(0, 300)}`);
}

module.exports = { sendMail };
