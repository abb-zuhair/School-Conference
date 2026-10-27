const { chromium } = require('playwright-core');
const OUT = require('path').join(__dirname, 'shots');
const B = 'http://localhost:3000';
const E = `${B}/e/ptc-term1-hawally`;

async function shotCard(p, selector, file, pad = 0) {
  const el = await p.$(selector);
  if (!el) throw new Error('no element for ' + selector + ' on ' + p.url());
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await p.screenshot({
    path: `${OUT}/${file}`,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });

  /* ---------------- parent ---------------- */
  await p.goto(`${B}/`);
  await p.screenshot({ path: `${OUT}/p01-home.png`, clip: { x: 0, y: 0, width: 900, height: 620 } });

  await p.goto(E);
  await p.screenshot({ path: `${OUT}/p02-event.png`, fullPage: true });

  await p.goto(`${E}/d/1`);
  await p.fill('#q', 'Sara');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${OUT}/p03-department-search.png`, fullPage: true });

  // first pick -> who is this for
  await p.goto(`${E}/s/1`);
  await p.click('.slot form button[type=submit]');
  await p.waitForLoadState('networkidle');
  await shotCard(p, 'main .card', 'p04-who-is-this-for.png', 10);
  await p.fill('#student_name', 'Ahmed Al-Fahad');
  await p.fill('#student_grade', 'Grade 5A');
  await p.click('#child-form button[type=submit]');
  await p.waitForLoadState('networkidle');

  // slot picker with the "choosing times for" bar and a selected time
  await p.screenshot({ path: `${OUT}/p05-pick-a-time.png`, fullPage: true });

  // switch child
  await p.click('.for-child a');
  await p.waitForLoadState('networkidle');
  await shotCard(p, 'main .card', 'p06-switch-child.png', 10);
  await p.check('input[name=child][value=new]');
  await p.fill('#student_name', 'Layla Al-Fahad');
  await p.fill('#student_grade', 'Grade 4A');
  await p.click('#child-form button[type=submit]');
  await p.waitForLoadState('networkidle');
  await p.goto(`${E}/s/3`);
  const btns = await p.$$('.slot form button[type=submit]');
  await btns[5].click();
  await p.waitForLoadState('networkidle');

  // review
  await p.goto(`${E}/review`);
  await p.screenshot({ path: `${OUT}/p07-review.png`, fullPage: true });

  // confirm → confirmation page
  await p.fill('#parent_name', 'Mariam Al-Fahad');
  await p.fill('#parent_email', 'mariam@example.com');
  await p.fill('#parent_phone', '99123456');
  await p.fill('#notes', 'Ahmed has found the reading homework hard this term.');
  await p.click('form[action$="/confirm"] button[type=submit]');
  await p.waitForLoadState('networkidle');
  await p.screenshot({ path: `${OUT}/p08-confirmation.png`, fullPage: true });

  // manage page
  const manage = await p.$('a[href^="/booking/"]');
  const href = await manage.getAttribute('href');
  await p.goto(`${B}${href}`);
  await p.screenshot({ path: `${OUT}/p09-manage.png`, fullPage: true });

  // lookup
  await p.goto(`${B}/lookup`);
  await p.fill('input[name=parent_email]', 'mariam@example.com');
  await p.click('main form button[type=submit]');
  await p.waitForLoadState('networkidle');
  await p.screenshot({ path: `${OUT}/p10-lookup.png`, fullPage: true });

  /* ---------------- teacher ---------------- */
  const t = await b.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
  await t.goto(`${B}/staff/login`);
  await t.screenshot({ path: `${OUT}/t01-login.png`, clip: { x: 0, y: 0, width: 1000, height: 640 } });
  await t.fill('input[name=email]', 'sara.mutairi@example.aca.edu.kw');
  await t.fill('input[name=password]', 'SaraPass123');
  await t.click('main form button[type=submit]');
  await t.waitForLoadState('networkidle');
  await t.goto(`${B}/staff`);
  await t.screenshot({ path: `${OUT}/t02-dashboard.png`, fullPage: true });
  await t.goto(`${B}/staff/schedule/1`);
  await t.screenshot({ path: `${OUT}/t03-schedule.png`, fullPage: true });
  await t.goto(`${B}/staff/schedule/1/print`);
  await t.screenshot({ path: `${OUT}/t04-print.png`, clip: { x: 0, y: 0, width: 1000, height: 700 } });

  /* ---------------- department head ---------------- */
  const h = await b.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
  await h.goto(`${B}/staff/login`);
  await h.fill('input[name=email]', 'huda.ajmi@example.aca.edu.kw');
  await h.fill('input[name=password]', 'Welcome123!');
  await h.click('main form button[type=submit]');
  await h.waitForLoadState('networkidle');
  if (h.url().includes('/password')) {
    await h.fill('input[name=new_password]', 'HeadPass123');
    await h.fill('input[name=confirm_password]', 'HeadPass123');
    await h.click('main form button[type=submit]');
    await h.waitForLoadState('networkidle');
  }
  await h.goto(`${B}/staff/department`);
  await h.screenshot({ path: `${OUT}/h01-department.png`, fullPage: true });

  await b.close();
})();
