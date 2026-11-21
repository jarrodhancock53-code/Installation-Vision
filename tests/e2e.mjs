// End-to-end tests for BuildLens in Chromium (desktop + phone emulation), against a mocked Claude API.
// Run: node e2e.mjs   (from tests/, after `npm install` and `python3 make_fixtures.py`)
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createMock } from './mock-claude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FX = f => path.join(HERE, 'fixtures', f);
const OUT = path.join(HERE, 'out');
const PORT = 8123;
const BASE = `http://localhost:${PORT}/index.html`;
await mkdir(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch();
let passed = 0, failed = 0; const failures = [];

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ ...opts });
  const page = await ctx.newPage();
  const mock = createMock();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await ctx.route('https://api.anthropic.com/**', mock.handler);
  await ctx.route('https://proxy.test/**', mock.handler);
  await ctx.route('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/*', async route => {
    const file = path.basename(new URL(route.request().url()).pathname);
    route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: await readFile(path.join(HERE, 'node_modules/pdfjs-dist/build', file)) });
  });
  return { ctx, page, mock, errors };
}
async function test(name, fn, opts) {
  const t = await newPage(opts);
  try { await fn(t); assert.deepEqual(t.errors, [], 'no page errors'); passed++; console.log('ok -', name); }
  catch (e) { failed++; failures.push(name); console.log('FAIL -', name, '\n   ', e.message.split('\n').slice(0, 6).join('\n    '), t.errors.length ? '\n    page errors: ' + t.errors.join(' | ') : '');
    await t.page.screenshot({ path: path.join(OUT, name.replace(/\W+/g, '_') + '.png'), fullPage: true }).catch(() => {}); }
  finally { await t.ctx.close(); }
}
// Click something that opens a file chooser, then provide files.
async function choose(page, selector, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await fc.setFiles(files);
}
async function setKey(page) {
  await page.goto(BASE);
  await page.click('#setBtn');
  await page.fill('#apiKey', 'sk-ant-test');
  await page.click('#saveSettings');
}
const visibleText = page => page.locator('#app').innerText();
async function noHorizontalScroll(page) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(o <= 1, `horizontal overflow ${o}px`);
}

