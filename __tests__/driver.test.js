// The driver on its own: label reading, trace extraction and the VNC client,
// against a real RF Explorer Pro screenshot and against drawn screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AxesUnreadable, readAxes } from '../driver/axes.js';
import { PLOT_FULL_WIDTH, PLOT_WITH_MENU, SCREEN, columnsOf, findPlot } from '../driver/layout.js';
import { TraceNotFound, extractTrace, resamplePeak } from '../driver/trace.js';
import { renderScreen, simulatedSpectrum } from '../driver/simulated-screen.js';
import { startFakeVnc } from '../driver/fake-vnc-server.js';
import { RfbClient } from '../driver/rfb.js';
import { realScreen, realScreenWide } from './helpers.js';

const REAL_AXES = { startHz: 469_886_000, stopHz: 700_086_000, topDbm: -16.4, bottomDbm: -118.9, plot: PLOT_WITH_MENU };
const WIDE_AXES = { startHz: 469_811_000, stopHz: 900_011_000, topDbm: -16.4, bottomDbm: -118.9, plot: PLOT_FULL_WIDTH };
const COLUMNS = columnsOf(PLOT_WITH_MENU);

test('the axis labels of a real Pro screen are read exactly', () => {
  assert.deepEqual(readAxes(realScreen()), REAL_AXES);
});

