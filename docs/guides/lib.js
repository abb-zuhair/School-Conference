'use strict';
/**
 * Shared building blocks for the ACA appointment guides.
 *
 * One page style, two documents. Everything the two guides have in common -
 * the title block, the note box, the bilingual two-column block the parent
 * guide is built from, screenshots with captions - lives here so they look
 * like a set.
 */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType, LevelFormat,
  PageBreak, VerticalAlign,
} = require('docx');

const SHOTS = path.join(__dirname, 'shots');

const NAVY = '0B3D5C';
const GOLD = 'C8922A';
const INK = '16232E';
const MUTED = '6B7C8C';
const LINE = 'D9E1E8';
const PANEL = 'F1F6FA';
const NOTE_BG = 'FFF8E6';

const PAGE_W = 11906;             // A4 in DXA
const MARGIN = 1134;              // 2 cm
const CONTENT_W = PAGE_W - 2 * MARGIN; // 9638
const IMG_MAX_PX = 630;           // content width at 96 dpi, with a little slack

/* --------------------------------------------------------------------- *
 * Text runs
 * --------------------------------------------------------------------- */

/** Inline markup: **bold**, *italic*. Keeps authoring readable. */
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(new TextRun({ text: tok.slice(2, -2), bold: true, ...base }));
    else out.push(new TextRun({ text: tok.slice(1, -1), italics: true, ...base }));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}

const AR = { rightToLeft: true };

function p(text, opts = {}) {
  const { ar = false, size, color, bold, after = 120, before = 0, align, keepNext } = opts;
  return new Paragraph({
    children: runs(text, { size, color, bold, ...(ar ? AR : {}) }),
    bidirectional: ar,
    alignment: align || (ar ? AlignmentType.RIGHT : AlignmentType.LEFT),
    spacing: { after, before },
    keepNext,
  });
}

function h1(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160 },
    keepNext: true,
  });
}

function h2(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    keepNext: true,
  });
}

/* --------------------------------------------------------------------- *
 * Lists - each list gets its own numbering instance so numbers restart.
 * --------------------------------------------------------------------- */

let listCounter = 0;
const numberingConfigs = [];

function numbered(items, { ar = false } = {}) {
  listCounter += 1;
  const ref = `num-${listCounter}`;
  numberingConfigs.push({
    reference: ref,
    levels: [{
      level: 0,
      format: LevelFormat.DECIMAL,
      text: '%1.',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 540, hanging: 360 } } },
    }],
  });
  return items.map((text) => new Paragraph({
    children: runs(text, ar ? AR : {}),
    numbering: { reference: ref, level: 0 },
    bidirectional: ar,
    spacing: { after: 100 },
  }));
}

function bullets(items, { ar = false } = {}) {
  listCounter += 1;
  const ref = `bul-${listCounter}`;
  numberingConfigs.push({
    reference: ref,
    levels: [{
      level: 0,
      format: LevelFormat.BULLET,
      text: '•',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 540, hanging: 360 } } },
    }],
  });
  return items.map((text) => new Paragraph({
    children: runs(text, ar ? AR : {}),
    numbering: { reference: ref, level: 0 },
    bidirectional: ar,
    spacing: { after: 80 },
  }));
}

/* --------------------------------------------------------------------- *
 * Boxes and tables
 * --------------------------------------------------------------------- */

const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
const thin = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const thinBorders = { top: thin, bottom: thin, left: thin, right: thin };

function cell(children, { width, fill, borders = noBorders, margins } = {}) {
  return new TableCell({
    children,
    width: { size: width, type: WidthType.DXA },
    shading: fill ? { fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    borders,
    margins: margins || { top: 120, bottom: 120, left: 160, right: 160 },
    verticalAlign: VerticalAlign.TOP,
  });
}

/** A shaded callout that never splits across pages. */
function note(title, body, { ar = false, arTitle, arBody } = {}) {
  const left = [p(`**${title}**`, { after: 60, color: NAVY }), ...[].concat(body).map((t) => p(t, { after: 60 }))];
  if (!arTitle) {
    return new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: [CONTENT_W],
      rows: [new TableRow({ cantSplit: true, children: [cell(left, { width: CONTENT_W, fill: NOTE_BG, borders: thinBorders })] })],
    });
  }
  const half = Math.floor(CONTENT_W / 2);
  const right = [p(`**${arTitle}**`, { ar: true, after: 60, color: NAVY }), ...[].concat(arBody).map((t) => p(t, { ar: true, after: 60 }))];
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [half, CONTENT_W - half],
    rows: [new TableRow({ cantSplit: true, children: [
      cell(left, { width: half, fill: NOTE_BG, borders: thinBorders }),
      cell(right, { width: CONTENT_W - half, fill: NOTE_BG, borders: thinBorders }),
    ] })],
  });
}

