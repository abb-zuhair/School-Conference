'use strict';
/**
 * End-to-end SSO test against a mock Microsoft login host.
 *
 * Starts its own app instance on port 3100 with ENTRA_* pointed at a local
 * fake authority, then walks the real browser flow: /auth/microsoft →
 * authorize → callback → session. Also checks the rejection paths that matter
 * (unknown account, wrong tenant, replayed nonce, forged state, inactive user).
 *
 *   node test/sso.js
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const APP_PORT = 3100;
const IDP_PORT = 3101;
const BASE = `http://localhost:${APP_PORT}`;
const DB = path.join(__dirname, '..', 'data', 'sso-test.db');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

/* ---------------------- mock Microsoft ---------------------- */

const issued = new Map(); // code -> claims

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.${'sig'}`;
}

function baseClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `http://localhost:${IDP_PORT}/${TENANT}/v2.0`,
    aud: CLIENT_ID,
    tid: TENANT,
    exp: now + 3600,
    iat: now,
    oid: 'oid-of-sara',
    name: 'Sara Al-Mutairi',
    preferred_username: 'sara.mutairi@example.aca.edu.kw',
    ...overrides,
  };
}

/** The mock issues whatever claims the current scenario asks for. */
let nextClaims = (o) => baseClaims(o);

