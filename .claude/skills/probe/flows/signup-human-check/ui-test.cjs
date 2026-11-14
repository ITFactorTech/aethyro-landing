const { chromium } = require('playwright');
const fs = require('fs');
const ROOT = process.cwd();
const SITEKEY = '0xTESTSITEKEY';
let failures = 0;
const ok = (c, m) => { console.log((c ? 'ok   - ' : 'FAIL - ') + m); if (!c) failures++; };

async function open(page, path, { sitekey = '', solve = true, blockTs = false } = {}) {
  const calls = { signup: [], otp: [], tsScript: 0, tsReset: 0 };
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost') {
      if (u.pathname === '/app/config.js') {
        const body = fs.readFileSync(ROOT + '/app/config.js', 'utf8').replace('window.AETHYRO_TURNSTILE_SITEKEY = "";', `window.AETHYRO_TURNSTILE_SITEKEY = "${sitekey}";`);
        return route.fulfill({ contentType: 'application/javascript', body });
      }
      return route.continue();
    }
    if (u.hostname === 'challenges.cloudflare.com') {
      calls.tsScript++;
      if (blockTs) return route.abort();
      const cb = solve ? `setTimeout(function(){ opts.callback('fake-token-' + (++window.__n)); }, 50);` : '';
      return route.fulfill({ contentType: 'application/javascript', body: `
        window.__n = 0; window.__resets = 0;
        window.turnstile = { render: function(sel, opts){ ${cb} document.querySelector(sel).setAttribute('data-rendered', opts.sitekey); return 'w1'; }, reset: function(id){ window.__resets++; ${solve ? "setTimeout(function(){ window.__lastOpts && 0; }, 0);" : ''} } };
        ${'window.__onl && 0;'}
        (function(){ var q = location.search; })();
        if (window.__aethyroTsLoaded) window.__aethyroTsLoaded();` });
    }
    if (u.hostname.endsWith('supabase.co')) {
      const post = route.request().postData();
      if (u.pathname.endsWith('/auth/v1/signup')) { calls.signup.push(JSON.parse(post)); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'u', email: 'a@b.test', session: null }) }); }
      if (u.pathname.endsWith('/auth/v1/otp')) { calls.otp.push(JSON.parse(post)); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (u.hostname === 'api.pwnedpasswords.com') return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    return route.abort();
  });
  await page.goto('http://localhost:8765' + path, { waitUntil: 'domcontentloaded' });
  return calls;
}
(async () => {
  const browser = await chromium.launch();
  const ctx = async () => { const c = await browser.newContext(); return c.newPage(); };
  const submitSignup = async (page) => { await page.fill('#email', 'new.person@example.org'); await page.fill('#password', 'a-strong-unique-passphrase-9'); await page.click('#submit'); await page.waitForTimeout(700); };

  // A. default config: nothing changes
  let page = await ctx(); let c = await open(page, '/app/signup.html');
  await page.waitForTimeout(300);
  ok(await page.locator('#humanCheck').isHidden(), 'A: no sitekey -> widget container hidden');
  await submitSignup(page);
  ok(c.tsScript === 0, 'A: no sitekey -> Turnstile script never requested');
  ok(c.signup.length === 1 && !('cf_turnstile_token' in (c.signup[0].data || {})), 'A: signup request sent WITHOUT a token (behaviour unchanged)');
  ok(c.signup[0].data && 'signup_referrer' in c.signup[0].data, 'A: attribution metadata still sent');

  // B. sitekey set, widget solves
  page = await ctx(); c = await open(page, '/app/signup.html', { sitekey: SITEKEY });
  await page.waitForTimeout(400);
  ok(await page.locator('#humanCheck').evaluate(function(el){return !el.hidden;}), 'B: sitekey -> widget container shown');
  ok((await page.locator('#humanCheck').getAttribute('data-rendered')) === SITEKEY, 'B: widget rendered with the configured site key');
  await submitSignup(page);
  ok(c.signup.length === 1 && c.signup[0].data.cf_turnstile_token === 'fake-token-1', 'B: signup request carries the token in user_metadata');
  ok(c.signup[0].data.signup_referrer !== undefined, 'B: attribution metadata still sent alongside');
  ok((await page.evaluate(() => window.__resets)) >= 1, 'B: widget reset after use (tokens are single-use)');

  // C. sitekey set, not solved yet: no request, clear message
  page = await ctx(); c = await open(page, '/app/signup.html', { sitekey: SITEKEY, solve: false });
  await page.waitForTimeout(400);
  await submitSignup(page);
  ok(c.signup.length === 0, 'C: unsolved -> NO signup request is made');
  ok(/human check/i.test(await page.locator('#msg').innerText()), 'C: unsolved -> user is told to complete the check');
  ok(await page.locator('#submit').isEnabled(), 'C: submit button stays usable');

  // D. magic link
  page = await ctx(); c = await open(page, '/app/signup.html', { sitekey: SITEKEY });
  await page.waitForTimeout(400);
  await page.fill('#email', 'new.person@example.org'); await page.click('#magicBtn'); await page.waitForTimeout(700);
  ok(c.otp.length === 1 && c.otp[0].data && c.otp[0].data.cf_turnstile_token === 'fake-token-1', 'D: magic-link signup carries the token');
  page = await ctx(); c = await open(page, '/app/signup.html', { sitekey: SITEKEY, solve: false });
  await page.waitForTimeout(400);
  await page.fill('#email', 'new.person@example.org'); await page.click('#magicBtn'); await page.waitForTimeout(500);
  ok(c.otp.length === 0, 'D: magic link without a solved check -> no request');

  // E. Turnstile blocked (ad blocker / CSP)
  page = await ctx(); c = await open(page, '/app/signup.html', { sitekey: SITEKEY, blockTs: true });
  await page.waitForTimeout(600);
  await submitSignup(page);
  ok(c.signup.length === 0 && /couldn't load/i.test(await page.locator('#msg').innerText()), 'E: script blocked -> no request, message offers Google/GitHub');

  // F. login page magic link must not create accounts
  page = await ctx(); c = await open(page, '/app/login.html');
  await page.fill('#email', 'someone@example.org'); await page.click('#magicBtn'); await page.waitForTimeout(600);
  ok(c.otp.length === 1 && c.otp[0].create_user === false, 'F: login-page magic link sends create_user:false');

  await browser.close();
  console.log(failures ? failures + ' FAILED' : 'all ok'); process.exit(failures ? 1 : 0);
})();
