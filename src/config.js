'use strict';
require('dotenv').config();
const path = require('path');

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : parseInt(v, 10));

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'app.db'),
  timezone: process.env.SCHOOL_TIMEZONE || 'Asia/Kuwait',
  schoolName: process.env.SCHOOL_NAME || 'American Creativity Academy',
  supportEmail: process.env.SUPPORT_EMAIL || '',
  trustProxy: bool(process.env.TRUST_PROXY, true),

  admin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Administrator',
  },

  graph: {
    tenantId: process.env.GRAPH_TENANT_ID || '',
    clientId: process.env.GRAPH_CLIENT_ID || '',
    clientSecret: process.env.GRAPH_CLIENT_SECRET || '',
    sender: process.env.GRAPH_SENDER || '',
    get enabled() {
      return Boolean(this.tenantId && this.clientId && this.clientSecret && this.sender);
    },
  },

  wati: {
    endpoint: (process.env.WATI_API_ENDPOINT || '').replace(/\/+$/, ''),
    token: process.env.WATI_ACCESS_TOKEN || '',
    templates: {
      confirmation: process.env.WATI_TEMPLATE_CONFIRM || '',
      cancellation: process.env.WATI_TEMPLATE_CANCEL || '',
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