/**
 * The parent guide's unit: English on the left, Arabic on the right, one
 * row that will not split. `en` and `ar` are arrays of paragraph strings;
 * the first of each is the heading.
 */
function bilingual(en, ar, { fill = PANEL } = {}) {
  const half = Math.floor(CONTENT_W / 2);
  const left = en.map((t, i) => p(t, { after: 80, bold: i === 0, color: i === 0 ? NAVY : undefined }));
  const right = ar.map((t, i) => p(t, { ar: true, after: 80, bold: i === 0, color: i === 0 ? NAVY : undefined }));
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [half, CONTENT_W - half],
    rows: [new TableRow({ cantSplit: true, children: [
      cell(left, { width: half, fill, borders: thinBorders }),
      cell(right, { width: CONTENT_W - half, fill, borders: thinBorders }),
    ] })],
  });
}

/** A plain two-column reference table with a header row. */
function table(headers, rows, widths) {
  const ws = widths || headers.map(() => Math.floor(CONTENT_W / headers.length));
  const head = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: headers.map((h, i) => cell([p(`**${h}**`, { after: 0, color: NAVY })], { width: ws[i], fill: PANEL, borders: thinBorders })),
  });
  const body = rows.map((r) => new TableRow({
    cantSplit: true,
    children: r.map((c, i) => cell([].concat(c).map((t) => p(t, { after: 40 })), { width: ws[i], borders: thinBorders })),
  }));
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: ws, rows: [head, ...body] });
}

/* --------------------------------------------------------------------- *
 * Screenshots
 * --------------------------------------------------------------------- */

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A screenshot scaled to the content width, with a small caption below. */
function shot(file, caption, { maxWidth = IMG_MAX_PX, arCaption } = {}) {
  const buf = fs.readFileSync(path.join(SHOTS, file));
  const { width, height } = pngSize(buf);
  const scale = Math.min(1, maxWidth / (width / 2)); // shots were taken at 2x
  const w = Math.round((width / 2) * scale);
  const h = Math.round((height / 2) * scale);
  const out = [
    new Paragraph({
      children: [new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h } })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 40 },
      keepNext: Boolean(caption),
    }),
  ];
  if (caption) {
    out.push(new Paragraph({
      children: [
        ...runs(caption, { size: 18, color: MUTED, italics: true }),
        ...(arCaption ? [new TextRun({ text: '   ·   ', size: 18, color: MUTED }), ...runs(arCaption, { size: 18, color: MUTED, italics: true, rightToLeft: true })] : []),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }));
  }
  return out;
}

/* --------------------------------------------------------------------- *
 * Title block and document shell
 * --------------------------------------------------------------------- */

function title(kicker, name, strap, arStrap) {
  const out = [
    new Paragraph({
      children: [new TextRun({ text: kicker.toUpperCase(), bold: true, color: GOLD, size: 20, characterSpacing: 40 })],
      spacing: { after: 60 },
    }),
    new Paragraph({
      children: [new TextRun({ text: name, bold: true, color: NAVY, size: 56 })],
      spacing: { after: 120 },
    }),
  ];
  if (strap) {
    out.push(new Paragraph({
      children: [
        ...runs(strap, { size: 24, color: MUTED }),
        ...(arStrap ? [new TextRun({ text: '   ·   ', size: 24, color: MUTED }), ...runs(arStrap, { size: 24, color: MUTED, rightToLeft: true })] : []),
      ],
      spacing: { after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: GOLD, space: 8 } },
    }));
  }
  return out;
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

async function build(children, { file, titleText }) {
  const doc = new Document({
    creator: 'American Creativity Academy',
    title: titleText,
    styles: {
      default: {
        document: { run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Arial' }, size: 22, color: INK } },
      },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 34, bold: true, color: NAVY, font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Arial' } },
          paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, color: NAVY, font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Arial' } },
          paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
      ],
    },
    numbering: { config: numberingConfigs },
    sections: [{
      properties: { page: { margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      children,
    }],
  });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = { p, h1, h2, numbered, bullets, note, bilingual, table, shot, title, pageBreak, build, NAVY, MUTED };
