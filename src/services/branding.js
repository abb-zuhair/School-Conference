'use strict';
/**
 * The school's look: name, short mark, logo, two colours. One deployment per
 * school, and this is everything that differs between them on screen and in
 * email. Saved from Admin › Branding; environment variables are the defaults,
 * so a fresh deployment is already branded before anyone signs in.
 *
 *   SCHOOL_NAME     full name        SCHOOL_SHORT    2–5 letter mark ("ACA")
 *   BRAND_PRIMARY   main colour      BRAND_ACCENT    highlight colour
 *   SUPPORT_EMAIL   footer address   SCHOOL_DOMAIN   staff sign-in hint
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const settings = require('../lib/settings');

const KEYS = {
  name: 'brand.name',
  nameAr: 'brand.name_ar',
  short: 'brand.short',
  primary: 'brand.primary',
  accent: 'brand.accent',
  supportEmail: 'brand.support_email',
  domain: 'brand.domain',
  logo: 'brand.logo', // file name inside logoDir(), or ''
};

const DEFAULTS = {
  name: process.env.SCHOOL_NAME || 'American Creativity Academy',
  short: process.env.SCHOOL_SHORT || '',
  primary: process.env.BRAND_PRIMARY || '#0b3d5c',
  accent: process.env.BRAND_ACCENT || '#c8922a',
  supportEmail: process.env.SUPPORT_EMAIL || '',
  domain: process.env.SCHOOL_DOMAIN || 'aca.edu.kw',
};

/* ------------------------------ colour maths ------------------------------ */

function parseHex(v) {
  const m = String(v || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
}

/** Blend `amount` (0–1) of `to` into `from`. */
function mix(from, to, amount) {
  return toHex(from.map((c, i) => c + (to[i] - c) * amount));
}

/** Relative luminance, for choosing white or dark text on a colour. */
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function normaliseHex(v, fallback) {
  const rgb = parseHex(v);
  return rgb ? toHex(rgb) : fallback;
}

/** Initials from the name: "Kuwait English School" → "KES". */
function initials(name) {
  const words = String(name || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(of|the|and|&|de|al)$/i.test(w));
  const s = words.map((w) => w[0].toUpperCase()).join('');
  return s.slice(0, 4) || 'S';
}

/* --------------------------------- logo --------------------------------- */

/** Logos live beside the database, so on Railway they sit on the volume and survive deploys. */
function logoDir() {
  return path.resolve(path.dirname(config.databasePath), 'branding');
}

function logoPath() {
  const file = settings.get(KEYS.logo, '');
  if (!file || /[\\/]/.test(file)) return null;
  const full = path.join(logoDir(), file);
  return fs.existsSync(full) ? full : null;
}

const LOGO_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

/** The file must really be what it says it is — the browser's type is only a claim. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const head = buf.slice(0, 2048).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

/** An SVG is a document: scripts, event handlers and external loads have no place in a logo. */
function safeSvg(buf) {
  const text = buf.toString('utf8');
  return !/<script|<foreignObject|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:|<use[^>]+href\s*=\s*["']?\s*(https?:|data:)|xlink:href\s*=\s*["']?\s*(https?:|data:)/i.test(text);
}

function saveLogo(file) {
  const ext = sniff(file.buffer);
  if (!ext || ext !== LOGO_TYPES[file.mimetype]) throw new Error('That file is not a PNG, JPG, SVG or WebP image.');
  if (ext === 'svg' && !safeSvg(file.buffer)) throw new Error('That SVG contains scripts or external references and cannot be used as a logo.');
  fs.mkdirSync(logoDir(), { recursive: true });
  const name = `logo-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(logoDir(), name), file.buffer);
  const old = logoPath();
  settings.set(KEYS.logo, name);
  if (old) fs.rm(old, { force: true }, () => {});
  return name;
}

function removeLogo() {
  const old = logoPath();
  settings.set(KEYS.logo, '');
  if (old) fs.rm(old, { force: true }, () => {});
}

/* -------------------------------- current -------------------------------- */

function current() {
  const name = settings.get(KEYS.name, '') || DEFAULTS.name;
  const primary = normaliseHex(settings.get(KEYS.primary, '') || DEFAULTS.primary, '#0b3d5c');
  const accent = normaliseHex(settings.get(KEYS.accent, '') || DEFAULTS.accent, '#c8922a');
  const p = parseHex(primary);
  const a = parseHex(accent);
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  const logo = settings.get(KEYS.logo, '');
  const logoFile = logoPath();
  return {
    name,
    nameAr: settings.get(KEYS.nameAr, ''),
    short: (settings.get(KEYS.short, '') || DEFAULTS.short || initials(name)).slice(0, 6),
    primary,
    accent,
    primaryDark: mix(p, black, 0.22),
    primarySoft: mix(p, white, 0.9),
    primaryLine: mix(p, white, 0.72),
    onPrimary: luminance(p) > 0.179 ? '#16232e' : '#ffffff',
    onAccent: luminance(a) > 0.179 ? '#16232e' : '#ffffff',
    supportEmail: settings.get(KEYS.supportEmail, '') || DEFAULTS.supportEmail,
    domain: settings.get(KEYS.domain, '') || DEFAULTS.domain,
    logo,
    logoUrl: logoFile ? `/branding/logo?v=${encodeURIComponent(logo)}` : '',
    // Changes whenever anything above does, so browsers refetch the theme.
    version: Buffer.from(`${name}|${primary}|${accent}|${logo}`).toString('base64url').slice(0, 24),
  };
}

/** A tiny stylesheet overriding the colour variables in app.css. */
function themeCss() {
  const b = current();
  return `:root{--navy:${b.primary};--navy-dark:${b.primaryDark};--navy-soft:${b.primarySoft};--navy-line:${b.primaryLine};--gold:${b.accent};--on-navy:${b.onPrimary};--on-gold:${b.onAccent};}\n`;
}

/** Favicon as an SVG data URL: the short mark in the school's colours. */
function faviconDataUrl() {
  const b = current();
  const text = b.short.slice(0, 3);
  const size = text.length > 2 ? 11 : text.length > 1 ? 14 : 18;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${b.primary}'/><text x='16' y='21' font-size='${size}' font-family='Arial' font-weight='bold' text-anchor='middle' fill='${b.accent}'>${text}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function save(form) {
  settings.set(KEYS.name, form.name);
  settings.set(KEYS.nameAr, form.name_ar);
  settings.set(KEYS.short, String(form.short || '').toUpperCase().slice(0, 6));
  settings.set(KEYS.primary, parseHex(form.primary) ? normaliseHex(form.primary) : '');
  settings.set(KEYS.accent, parseHex(form.accent) ? normaliseHex(form.accent) : '');
  settings.set(KEYS.supportEmail, form.support_email);
  settings.set(KEYS.domain, String(form.domain || '').replace(/^@/, '').toLowerCase());
}

module.exports = { sniff, safeSvg, KEYS, DEFAULTS, current, themeCss, faviconDataUrl, save, saveLogo, removeLogo, logoPath, parseHex, mix, initials };
