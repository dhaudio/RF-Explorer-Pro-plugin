// The driver on its own: label reading, trace extraction and the VNC client,
// against a real RF Explorer Pro screenshot and against drawn screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AxesUnreadable, readAxes } from '../driver/axes.js';
import { COLUMNS, SCREEN } from '../driver/layout.js';
import { TraceNotFound, extractTrace, resamplePeak } from '../driver/trace.js';
import { renderScreen, simulatedSpectrum } from '../driver/simulated-screen.js';
import { startFakeVnc } from '../driver/fake-vnc-server.js';
import { RfbClient } from '../driver/rfb.js';
import { realScreen } from './helpers.js';

const REAL_AXES = { startHz: 469_886_000, stopHz: 700_086_000, topDbm: -16.4, bottomDbm: -118.9 };

test('the axis labels of a real Pro screen are read exactly', () => {
  assert.deepEqual(readAxes(realScreen()), REAL_AXES);
});

test('the trace of a real Pro screen matches the reference extraction', () => {
  const reference = JSON.parse(
    readFileSync(new URL('./fixtures/rfepro-1280x800.trace.json', import.meta.url), 'utf8')
  );
  const amps = extractTrace(realScreen(), REAL_AXES);
  assert.equal(amps.length, COLUMNS);
  for (let i = 0; i < COLUMNS; i += 1) assert.ok(Math.abs(amps[i] - reference[i]) < 1e-3, `column ${i}`);
  assert.equal(Math.max(...amps).toFixed(2), '-45.56');
});

test('the center detector never reads above the peak detector', () => {
  const peak = extractTrace(realScreen(), REAL_AXES);
  const center = extractTrace(realScreen(), REAL_AXES, { detector: 'center' });
  for (let i = 0; i < COLUMNS; i += 1) assert.ok(center[i] <= peak[i] + 1e-9);
});

for (const axes of [
  { startHz: 469_843_000, stopHz: 900_043_000, topDbm: -16.4, bottomDbm: -118.9 },
  { startHz: 470_000_000, stopHz: 608_000_000, topDbm: -20, bottomDbm: -120 },
  { startHz: 1_234_567_000, stopHz: 1_300_000_000, topDbm: 0, bottomDbm: -100.5 },
]) {
  test(`a drawn screen at ${axes.startHz / 1e6}-${axes.stopHz / 1e6} MHz reads back`, () => {
    const amps = simulatedSpectrum(axes, 0);
    const frame = { width: 1280, height: 800, data: renderScreen(axes, amps) };
    assert.deepEqual(readAxes(frame), axes);
    const read = extractTrace(frame, axes);
    const dbPerPixel = (axes.topDbm - axes.bottomDbm) / 457;
    for (let i = 0; i < COLUMNS - 5; i += 1) {
      if (amps[i] < axes.bottomDbm) continue;
      assert.ok(read[i] >= amps[i] - dbPerPixel, `column ${i} reads low`);
    }
  });
}

test('a screen that is not the analyzer is reported, not guessed', () => {
  const blank = { width: 1280, height: 800, data: new Uint8Array(1280 * 800 * 4) };
  assert.throws(() => readAxes(blank), AxesUnreadable);
  assert.throws(() => extractTrace(blank, REAL_AXES), TraceNotFound);
});

test('labels that disagree with each other are rejected', () => {
  const axes = { startHz: 470_000_000, stopHz: 608_000_000, topDbm: -20, bottomDbm: -120 };
  const data = renderScreen(axes, simulatedSpectrum(axes, 0));
  // wipe the centre frequency label and draw a wrong one
  const other = renderScreen({ ...axes, startHz: 400_000_000 }, simulatedSpectrum(axes, 0));
  for (let y = 503; y < 512; y += 1) {
    for (let x = 400; x < 620; x += 1) {
      const i = (y * 1280 + x) * 4;
      data.set(other.subarray(i, i + 4), i);
    }
  }
  assert.throws(() => readAxes({ width: 1280, height: 800, data }), /halfway/);
});

test('fewer points keep the maximum of each share', () => {
  const a = new Array(911).fill(-100);
  a[517] = -20;
  const r = resamplePeak(a, 100);
  assert.equal(r.length, 100);
  assert.equal(Math.max(...r), -20);
  assert.equal(resamplePeak(a, 5000).length, 911);
});

test('the VNC client receives the screen and its changes, and never sends input', async (t) => {
  let screen = realScreen().data;
  const server = await startFakeVnc({ frame: () => screen });
  t.after(() => server.close());
  const client = new RfbClient({ host: server.host, port: server.port });
  await client.connect();
  t.after(() => client.close());
  assert.equal(client.width, SCREEN.width);
  assert.equal(await client.update({ incremental: false }), true);
  assert.deepEqual(readAxes(client.frame()), REAL_AXES);

  // nothing changed: an incremental request waits
  assert.equal(await client.update({ x: 0, y: 28, w: 1010, h: 490, timeoutMs: 300 }), false);
  // the screen changes: the waiting request is answered
  const axes = { startHz: 470_000_000, stopHz: 608_000_000, topDbm: -20, bottomDbm: -120 };
  const pending = client.update({ x: 0, y: 28, w: 1010, h: 490, timeoutMs: 3_000 });
  screen = renderScreen(axes, simulatedSpectrum(axes, 0));
  server.changed();
  assert.equal(await pending, true);
  assert.deepEqual(readAxes(client.frame()), axes);
  assert.equal(server.inputEvents(), 0);
});

test('an unreachable address fails with a specific message', async () => {
  const client = new RfbClient({ host: '127.0.0.1', port: 1, timeoutMs: 2_000 });
  await assert.rejects(client.connect(), /cannot reach the VNC server at 127\.0\.0\.1:1/);
});