// ---------------------------------------------------------------------------
await test('settings: test connection, request shape', async ({ page, mock }) => {
  await setKey(page);
  await page.click('#setBtn');
  await page.click('#testConn');
  await page.waitForSelector('text=Connected');
  const r = mock.state.requests[0];
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'sk-ant-test');
  assert.equal(r.headers['anthropic-version'], '2026-10-21');
  assert.equal(r.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(r.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(r.body.fallbacks, 'default');
  assert.equal(r.body.stream, true);
  assert.equal(r.body.tool_choice, undefined, 'no forced tool_choice');
  assert.equal(r.body.tools, undefined);
  assert.equal(r.body.output_config.format.type, 'json_schema');
  assert.equal(r.body.output_config.effort, 'low');
  assert.equal(r.body.temperature, undefined);
});

const furnitureFlow = tag => async ({ page, mock }) => {
  const shot = n => page.screenshot({ path: path.join(OUT, `${tag}-${n}.png`) });
  await setKey(page);
  await page.click('#newBuild');
  await page.click('[data-cat=furniture]');
  await page.click('#createBuild');
  await choose(page, '[data-add=seat-file]', [FX('furniture_manual.pdf')]);
  await page.waitForSelector('#seatPages .thumb >> nth=2');
  assert.equal(await page.locator('#seatPages .thumb').count(), 3);
  await page.click('#readManual');
  await page.waitForSelector('#startBuild');
  const parse = mock.state.requests.find(r => r.call === 'parseManual');
  assert.equal(parse.body.model, 'claude-opus-5-5');
  assert.equal(parse.body.messages[0].content.filter(c => c.type === 'image').length, 3, 'three page images sent');
  assert.equal(parse.body.output_config.effort, 'medium');
  assert.match(await visibleText(page), /KALLBO shelf/);
  assert.equal(await page.locator('#stepList li').count(), 3);

  // re-reading the same manual must use the cache (no new parse call)
  await page.click('#startBuild');
  await page.waitForSelector('#invCamera');
  // HEIC is rejected with a clear message
  await choose(page, '#invUpload', [FX('photo.heic')]);
  await page.waitForSelector('#errMsg');
  assert.match(await page.locator('#errMsg').innerText(), /HEIC/);
  await page.click('text=Close');
  // Inventory photo with EXIF rotation
  await choose(page, '#invUpload', [FX('parts.jpg')]);
  await page.waitForSelector('#invOk');
  const inv = mock.state.requests.find(r => r.call === 'scanInventory');
  assert.match(inv.body.messages[0].content.find(c => /PHOTO/.test(c.text || '')).text, /PHOTO \(1932×2576 px\)/, 'EXIF-rotated, long edge 2576');
  assert.ok(inv.body.system[1].cache_control, 'guide JSON block is cached');
  assert.match(inv.body.system[1].text, /GUIDE JSON/);
  // Correct the uncertain tag (A or B?) to A by tapping it
  const tapAt = async (fx, fy) => { await page.waitForSelector('.stage canvas[data-drawn]'); const c = page.locator('.stage canvas'); const b = await c.boundingBox(); await c.click({ position: { x: b.width * fx, y: b.height * fy } }); };
  await tapAt(0.2, 0.72);
  await page.click('[data-tag=A]');
  await shot('inventory');
  await page.click('#invOk');
  await page.waitForSelector('#stepHeader');
  assert.match(await page.locator('#stepHeader').innerText(), /Step 1 of 3: Insert cam bolts/);
  const crops = await page.evaluate(() => window.__bl.build.inventory.crops.map(c => c.ref));
  assert.ok(crops.includes('A') && crops.includes('B') && !crops.includes('101'), 'crops saved for confident parts: ' + crops);

  // Step 1: grab photo
  await choose(page, '#uploadPhoto', [FX('parts.jpg')]);
  await page.waitForSelector('#instruction');
  assert.match(await page.locator('#instruction').innerText(), /Grab panel A/);
  assert.match(await page.locator('#notVisible').innerText(), /Allen key/);
  const g = mock.state.requests.filter(r => r.call === 'guideStep').at(-1);
  const texts = g.body.messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(texts, /GRAB photo/);
  assert.match(texts, /Inventory reference crop of A/);
  assert.match(texts, /The manual's drawing for this step/);
  assert.equal(g.body.messages[0].content.at(-1).type, 'image', 'photo is last');
  await page.waitForSelector('.inset img');
  await shot('grab-overlay');
  // low-confidence "Is this it?" pill: tap the 101 box (x .6-.7, y .6-.68)
  await tapAt(0.65, 0.64);
  await page.click('#confirmYes');
  await page.click('#fbYes');
  // Wrong part flow: tap a point, model re-runs with hint
  await page.click('#wrongPart');
  await page.waitForSelector('#wrongHint');
  await tapAt(0.5, 0.5);
  await page.waitForFunction(() => /Use this panel instead/.test(document.querySelector('#instruction')?.innerText || ''));
  const corr = mock.state.requests.filter(r => r.call === 'guideStep').at(-1);
  assert.match(corr.body.messages[0].content[0].text, /User correction: .*at about \(9\d\d, 12\d\d\)/);
  await page.click('#toPlace');
  // Step 1: place photo
  await choose(page, '#uploadPhoto', [FX('build.jpg')]);
  await page.waitForSelector('#checkWork');
  assert.match(await page.locator('#instruction').innerText(), /Slide shelf B/);
  assert.match(mock.state.requests.filter(r => r.call === 'guideStep').at(-1).body.messages[0].content[0].text, /PLACE photo/);
  await page.click('#checkWork');
  // Check: first a fix, then pass
  mock.state.checkVerdicts.push('fix', 'pass');
  await choose(page, '#uploadCheck', [FX('check.jpg')]);
  await page.waitForSelector('#verdict');
  assert.match(await page.locator('#verdict').innerText(), /Needs a fix/);
  assert.match(await page.locator('#fixes').innerText(), /Flip it/);
  await page.waitForSelector('.stage canvas[data-drawn]'); await shot('check-fix');
  assert.equal(await page.locator('#override').innerText(), "It's fine, continue");
  await choose(page, '#tryAgain', [FX('check.jpg')]);
  await page.waitForFunction(() => /Looks right/.test(document.querySelector('#verdict')?.innerText || ''));
  await page.click('#afterPass');
  // Step 2: skip grab, then place, check pass
  await page.waitForFunction(() => /Step 2 of 3/.test(document.querySelector('#stepHeader')?.innerText || ''));
  assert.match(await visibleText(page), /Holes face inward/, 'caution shown');
  await page.click('#skipGrab');
  await choose(page, '#uploadPhoto', [FX('build.jpg')]);
  await page.click('#checkWork');
  await choose(page, '#uploadCheck', [FX('check.jpg')]);
  await page.click('#afterPass');
  // Step 3: has a hands-on check
  await page.waitForFunction(() => /Step 3 of 3/.test(document.querySelector('#stepHeader')?.innerText || ''));
  await page.click('#skipGrab'); await page.click('#skipPlace');
  await choose(page, '#uploadCheck', [FX('check.jpg')]);
  await page.click('#afterPass');
  await page.waitForSelector('[data-hc="0"]');
  assert.equal(await page.locator('#handsOnDone').isDisabled(), false, 'furniture can continue (with a warning) even if unticked');
  await page.check('[data-hc="0"]');
  await page.click('#handsOnDone');
  await page.waitForSelector('#buildCost');
  const txt = await visibleText(page);
  assert.match(txt, /Build complete/);
  assert.match(txt, /Step 1/, 'step needing a fix listed');
  assert.doesNotMatch(txt, /certified/);
  assert.notEqual(await page.locator('#buildCost').innerText(), '$0.0000');
  // log
  await page.click('#logBtn');
  await page.waitForSelector('#hitRates');
  assert.match(await page.locator('#hitRates').innerText(), /claude-sonnet-5-5: 1 of 1 right/);
  await noHorizontalScroll(page);
};
await test('furniture (desktop): full build with grab/place/check, fix loop, hands-on, cost', furnitureFlow('desktop'));
await test('furniture (phone): same flow on a phone', furnitureFlow('phone'), { ...devices['Pixel 7'] });

await test('car seat (phone): install, mode select, vehicle marks, hands-on gating, technician', async ({ page, mock }) => {
  await setKey(page);
  await page.click('#newBuild');
  await page.click('[data-cat=car_seat]');
  assert.equal(await page.locator('#createBuild').isDisabled(), true, 'vehicle required');
  await page.fill('#veh_year', '2021'); await page.fill('#veh_make', 'Honda'); await page.fill('#veh_model', 'CR-V');
  await page.click('[data-job=install]');
  await page.click('#createBuild');
  await choose(page, '[data-add=seat-file]', [FX('carseat_manual.pdf')]);
  await page.waitForSelector('#seatPages .thumb >> nth=1');
  await noHorizontalScroll(page);
  await page.click('#readManual');
  await page.waitForSelector('[data-mode=rf_latch]');
  const parse = mock.state.requests.find(r => r.call === 'parseManual');
  assert.match(parse.body.messages[0].content[0].text, /2021 Honda CR-V/);
  assert.match(parse.body.messages[0].content[0].text, /Vehicle manual pages provided: no/);
  assert.match(await visibleText(page), /No vehicle manual added/);
  assert.equal(await page.locator('#startBuild').isDisabled(), true, 'mode required');
  await page.click('[data-mode=rf_latch]');
  await page.waitForFunction(() => document.querySelectorAll('#stepList li').length === 2);
  await page.click('#startBuild');
  await choose(page, '#invUpload', [FX('backseat.jpg')]);
  await page.waitForSelector('#invOk');
  assert.match(await visibleText(page), /visible symbol or tag/);
  await page.click('#invOk');
  // step 1: skip to check, pass -> hands-on gating
  await page.click('#skipGrab'); await page.click('#skipPlace');
  mock.state.checkVerdicts.push('fix');
  await choose(page, '#uploadCheck', [FX('check.jpg')]);
  await page.waitForSelector('#verdict');
  assert.equal(await page.locator('#override').innerText(), 'I checked it by hand');
  await page.click('#override');
  assert.equal(await page.locator('#overrideOk').isDisabled(), true);
  await page.check('#overrideConfirm');
  await page.click('#overrideOk');
  await page.waitForSelector('[data-hc="0"]');
  assert.equal(await page.locator('#handsOnDone').isDisabled(), true, 'car seat: must tick all');
  await page.check('[data-hc="0"]');
  assert.equal(await page.locator('#handsOnDone').isDisabled(), false);
  await page.click('#handsOnDone');
  // step 2
  await page.waitForFunction(() => /Step 2 of 2/.test(document.querySelector('#stepHeader')?.innerText || ''));
  await page.click('#skipGrab'); await page.click('#skipPlace');
  await choose(page, '#uploadCheck', [FX('check.jpg')]);
  await page.click('#afterPass');
  await page.waitForSelector('[data-hc="1"]');
  await page.check('[data-hc="0"]');
  assert.equal(await page.locator('#handsOnDone').isDisabled(), true);
  await page.check('[data-hc="1"]');
  await page.click('#handsOnDone');
  await page.waitForSelector('#techBanner');
  assert.match(await page.locator('#techBanner').innerText(), /certified child passenger safety technician/);
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(OUT, 'phone-finished.png') });
}, { ...devices['Pixel 7'] });

