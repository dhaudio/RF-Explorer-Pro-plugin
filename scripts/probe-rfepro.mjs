#!/usr/bin/env node
// Try the driver against a real RF Explorer Pro, without SoundBase.
//
//   npm run probe -- 169.254.225.207
//   npm run probe -- 169.254.225.207 --port 5900 --sweeps 3
//
// Connects over VNC (watching only: it never clicks or types), reads the axis
// labels, extracts a few traces, and writes:
//   probe-rfepro-<date>.png   the screen as the plugin saw it
//   probe-rfepro-<date>.json  what it read, for a bug report

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { AxesUnreadable, readAxes } from '../driver/axes.js';
import { columnsOf } from '../driver/layout.js';
import { VncScreenSource } from '../driver/sources.js';
import { TraceNotFound, columnHz, extractTrace } from '../driver/trace.js';

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
if (!host) {
  console.error('usage: npm run probe -- <ip address of the RF Explorer Pro> [--port 5900] [--sweeps 3]');
  process.exit(2);
}
const port = Number(opt('port', 5900));
const sweeps = Number(opt('sweeps', 3));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const report = { host, port, startedAt: new Date().toISOString(), steps: [] };
const step = (what, data = {}) => {
  console.log(`- ${what}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`);
  report.steps.push({ at: new Date().toISOString(), what, ...data });
};

function png(frame) {
  const { width, height, data } = frame;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = data[i + 2];
      raw[o + 1] = data[i + 1];
      raw[o + 2] = data[i];
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const source = new VncScreenSource({ host, port, password: opt('password', '') });
let exitCode = 0;
try {
  step(`connecting to ${host}:${port} over VNC`);
  const frame = await source.open();
  step('connected', { width: frame.width, height: frame.height });
  writeFileSync(`probe-rfepro-${stamp}.png`, png(frame));
  step(`screenshot saved: probe-rfepro-${stamp}.png`);

  let axes = null;
  try {
    axes = readAxes(frame);
    step('axis labels read', {
      startMHz: axes.startHz / 1e6, stopMHz: axes.stopHz / 1e6, topDbm: axes.topDbm, bottomDbm: axes.bottomDbm,
      plotRight: axes.plot.right, points: columnsOf(axes.plot),
    });
  } catch (err) {
    if (!(err instanceof AxesUnreadable)) throw err;
    step('axis labels NOT readable', { reason: err.message });
    exitCode = 1;
  }

  if (axes) {
    for (let n = 0; n < sweeps; n += 1) {
      const t0 = Date.now();
      const changed = await source.next(10_000);
      if (!changed) {
        step('the screen did not change for 10 s: is the Pro on Hold or replaying?');
        exitCode = 1;
        break;
      }
      try {
        const amps = extractTrace(source.frame(), axes);
        const peak = amps.indexOf(Math.max(...amps));
        const sorted = [...amps].sort((a, b) => a - b);
        step(`sweep ${n + 1}`, {
          waitedMs: Date.now() - t0,
          points: columnsOf(axes.plot),
          peakDbm: Number(amps[peak].toFixed(1)),
          peakMHz: Number((columnHz(axes, peak) / 1e6).toFixed(3)),
          medianDbm: Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)),
        });
      } catch (err) {
        if (!(err instanceof TraceNotFound)) throw err;
        step('trace NOT found', { reason: err.message });
        exitCode = 1;
      }
    }
  }
} catch (err) {
  step('failed', { error: err.message });
  exitCode = 1;
} finally {
  source.close();
  writeFileSync(`probe-rfepro-${stamp}.json`, JSON.stringify(report, null, 2));
  console.log(`report saved: probe-rfepro-${stamp}.json`);
  process.exit(exitCode);
}
