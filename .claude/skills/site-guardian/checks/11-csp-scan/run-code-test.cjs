// Usage: NODE_PATH=$(npm root -g) node run-code-test.cjs <base-url>
// Anonymous chat.html with the trial-chat reply mocked to contain js / jsx / python code blocks; clicks Run on each
// and then loads pdf.js and extracts text from a generated one-page PDF, exactly as chat.html does. Clean output:
// js:true jsx:true jsx_click:true py:"PY_OK 30" pdf:"text=PDF_HELLO" and "CSP refusals: 0".
const { chromium } = require('playwright');
const B = process.argv[2];
const reply = [
 'Here are three snippets:','',
 '```js','document.body.innerHTML="<p id=r>JS_OK</p>";','```','',
 '```jsx','function App(){ const [n,setN]=React.useState(0); return <button id="b" onClick={()=>setN(n+1)}>Count: {n}</button>; }','export default App;','```','',
 '```python','print("PY_OK", sum(i*i for i in range(5)))','```',''
].join('\n');
// minimal one-page PDF with the text "PDF_HELLO"
function makePdf(){
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  const stream = 'BT /F1 18 Tf 20 50 Td (PDF_HELLO) Tj ET';
  objs.push('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o,i)=>{ offs.push(out.length); out += (i+1)+' 0 obj\n'+o+'\nendobj\n'; });
  const x = out.length; out += 'xref\n0 '+(objs.length+1)+'\n0000000000 65535 f \n' + offs.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
  out += 'trailer\n<< /Size '+(objs.length+1)+' /Root 1 0 R >>\nstartxref\n'+x+'\n%%EOF';
  return Buffer.from(out,'latin1');
}
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport:{width:1280,height:1000} });
  const page = await ctx.newPage();
  const refused = new Set();
  page.on('console', m => { const t = m.text(); if (/Content Security Policy|violates the following/i.test(t)) refused.add(t.replace(/Refused to /,'').slice(0,190)); });
  await page.route('**/functions/v1/trial-chat', r => r.fulfill({ status:200, headers:{'content-type':'text/plain; charset=utf-8','access-control-allow-origin':'*'}, body: reply }));
  await page.goto(B + '/app/chat.html', { waitUntil:'load' });
  await page.waitForTimeout(1500);
  // dismiss any onboarding overlay
  await page.evaluate(()=>{ document.querySelectorAll('[id*=nboard] button, .onboard-skip').forEach(b=>{ if(/skip|got it|close|×/i.test(b.textContent)) b.click(); }); });
  await page.fill('#input','show me code');
  await page.click('#sendBtn');
  await page.waitForSelector('.code-block', { timeout: 20000 });
  const blocks = await page.$$('.code-block');
  console.log('code blocks rendered:', blocks.length);
  const res = {};
  // JS
  await blocks[0].$eval('.btn-run-code', b=>b.click());
  await page.waitForTimeout(2500);
  let txt = await Promise.all(page.frames().map(f=>f.evaluate(()=>document.body && document.body.innerText).catch(()=>'')));
  res.js = txt.some(t=>t.includes('JS_OK'));
  // JSX
  await blocks[1].$eval('.btn-run-code', b=>b.click());
  await page.waitForTimeout(9000);
  let ok=false;
  for (const f of page.frames()) { const t = await f.evaluate(()=>document.body && document.body.innerText).catch(()=>''); if (t && t.includes('Count: 0')) { ok = true; const btn = await f.$('#b'); if (btn) { await btn.click(); const t2 = await f.evaluate(()=>document.body.innerText); res.jsx_click = t2.includes('Count: 1'); } } }
  res.jsx = ok;
  // Python
  await blocks[2].$eval('.btn-run-code', b=>b.click());
  try { await blocks[2].waitForSelector('.py-stdout', { timeout: 90000 }); res.py = (await blocks[2].$eval('.code-run-output', e=>e.innerText)).trim(); } catch(e){ res.py = 'FAILED: ' + (await blocks[2].$eval('.code-run-output', e=>e.innerText).catch(()=>'?')).slice(0,200); }
  // pdf.js mechanism (same code path as chat.html)
  const pdfB64 = makePdf().toString('base64');
  res.pdf = await page.evaluate(async (b64) => {
    try {
      await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload=()=>{ window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(); }; s.onerror=()=>rej(new Error('script blocked')); document.head.appendChild(s); });
      const bin = atob(b64); const buf = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) buf[i]=bin.charCodeAt(i);
      const pdf = await window.pdfjsLib.getDocument({data:buf}).promise; const pg = await pdf.getPage(1); const tc = await pg.getTextContent();
      return 'text=' + tc.items.map(i=>i.str).join(' ');
    } catch(e){ return 'FAILED: ' + String(e).slice(0,160); }
  }, pdfB64);
  console.log(JSON.stringify(res, null, 1));
  console.log('CSP refusals:', refused.size); [...refused].forEach(x=>console.log('  R', x));
  await browser.close();
})();