await test('car seat: check-existing-install job starts at CHECK, convert mode with vehicle manual', async ({ page, mock }) => {
  await setKey(page);
  await page.click('#newBuild'); await page.click('[data-cat=car_seat]');
  await page.fill('#veh_year', '2019'); await page.fill('#veh_make', 'Toyota'); await page.fill('#veh_model', 'RAV4');
  await page.click('[data-job=check]'); await page.click('#createBuild');
  await choose(page, '[data-add=seat-file]', [FX('carseat_manual.pdf')]);
  await choose(page, '[data-add=vehicle-file]', [FX('vehicle_section.pdf')]);
  await page.waitForSelector('#vehiclePages .thumb');
  await page.click('#readManual');
  await page.waitForSelector('[data-mode=ff]');
  assert.match(await visibleText(page), /From your vehicle manual/);
  assert.match(await visibleText(page), /rear shelf/);
  const parse = mock.state.requests.find(r => r.call === 'parseManual');
  assert.ok(parse.body.messages[0].content.some(c => /Vehicle manual page 1/.test(c.text || '')));
  await page.click('[data-mode=ff]');
  assert.equal(await page.locator('#startBuild').innerText(), 'Start checking');
  await page.click('#startBuild');
  await page.waitForSelector('#takeCheck');
  assert.match(await page.locator('#stepHeader').innerText(), /Step 1 of 1: Attach tether/);
  assert.equal(mock.state.requests.filter(r => r.call === 'scanInventory').length, 0, 'check job skips inventory');
});

