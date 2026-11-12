# Check 11 — the enforced CSP must allow everything the app loads

**Catches:** a `_headers` Content-Security-Policy that is stricter than what the pages actually load, so features
fail silently (no server error, no failed test) the moment the site is served by the Worker (workers.dev, branch
previews, or any hostname routed to it).

**First found by:** Gate 0 hosting-parity work, 2026-11-12. The CSP in `_headers` had never been exercised against the
real pages. Scanned under it, `chat.html` lost highlight.js CSS (`style-src`), pdf.js document upload (`script-src`
lacked cdnjs; the worker needs `worker-src blob:`), and Python Run-code (Pyodide's WebAssembly needs
`'wasm-unsafe-eval'`); `share.html` lost marked + DOMPurify (cdnjs) so shared conversations would not render; GA4's
`www.google.com/g/collect` beacon was refused on the real edge on `dashboard.html` only (GA picks the endpoint per
hit, so a local scan can miss it — scan the real preview as well). None of these show up in a code review, a unit
test or a page-load status check.

**When to run:** any change to `_headers`, `wrangler.jsonc` or `worker.js`; any PR that adds an external
`<script src>`, `<link href>`, font, `new Worker`, `fetch()` host or `import()` to a page; every sweep that sees one of
those files in its window.

## Procedure

1. Serve the site the way it will be served. Either `wrangler dev --local --port 8799` in the repo root (wrangler is
   `npm i wrangler@latest` in a scratch dir; it applies `_headers`), or use the branch preview URL
   `https://<branch>-aethyro-landing.leer4030.workers.dev` of a PR. Do both for a CSP change (the second catches
   edge-only and per-hit behaviour such as the GA4 endpoint).
2. Scan every public page for CSP refusals:
   ```
   PAGES=$(git ls-files '*.html' | grep -v '^supabase/' | grep -v '^\.' | sed 's#^#/#' | tr '\n' ' ')
   NODE_PATH=$(npm root -g) node .claude/skills/site-guardian/checks/11-csp-scan/csp-scan.cjs $BASE $PAGES \
     "/app/share.html?t=00000000-0000-0000-0000-000000000000"
   ```
   Clean: every line says `CSP-refusals: 0 pageerrors: 0`. Do not trust a `securitypolicyviolation` listener on its
   own; it missed refusals that the console reported. Logged-out pages only: pages behind a login redirect to the
   login page, so a clean scan does not cover them (see "Not covered").
3. Exercise the features that load code dynamically (they only run on a click, so a page-load scan never sees them):
   ```
   NODE_PATH=$(npm root -g) node .claude/skills/site-guardian/checks/11-csp-scan/run-code-test.cjs $BASE
   ```
   Clean: `js:true, jsx:true, jsx_click:true, py:"PY_OK 30", pdf:"text=PDF_HELLO"` and `CSP refusals: 0`. It uses the
   anonymous chat mode with the `trial-chat` reply mocked, so it needs no account.

## What a mismatch looks like
A line `R load the script 'https://…' because it violates … Content Security Policy directive: "script-src …"`
(or `style-src`, `connect-src`, `worker-src`), or a `FAILED` value in the dynamic test. Fix = add the exact host or
keyword to the matching directive in `_headers` in the same PR as the feature, re-run both steps, record the host in
CLAUDE.md's "Worker serving rules" convention.

## Not covered (say so in the sweep report, do not claim it)
Flows behind a login (connectors, billing modal, dashboard panels, OAuth redirects), Stripe checkout navigation under
`form-action 'self'`, and the production hostname while it is served by another host that sends no CSP. Cover the
logged-in ones with `probe` flows run against the preview URL.
