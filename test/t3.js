const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
  const q = '&ph=127.0.0.1&pp=9000&ps=0';
  const tvc = await browser.newContext(); const phc = await browser.newContext();
  for (const c of [tvc, phc]) { await c.grantPermissions(['microphone'], {origin:'http://localhost:8080'}); await c.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)).*/, r => r.abort()); }
  const tv = await tvc.newPage(); const ph = await phc.newPage();
  await tv.goto('http://localhost:8080/?tv' + q); await tv.click('#tvStartBtn');
  await tv.waitForFunction(() => document.querySelector('#netStatus').textContent.includes('En línea'));
  const code = await tv.textContent('#roomCode');
  await ph.goto(`http://localhost:8080/?mic=${code}` + q); await ph.fill('#mjName', 'David'); await ph.click('#mjGo');
  await tv.waitForFunction(() => [...window.__cantaya.mics.values()].some(m => m.va), null, {timeout: 20000});
  let max = 0; for (let i = 0; i < 30; i++) { max = Math.max(max, await tv.evaluate(() => window.__cantaya.outLevel())); await tv.waitForTimeout(100); }
  console.log('voz en la salida de la TV (rms max):', max.toFixed(3), 'ctx:', await tv.evaluate(() => 'ok'));
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