await test('resume after reload mid-step (iOS tab kill)', async ({ page }) => {
  await setKey(page);
  await page.click('#newBuild'); await page.click('[data-cat=furniture]'); await page.click('#createBuild');
  await choose(page, '[data-add=seat-file]', [FX('furniture_manual.pdf')]);
  await page.waitForSelector('#seatPages .thumb >> nth=2');
  await page.click('#readManual'); await page.click('#startBuild'); await page.click('#invSkip');
  await page.click('#skipGrab');
  await choose(page, '#uploadPhoto', [FX('build.jpg')]);
  await page.waitForSelector('#checkWork');
  await page.reload();
  await page.waitForSelector('#checkWork');
  assert.match(await page.locator('#stepHeader').innerText(), /Step 1 of 3/);
  assert.match(await page.locator('#instruction').innerText(), /Slide shelf B/);
  // home shows the build with progress
  await page.click('#homeBtn');
  assert.match(await page.locator('.build-card').innerText(), /Step 1 of 3/);
});

await test('manual cache: same PDF in a new build skips the parse call', async ({ page, mock }) => {
  await setKey(page);
  for (let i = 0; i < 2; i++) {
    await page.click('#homeBtn'); await page.click('#newBuild'); await page.click('[data-cat=furniture]'); await page.click('#createBuild');
    await page.waitForSelector('#seatPages');
    if (i === 1) assert.ok(await page.locator('[data-saved]').count() >= 1, 'saved guide offered');
    await choose(page, '[data-add=seat-file]', [FX('furniture_manual.pdf')]);
    await page.waitForSelector('#seatPages .thumb >> nth=2');
    await page.click('#readManual'); await page.waitForSelector('#startBuild');
  }
  assert.equal(mock.state.requests.filter(r => r.call === 'parseManual').length, 1);
});

