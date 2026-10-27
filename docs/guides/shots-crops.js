const { chromium } = require('playwright-core');
const OUT = require('path').join(__dirname, 'shots');
const B = 'http://localhost:3000';
const E = `${B}/e/ptc-term1-hawally`;

async function clipTo(p, selectors, file, pad = 12) {
  const boxes = [];
  for (const s of selectors) {
    // "main>.card#2" means the third .card directly under main
    let el;
    const m = /^(.*)#(\d+)$/.exec(s);
    if (m) { const list = await p.$$(m[1]); el = list[Number(m[2])]; }
    else el = await p.$(s);
    if (!el) throw new Error('missing ' + s + ' on ' + p.url());
    boxes.push(await el.boundingBox());
  }
  const x = Math.min(...boxes.map((b) => b.x)) - pad;
  const y = Math.min(...boxes.map((b) => b.y)) - pad;
  const r = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const btm = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  await p.screenshot({ path: `${OUT}/${file}`, clip: { x: Math.max(0, x), y: Math.max(0, y), width: r - Math.max(0, x), height: btm - Math.max(0, y) }, fullPage: true });
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });

  await p.goto(`${E}/d/1`);
  await p.fill('#q', 'Sara');
  await p.waitForTimeout(200);
  await clipTo(p, ['main > .card#0', 'main > .card.teacher-row:not([hidden])'], 'p03-department-search.png');

  // build the same two-child basket as before
  await p.goto(`${E}/s/1`);
  await p.click('.slot form button[type=submit]');
  await p.waitForLoadState('networkidle');
  await p.fill('#student_name', 'Ahmed Al-Fahad');
  await p.fill('#student_grade', 'Grade 5A');
  await p.click('#child-form button[type=submit]');
  await p.waitForLoadState('networkidle');
  await p.goto(`${E}/child?back=${encodeURIComponent('/e/ptc-term1-hawally/s/3')}`);
  await p.check('input[name=child][value=new]');
  await p.fill('#student_name', 'Layla Al-Fahad');
  await p.fill('#student_grade', 'Grade 4A');
  await p.click('#child-form button[type=submit]');
  await p.waitForLoadState('networkidle');
  const btns = await p.$$('.slot form button[type=submit]');
  await btns[7].click();
  await p.waitForLoadState('networkidle');

  await p.goto(`${E}/review`);
  await clipTo(p, ['main > .card#0'], 'p07-review.png');

  await p.fill('#parent_name', 'Mariam Al-Fahad');
  await p.fill('#parent_email', 'mariam2@example.com');
  await p.fill('#parent_phone', '99123456');
  await p.click('form[action$="/confirm"] button[type=submit]');
  await p.waitForLoadState('networkidle');
  await clipTo(p, ['main > .card#0', 'main > .card#2'], 'p08-confirmation.png');

  const href = await (await p.$('a[href^="/booking/"]')).getAttribute('href');
  await p.goto(`${B}${href}`);
  await clipTo(p, ['main > .card#0'], 'p09-manage.png');

  await p.goto(`${B}/lookup`);
  await p.fill('input[name=parent_email]', 'mariam2@example.com');
  await p.click('main form button[type=submit]');
  await p.waitForLoadState('networkidle');
  const all = await p.$$('main > .card');
  await clipTo(p, [`main > .card#${all.length - 1}`], 'p10-lookup.png');

  await b.close();
})();
