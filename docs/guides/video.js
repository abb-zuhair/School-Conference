'use strict';
/**
 * Records a parent booking one appointment, slowly, with a caption bar and a
 * visible cursor, so it can be watched without sound.
 *
 * The caption bar and the cursor are injected into the page itself: the
 * browser shapes the Arabic correctly and the recording picks it all up, so
 * no text is drawn afterwards.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, 'raw');
const B = 'http://localhost:3000';
const W = 960;
const H = 540;

/* ----------------------------- overlay ------------------------------ */

const OVERLAY_CSS = `
  /* the page's own bottom bar sits above the caption, not under it */
  .basket-bar { bottom: 78px !important; }
  #v-cursor { position: fixed; z-index: 99999; width: 28px; height: 28px; pointer-events: none;
    transform: translate(-4px, -2px); transition: none; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
  #v-ripple { position: fixed; z-index: 99998; width: 44px; height: 44px; border-radius: 50%;
    border: 3px solid #C8922A; pointer-events: none; opacity: 0; transform: translate(-50%, -50%) scale(.4); }
  #v-ripple.go { animation: v-rip .55s ease-out forwards; }
  @keyframes v-rip { 0% { opacity: .9; transform: translate(-50%,-50%) scale(.4); } 100% { opacity: 0; transform: translate(-50%,-50%) scale(1.6); } }
  #v-cap { pointer-events: none; position: fixed; z-index: 99997; left: 0; right: 0; bottom: 0; padding: 14px 28px 16px;
    background: linear-gradient(180deg, rgba(11,61,92,0) 0%, rgba(11,61,92,.96) 28%);
    color: #fff; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex; align-items: center; justify-content: space-between; gap: 28px;
    opacity: 0; transition: opacity .35s ease; }
  #v-cap.show { opacity: 1; }
  #v-cap .n { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 50%; background: #C8922A; color: #0B3D5C;
    font-weight: 800; font-size: 22px; display: flex; align-items: center; justify-content: center; }
  #v-cap .en { flex: 1; font-size: 23px; font-weight: 700; letter-spacing: -.01em; }
  #v-cap .ar { flex: 1; font-size: 23px; font-weight: 700; direction: rtl; text-align: right; }
  #v-card { pointer-events: none; position: fixed; inset: 0; z-index: 100000; background: #0B3D5C; color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; text-align: center;
    opacity: 0; transition: opacity .4s ease; }
  #v-card.show { opacity: 1; }
  #v-card .mark { width: 60px; height: 60px; border-radius: 14px; background: #C8922A; color: #0B3D5C;
    font-weight: 900; font-size: 28px; display: flex; align-items: center; justify-content: center; }
  #v-card h1 { font-size: 42px; margin: 10px 0 0; font-weight: 800; letter-spacing: -.01em; }
  #v-card h2 { font-size: 32px; margin: 0; font-weight: 700; direction: rtl; }
  #v-card p { font-size: 20px; margin: 6px 0 0; color: #cfdce6; }
  #v-card .url { margin-top: 20px; font-size: 28px; background: rgba(255,255,255,.1); padding: 12px 28px; border-radius: 12px; }
`;