await test('errors: refusal, offline, 529 retry, bad key', async ({ page, mock }) => {
  await setKey(page);
  await page.click('#setBtn');
  mock.state.next.push('refusal');
  await page.click('#testConn');
  await page.waitForSelector('#errMsg');
  assert.match(await page.locator('#errMsg').innerText(), /declined/);
  mock.state.next.push('offline', 'offline');
  await page.click('#errRetry');
  await page.waitForFunction(() => /No connection/.test(document.querySelector('#errMsg')?.innerText || ''), null, { timeout: 15000 });
  await page.click('#errRetry');
  await page.waitForSelector('text=Connected');
  await page.click('text=Close');
  mock.state.next.push('overloaded');
  await page.click('#testConn');
  await page.waitForSelector('text=Connected', { timeout: 15000 });
  await page.click('text=Close');
  mock.state.next.push('unauthorized');
  await page.click('#testConn');
  await page.waitForSelector('#errMsg');
  assert.match(await page.locator('#errMsg').innerText(), /API key was rejected/);
  // log records failures
  await page.click('text=Close'); await page.click('#saveSettings'); await page.click('#logBtn');
  await page.waitForSelector('#logTotal');
  assert.match(await page.locator('#app').innerText(), /refusal/);
});

await test('fallback beta rejected: retries once without it, then stops sending it', async ({ page, mock }) => {
  await setKey(page);
  await page.click('#setBtn');
  mock.state.next.push('no-fallbacks');
  await page.click('#testConn');
  await page.waitForSelector('text=Connected');
  assert.equal(mock.state.requests.length, 2);
  assert.equal(mock.state.requests[0].body.fallbacks, 'default');
  assert.equal(mock.state.requests[1].body.fallbacks, undefined);
  assert.equal(mock.state.requests[1].headers['anthropic-beta'], undefined);
  await page.click('text=Close');
  mock.state.next.length = 0;
  await page.click('#testConn'); await page.waitForSelector('text=Connected');
  assert.equal(mock.state.requests[2].body.fallbacks, undefined, 'remembered for the session');
});

const startCarBuild = async (page, { year = '2021', make = 'Honda', model = 'CR-V', job = 'install' } = {}) => {
  await page.click('#homeBtn'); await page.click('#newBuild'); await page.click('[data-cat=car_seat]');
  await page.fill('#veh_year', year); await page.fill('#veh_make', make); await page.fill('#veh_model', model);
  await page.click(`[data-job=${job}]`); await page.click('#createBuild');
  await page.waitForSelector('#vehicleLookup');
};

