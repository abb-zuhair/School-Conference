'use strict';

/** Minimal RFC-4180 CSV parser — handles quotes, embedded commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** First row is the header; returns array of objects keyed by lowercase header. */
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((key, i) => {
      obj[key] = String(r[i] == null ? '' : r[i]).trim();
    });
    return obj;
  });
}

module.exports = { parseCsv, parseCsvObjects };
