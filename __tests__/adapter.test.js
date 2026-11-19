// The adapter on its own, for timing behaviour the HTTP tests cannot pin down.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SB_RFEPRO_SIM_FRAME_MS = '40';
const { createSpectrumAnalyzerAdapter, SIMULATED_DEVICE_ID } = await import('../adapter.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('stopping and restarting quickly leaves exactly one sweep loop', async (t) => {
  const a = createSpectrumAnalyzerAdapter({ id: SIMULATED_DEVICE_ID });
  t.after(() => a.close());
  await a.open();
  await a.applyConfig({});
  let old = 0;
  let fresh = 0;
  await a.startSweep(() => {
    old += 1;
  });
  await delay(150);
  await a.stopSweep();
  await a.startSweep(() => {
    fresh += 1;
  });
  const before = old;
  await delay(500);
  assert.equal(old, before, 'the stopped loop kept delivering traces');
  assert.ok(fresh > 3, `the new loop delivered ${fresh} traces`);
});

test('close stops the sweep for good', async () => {
  const a = createSpectrumAnalyzerAdapter({ id: SIMULATED_DEVICE_ID });
  await a.open();
  await a.applyConfig({});
  let n = 0;
  await a.startSweep(() => {
    n += 1;
  });
  await delay(150);
  await a.close();
  const at = n;
  await delay(300);
  assert.equal(n, at);
});