await test('find my car manual: Haiku web search, confirm, facts flow into the guide', async ({ page, mock }) => {
  await setKey(page);
  await startCarBuild(page);
  await page.click('#findVehicle');
  await page.waitForSelector('#confirmVehicle');
  const r = mock.state.requests.find(x => x.call === 'findVehicleManual');
  assert.equal(r.body.model, 'claude-haiku-5-5');
  assert.deepEqual(r.body.tools.map(t => t.type), ['web_search_20250305', 'web_fetch_20250910'], 'basic web tools on Haiku');
  assert.match(r.body.system[0].text, /NEVER fetch a PDF/);
  assert.ok(r.body.tools[1].max_uses <= 3 && r.body.tools[1].max_content_tokens <= 30000);
  assert.equal(r.body.stream, undefined);
  assert.equal(r.body.tool_choice, undefined);
  assert.equal(r.body.output_config.format, undefined, 'no structured-output constraint on the web call');
  assert.match(r.body.messages[0].content[0].text, /model year 2021, make Honda, model CR-V/);
  assert.match(await page.locator('#vehicleManualLink').innerText(), /2021 Honda CR-V Owner's Manual/);
  assert.match(await page.locator('#vehicleFactsList').innerText(), /outboard rear seats only[\s\S]*p\. 70/);
  await page.click('#confirmVehicle');
  await page.waitForSelector('#vehicleConfirmed');
  await choose(page, '[data-add=seat-file]', [FX('carseat_manual.pdf')]);
  await page.waitForSelector('#seatPages .thumb >> nth=1');
  await page.click('#readManual');
  await page.waitForSelector('[data-mode=rf_latch]');
  const parse = mock.state.requests.find(x => x.call === 'parseManual');
  const ptxt = parse.body.messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(ptxt, /CONFIRMED VEHICLE FACTS[\s\S]*center position using the lower anchors/);
  assert.match(ptxt, /Confirmed vehicle facts provided: yes/);
  const txt = await visibleText(page);
  assert.match(txt, /From your vehicle manual/);
  assert.match(txt, /2021 Honda CR-V Owner's Manual, p\. 72/);
  // the log prices the web searches
  await page.click('#logBtn'); await page.waitForSelector('#logTotal');
  assert.match(await visibleText(page), /findVehicleManual/);
});

await test('find my car manual: pause_turn resumes, cache reused for the same car', async ({ page, mock }) => {
  await setKey(page);
  mock.state.vehicle.push('pause');
  await startCarBuild(page);
  await page.click('#findVehicle');
  await page.waitForSelector('#confirmVehicle');
  const calls = mock.state.requests.filter(x => x.call === 'findVehicleManual');
  assert.equal(calls.length, 2, 'one resume after pause_turn');
  assert.equal(calls[1].body.messages.at(-1).role, 'assistant');
  assert.equal(calls[1].body.messages.at(-1).content[0].type, 'server_tool_use');
  await page.click('#confirmVehicle');
  await startCarBuild(page, { job: 'move' });
  await page.waitForSelector('#vehicleConfirmed');
  assert.equal(mock.state.requests.filter(x => x.call === 'findVehicleManual').length, 2, 'no new lookup for the same car');
  // a different car must not reuse it
  await startCarBuild(page, { year: '2018', make: 'Ford', model: 'Escape' });
  assert.equal(await page.locator('#findVehicle').count(), 1);
  assert.equal(await page.locator('#vehicleConfirmed').count(), 0);
});

await test('find my car manual: wrong year, unofficial, not found, rejected, web off', async ({ page, mock }) => {
  await setKey(page);
  await startCarBuild(page);
  mock.state.vehicle.push('wrongYear');
  await page.click('#findVehicle');
  await page.waitForSelector('#vehicleNotFound');
  assert.match(await page.locator('#vehicleNotFound').innerText(), /for 2019, not 2021/);
  assert.equal(await page.locator('#confirmVehicle').count(), 0);
  mock.state.vehicle.push('unofficial');
  await page.click('#findVehicle');
  await page.waitForFunction(() => /not the carmaker/.test(document.querySelector('#vehicleNotFound')?.innerText || ''));
  mock.state.vehicle.push('notFound');
  await page.click('#findVehicle');
  await page.waitForFunction(() => /No official manual for that year/.test(document.querySelector('#vehicleNotFound')?.innerText || ''));
  await page.click('#findVehicle');
  await page.waitForSelector('#rejectVehicle');
  await page.click('#rejectVehicle');
  await page.waitForFunction(() => /wasn’t your car/.test(document.querySelector('#vehicleNotFound')?.innerText || ''));
  mock.state.vehicle.push('webOff');
  await page.click('#findVehicle');
  await page.waitForSelector('#errMsg');
  assert.match(await page.locator('#errMsg').innerText(), /Anthropic Console/);
  await page.click('text=Close');
  // nothing confirmed -> parse gets no vehicle facts, review says hands-on
  await choose(page, '[data-add=seat-file]', [FX('carseat_manual.pdf')]);
  await page.waitForSelector('#seatPages .thumb >> nth=1');
  await page.click('#readManual');
  await page.waitForSelector('[data-mode=rf_latch]');
  assert.match(await visibleText(page), /No vehicle manual added/);
  const ptxt = mock.state.requests.find(x => x.call === 'parseManual').body.messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.doesNotMatch(ptxt, /CONFIRMED VEHICLE FACTS/);
});

await test('find my car manual: free-text answer is repaired; Sonnet gets dynamic web tools', async ({ page, mock }) => {
  await setKey(page);
  mock.state.vehicle.push('freeText');
  await startCarBuild(page);
  await page.click('#findVehicle');
  await page.waitForSelector('#confirmVehicle');
  const rep = mock.state.requests.find(x => x.call === 'findVehicleManualRepair');
  assert.ok(rep, 'repair call made');
  assert.equal(rep.body.output_config.format.type, 'json_schema');
  await page.click('#setBtn');
  await page.fill('#model_vehicle', 'claude-sonnet-5-5');
  await page.click('#saveSettings');
  await page.click('#findVehicle');
  await page.waitForSelector('#confirmVehicle');
  const last = mock.state.requests.filter(x => x.call === 'findVehicleManual').at(-1);
  assert.deepEqual(last.body.tools.map(t => t.type), ['web_search_20260209', 'web_fetch_20260209']);
});

await test('find my car manual: "prompt is too long" retries search-only, then explains', async ({ page, mock }) => {
  await setKey(page);
  mock.state.vehicle.push('tooLong');
  await startCarBuild(page);
  await page.click('#findVehicle');
  await page.waitForSelector('#confirmVehicle');
  const calls = mock.state.requests.filter(x => x.call === 'findVehicleManual');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.tools.map(t => t.name), ['web_search'], 'retry has no fetch tool');
  assert.match(calls[1].body.system[0].text, /web_search only/);
  assert.equal(calls[1].body.messages.length, 1, 'retry starts fresh');
  // if it still overflows: a plain message, no raw API error
  await page.click('#confirmVehicle');
  mock.state.vehicle.push('tooLongAlways');
  await startCarBuild(page, { year: '2017', make: 'Subaru', model: 'Outback' });
  await page.click('#findVehicle');
  await page.waitForSelector('#errMsg');
  const msg = await page.locator('#errMsg').innerText();
  assert.match(msg, /whole owner’s manual/);
  assert.doesNotMatch(msg, /1280140/);
  assert.equal(await page.locator('#errRetry').count(), 0, 'no pointless retry button');
});

const SEAT_URL = 'https://www.saferide.example/manuals/360.pdf';
await test('find the car seat manual online: search-only lookup, confirm, PDF read by URL, cached', async ({ page, mock }) => {
  await setKey(page);
  await startCarBuild(page);
  assert.equal(await page.locator('#findSeat').isDisabled(), true, 'needs brand and model');
  await page.fill('#seat_brand', 'SafeRide'); await page.fill('#seat_model', '360');
  await page.click('#findSeat');
  await page.waitForSelector('#confirmSeat');
  const look = mock.state.requests.find(r => r.call === 'findSeatManual');
  assert.equal(look.body.model, 'claude-haiku-5-5');
  assert.deepEqual(look.body.tools.map(t => t.name), ['web_search'], 'lookup cannot fetch pages');
  assert.match(look.body.messages[0].content[0].text, /brand SafeRide, model 360/);
  assert.equal(await page.locator('#readManual').isDisabled(), true, 'not usable until confirmed');
  await page.click('#confirmSeat');
  await page.waitForSelector('#seatConfirmed');
  assert.equal(await page.locator('#readManual').isDisabled(), false);
  await page.click('#readManual');
  await page.waitForSelector('[data-mode=rf_latch]');
  const parse = mock.state.requests.find(r => r.call === 'parseManual');
  const c0 = parse.body.messages[0].content;
  const doc = c0.find(c => c.type === 'document');
  assert.deepEqual(doc.source, { type: 'url', url: SEAT_URL });
  assert.equal(c0.filter(c => c.type === 'image').length, 0, 'no page images when read online');
  assert.match(c0.find(c => /attached PDF/.test(c.text || '')).text, /manualBox to \[0,0,0,0\]/);
  // the build works without manual page images: no inset, no crash
  await page.click('[data-mode=rf_latch]'); await page.click('#startBuild'); await page.click('#invSkip');
  await page.waitForSelector('#stepHeader');
  assert.equal(await page.locator('.inset').count(), 0);
  await page.click('#skipGrab'); await page.click('#skipPlace');
  mock.state.checkVerdicts.push('pass');
  await choose(page, '#uploadCheck', [FX('check.jpg')]);
  await page.waitForSelector('#verdict');
  const chk = mock.state.requests.filter(r => r.call === 'checkStep').at(-1);
  assert.equal(chk.body.messages[0].content.filter(c => c.type === 'image').length, 1, 'only the check photo, no manual crop');
  // same seat in another build: lookup and parse come from the cache
  await startCarBuild(page, { job: 'move' });
  await page.fill('#seat_brand', 'SafeRide'); await page.fill('#seat_model', '360');
  await page.click('#findSeat'); await page.waitForSelector('#confirmSeat'); await page.click('#confirmSeat');
  await page.click('#readManual'); await page.waitForSelector('[data-mode=rf_latch]');
  assert.equal(mock.state.requests.filter(r => r.call === 'findSeatManual').length, 1);
  assert.equal(mock.state.requests.filter(r => r.call === 'parseManual').length, 1);
});

await test('find the car seat manual online: non-official, not found, unreadable link, then upload still works', async ({ page, mock }) => {
  await setKey(page);
  await startCarBuild(page);
  await page.fill('#seat_brand', 'SafeRide'); await page.fill('#seat_model', '360');
  mock.state.seat.push('unofficial');
  await page.click('#findSeat');
  await page.waitForSelector('#seatNotFound');
  assert.match(await page.locator('#seatNotFound').innerText(), /non-official/);
  assert.equal(await page.locator('#confirmSeat').count(), 0);
  mock.state.seat.push('notFound');
  await page.click('#findSeat');
  await page.waitForFunction(() => /No official manual for that model/.test(document.querySelector('#seatNotFound')?.innerText || ''));
  // found, confirmed, but the API can't download it
  await page.click('#findSeat');
  await page.waitForSelector('#confirmSeat'); await page.click('#confirmSeat');
  mock.state.parse.push('docFail');
  await page.click('#readManual');
  await page.waitForSelector('#errMsg');
  assert.match(await page.locator('#errMsg').innerText(), /Upload the manual’s pages or PDF/);
  assert.equal(await page.locator('#errRetry').count(), 0);
  await page.click('text=Close');
  await page.waitForSelector('#seatNotFound');
  assert.equal(await page.locator('#readManual').isDisabled(), true);
  // too long
  await page.click('#findSeat'); await page.waitForSelector('#confirmSeat'); await page.click('#confirmSeat');
  mock.state.parse.push('tooLong');
  await page.click('#readManual');
  await page.waitForSelector('#errMsg');
  assert.match(await page.locator('#errMsg').innerText(), /too long to read in one go/);
  await page.click('text=Close');
  // uploading still works, and uploaded pages win over an online link
  await choose(page, '[data-add=seat-file]', [FX('carseat_manual.pdf')]);
  await page.waitForSelector('#seatPages .thumb >> nth=1');
  await page.click('#readManual');
  await page.waitForSelector('[data-mode=rf_latch]');
  const parse = mock.state.requests.filter(r => r.call === 'parseManual').at(-1);
  assert.equal(parse.body.messages[0].content.filter(c => c.type === 'document').length, 0);
  assert.equal(parse.body.messages[0].content.filter(c => c.type === 'image').length, 2);
});

await test('proxy mode sends passcode, never the key', async ({ page, mock }) => {
  await page.goto(BASE);
  await page.click('#setBtn');
  await page.selectOption('#conn', 'proxy');
  await page.fill('#proxyUrl', 'https://proxy.test');
  await page.fill('#passcode', 'mom-7341');
  await page.click('#testConn');
  await page.waitForSelector('text=Connected');
  const r = mock.state.requests[0];
  assert.equal(r.url, 'https://proxy.test/v1/messages');
  assert.equal(r.headers['x-buildlens-passcode'], 'mom-7341');
  assert.equal(r.headers['x-api-key'], undefined);
  assert.equal(r.headers['anthropic-dangerous-direct-browser-access'], undefined);
});

await test('long PDF asks for a page range', async ({ page }) => {
  await setKey(page);
  await page.click('#newBuild'); await page.click('[data-cat=generic]'); await page.click('#createBuild');
  await choose(page, '[data-add=seat-file]', [FX('big_manual.pdf')]);
  await page.waitForSelector('#rangeFrom');
  await page.fill('#rangeFrom', '3'); await page.fill('#rangeTo', '7');
  await page.click('#rangeOk');
  await page.waitForSelector('#seatPages .thumb >> nth=4');
  assert.equal(await page.locator('#seatPages .thumb').count(), 5);
  const pdfPages = await page.evaluate(() => window.__bl.build.pages.map(p => p.pdfPage));
  assert.deepEqual(pdfPages, [3, 4, 5, 6, 7]);
});

await test('phone layout: home and settings fit, no sideways scroll', async ({ page }) => {
  await page.goto(BASE);
  await noHorizontalScroll(page);
  await page.click('#setBtn'); await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(OUT, 'phone-settings.png') });
}, { ...devices['iPhone 13'], defaultBrowserType: undefined });

await browser.close();
server.kill();
console.log(`\ne2e: ${passed} passed, ${failed} failed${failures.length ? ' — ' + failures.join('; ') : ''}`);
process.exit(failed ? 1 : 0);