const CURSOR_SVG = `<svg viewBox="0 0 24 24" width="28" height="28"><path d="M5 3l14 9-6 1.5L16 20l-2.5 1-3-6.5L6 19z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

/** Put the overlay into whatever page is showing. Re-run after every navigation. */
async function installOverlay(page, state) {
  await page.evaluate(({ css, cursor, state: s }) => {
    if (!document.getElementById('v-style')) {
      const st = document.createElement('style'); st.id = 'v-style'; st.textContent = css; document.head.appendChild(st);
    }
    if (!document.getElementById('v-cursor')) {
      const c = document.createElement('div'); c.id = 'v-cursor'; c.innerHTML = cursor; document.body.appendChild(c);
      const r = document.createElement('div'); r.id = 'v-ripple'; document.body.appendChild(r);
      const cap = document.createElement('div'); cap.id = 'v-cap';
      cap.innerHTML = '<div class="n"></div><div class="en"></div><div class="ar"></div>';
      document.body.appendChild(cap);
      const card = document.createElement('div'); card.id = 'v-card'; document.body.appendChild(card);
      document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; });
      document.addEventListener('mousedown', (e) => {
        r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
        r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
      });
    }
    const c = document.getElementById('v-cursor');
    c.style.left = s.x + 'px'; c.style.top = s.y + 'px';
    if (s.caption) {
      const cap = document.getElementById('v-cap');
      cap.querySelector('.n').textContent = s.caption.n || '';
      cap.querySelector('.n').style.display = s.caption.n ? 'flex' : 'none';
      cap.querySelector('.en').textContent = s.caption.en;
      cap.querySelector('.ar').textContent = s.caption.ar;
      cap.classList.add('show');
    }
  }, { css: OVERLAY_CSS, cursor: CURSOR_SVG, state });
}

const state = { x: 450, y: 280, caption: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function caption(page, n, en, ar) {
  state.caption = { n, en, ar };
  await page.evaluate((cap) => {
    const el = document.getElementById('v-cap');
    el.classList.remove('show');
    setTimeout(() => {
      el.querySelector('.n').textContent = cap.n || '';
      el.querySelector('.n').style.display = cap.n ? 'flex' : 'none';
      el.querySelector('.en').textContent = cap.en;
      el.querySelector('.ar').textContent = cap.ar;
      el.classList.add('show');
    }, 250);
  }, state.caption);
  await sleep(500);
}

async function card(page, html, ms) {
  await page.evaluate((h) => { const el = document.getElementById('v-card'); el.innerHTML = h; el.classList.add('show'); }, html);
  await sleep(ms);
  await page.evaluate(() => document.getElementById('v-card').classList.remove('show'));
  await sleep(450);
}

/** Glide the cursor to an element and click it, like a person would. */
async function go(page, selector, { settle = 900, nth = 0, noScroll = false } = {}) {
  const els = await page.$$(selector);
  const el = els[nth];
  if (!el) {
    await page.screenshot({ path: path.join(__dirname, 'debug-fail.png') });
    throw new Error(`no element ${selector} [${nth}] on ${page.url()}`);
  }
  if (!noScroll) await el.evaluate((n) => n.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await sleep(300);
  const box = await el.boundingBox();
  const x = box.x + Math.min(box.width / 2, 120);
  const y = box.y + box.height / 2;
  await page.mouse.move(state.x, state.y);
  await page.mouse.move(x, y, { steps: 28 });
  state.x = x; state.y = y;
  await sleep(350);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
  await sleep(settle);
}

/** After a navigation the overlay is gone - put it back where the cursor was. */
async function arrived(page) {
  await page.waitForLoadState('networkidle');
  await installOverlay(page, state);
  await sleep(200);
}

async function typeSlowly(page, selector, text) {
  await go(page, selector, { settle: 300 });
  await page.type(selector, text, { delay: 70 });
  await sleep(600);
}

/* ------------------------------- run -------------------------------- */

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  // Recorded at the viewport's own size - Playwright pads rather than scales
  // up - and enlarged to 720p in the encode step, so the page reads at a size
  // a phone screen can show.
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  const page = await ctx.newPage();

  await page.goto(`${B}/`);
  await arrived(page);

  // Title card
  await card(page, `
    <div class="mark">ACA</div>
    <h1>Book a parent–teacher meeting</h1>
    <h2>احجز موعد لقاء المعلّم</h2>
    <p>Two minutes. No account needed.  ·  دقيقتان، بلا حساب.</p>`, 3200);

  // 1 · the conference, under your campus
  await caption(page, '1', 'Tap the conference', 'اضغط على اللقاء');
  await sleep(1200);
  await go(page, 'main a.tile[href="/e/ptc-term1-hawally"]');
  await arrived(page);

  // 2 · department
  await caption(page, '2', 'Choose the department', 'اختر القسم');
  await sleep(900);
  await go(page, 'main a[href^="/e/ptc-term1-hawally/d/"]');
  await arrived(page);

  // 4 · find the teacher
  await caption(page, '3', 'Type the teacher\'s name', 'اكتب اسم المعلّم');
  await sleep(500);
  await typeSlowly(page, '#q', 'Sara');
  await sleep(700);
  await go(page, 'main .card.teacher-row:not([hidden]) a.tile');
  await arrived(page);

  // 5 · pick a time -> asks for the child
  await caption(page, '4', 'Tap a free time', 'اضغط على وقت متاح');
  await sleep(900);
  await go(page, '.slot form button[type=submit]', { nth: 2 });
  await arrived(page);

  // 6 · child's name
  await caption(page, '5', 'Enter your child\'s name', 'أدخل اسم طفلك');
  await sleep(500);
  await typeSlowly(page, '#student_name', 'Ahmed Al-Fahad');
  await typeSlowly(page, '#student_grade', 'Grade 5A');
  await go(page, '#child-form button[type=submit]');
  await arrived(page);

  // back on the picker: selected
  await caption(page, '', 'Your time is selected ✓', 'تم اختيار الوقت ✓');
  await sleep(1800);
  await caption(page, '', 'More children? Press “Another child”', 'لديك طفل آخر؟ اضغط «Another child»');
  await page.evaluate(() => { const a = document.querySelector('.for-child a'); if (a) a.style.boxShadow = '0 0 0 4px #C8922A'; });
  await sleep(2200);
  await page.evaluate(() => { const a = document.querySelector('.for-child a'); if (a) a.style.boxShadow = ''; });

  // 7 · review
  await caption(page, '6', 'Press “Review & confirm”', 'اضغط «Review & confirm»');
  await sleep(700);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(300);
  await go(page, 'a.btn[href$="/review"]', { noScroll: true });
  await arrived(page);

  // 8 · details
  await caption(page, '7', 'Enter your name, email and mobile', 'أدخل اسمك وبريدك ورقم هاتفك');
  await sleep(500);
  await typeSlowly(page, '#parent_name', 'Mariam Al-Fahad');
  await typeSlowly(page, '#parent_email', 'mariam@example.com');
  await typeSlowly(page, '#parent_phone', '99123456');

  // 9 · confirm
  await caption(page, '8', 'Press Confirm', 'اضغط Confirm');
  await sleep(600);
  await go(page, 'form[action$="/confirm"] button[type=submit]');
  await arrived(page);

  await caption(page, '✓', 'Done — check email & WhatsApp', 'تم — تحقّق من بريدك وواتساب');
  await sleep(3200);

  // End card
  await card(page, `
    <div class="mark">ACA</div>
    <h1>That's it</h1>
    <h2>هذا كل شيء</h2>
    <p>Each appointment has its own link to cancel.  ·  لكل موعد رابط خاص للإلغاء.</p>
    <div class="url">appointments.aca.edu.kw</div>`, 3600);

  const video = page.video();
  await page.close();
  await ctx.close();
  const finalPath = path.join(OUT, 'booking.webm');
  await video.saveAs(finalPath);
  await browser.close();
  console.log('recorded', finalPath, fs.statSync(finalPath).size, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
