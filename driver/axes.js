// Read the axis labels off the RF Explorer Pro's screen, so the plugin knows
// which frequencies and levels the plot shows without anyone typing them in.
//
// Each glyph is matched against several variants of every character of the
// Pro's font (driver/glyphs.js) and keeps its best few candidates. The
// readings are then decoded together, using what the screen guarantees:
//   - the eleven dBm labels fall in equal steps from top to bottom;
//   - the centre frequency label is halfway between start and stop.
// The decoder picks the most likely reading that satisfies both; a doubtful
// glyph (a 3 that looks like a 2) is settled by the other labels. If no
// reading satisfies them, the labels are reported unreadable, never guessed.

import { createHash } from 'node:crypto';
import { GLYPHS } from './glyphs.js';
import { bottomLabelRow, findPlot, leftLabels, luminance } from './layout.js';

const ROW_INK = 90; // luminance above which a pixel is text
const SEG_INK = 130; // stricter, to split glyphs
const MAX_GAP = 4; // columns of blank that end a number
const MAX_GLYPH_WIDTH = 8; // wider segments are touching glyphs, and get split
const MAX_GLYPH_ERROR = 60; // mean luminance error; above it, not a glyph we know
const CANDIDATE_SPREAD = 12; // keep alternatives this close to the best match
const CANDIDATES = 3;
const LINE_HEIGHT = 9;

export class AxesUnreadable extends Error {}

const VARIANTS = Object.entries(GLYPHS).flatMap(([ch, list]) => list.map((g) => ({ ch, ...g })));

function hasInk(frame, x, y0, thr) {
  for (let y = y0; y < y0 + LINE_HEIGHT; y += 1) if (luminance(frame, x, y) > thr) return true;
  return false;
}

/** Ink segments on rows [y0, y0+9) from x0, up to the first gap wider than MAX_GAP. */
function segments(frame, y0, x0, x1) {
  const segs = [];
  for (let x = x0; x < x1; ) {
    if (!hasInk(frame, x, y0, SEG_INK)) {
      x += 1;
      continue;
    }
    const s = x;
    while (x < x1 && hasInk(frame, x, y0, SEG_INK)) x += 1;
    if (segs.length && s - segs[segs.length - 1][1] > MAX_GAP) break;
    segs.push([s, x]);
  }
  return segs;
}

/** Mean absolute difference of the glyph at [a, a+w) against a variant, best alignment. */
function distance(frame, y0, a, w, t) {
  const W = Math.max(w, t.w) + 2;
  let best = Infinity;
  for (let og = 0; og <= W - w; og += 1) {
    for (let ot = 0; ot <= W - t.w; ot += 1) {
      let err = 0;
      for (let r = 0; r < LINE_HEIGHT && err < best * LINE_HEIGHT * W; r += 1) {
        for (let x = 0; x < W; x += 1) {
          const gx = x - og;
          const tx = x - ot;
          const g = gx >= 0 && gx < w ? luminance(frame, a + gx, y0 + r) : 0;
          const tv = tx >= 0 && tx < t.w ? t.lum[r * t.w + tx] : 0;
          err += Math.abs(g - tv);
        }
      }
      err /= LINE_HEIGHT * W;
      if (err < best) best = err;
    }
  }
  return best;
}

/** The best few characters for the glyph at [a, a+w): [{ ch, err }], best first. */
function candidates(frame, y0, a, w) {
  const best = new Map();
  for (const v of VARIANTS) {
    const e = distance(frame, y0, a, w, v);
    if (!best.has(v.ch) || e < best.get(v.ch)) best.set(v.ch, e);
  }
  const sorted = [...best.entries()].map(([ch, err]) => ({ ch, err })).sort((p, q) => p.err - q.err);
  const top = sorted[0].err;
  return sorted.filter((c) => c.err <= top + CANDIDATE_SPREAD && c.err <= MAX_GLYPH_ERROR).slice(0, CANDIDATES);
}

/** One candidate list per glyph of the number starting in [x0, x1). */
function glyphCandidates(frame, y0, x0, x1) {
  const out = [];
  for (let [a, b] of segments(frame, y0, x0, x1)) {
    // touching glyphs: peel off the best-matching glyph from the left
    while (b - a > MAX_GLYPH_WIDTH) {
      let best = null;
      for (let w = 3; w <= MAX_GLYPH_WIDTH; w += 1) {
        const c = candidates(frame, y0, a, w);
        if (c.length && (!best || c[0].err < best.c[0].err)) best = { w, c };
      }
      if (!best) return out;
      out.push(best.c);
      a += best.w;
      while (a < b && !hasInk(frame, a, y0, SEG_INK)) a += 1;
    }
    if (b > a) {
      const c = candidates(frame, y0, a, b - a);
      if (!c.length) return out; // a letter (" MHz"): the number has ended
      out.push(c);
    }
  }
  return out;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Every well-formed number the candidates can spell: [{ err, text, value }], best first. */
function readings(cands, limit = 400) {
  const out = [];
  const walk = (i, text, err) => {
    if (out.length >= limit) return;
    if (i === cands.length) {
      if (NUMBER.test(text)) out.push({ err, text, value: Number(text) });
      return;
    }
    for (const c of cands[i]) walk(i + 1, text + c.ch, err + c.err);
  };
  if (cands.length) walk(0, '', 0);
  return out.sort((p, q) => p.err - q.err);
}

/** Top row of the 9-row label band nearest y, or null. */
function snapLabelRow(frame, y, x0, x1) {
  const rowInk = (yy) => {
    for (let x = x0; x < x1; x += 1) if (luminance(frame, x, yy) > ROW_INK) return true;
    return false;
  };
  for (let d = 0; d <= 3; d += 1) {
    for (const y0 of d === 0 ? [y] : [y - d, y + d]) {
      if (rowInk(y0) && rowInk(y0 + LINE_HEIGHT - 1) && !rowInk(y0 - 1)) return y0;
    }
  }
  return null;
}

function decodeLevels(frame, PLOT) {
  const { x0, x1, count } = leftLabels(PLOT);
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    const cy = PLOT.top - 0.5 + (i * (PLOT.bottom - PLOT.top + 0.5)) / (count - 1);
    const y0 = snapLabelRow(frame, Math.round(cy - LINE_HEIGHT / 2), x0, x1);
    const r = y0 === null ? [] : readings(glyphCandidates(frame, y0, x0, x1));
    if (!r.length) throw new AxesUnreadable(`dBm label ${i + 1} of ${count} cannot be read`);
    labels.push(r);
  }
  let best = null;
  for (const top of labels[0].slice(0, 20)) {
    for (const bottom of labels[count - 1].slice(0, 20)) {
      if (!(top.value > bottom.value)) continue;
      const step = (top.value - bottom.value) / (count - 1);
      let err = top.err + bottom.err;
      let ok = true;
      for (let i = 1; i < count - 1 && ok; i += 1) {
        const want = top.value - i * step;
        const fit = labels[i].filter((r) => Math.abs(r.value - want) <= 0.0501);
        if (!fit.length) ok = false;
        else err += fit[0].err;
      }
      if (ok && (!best || err < best.err)) best = { err, top: top.value, bottom: bottom.value };
    }
  }
  if (!best) {
    const seen = labels.map((r) => r[0].text).join(', ');
    throw new AxesUnreadable(`the dBm labels do not read as an even scale (${seen})`);
  }
  return best;
}

