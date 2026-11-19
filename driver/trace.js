// Screen pixels -> trace in dBm.

import { COLOR_TOLERANCE, IGNORE_LAST_COLUMNS, MIN_COVERAGE, TRACE_COLORS, columnsOf } from './layout.js';

export class TraceNotFound extends Error {}

/**
 * One amplitude per plot column, in dBm. axes.plot is the plot rectangle the
 * axes were read from (driver/axes.js).
 *
 * In each column, the trace pixels are those within COLOR_TOLERANCE of the
 * trace colour. `peak` takes the highest of them: the Pro draws a connected
 * line, so a column also holds part of the segment to its neighbour, and the
 * peak never reads low (on noise it reads a little high). `center` takes the
 * middle of them, closer to the Pro's own single-point markers on noise.
 * Columns with no trace pixel (under a marker line) are interpolated.
 */
export function extractTrace(frame, axes, { detector = 'peak' } = {}) {
  const PLOT = axes.plot;
  const COLUMNS = columnsOf(PLOT);
  const rows = PLOT.bottom - PLOT.top + 1;
  const row = new Float64Array(COLUMNS).fill(NaN);
  const tol2 = COLOR_TOLERANCE * COLOR_TOLERANCE;
  const { width, data } = frame;
  let found = 0;
  for (let c = 0; c < COLUMNS; c += 1) {
    const x = PLOT.left + c;
    if (c >= COLUMNS - IGNORE_LAST_COLUMNS) continue;
    let first = -1;
    let sum = 0;
    let n = 0;
    for (let r = 0; r < rows; r += 1) {
      const y = PLOT.top + r;
      const i = (y * width + x) * 4;
      const R = data[i + 2];
      const G = data[i + 1];
      const B = data[i];
      for (const [cr, cg, cb] of TRACE_COLORS) {
        const d = (R - cr) ** 2 + (G - cg) ** 2 + (B - cb) ** 2;
        if (d <= tol2) {
          if (first < 0) first = r;
          sum += r;
          n += 1;
          break;
        }
      }
    }
    if (n > 0) {
      row[c] = detector === 'center' ? sum / n : first;
      found += 1;
    }
  }
  if (found < MIN_COVERAGE * COLUMNS) {
    throw new TraceNotFound(
      `the trace is visible in only ${Math.round((100 * found) / COLUMNS)}% of the plot`
    );
  }
  interpolateGaps(row);
  const span = axes.topDbm - axes.bottomDbm;
  const out = new Array(COLUMNS);
  for (let c = 0; c < COLUMNS; c += 1) out[c] = axes.topDbm - (row[c] / (rows - 1)) * span;
  return out;
}

function interpolateGaps(v) {
  const n = v.length;
  let prev = -1;
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(v[i])) continue;
    if (prev < 0) for (let k = 0; k < i; k += 1) v[k] = v[i];
    else for (let k = prev + 1; k < i; k += 1) v[k] = v[prev] + ((v[i] - v[prev]) * (k - prev)) / (i - prev);
    prev = i;
  }
  for (let k = prev + 1; k < n; k += 1) v[k] = v[prev];
}

/** Keep `points` values, each the maximum of its share of columns: fewer
 *  points never hide a signal, and more points are never invented. */
export function resamplePeak(amps, points) {
  const n = amps.length;
  if (points >= n) return amps.slice();
  const out = new Array(points);
  for (let k = 0; k < points; k += 1) {
    const a = Math.round((k * n) / points);
    const b = Math.max(Math.round(((k + 1) * n) / points), a + 1);
    let m = -Infinity;
    for (let i = a; i < b; i += 1) if (amps[i] > m) m = amps[i];
    out[k] = m;
  }
  return out;
}

/** Frequency of plot column c. */
export function columnHz(axes, c) {
  return axes.startHz + (c * (axes.stopHz - axes.startHz)) / (columnsOf(axes.plot) - 1);
}
