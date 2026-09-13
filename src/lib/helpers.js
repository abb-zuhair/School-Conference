'use strict';
const crypto = require('crypto');
const { DateTime } = require('luxon');
const config = require('../config');

const TZ = config.timezone;

function token(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function slugify(value, fallback = 'item') {
  const base = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || fallback;
}

function nowLocal() {
  return DateTime.now().setZone(TZ);
}

/** '2026-10-05' + '14:30' -> luxon DateTime in school timezone */
function localDT(date, time = '00:00') {
  return DateTime.fromFormat(`${date} ${time}`, 'yyyy-MM-dd HH:mm', { zone: TZ });
}

/** '2026-10-05 14:30' (as stored on events) -> DateTime, tolerant of missing time */
function parseStamp(value) {
  if (!value) return null;
  const cleaned = String(value).trim().replace('T', ' ').slice(0, 16);
  const withTime = cleaned.length === 10 ? `${cleaned} 00:00` : cleaned;
  const dt = DateTime.fromFormat(withTime, 'yyyy-MM-dd HH:mm', { zone: TZ });
  return dt.isValid ? dt : null;
}

function formatDate(date, locale = 'en') {
  const dt = typeof date === 'string' ? localDT(date) : date;
  if (!dt || !dt.isValid) return '';
  return dt.setLocale(locale === 'ar' ? 'ar' : 'en-GB').toFormat('cccc d LLLL yyyy');
}

function formatShortDate(date, locale = 'en') {
  const dt = typeof date === 'string' ? localDT(date) : date;
  if (!dt || !dt.isValid) return '';
  return dt.setLocale(locale === 'ar' ? 'ar' : 'en-GB').toFormat('ccc d LLL');
}

/** '14:30' -> '2:30 PM' */
function formatTime(time) {
  const [h, m] = String(time).split(':').map(Number);
  if (Number.isNaN(h)) return time;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function timeToMinutes(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

/** Normalise a Kuwaiti mobile to E.164 digits (no '+') for WATI. */
function normalisePhone(value, countryCode = config.wati.countryCode) {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  digits = digits.replace(/^00/, '').replace(/^\+/, '');
  if (digits.length === 8) digits = `${countryCode}${digits}`;
  return digits;
}

function asBool(value) {
  return value === true || value === 1 || value === '1' || value === 'on' || value === 'true';
}

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const body = rows
    .map((row) => columns.map((c) => csvEscape(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','))
    .join('\n');
  // BOM so Excel on Windows opens Arabic names correctly
  return `﻿${header}\n${body}\n`;
}

const EVENT_TYPES = {
  conference: { label: 'Parent–teacher conference', ownerLabel: 'Teacher', icon: '🎓' },
  uniform: { label: 'Uniform fitting / pick-up', ownerLabel: 'Counter', icon: '👕' },
  registration: { label: 'Registration / admissions', ownerLabel: 'Desk', icon: '📝' },
  other: { label: 'Other appointment', ownerLabel: 'Desk', icon: '📅' },
};

const MODES = {
  in_person: 'In person',
  phone: 'Phone call',
  video: 'Video call',
};

module.exports = {
  TZ,
  token,
  slugify,
  nowLocal,
  localDT,
  parseStamp,
  formatDate,
  formatShortDate,
  formatTime,
  timeToMinutes,
  minutesToTime,
  escapeHtml,
  isEmail,
  normalisePhone,
  asBool,
  toCsv,
  EVENT_TYPES,
  MODES,
};