test('the side menu hidden: the wider plot and its labels are found', () => {
  assert.deepEqual(findPlot(realScreenWide()), PLOT_FULL_WIDTH);
  assert.deepEqual(findPlot(realScreen()), PLOT_WITH_MENU);
  assert.deepEqual(readAxes(realScreenWide()), WIDE_AXES);
  const amps = extractTrace(realScreenWide(), WIDE_AXES);
  assert.equal(amps.length, 1181);
  // the strongest carrier of that screen, around 544 MHz, near -45 dBm
  const peak = amps.indexOf(Math.max(...amps));
  const hz = WIDE_AXES.startHz + (peak * (WIDE_AXES.stopHz - WIDE_AXES.startHz)) / 1180;
  assert.ok(hz > 540e6 && hz < 548e6, String(hz));
  assert.ok(Math.max(...amps) > -47 && Math.max(...amps) < -43);
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
  { startHz: 469_843_000, stopHz: 900_043_000, topDbm: -16.4, bottomDbm: -118.9, plot: PLOT_FULL_WIDTH },
  { startHz: 470_000_000, stopHz: 608_000_000, topDbm: -20, bottomDbm: -120, plot: PLOT_WITH_MENU },
  { startHz: 1_234_567_000, stopHz: 1_300_000_000, topDbm: 0, bottomDbm: -100.5, plot: PLOT_FULL_WIDTH },
]) {
  test(`a drawn screen at ${axes.startHz / 1e6}-${axes.stopHz / 1e6} MHz, ${columnsOf(axes.plot)} columns, reads back`, () => {
    const amps = simulatedSpectrum(axes, 0);
    const frame = { width: 1280, height: 800, data: renderScreen(axes, amps) };
    assert.deepEqual(readAxes(frame), axes);
    const read = extractTrace(frame, axes);
    const dbPerPixel = (axes.topDbm - axes.bottomDbm) / 457;
    for (let i = 0; i < columnsOf(axes.plot) - 5; i += 1) {
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
  const axes = { startHz: 470_000_000, stopHz: 608_000_000, topDbm: -20, bottomDbm: -120, plot: PLOT_WITH_MENU };
  const data = renderScreen(axes, simulatedSpectrum(axes, 0));
  // wipe the centre frequency label and draw a wrong one
  const other = renderScreen({ ...axes, startHz: 400_000_000 }, simulatedSpectrum(axes, 0));
  for (let y = 503; y < 512; y += 1) {
    for (let x = 400; x < 620; x += 1) {
      const i = (y * 1280 + x) * 4;
      data.set(other.subarray(i, i + 4), i);
    }
  }
  assert.throws(() => readAxes({ width: 1280, height: 800, data }), /do not agree/);
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
  assert.equal(await client.update({ timeoutMs: 300 }), false);
  // the screen changes: the waiting request is answered
  const axes = { startHz: 470_000_000, stopHz: 608_000_000, topDbm: -20, bottomDbm: -120, plot: PLOT_FULL_WIDTH };
  const pending = client.update({ timeoutMs: 3_000 });
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

test('DES matches the FIPS test vector and VNC password answers match vncdotool', async () => {
  const { desEncryptBlock, vncAuthResponse } = await import('../driver/des.js');
  const c = desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex'));
  assert.equal(c.toString('hex'), '85e813540f0ab405');
  // reference values computed with vncdotool's own implementation
  assert.equal(
    vncAuthResponse(Buffer.from('00112233445566778899aabbccddeeff', 'hex'), 'secret12').toString('hex'),
    '817402416b165d7ade9c46b5faa42370'
  );
  assert.equal(
    vncAuthResponse(Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'), 'ab').toString('hex'),
    '857d0c0a27d67b209daa03952f48bf11'
  );
});

for (const version of ['3.3', '3.7', '3.8']) {
  for (const password of [null, 'p4ssw0rd']) {
    test(`RFB ${version} ${password ? 'with a VNC password' : 'without a password'} connects`, async (t) => {
      const screen = realScreen().data;
      const server = await startFakeVnc({ frame: () => screen, version, password });
      t.after(() => server.close());
      const client = new RfbClient({ host: server.host, port: server.port, password: password ?? '' });
      await client.connect();
      t.after(() => client.close());
      assert.equal(await client.update({ incremental: false }), true);
      assert.deepEqual(readAxes(client.frame()), REAL_AXES);
    });
  }
}

test('a wrong VNC password and a missing one are reported clearly', async (t) => {
  const screen = realScreen().data;
  const server = await startFakeVnc({ frame: () => screen, password: 'right' });
  t.after(() => server.close());
  await assert.rejects(
    new RfbClient({ host: server.host, port: server.port, password: 'wrong' }).connect(),
    /VNC password rejected/
  );
  await assert.rejects(
    new RfbClient({ host: server.host, port: server.port }).connect(),
    /asks for a password/
  );
});

test('the firmware version is read from the screen', async () => {
  const { readFirmware } = await import('../driver/axes.js');
  assert.equal(readFirmware(realScreen()), '1.25');
  assert.equal(readFirmware({ width: 1280, height: 800, data: new Uint8Array(1280 * 800 * 4) }), null);
});

test('a plot moved a few pixels (another firmware) is still found and read', () => {
  const plot = { left: 60, top: 45, right: 1228, bottom: 502 };
  const axes = { startHz: 470_000_000, stopHz: 700_000_000, topDbm: -20, bottomDbm: -120, plot };
  const frame = { width: 1280, height: 800, data: renderScreen(axes, simulatedSpectrum(axes, 0)) };
  assert.deepEqual(findPlot(frame), plot);
  assert.deepEqual(readAxes(frame), axes);
});

test('grid lines are never taken for the frame', () => {
  // the real screens have grid lines every ~91 px; the frame is found past them
  assert.equal(findPlot(realScreen()).right, 965);
  assert.equal(findPlot(realScreenWide()).right, 1235);
});

test('with no recognisable frame, the trace tells which layout it is', async () => {
  const { guessPlot } = await import('../driver/layout.js');
  for (const plot of [PLOT_WITH_MENU, PLOT_FULL_WIDTH]) {
    const axes = { startHz: 470e6, stopHz: 700e6, topDbm: -20, bottomDbm: -120, plot };
    const data = renderScreen(axes, simulatedSpectrum(axes, 0));
    eraseFrame(data, plot);
    const frame = { width: 1280, height: 800, data };
    assert.equal(findPlot(frame), null);
    assert.deepEqual(guessPlot(frame), plot);
  }
});

export function eraseFrame(data, plot) {
  for (let y = 0; y < 800; y += 1) {
    for (let x = 0; x < 1280; x += 1) {
      const i = (y * 1280 + x) * 4;
      const grey = data[i] === data[i + 1] && data[i + 1] === data[i + 2] && data[i] >= 100;
      if (grey && (x <= plot.left || x >= plot.right - 1 || y <= plot.top || y >= plot.bottom - 1)) {
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
}
