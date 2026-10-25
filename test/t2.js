const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
  const q = '&ph=127.0.0.1&pp=9000&ps=0';
  const tvc = await browser.newContext(); const phc = await browser.newContext({ viewport:{width:390,height:844} });
  for (const c of [tvc, phc]) { await c.grantPermissions(['microphone'], {origin:'http://localhost:8080'}); await c.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)).*/, r => r.abort()); }
  const tv = await tvc.newPage(); const ph = await phc.newPage();
  tv.on('pageerror', e => console.log('[tv] PAGEERROR', e.message)); ph.on('pageerror', e => console.log('[ph] PAGEERROR', e.message));
  await tv.goto('http://localhost:8080/?tv' + q); await tv.click('#tvStartBtn');
  await tv.waitForFunction(() => document.querySelector('#netStatus').textContent.includes('En línea'));
  const code = await tv.textContent('#roomCode');
  await ph.goto(`http://localhost:8080/?mic=${code}` + q); await ph.fill('#mjName', 'Ana'); await ph.click('#mjGo');
  await ph.waitForFunction(() => document.querySelector('#mStatus').textContent.includes('Conectado'));
  console.log('connected; reloading TV');
  await tv.reload(); await tv.click('#tvStartBtn');
  const t0 = Date.now();
  await tv.waitForFunction(() => document.querySelector('#netStatus').textContent.includes('En línea'), null, {timeout: 30000});
  console.log('tv back online, same code:', (await tv.textContent('#roomCode')) === code, ((Date.now()-t0)/1000)+'s');
  await tv.waitForFunction(() => [...window.__cantaya.mics.values()].some(m => m.va && m.name === 'Ana'), null, { timeout: 40000 });
  console.log('phone re-attached after', ((Date.now()-t0)/1000)+'s');
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
