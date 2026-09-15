'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const sso = require('../services/entra-sso');

const router = express.Router();

function ssoUnavailable(res, message) {
  return res.status(503).render('error', {
    title: 'Microsoft sign-in unavailable',
    status: 503,
    message,
  });
}

/** Step 1 — hand the browser to Microsoft. */
router.get('/microsoft', (req, res) => {
  if (!config.entra.enabled) {
    return ssoUnavailable(res, 'Microsoft sign-in is not configured on this site. Use your email and password, or contact the IT office.');
  }
  const { url, state, nonce } = sso.buildAuthUrl();
  req.session.sso = { state, nonce, startedAt: Date.now(), returnTo: req.session.returnTo || null };
  // Persist the session before we leave, or the callback finds nothing to compare against.
  return req.session.save(() => res.redirect(url));
});

/** Step 2 — Microsoft sends the browser back here with a code. */
router.get('/microsoft/callback', async (req, res, next) => {
  if (!config.entra.enabled) return ssoUnavailable(res, 'Microsoft sign-in is not configured on this site.');

  const fail = (message, detail) => {
    if (detail) console.warn('[sso]', detail);
    req.flash('error', message);
    return res.redirect('/staff/login');
  };

  try {
    const pending = req.session.sso;
    delete req.session.sso;

    if (req.query.error) {
      return fail(
        req.query.error === 'access_denied'
          ? 'Microsoft sign-in was cancelled.'
          : 'Microsoft returned an error during sign-in.',
        `${req.query.error}: ${req.query.error_description || ''}`
      );
    }
    if (!pending || !pending.state) return fail('That sign-in link has expired. Please try again.');
    if (!req.query.state || req.query.state !== pending.state) {
      return fail('Sign-in could not be verified. Please try again.', 'state mismatch');
    }
    if (Date.now() - pending.startedAt > 10 * 60 * 1000) return fail('Sign-in took too long. Please try again.');
    if (!req.query.code) return fail('Microsoft did not return a sign-in code. Please try again.');

    const tokens = await sso.exchangeCode(String(req.query.code));
    if (!tokens.id_token) return fail('Microsoft did not return an identity token.', JSON.stringify(tokens).slice(0, 300));

    const profile = sso.verifyIdToken(tokens.id_token, pending.nonce);

    // Match an existing staff record — by Entra object id first, then by email.
    let user = profile.oid
      ? db.prepare('SELECT * FROM staff WHERE entra_oid = ?').get(profile.oid)
      : null;
    if (!user) user = auth.findByEmail(profile.email);

    if (!user && config.entra.autoCreate) {
      const role = auth.ROLES.includes(config.entra.autoCreateRole) ? config.entra.autoCreateRole : 'teacher';
      const info = db
        .prepare(
          `INSERT INTO staff (name, email, role, entra_oid, active, must_change_pw)
           VALUES (?, ?, ?, ?, 1, 0)`
        )
        .run(profile.name, profile.email, role, profile.oid);
      user = auth.findById(info.lastInsertRowid);
      auth.audit(user.id, 'sso_account_created', { email: profile.email, role });
    }

    if (!user) {
      auth.audit(null, 'sso_denied_unknown', { email: profile.email });
      return fail(
        `${profile.email} is not registered in the appointment system. Ask the IT office to add your account first.`
      );
    }
    if (!user.active) {
      auth.audit(user.id, 'sso_denied_inactive', { email: profile.email });
      return fail('That account has been deactivated. Contact the IT office.');
    }

    // Remember the Entra id so a later email change doesn't orphan the account.
    if (profile.oid && user.entra_oid !== profile.oid) {
      db.prepare('UPDATE staff SET entra_oid = ? WHERE id = ?').run(profile.oid, user.id);
    }
    db.prepare("UPDATE staff SET last_login_at = datetime('now'), last_login_method = 'microsoft' WHERE id = ?").run(user.id);

    // A Microsoft sign-in is proof of identity — no need to force a password change.
    if (user.must_change_pw && user.password_hash === null) {
      db.prepare('UPDATE staff SET must_change_pw = 0 WHERE id = ?').run(user.id);
    }

    return req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.staffId = user.id;
      auth.audit(user.id, 'login_microsoft', { email: user.email });
      const dest = pending.returnTo || (auth.ADMIN_ROLES.includes(user.role) ? '/admin' : '/staff');
      return req.session.save(() => res.redirect(dest));
    });
  } catch (err) {
    return fail('Microsoft sign-in failed. Please try again or use your password.', err.message);
  }
});

module.exports = router;
