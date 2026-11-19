// Contract tests, driven through the real shell over real HTTP.
//
// Nothing here needs an RF Explorer Pro. A fake VNC server
// (driver/fake-vnc-server.js) shows either a real screenshot of a Pro or a
// drawn screen, so everything between the HTTP request and the VNC socket is
// the real thing: shell, adapter, VNC client, label reading, trace extraction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startFakeVnc } from '../driver/fake-vnc-server.js';
import { renderScreen, simulatedSpectrum } from '../driver/simulated-screen.js';
import { realScreen, realScreenWide } from './helpers.js';

process.env.SB_RFEPRO_MOCK = '1';
process.env.SB_RFEPRO_SIM_FRAME_MS = '60';
process.env.SB_RFEPRO_FROZEN_MS = '800';

const { PRODUCT, SIMULATED_DEVICE_ID } = await import('../adapter.js');
const manifest = JSON.parse(readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8'));

// a "Pro" on the network: a VNC server showing a screen we control
let screen = realScreen().data;
let tick = 0;
const pro = await startFakeVnc({ frame: () => screen });
const animate = setInterval(() => {
  // the real screenshot does not move; nudge one trace pixel so the plot "changes"
  const i = (300 * 1280 + 700) * 4;
  screen[i + 1] = tick++ % 2 ? 0 : 1;
  pro.changed();
}, 80);

const DEVICE_ID = `net:${pro.host}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const SIM_PATH = `/devices/${encodeURIComponent(SIMULATED_DEVICE_ID)}`;

const handle = await (await import('../main.js')).default;
test.after(async () => {
  clearInterval(animate);
  await handle.close();
  await pro.close();
});

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, { timeoutMs = 8_000, what = 'the condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
};
const listed = async (id) => (await request('GET', '/devices')).body.devices.find((d) => d.id === id);
const configure = (body, path = DEVICE_PATH) => request('POST', `${path}/configuration`, body);
const sweeping = async (t, path = DEVICE_PATH) => {
  const started = await request('POST', `${path}/sweep/start`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  t.after(() => request('POST', `${path}/sweep/stop`));
};
const traceAfter = async (sweepId = 0, path = DEVICE_PATH) => {
  let trace = await request('GET', `${path}/trace`);
  while (trace.status === 200 && trace.body.sweepId <= sweepId) trace = await request('GET', `${path}/trace`);
  return trace;
};

const added = await request('POST', '/devices', {
  id: DEVICE_ID,
  product: PRODUCT,
  config: { host: pro.host, port: pro.port },
});

test('the product the adapter announces is declared in the manifest', () => {
  assert.ok(manifest.products.some((p) => p.deviceTypeId === PRODUCT));
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
  assert.equal(added.status, 201, JSON.stringify(added.body));
});

test('the simulated Pro is offered when the setting asks for it', async () => {
  const d = await listed(SIMULATED_DEVICE_ID);
  assert.ok(d);
  assert.equal(d.product, PRODUCT);
});

test('the range comes from the Pro\'s own screen labels', async () => {
  const { status, body } = await configure({});
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.startHz, 469_886_000);
  assert.equal(body.stopHz, 700_086_000);
  assert.equal(body.pointCount, 911);
  const caps = (await listed(DEVICE_ID)).capabilities;
  assert.equal(caps.minFrequencyHz, 469_886_000);
  assert.equal(caps.maxFrequencyHz, 700_086_000);
  assert.deepEqual(caps.controls.map((c) => c.id), ['detector', 'axisStartMHz', 'axisStopMHz', 'axisTopDbm', 'axisBottomDbm']);
});

test('asking beyond the Pro\'s span is clamped to it, and a part of it is cut out', async () => {
  const wide = await configure({ startHz: 100e6, stopHz: 900e6, pointCount: 5000 });
  assert.equal(wide.status, 200);
  assert.equal(wide.body.startHz, 469_886_000);
  assert.equal(wide.body.stopHz, 700_086_000);
  assert.equal(wide.body.pointCount, 911, 'never more points than plot columns');

  const part = await configure({ startHz: 500e6, stopHz: 600e6, pointCount: 10_000 });
  assert.equal(part.status, 200);
  assert.ok(part.body.startHz >= 500e6 && part.body.startHz < 500.3e6, part.body.startHz);
  assert.ok(part.body.stopHz <= 600e6 && part.body.stopHz > 599.7e6, part.body.stopHz);
  assert.ok(part.body.pointCount > 390 && part.body.pointCount < 400, String(part.body.pointCount)); // the columns in 500-600 MHz
});

test('live traces flow, with the length and levels of the real screen', async (t) => {
  await configure({ startHz: 0, stopHz: 1e10, pointCount: 911 });
  await sweeping(t);
  const a = await traceAfter();
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.amplitudesDbm.length, 911);
  assert.equal(Math.max(...a.body.amplitudesDbm).toFixed(2), '-45.56');
  const b = await traceAfter(a.body.sweepId);
  assert.ok(b.body.sweepId > a.body.sweepId);
  assert.equal(pro.inputEvents(), 0, 'the plugin must never click or type on the Pro');
});

test('the point count is the screen\'s: requests for fewer points are ignored', async (t) => {
  const caps = (await listed(DEVICE_ID)).capabilities;
  assert.equal(caps.autoPointCount, true);
  const r = await configure({ startHz: 0, stopHz: 1e10, pointCount: 100 });
  assert.equal(r.body.pointCount, 911);
  await sweeping(t);
  const tr = await traceAfter();
  assert.equal(tr.body.amplitudesDbm.length, 911);
  assert.equal(Math.max(...tr.body.amplitudesDbm).toFixed(2), '-45.56');
});

test('a range changed on the Pro reconnects with the new range', async (t) => {
  await configure({ startHz: 0, stopHz: 1e10, pointCount: 911 });
  await sweeping(t);
  await traceAfter();
  const axes = { startHz: 470_000_000, stopHz: 608_000_000, topDbm: -20, bottomDbm: -120 };
  const saved = screen;
  screen = renderScreen(axes, simulatedSpectrum(axes, 0));
  t.after(() => {
    screen = saved;
  });
  const failed = await until(async () => {
    const d = await listed(DEVICE_ID);
    return d?.status.status === 'failed' ? d : null;
  }, { what: 'the reconnect' });
  assert.match(failed.status.message, /470\.000-608\.000 MHz/);
  // the next operation reopens it with the new range
  const { status, body } = await configure({ startHz: 0, stopHz: 1e10 });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.startHz, 470_000_000);
  assert.equal(body.stopHz, 608_000_000);
  // and back: noticed at the next configuration too, without sweeping
  await request('POST', `${DEVICE_PATH}/sweep/stop`);
  screen = saved;
  const changed = await configure({ startHz: 0, stopHz: 1e10 });
  assert.notEqual(changed.status, 200);
  assert.match(JSON.stringify(changed.body), /469\.886-700\.086 MHz/);
  const back = await configure({ startHz: 0, stopHz: 1e10 });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.stopHz, 700_086_000);
});

test('a screen without labels says so, and manual axis values make it work', async (t) => {
  const saved = screen;
  const blank = new Uint8Array(1280 * 800 * 4);
  // the real plot without its labels: trace visible, axes unreadable
  for (let y = 36; y < 497; y += 1) {
    const a = (y * 1280 + 54) * 4;
    blank.set(saved.subarray(a, a + 913 * 4), a);
  }
  const id = `net:${pro.host}:blank`;
  const other = await startFakeVnc({ frame: () => blank });
  t.after(() => other.close());
  const add = await request('POST', '/devices', { id, product: PRODUCT, config: { host: other.host, port: other.port } });
  assert.equal(add.status, 201);
  const path = `/devices/${encodeURIComponent(id)}`;
  t.after(() => request('DELETE', path));

  const bad = await configure({}, path);
  assert.notEqual(bad.status, 200);
  assert.match(JSON.stringify(bad.body), /cannot read the frequency and level labels/);

  const manual = await configure({
    controls: { axisStartMHz: 469.886, axisStopMHz: 700.086, axisTopDbm: -16.4, axisBottomDbm: -118.9 },
  }, path);
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.startHz, 469_886_000);
  const timer = setInterval(() => {
    blank[(300 * 1280 + 700) * 4 + 1] ^= 1;
    other.changed();
  }, 80);
  t.after(() => clearInterval(timer));
  await sweeping(t, path);
  const tr = await traceAfter(0, path);
  assert.equal(tr.status, 200);
  assert.equal(Math.max(...tr.body.amplitudesDbm).toFixed(2), '-45.56');
});

test('the Pro with its side menu hidden (as used in the field) gives 1181 points', async (t) => {
  const wide = realScreenWide().data;
  const other = await startFakeVnc({ frame: () => wide });
  t.after(() => other.close());
  const timer = setInterval(() => {
    wide[(300 * 1280 + 700) * 4 + 1] ^= 1;
    other.changed();
  }, 80);
  t.after(() => clearInterval(timer));
  const id = `net:${other.host}:wide`;
  const path = `/devices/${encodeURIComponent(id)}`;
  const add = await request('POST', '/devices', { id, product: PRODUCT, config: { host: other.host, port: other.port } });
  assert.equal(add.status, 201);
  t.after(() => request('DELETE', path));
  const { status, body } = await configure({}, path);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.startHz, 469_811_000);
  assert.equal(body.stopHz, 900_011_000);
  assert.equal(body.pointCount, 1181);
  await sweeping(t, path);
  const tr = await traceAfter(0, path);
  assert.equal(tr.status, 200);
  assert.equal(tr.body.amplitudesDbm.length, 1181);
});

test('a VNC server that sends the screen in pieces does not cause reconnects', async (t) => {
  const wide = realScreenWide().data;
  const other = await startFakeVnc({ frame: () => wide, piecewise: true });
  t.after(() => other.close());
  const id = `net:${other.host}:piecewise`;
  const path = `/devices/${encodeURIComponent(id)}`;
  const add = await request('POST', '/devices', { id, product: PRODUCT, config: { host: other.host, port: other.port } });
  assert.equal(add.status, 201);
  t.after(() => request('DELETE', path));
  const first = await configure({}, path);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.pointCount, 1181);
  const second = await configure({ startHz: 500e6, stopHz: 600e6 }, path);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const d = await listed(id);
  assert.notEqual(d.status.status, 'failed', JSON.stringify(d.status));
  assert.equal((d.capabilities ?? {}).minFrequencyHz, 469_811_000, 'opened with the range read off the screen');
});

test('a frozen screen (Hold on the Pro) raises a critical warning', async (t) => {
  clearInterval(animate);
  await configure({ startHz: 0, stopHz: 1e10 });
  await sweeping(t);
  const d = await until(async () => {
    const x = await listed(DEVICE_ID);
    return x?.status.warnings?.some((w) => w.id === 'frozen') ? x : null;
  }, { what: 'the frozen warning' });
  assert.equal(d.status.warnings.find((w) => w.id === 'frozen').severity, 'critical');
});

test('the simulated Pro sweeps through the same reading path', async (t) => {
  const { status, body } = await configure({ startHz: 470e6, stopHz: 700e6 }, SIM_PATH);
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.startHz >= 470e6 && body.stopHz <= 700e6);
  await sweeping(t, SIM_PATH);
  const tr = await traceAfter(0, SIM_PATH);
  assert.equal(tr.status, 200);
  assert.equal(tr.body.amplitudesDbm.length, body.pointCount);
  assert.ok(Math.max(...tr.body.amplitudesDbm) > -50);
});

test('an address with no Pro behind it fails with a reason', async (t) => {
  const id = 'net:127.0.0.1:1';
  const add = await request('POST', '/devices', { id, product: PRODUCT, config: { host: '127.0.0.1', port: 1 } });
  assert.equal(add.status, 201);
  t.after(() => request('DELETE', `/devices/${encodeURIComponent(id)}`));
  const r = await configure({}, `/devices/${encodeURIComponent(id)}`);
  assert.notEqual(r.status, 200);
  const d = await until(async () => {
    const x = await listed(id);
    return x?.status.status === 'failed' ? x : null;
  }, { what: 'the failure' });
  assert.match(d.status.message, /Cannot see the RF Explorer Pro's screen at 127\.0\.0\.1/);
});
