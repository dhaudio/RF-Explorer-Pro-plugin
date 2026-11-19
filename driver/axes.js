// Read the axis labels off the RF Explorer Pro's screen, so the plugin knows
// which frequencies and levels the plot shows without anyone typing them in.
//
// The labels are matched glyph by glyph against templates of the Pro's font
// (driver/glyphs.js). Every reading is checked against the screen's own
// geometry before it is trusted:
//   - the eleven dBm labels must fall evenly from top to bottom;
//   - the centre frequency label must sit halfway between start and stop.
// A reading that fails a check is reported as unreadable, never guessed.

import { GLYPHS } from './glyphs.js';
import { LABELS, PLOT, luminance } from './layout.js';

const ROW_INK = 90; // luminance above which a pixel is text
const SEG_INK = 130; // stricter, to split touching glyphs
const MAX_GAP = 4; // columns of blank that end a number
const MAX_GLYPH_ERROR = 55; // mean luminance error; above it, not a glyph we know
const LINE_HEIGHT = 9;

export class AxesUnreadable extends Error {}

const TEMPLATES = Object.entries(GLYPHS).map(([ch, g]) => ({ ch, ...g }));

function inkColumns(frame, y0, y1, x0, x1, thr) {
  const out = [];
  for (let x = x0; x < x1; x += 1) {
    let ink = false;
    for (let y = y0; y < y1 && !ink; y += 1) ink = luminance(frame, x, y) > thr;
    out.push(ink);
  }
  return out;
}

function segments(frame, y0, y1, x0, x1) {
  const cols = inkColumns(frame, y0, y1, x0, x1, SEG_INK);
  const segs = [];
  for (let i = 0; i < cols.length; ) {
    if (!cols[i]) {
      i += 1;
      continue;
    }
    const s = i;
    while (i < cols.length && cols[i]) i += 1;
    segs.push([x0 + s, x0 + i]);
  }
  return segs;
}

function classify(frame, y0, a, b) {
  const gw = b - a;
  let best = { err: Infinity, ch: null };
  for (const t of TEMPLATES) {
    const h = Math.min(LINE_HEIGHT, t.h);
    const W = Math.max(gw, t.w) + 2;
    for (let og = 0; og <= W - gw; og += 1) {
      for (let ot = 0; ot <= W - t.w; ot += 1) {
        let err = 0;
        for (let r = 0; r < h; r += 1) {
          for (let x = 0; x < W; x += 1) {
            const gx = x - og;
            const tx = x - ot;
            const g = gx >= 0 && gx < gw ? luminance(frame, a + gx, y0 + r) : 0;
            const tv = tx >= 0 && tx < t.w ? t.lum[r * t.w + tx] : 0;
            err += Math.abs(g - tv);
          }
        }
        err /= h * W;
        if (err < best.err) best = { err, ch: t.ch };
      }
    }
  }
  return best;
}

/** The number written from the first glyph in [x0, x1) on rows [y0, y0+9). */
export function readNumber(frame, y0, x0, x1) {
  const text = readDigits(frame, y0, x0, x1);
  return text === null ? null : Number(text);
}

/** Like readNumber, but the text as written ("1.30" stays "1.30"). */
export function readDigits(frame, y0, x0, x1) {
  let text = '';
  let prev = null;
  for (const [a, b] of segments(frame, y0, y0 + LINE_HEIGHT, x0, x1)) {
    if (prev !== null && a - prev > MAX_GAP) break;
    const { err, ch } = classify(frame, y0, a, b);
    if (err > MAX_GLYPH_ERROR) break; // a letter (" MHz"), not a digit
    text += ch;
    prev = b;
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return text;
}

/** The firmware version the Pro shows top left ("RFEPro v1.25"), or null. */
export function readFirmware(frame) {
  const text = readDigits(frame, 10, 76, 110);
  return text && /^\d+\.\d+$/.test(text) ? text : null;
}

/** Top row of the 9-row label band nearest y, or null. */
function snapLabelRow(frame, y, x0, x1) {
  const rowInk = (yy) => inkColumns(frame, yy, yy + 1, x0, x1, ROW_INK).some(Boolean);
  for (let d = 0; d <= 3; d += 1) {
    for (const y0 of d === 0 ? [y] : [y - d, y + d]) {
      if (rowInk(y0) && rowInk(y0 + LINE_HEIGHT - 1) && !rowInk(y0 - 1)) return y0;
    }
  }
  return null;
}

/**
 * { startHz, stopHz, topDbm, bottomDbm } as shown on the screen.
 * Throws AxesUnreadable with the reason when a label cannot be read or the
 * readings are not consistent with each other.
 */
export function readAxes(frame) {
  // dBm: one label centred on each of the eleven horizontal grid lines
  const { x0, x1, count } = LABELS.left;
  const levels = [];
  for (let i = 0; i < count; i += 1) {
    const cy = PLOT.top - 0.5 + (i * (PLOT.bottom - PLOT.top + 0.5)) / (count - 1);
    const y0 = snapLabelRow(frame, Math.round(cy - LINE_HEIGHT / 2), x0, x1);
    const v = y0 === null ? null : readNumber(frame, y0, x0, x1);
    if (v === null) throw new AxesUnreadable(`dBm label ${i + 1} of ${count} cannot be read`);
    levels.push(v);
  }
  const step = (levels[0] - levels[count - 1]) / (count - 1);
  if (!(step > 0)) throw new AxesUnreadable('the dBm labels do not decrease downwards');
  for (let i = 1; i < count; i += 1) {
    if (Math.abs(levels[i - 1] - levels[i] - step) > 0.15) {
      throw new AxesUnreadable(`the dBm labels are not evenly spaced (${levels.join(', ')})`);
    }
  }

  // MHz: start under the left edge, stop under the right edge, centre between
  const { y0, start, centre, stop } = LABELS.bottom;
  const first = (range) => segments(frame, y0, y0 + LINE_HEIGHT, range[0], range[1])[0]?.[0];
  const read = (range) => {
    const x = first(range);
    return x === undefined ? null : readNumber(frame, y0, x, range[1]);
  };
  const startMHz = read(start);
  const stopMHz = read(stop);
  if (startMHz === null || stopMHz === null) throw new AxesUnreadable('the frequency labels cannot be read');
  if (!(stopMHz > startMHz)) throw new AxesUnreadable(`stop ${stopMHz} MHz is not above start ${startMHz} MHz`);
  const centreMHz = read(centre);
  if (centreMHz !== null && Math.abs(centreMHz - (startMHz + stopMHz) / 2) > 0.0021) {
    throw new AxesUnreadable(
      `the centre label (${centreMHz} MHz) is not halfway between ${startMHz} and ${stopMHz} MHz`
    );
  }

  return {
    startHz: Math.round(startMHz * 1e6),
    stopHz: Math.round(stopMHz * 1e6),
    topDbm: levels[0],
    bottomDbm: levels[count - 1],
  };
}

export function sameAxes(a, b) {
  return (
    !!a && !!b &&
    a.startHz === b.startHz &&
    a.stopHz === b.stopHz &&
    Math.abs(a.topDbm - b.topDbm) < 1e-9 &&
    Math.abs(a.bottomDbm - b.bottomDbm) < 1e-9
  );
}
