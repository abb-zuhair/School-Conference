'use strict';
require('dotenv').config();
const path = require('path');

/**
 * Environment values arrive from dashboards where it is easy to paste a
 * placeholder verbatim. Strip surrounding whitespace, angle brackets and
 * quotes so `<my-tenant-id>` and `"secret"` behave like the bare value.
 */
const clean = (v) =>
  String(v == null ? '' : v)
    .trim()
    .replace(/^<+|>+$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : parseInt(v, 10));

/** Read a branding value once the database is up; before that, the environment answers. */
function brand(key, fallback) {
  try {
    // Lazy: the database needs this module first.
    return require('./services/branding').current()[key] || fallback;
  } catch (_) {
    return fallback;
  }
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  baseUrl: (clean(process.env.BASE_URL) || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'app.db'),
  timezone: process.env.SCHOOL_TIMEZONE || 'Asia/Kuwait',
  // Both can be changed on Admin › Branding; the environment is the default.
  get schoolName() {
    return brand('name', process.env.SCHOOL_NAME || 'American Creativity Academy');
  },
  get supportEmail() {
    return brand('supportEmail', process.env.SUPPORT_EMAIL || '');
  },
  trustProxy: bool(process.env.TRUST_PROXY, true),

  admin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Administrator',
  },

  // The same Entra app that signs staff in can send mail, once it has the
  // Mail.Send application permission - so GRAPH_* only need setting when a
  // different app is wanted. The sender mailbox can also be set on Admin -> Email.
  graph: {
    tenantId: clean(process.env.GRAPH_TENANT_ID) || clean(process.env.ENTRA_TENANT_ID),
    clientId: clean(process.env.GRAPH_CLIENT_ID) || clean(process.env.ENTRA_CLIENT_ID),
    clientSecret: clean(process.env.GRAPH_CLIENT_SECRET) || clean(process.env.ENTRA_CLIENT_SECRET),
    sender: clean(process.env.GRAPH_SENDER),
    // Overridable so the test suite can stand in for Microsoft.
    host: (process.env.GRAPH_HOST || 'https://graph.microsoft.com').replace(/\/+$/, ''),
    authorityHost: (process.env.ENTRA_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    get hasApp() {
      return Boolean(this.tenantId && this.clientId && this.clientSecret);
    },
    get enabled() {
      return Boolean(this.hasApp && this.sender);
    },
  },

  entra: {
    tenantId: clean(process.env.ENTRA_TENANT_ID) || clean(process.env.GRAPH_TENANT_ID),
    clientId: clean(process.env.ENTRA_CLIENT_ID),
    clientSecret: clean(process.env.ENTRA_CLIENT_SECRET),
    redirectUri: clean(process.env.ENTRA_REDIRECT_URI),
    // Sovereign clouds use a different login host (and the test suite points this
    // at a local mock). Leave unset for normal Microsoft 365.
    authorityHost: (process.env.ENTRA_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    // Deny anyone without a staff record. Flip on only if you want every
    // account in the tenant to get a teacher login automatically.
    autoCreate: bool(process.env.ENTRA_AUTO_CREATE, false),
    autoCreateRole: process.env.ENTRA_AUTO_CREATE_ROLE || 'teacher',
    get enabled() {
      return Boolean(this.tenantId && this.clientId && this.clientSecret);
    },
  },

  wati: {
    endpoint: (process.env.WATI_API_ENDPOINT || '').replace(/\/+$/, ''),
    token: process.env.WATI_ACCESS_TOKEN || '',
    templates: {
      confirmation: process.env.WATI_TEMPLATE_CONFIRM || '',
      cancellation: process.env.WATI_TEMPLATE_CANCEL || '',
      reschedule: process.env.WATI_TEMPLATE_RESCHEDULE || '',
      reminder: process.env.WATI_TEMPLATE_REMINDER || '',
    },
    countryCode: (process.env.DEFAULT_COUNTRY_CODE || '965').replace(/\D/g, ''),
    get enabled() {
      return Boolean(this.endpoint && this.token);
    },
  },

  reminders: {
    cron: process.env.REMINDER_CRON || '0 18 * * *',
    hoursBefore: int(process.env.REMINDER_HOURS_BEFORE, 24),
    enabled: bool(process.env.REMINDERS_ENABLED, true),
  },
};

module.exports = config;