function decodeFrequencies(frame, PLOT) {
  const y0 = bottomLabelRow(PLOT);
  const mid = Math.round((PLOT.left + PLOT.right) / 2);
  const read = (x0, x1) => {
    const first = segments(frame, y0, x0, x1)[0];
    return first ? readings(glyphCandidates(frame, y0, first[0], x1)) : [];
  };
  const starts = read(0, PLOT.left + 150);
  const centres = read(mid - 110, mid + 110);
  const stops = read(PLOT.right - 130, Math.min(frame.width, PLOT.right + 45));
  if (!starts.length || !stops.length || !centres.length) {
    throw new AxesUnreadable('the frequency labels cannot be read');
  }
  let best = null;
  for (const s of starts.slice(0, 30)) {
    for (const e of stops.slice(0, 30)) {
      if (!(e.value > s.value)) continue;
      const want = (s.value + e.value) / 2;
      const fit = centres.filter((c) => Math.abs(c.value - want) <= 0.00051);
      if (!fit.length) continue;
      const err = s.err + e.err + fit[0].err;
      if (!best || err < best.err) best = { err, start: s.value, stop: e.value };
    }
  }
  if (!best) {
    throw new AxesUnreadable(
      `the frequency labels do not agree (${starts[0].text} / ${centres[0].text} / ${stops[0].text} MHz)`
    );
  }
  return best;
}

let cache = { key: null, result: null, error: null };

/** A fingerprint of every pixel the labels and plot edges are read from. */
function labelKey(frame, PLOT) {
  const h = createHash('sha1');
  const { data, width } = frame;
  const rows = (y0, y1, x0, x1) => {
    for (let y = y0; y < y1; y += 1) h.update(data.subarray((y * width + x0) * 4, (y * width + x1) * 4));
  };
  const left = leftLabels(PLOT);
  rows(PLOT.top - 10, PLOT.bottom + 10, left.x0, left.x1);
  rows(bottomLabelRow(PLOT), bottomLabelRow(PLOT) + LINE_HEIGHT, 0, width);
  h.update(JSON.stringify(PLOT));
  return h.digest('hex');
}

/**
 * { startHz, stopHz, topDbm, bottomDbm, plot } as shown on the screen, where
 * plot is the plot rectangle (its right edge moves with the Pro's side menu).
 * Throws AxesUnreadable with the reason when there is no plot or the labels
 * cannot be read consistently. Results are cached while the labels' pixels
 * do not change, so calling it on every frame is cheap.
 */
export function readAxes(frame) {
  const PLOT = findPlot(frame);
  if (!PLOT) throw new AxesUnreadable('the analyzer plot is not on the screen');
  const key = labelKey(frame, PLOT);
  if (cache.key === key) {
    if (cache.error) throw cache.error;
    return { ...cache.result, plot: { ...PLOT } };
  }
  try {
    const levels = decodeLevels(frame, PLOT);
    const freqs = decodeFrequencies(frame, PLOT);
    const result = {
      startHz: Math.round(freqs.start * 1e6),
      stopHz: Math.round(freqs.stop * 1e6),
      topDbm: levels.top,
      bottomDbm: levels.bottom,
    };
    cache = { key, result, error: null };
    return { ...result, plot: { ...PLOT } };
  } catch (err) {
    if (err instanceof AxesUnreadable) cache = { key, result: null, error: err };
    throw err;
  }
}

/** The firmware version the Pro shows top left ("RFEPro v1.25"), or null. */
export function readFirmware(frame) {
  const best = readings(glyphCandidates(frame, 10, 76, 110))[0];
  return best && /^\d+\.\d+$/.test(best.text) ? best.text : null;
}

export function sameAxes(a, b) {
  return (
    !!a && !!b &&
    a.startHz === b.startHz &&
    a.stopHz === b.stopHz &&
    Math.abs(a.topDbm - b.topDbm) < 1e-9 &&
    Math.abs(a.bottomDbm - b.bottomDbm) < 1e-9 &&
    a.plot?.right === b.plot?.right
  );
}
