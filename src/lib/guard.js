'use strict';
/**
 * Request-level protections that do not belong to any one route:
 *
 *  - security headers (CSP, frame denial, nosniff, referrer policy, HSTS)
 *  - cross-site request forgery: every state-changing request must come from
 *    this site (Origin / Referer check, on top of SameSite=Lax cookies)
 *  - throttling of sign-in attempts and parent lookups, per address
 *
 * No dependencies on purpose: the behaviour is small enough to read here.
 */
const config = require('../config');

/* ----------------------------- headers ----------------------------- */

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function headers(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.set('Content-Security-Policy', CSP);
  if (config.env === 'production' && config.baseUrl.startsWith('https://')) {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

/* ------------------------------ CSRF ------------------------------ */

function hostOf(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch (_) {
    return null;
  }
}

/**
 * A browser sends Origin on every cross-site POST (and Referer on most). Both
 * must name this site, or the request is refused. A request carrying neither
 * is not from a browser form at all (a script, the test suite), and a script
 * cannot carry the victim's cookie cross-site, so it passes.
 */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = new Set([String(req.get('host') || '').toLowerCase(), hostOf(config.baseUrl)].filter(Boolean));
  const origin = req.get('origin');
  const referer = req.get('referer');
  const source = origin && origin !== 'null' ? hostOf(origin) : referer ? hostOf(referer) : null;
  if (origin === 'null' || (source && !expected.has(source))) {
    return res.status(403).render('error', {
      title: 'Request refused',
      status: 403,
      message: 'This request did not come from this site, so it was not carried out. Open the page again and retry.',
    });
  }
  return next();
}

/* ---------------------------- throttling ---------------------------- */

/** A small sliding window per key, kept in memory; one process, so this is enough. */
function windowLimiter({ max, windowMs }) {
  const hits = new Map();
  const prune = (now) => {
    for (const [k, times] of hits) {
      const kept = times.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  };
  let lastPrune = Date.now();
  return {
    /** True when the key may proceed. */
    allowed(key) {
      const now = Date.now();
      if (now - lastPrune > windowMs) {
        prune(now);
        lastPrune = now;
      }
      const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
      hits.set(key, times);
      return times.length < max;
    },
    /** Count one attempt against the key. */
    hit(key) {
      const now = Date.now();
      hits.set(key, [...(hits.get(key) || []).filter((t) => now - t < windowMs), now]);
    },
    /** Forget the key — after a successful sign-in. */
    clear(key) {
      hits.delete(key);
    },
    /** Seconds until the oldest attempt leaves the window. */
    retryAfter(key) {
      const times = hits.get(key) || [];
      if (!times.length) return 0;
      return Math.max(1, Math.ceil((windowMs - (Date.now() - times[0])) / 1000));
    },
    reset() {
      hits.clear();
    },
  };
}

const WINDOW = 15 * 60 * 1000;
const limits = {
  // Failed password sign-ins: per address and per account, so one attacker
  // cannot lock everyone out and one account cannot be brute-forced from many addresses.
  loginByIp: windowLimiter({ max: 100, windowMs: WINDOW }),
  loginByEmail: windowLimiter({ max: 10, windowMs: WINDOW }),
  // Parent lookups and cancel-by-token guesses.
  lookupByIp: windowLimiter({ max: 20, windowMs: WINDOW }),
  tokenByIp: windowLimiter({ max: 60, windowMs: WINDOW }),
};

module.exports = { headers, sameOrigin, limits, windowLimiter, CSP };
