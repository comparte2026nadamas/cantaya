const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
  const q = '&ph=127.0.0.1&pp=9000&ps=0';
  const tvc = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const phc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const c of [tvc, phc]) { await c.grantPermissions(['microphone'], {origin:'http://localhost:8080'}); await c.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)).*/, r => r.abort()); }
  const tv = await tvc.newPage(); const ph = await phc.newPage();
  const logs = [];
  tv.on('console', m => logs.push('[tv] ' + m.type() + ' ' + m.text())); tv.on('pageerror', e => logs.push('[tv] PAGEERROR ' + e.message));
  ph.on('console', m => logs.push('[ph] ' + m.type() + ' ' + m.text())); ph.on('pageerror', e => logs.push('[ph] PAGEERROR ' + e.message));
  await tv.goto('http://localhost:8080/?tv' + q);
  await tv.screenshot({ path: 'tv0.png' });
  await tv.click('#tvStartBtn');
  await tv.waitForFunction(() => document.querySelector('#netStatus').textContent.includes('En línea'), null, { timeout: 15000 });
  const code = await tv.textContent('#roomCode');
  console.log('code', code);
  await ph.goto(`http://localhost:8080/?mic=${code}` + q);
  await ph.screenshot({ path: 'ph0.png' });
  await ph.fill('#mjName', 'David');
  await ph.click('#mjGo');
  await ph.waitForFunction(() => document.querySelector('#mStatus').textContent.includes('Conectado'), null, { timeout: 20000 });
  console.log('phone connected');
  await tv.waitForFunction(() => [...window.__cantaya.mics.values()].some(m => m.va), null, { timeout: 20000 });
  console.log('tv got audio stream');
  // simula una canción
  await tv.evaluate(() => { window.__cantaya.addToQueue({ id: 'dQw4w9WgXcQ', title: 'Canción de prueba', channel: 'Test', thumb: '' }, 'David'); window.__cantaya.setPlaying(true); });
  await tv.waitForTimeout(3000);
  const lv = await tv.evaluate(() => [...window.__cantaya.mics.values()].map(m => ({ name: m.name, rms: m.level, midi: m.last && m.last.midi })));
  console.log('levels', JSON.stringify(lv));
  await tv.screenshot({ path: 'tv1.png' });
  await ph.screenshot({ path: 'ph1.png' });
  await tv.waitForTimeout(20000);
  const s = await tv.evaluate(() => { const s = window.__cantaya.session; return { frames: s.frames, voiced: s.voiced, devs: s.devs.length, res: s.result() }; });
  console.log('session', JSON.stringify(s));
  await tv.evaluate(() => window.__cantaya.finishSong());
  await tv.waitForTimeout(1500);
  await tv.screenshot({ path: 'tv2.png' });
  await ph.screenshot({ path: 'ph2.png' });
  // phone search without key -> error message
  await ph.click('#mScore [data-act=next]').catch(()=>{});
  await ph.fill('#mQ', 'bohemian rhapsody'); await ph.click('#mSearch button');
  await ph.waitForTimeout(1500);
  console.log('phone search result:', await ph.textContent('#mResults'));
  await ph.screenshot({ path: 'ph3.png' });
  console.log(logs.filter(l => !/net::ERR|Failed to load resource/.test(l)).join('\n'));
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
