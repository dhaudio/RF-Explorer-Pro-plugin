// Draws an RF Explorer Pro analyzer screen: plot frame, grid, the yellow
// real-time trace and the axis labels in the Pro's own font. Backs the
// "Simulated RF Explorer Pro" device and the tests, so both go through the
// same label reading and trace extraction as a real unit.

import { GLYPHS } from './glyphs.js';
import { PLOT_FULL_WIDTH, SCREEN, bottomLabelRow, columnsOf, leftLabels } from './layout.js';

const W = SCREEN.width;
const H = SCREEN.height;

function put(data, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  data[i] = b;
  data[i + 1] = g;
  data[i + 2] = r;
}

function hline(data, x0, x1, y, c) {
  for (let x = x0; x <= x1; x += 1) put(data, x, y, c);
}
function vline(data, x, y0, y1, c) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) put(data, x, y, c);
}

const glyph = (ch) => GLYPHS[ch][0];

function textWidth(text) {
  return [...text].reduce((w, ch) => w + glyph(ch).w + 1, -1);
}

function drawText(data, x, y, text) {
  for (const ch of text) {
    const g = glyph(ch);
    for (let r = 0; r < g.h; r += 1) {
      for (let c = 0; c < g.w; c += 1) {
        const v = g.lum[r * g.w + c];
        put(data, x + c, y + r, [v, v, v]);
      }
    }
    x += g.w + 1;
  }
}

/** A plausible spectrum for the simulated device: noise floor and carriers,
 *  one value per column of the plot (axes.plot, full width by default). */
export function simulatedSpectrum(axes, t = 0, seed = 1) {
  const COLUMNS = columnsOf(axes.plot ?? PLOT_FULL_WIDTH);
  let s = seed * 9301 + Math.floor(t * 1000);
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const carriers = [
    [500.15e6, -48], [518.6e6, -62], [544.1e6, -45], [606.35e6, -40],
    [655.5e6, -70], [742.9e6, -55], [863.5e6, -50],
  ];
  const out = new Array(COLUMNS);
  for (let c = 0; c < COLUMNS; c += 1) {
    const f = axes.startHz + (c * (axes.stopHz - axes.startHz)) / (COLUMNS - 1);
    let lin = 10 ** (-96 / 10) * (0.3 + rand() * 1.4);
    for (const [fc, lvl] of carriers) {
      const width = 150e3 + (axes.stopHz - axes.startHz) / COLUMNS;
      lin += 10 ** ((lvl + 2 * Math.sin(t + fc / 1e7)) / 10) * Math.exp(-0.5 * ((f - fc) / (width / 2.355)) ** 2);
    }
    out[c] = 10 * Math.log10(lin);
  }
  return out;
}

/**
 * The full 1280x800 screen, as B, G, R, X bytes.
 * axes: { startHz, stopHz, topDbm, bottomDbm, plot? } - plot defaults to the
 * full-width layout (side menu hidden); amps: one value per plot column, dBm.
 */
export function renderScreen(axes, amps, data = new Uint8Array(W * H * 4)) {
  const PLOT = axes.plot ?? PLOT_FULL_WIDTH;
  const COLUMNS = columnsOf(PLOT);
  data.fill(0);
  const grid = [55, 55, 60];
  const frame = [128, 128, 128];
  for (let i = 1; i < 10; i += 1) {
    vline(data, Math.round(PLOT.left + (i * (PLOT.right - PLOT.left)) / 10), PLOT.top, PLOT.bottom, grid);
    hline(data, PLOT.left, PLOT.right, Math.round(PLOT.top + (i * (PLOT.bottom - PLOT.top)) / 10), grid);
  }
  // the frame as the Pro draws it (measured on firmware 1.25): sides and top
  // two pixels thick in grey, bottom one light line
  const light = [229, 229, 229];
  hline(data, PLOT.left - 1, PLOT.right + 1, PLOT.top - 1, frame);
  hline(data, PLOT.left - 1, PLOT.right + 1, PLOT.top, frame);
  hline(data, PLOT.left - 1, PLOT.right + 1, PLOT.bottom, light);
  vline(data, PLOT.left - 1, PLOT.top, PLOT.bottom, frame);
  vline(data, PLOT.left, PLOT.top, PLOT.bottom, frame);
  vline(data, PLOT.right, PLOT.top, PLOT.bottom, frame);
  vline(data, PLOT.right + 1, PLOT.top, PLOT.bottom, frame);

  // the trace: a connected yellow line, as the Pro draws it
  const rows = PLOT.bottom - PLOT.top;
  const yOf = (dbm) => {
    const v = Math.min(Math.max(dbm, axes.bottomDbm), axes.topDbm);
    return Math.round(PLOT.top + ((axes.topDbm - v) / (axes.topDbm - axes.bottomDbm)) * rows);
  };
  const yellow = [255, 255, 0];
  let prev = yOf(amps[0]);
  for (let c = 0; c < amps.length && c < COLUMNS - 4; c += 1) {
    const y = yOf(amps[c]);
    const mid = Math.round((prev + y) / 2);
    vline(data, PLOT.left + c - 1, prev, mid, yellow);
    vline(data, PLOT.left + c, mid, y, yellow);
    prev = y;
  }

  // labels
  const { x1, count } = leftLabels(PLOT);
  const step = (axes.topDbm - axes.bottomDbm) / (count - 1);
  for (let i = 0; i < count; i += 1) {
    const text = (axes.topDbm - i * step).toFixed(1);
    const cy = PLOT.top - 0.5 + (i * (PLOT.bottom - PLOT.top + 0.5)) / (count - 1);
    drawText(data, x1 - 2 - textWidth(text), Math.round(cy - 4.5), text);
  }
  const mhz = (hz) => (hz / 1e6).toFixed(3);
  const y = bottomLabelRow(PLOT);
  drawText(data, PLOT.left - 21, y, mhz(axes.startHz));
  const centre = mhz((axes.startHz + axes.stopHz) / 2);
  drawText(data, Math.round((PLOT.left + PLOT.right) / 2) - Math.round(textWidth(centre) / 2), y, centre);
  const stop = mhz(axes.stopHz);
  drawText(data, PLOT.right - 5 - textWidth(stop), y, stop);
  return data;
}
