'use strict';
/**
 * Microsoft Entra ID (Azure AD) single sign-on — OIDC authorization code flow.
 *
 * Deliberately dependency-free: the flow is three HTTPS calls and some string
 * handling, and every OIDC library we'd pull in is much larger than this file.
 *
 * Security notes:
 *  - `state` is bound to the session and checked on return (CSRF).
 *  - `nonce` is bound to the session and checked inside the id_token (replay).
 *  - The id_token is read from the token endpoint response, fetched server-to-server
 *    over TLS with the client secret — not from the browser redirect. OIDC Core
 *    §3.1.3.7 allows skipping signature validation in exactly this case. We still
 *    check issuer, audience, nonce and expiry.
 *  - Only the tenant in ENTRA_TENANT_ID can sign in; `common` is not used.
 */
const crypto = require('crypto');
const config = require('../config');

const SCOPES = 'openid profile email User.Read';

function authority() {
  return `${config.entra.authorityHost}/${config.entra.tenantId}`;
}

function redirectUri() {
  return config.entra.redirectUri || `${config.baseUrl}/auth/microsoft/callback`;
}

/** Build the URL we send the browser to, and the values we must remember. */
function buildAuthUrl() {
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    client_id: config.entra.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: SCOPES,
    state,
    nonce,
    prompt: 'select_account',
  });
  return { url: `${authority()}/oauth2/v2.0/authorize?${params}`, state, nonce };
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: config.entra.clientId,
    client_secret: config.entra.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    scope: SCOPES,
  });

  const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${data.error_description || data.error || 'unknown'}`);
  }
  return data;
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) throw new Error('Malformed id_token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

/** Throws unless the token really is ours, for our tenant, for this sign-in attempt. */
function verifyIdToken(idToken, expectedNonce) {
  const claims = decodeJwtPayload(idToken);

  const validIssuers = [
    `${config.entra.authorityHost}/${config.entra.tenantId}/v2.0`,
    `https://sts.windows.net/${config.entra.tenantId}/`,
  ];
  if (!validIssuers.includes(claims.iss)) {
    throw new Error(`Unexpected token issuer (${claims.iss}) — check ENTRA_TENANT_ID.`);
  }
  if (claims.aud !== config.entra.clientId) throw new Error('Token was issued for a different application.');
  if (claims.tid && claims.tid !== config.entra.tenantId) throw new Error('Sign-in came from a different Microsoft tenant.');
  if (expectedNonce && claims.nonce !== expectedNonce) throw new Error('Sign-in could not be verified. Please try again.');
  if (claims.exp && Date.now() / 1000 > claims.exp + 120) throw new Error('Sign-in token has expired. Please try again.');

  const email = String(claims.preferred_username || claims.email || claims.upn || '').trim().toLowerCase();
  if (!email) throw new Error('Microsoft did not return an email address for this account.');

  return {
    email,
    name: claims.name || email,
    oid: claims.oid || null,
    claims,
  };
}

module.exports = { buildAuthUrl, exchangeCode, verifyIdToken, redirectUri, authority };
