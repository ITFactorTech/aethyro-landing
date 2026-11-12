// Usage: NODE_PATH=$(npm root -g) node csp-scan.cjs <base-url> <path> [<path> ...]
// Loads each page in headless Chromium and prints every console message that says the page CSP refused something,
// plus uncaught page errors. Clean = "CSP-refusals: 0 pageerrors: 0" for every page. (Do not rely on a
// securitypolicyviolation listener: it missed refusals that the console reported.)
const { chromium } = require('playwright');
const B = process.argv[2]; const pages = process.argv.slice(3);
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const p of pages) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport:{width:1280,height:900} });
    const page = await ctx.newPage();
    const refused = new Set(); const errs = new Set();
    page.on('console', m => { const t = m.text(); if (/Content Security Policy|violates the following/i.test(t)) refused.add(t.replace(/Refused to /,'').slice(0,170)); });
    page.on('pageerror', e => errs.add(String(e).slice(0,120)));
    try { await page.goto(B + p, { waitUntil: 'load', timeout: 45000 }); } catch (e) { errs.add('goto: '+String(e).slice(0,100)); }
    await page.waitForTimeout(3500);
    console.log('==', p, 'CSP-refusals:', refused.size, 'pageerrors:', errs.size);
    [...refused].slice(0,8).forEach(x => console.log('  R', x));
    [...errs].slice(0,3).forEach(x => console.log('  E', x));
    await ctx.close();
  }
  await browser.close();
})();