const idp = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${IDP_PORT}`);

  if (url.pathname === `/${TENANT}/oauth2/v2.0/authorize`) {
    const code = crypto.randomBytes(8).toString('hex');
    issued.set(code, nextClaims({ nonce: url.searchParams.get('nonce') }));
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (url.pathname === `/${TENANT}/oauth2/v2.0/token`) {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      const code = new URLSearchParams(body).get('code');
      const claims = issued.get(code);
      issued.delete(code);
      if (!claims) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'unknown code' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token_type: 'Bearer', expires_in: 3600, id_token: jwt(claims), access_token: 'mock' }));
    });
  }

  res.writeHead(404);
  return res.end('not found');
});

/* ---------------------------- client ---------------------------- */

function jar() {
  const c = new Map();
  return {
    header() { return [...c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    absorb(res) {
      for (const s of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [p] = s.split(';');
        const i = p.indexOf('=');
        c.set(p.slice(0, i), p.slice(i + 1));
      }
    },
  };
}

async function req(j, method, url, body) {
  const headers = { Cookie: j.header() };
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const target = url.startsWith('http') ? url : `${BASE}${url}`;
  const res = await fetch(target, { method, headers, body: payload, redirect: 'manual' });
  j.absorb(res);
  const text = res.status >= 300 && res.status < 400 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

/** Walk the whole redirect chain: app → idp → app callback. */
async function signInWithMicrosoft(j) {
  let r = await req(j, 'GET', '/auth/microsoft');
  if (r.status !== 302) return { stoppedAt: 'start', ...r };
  r = await req(j, 'GET', r.location); // mock authorize
  if (r.status !== 302) return { stoppedAt: 'authorize', ...r };
  r = await req(j, 'GET', r.location); // back to our callback
  return { stoppedAt: 'callback', ...r };
}

/* ----------------------------- run ----------------------------- */

(async () => {
  console.log('SSO test against a mock Microsoft login host\n');

  fs.rmSync(DB, { force: true });
  fs.rmSync(`${DB}-wal`, { force: true });
  fs.rmSync(`${DB}-shm`, { force: true });

  await new Promise((r) => idp.listen(IDP_PORT, r));

  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(APP_PORT),
    BASE_URL: BASE,
    DATABASE_PATH: DB,
    SESSION_SECRET: 'sso-test-secret',
    ENTRA_TENANT_ID: TENANT,
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET: 'mock-secret',
    ENTRA_AUTHORITY: `http://localhost:${IDP_PORT}`,
    ENTRA_AUTO_CREATE: 'false',
    ADMIN_EMAIL: 'admin@example.aca.edu.kw',
    ADMIN_PASSWORD: 'AdminPass123',
    REMINDERS_ENABLED: 'false',
  });

  const { app } = require('../src/server');
  const { db } = require('../src/db');
  const authLib = require('../src/lib/auth');
  void app;
  await new Promise((r) => setTimeout(r, 400));

  // A staff record that SSO should match, and one that is deactivated.
  db.prepare("INSERT INTO staff (name, email, role, active) VALUES ('Sara Al-Mutairi','sara.mutairi@example.aca.edu.kw','teacher',1)").run();
  db.prepare("INSERT INTO staff (name, email, role, active) VALUES ('Gone Away','gone@example.aca.edu.kw','teacher',0)").run();

  /* ---------- the button appears ---------- */
  let j = jar();
  let r = await req(j, 'GET', '/staff/login');
  check('login page offers Microsoft sign-in', r.text.includes('Sign in with Microsoft'));
  check('password form is still available', r.text.includes('name="password"'));

  /* ---------- happy path ---------- */
  j = jar();
  r = await signInWithMicrosoft(j);
  check('sign-in redirects into the app', r.status === 302, `status ${r.status} loc ${r.location}`);
  check('lands on the staff area', String(r.location).endsWith('/staff'), String(r.location));

  r = await req(j, 'GET', '/staff');
  check('session is authenticated', r.status === 200 && r.text.includes('My schedules'));

  const sara = authLib.findByEmail('sara.mutairi@example.aca.edu.kw');
  check('Entra object id was stored', sara.entra_oid === 'oid-of-sara');
  check('login method recorded', sara.last_login_method === 'microsoft');
  check('no password was needed', !sara.password_hash);

  /* ---------- unknown account is refused ---------- */
  nextClaims = (o) => baseClaims({ ...o, oid: 'oid-stranger', preferred_username: 'stranger@example.aca.edu.kw', name: 'A Stranger' });
  j = jar();
  r = await signInWithMicrosoft(j);
  check('unknown account bounces to login', r.status === 302 && String(r.location).includes('/staff/login'));
  r = await req(j, 'GET', '/staff/login');
  check('unknown account sees why', r.text.includes('not registered in the appointment system'));
  r = await req(j, 'GET', '/staff');
  check('unknown account gets no session', r.status === 302 && String(r.location).includes('/staff/login'));
  check('unknown account was not created', !authLib.findByEmail('stranger@example.aca.edu.kw'));

  /* ---------- deactivated account is refused ---------- */
  nextClaims = (o) => baseClaims({ ...o, oid: 'oid-gone', preferred_username: 'gone@example.aca.edu.kw', name: 'Gone Away' });
  j = jar();
  r = await signInWithMicrosoft(j);
  check('deactivated account is refused', r.status === 302 && String(r.location).includes('/staff/login'));
  r = await req(j, 'GET', '/staff/login');
  check('deactivated account sees why', r.text.includes('deactivated'));

  /* ---------- a token from another tenant ---------- */
  nextClaims = (o) => baseClaims({ ...o, tid: '99999999-9999-9999-9999-999999999999' });
  j = jar();
  r = await signInWithMicrosoft(j);
  r = await req(j, 'GET', '/staff/login');
  check('foreign tenant is rejected', r.text.includes('Microsoft sign-in failed'));

  /* ---------- a token minted for another app ---------- */
  nextClaims = (o) => baseClaims({ ...o, aud: 'some-other-app' });
  j = jar();
  await signInWithMicrosoft(j);
  r = await req(j, 'GET', '/staff/login');
  check('wrong audience is rejected', r.text.includes('Microsoft sign-in failed'));

  /* ---------- an expired token ---------- */
  nextClaims = (o) => baseClaims({ ...o, exp: Math.floor(Date.now() / 1000) - 600 });
  j = jar();
  await signInWithMicrosoft(j);
  r = await req(j, 'GET', '/staff/login');
  check('expired token is rejected', r.text.includes('Microsoft sign-in failed'));

  /* ---------- a replayed / mismatched nonce ---------- */
  nextClaims = (o) => baseClaims({ ...o, nonce: 'not-the-one-we-sent' });
  j = jar();
  await signInWithMicrosoft(j);
  r = await req(j, 'GET', '/staff/login');
  check('nonce mismatch is rejected', r.text.includes('Microsoft sign-in failed'));

  nextClaims = (o) => baseClaims(o);

  /* ---------- forged state (CSRF) ---------- */
  j = jar();
  r = await req(j, 'GET', '/auth/microsoft');
  const authorizeUrl = new URL(r.location);
  r = await req(j, 'GET', r.location);
  const good = new URL(r.location);
  good.searchParams.set('state', 'attacker-chosen-state');
  r = await req(j, 'GET', good.toString());
  check('forged state is rejected', r.status === 302 && String(r.location).includes('/staff/login'));
  r = await req(j, 'GET', '/staff/login');
  check('forged state explains itself', r.text.includes('could not be verified'));

  /* ---------- callback with no pending sign-in ---------- */
  j = jar();
  r = await req(j, 'GET', '/auth/microsoft/callback?code=abc&state=xyz');
  check('stray callback is rejected', r.status === 302 && String(r.location).includes('/staff/login'));

  /* ---------- the authorize URL itself ---------- */
  check('authorize URL targets our tenant', authorizeUrl.pathname.startsWith(`/${TENANT}/`));
  check('authorize URL asks for a code', authorizeUrl.searchParams.get('response_type') === 'code');
  check('authorize URL carries our client id', authorizeUrl.searchParams.get('client_id') === CLIENT_ID);
  check('authorize URL sends a nonce', Boolean(authorizeUrl.searchParams.get('nonce')));
  check('redirect_uri matches BASE_URL', authorizeUrl.searchParams.get('redirect_uri') === `${BASE}/auth/microsoft/callback`);

  /* ---------- password login still works ---------- */
  j = jar();
  r = await req(j, 'POST', '/staff/login', { email: 'admin@example.aca.edu.kw', password: 'AdminPass123' });
  check('password sign-in still works', r.status === 302);

  console.log(`\n${pass} passed, ${fail} failed`);
  idp.close();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nSSO test crashed:', err);
  idp.close();
  process.exit(1);
});
