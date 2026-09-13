'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const { migrate } = require('./db');
const SqliteStore = require('./db/session-store');
const auth = require('./lib/auth');
const helpers = require('./lib/helpers');
const reminders = require('./services/reminders');

migrate();
auth.ensureBootstrapAdmin();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', config.trustProxy ? 1 : 0);
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

app.use(
  session({
    name: 'aca.sid',
    store: new SqliteStore({ ttl: 1000 * 60 * 60 * 12 }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env === 'production' && config.baseUrl.startsWith('https://'),
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

// Flash messages
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  next();
});

// Shared view locals
app.use((req, res, next) => {
  res.locals.config = config;
  res.locals.h = helpers;
  res.locals.user = auth.currentUser(req);
  res.locals.path = req.path;
  res.locals.title = config.schoolName;
  res.locals.bodyClass = '';
  next();
});

// A member of staff still on a temporary password can only reach the change-password page.
app.use((req, res, next) => {
  const user = res.locals.user;
  const guarded = req.path.startsWith('/staff') || req.path.startsWith('/admin');
  const exempt = ['/staff/password', '/staff/logout', '/staff/login'].includes(req.path);
  if (user && user.must_change_pw && guarded && !exempt) return res.redirect('/staff/password');
  return next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/', require('./routes/public'));
app.use('/staff', require('./routes/staff'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', status: 404, message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).render('error', {
    title: 'Something went wrong',
    status: err.status || 500,
    message: config.env === 'production' ? 'Something went wrong. Please try again.' : err.message,
  });
});

const server = app.listen(config.port, () => {
  console.log(`${config.schoolName} appointments running on http://localhost:${config.port}`);
  console.log(`  base URL : ${config.baseUrl}`);
  console.log(`  email    : ${config.graph.enabled ? 'Microsoft Graph enabled' : 'disabled (set GRAPH_* in .env)'}`);
  console.log(`  whatsapp : ${config.wati.enabled ? 'WATI enabled' : 'disabled (set WATI_* in .env)'}`);
  reminders.start();
});

module.exports = { app, server };
