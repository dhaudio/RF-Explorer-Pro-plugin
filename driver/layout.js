// Where things are on the RF Explorer Pro's analyzer screen.
//
// Measured on a unit with firmware 1.25 and its 1280x800 screen. The plot's
// left, top and bottom edges are fixed; its right edge is not: with the menu
// and marker list shown on the right the plot ends at x=965 (911 columns),
// with them hidden it runs to x=1235 (1181 columns). findPlot() finds it on
// every frame.
//
// Frames everywhere in this driver are the VNC framebuffer as received:
// width x height pixels, 4 bytes each, in B, G, R, X order.

export const SCREEN = { width: 1280, height: 800 };

/** The fixed edges of the plot's frame (inclusive). Left/right are the
 *  start/stop frequencies, top/bottom the top/bottom dBm labels. */
export const PLOT_LEFT = 55;
export const PLOT_TOP = 38;
export const PLOT_BOTTOM = 495;

/** Plot geometries seen on firmware 1.25, for the simulator and the tests. */
export const PLOT_WITH_MENU = { left: PLOT_LEFT, top: PLOT_TOP, right: 965, bottom: PLOT_BOTTOM };
export const PLOT_FULL_WIDTH = { left: PLOT_LEFT, top: PLOT_TOP, right: 1235, bottom: PLOT_BOTTOM };

export const columnsOf = (plot) => plot.right - plot.left + 1;

/** The real-time trace is drawn in pure yellow; max-hold (dark red) and the
 *  green fill are deliberately not read. */
export const TRACE_COLORS = [[255, 255, 0]];
export const COLOR_TOLERANCE = 70;

/** Fraction of columns that must contain the trace for a frame to count. */
export const MIN_COVERAGE = 0.6;

/** The Pro draws a vertical yellow line on the last point: these last
 *  columns of the plot are not read (they are interpolated). */
export const IGNORE_LAST_COLUMNS = 4;


export function pixel(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]]; // R, G, B
}

export function luminance(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3;
}

/** A pixel of the plot's frame: grey, or the yellow edge line drawn over it. */
function isFrame(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  const b = frame.data[i];
  const g = frame.data[i + 1];
  const r = frame.data[i + 2];
  const grey = Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 90;
  const yellow = r > 200 && g > 200 && b < 80;
  return grey || yellow;
}

/** Fraction of frame pixels on column x over rows [y0, y1). */
function columnCover(frame, x, y0, y1) {
  let n = 0;
  for (let y = y0; y < y1; y += 1) if (isFrame(frame, x, y)) n += 1;
  return n / (y1 - y0);
}

/** Fraction of frame pixels on row y over columns [x0, x1); bright: only light ones. */
function rowCover(frame, y, x0, x1, bright = false) {
  let n = 0;
  for (let x = x0; x < x1; x += 1) {
    if (!isFrame(frame, x, y)) continue;
    if (bright && luminance(frame, x, y) < 200) continue;
    n += 1;
  }
  return n / (x1 - x0);
}

const LINE = 0.75; // a frame line covers at least this much of its side

/**
 * The plot rectangle on this frame, or null if there is no analyzer plot.
 *
 * Every edge is found, not assumed, so a firmware that moves the plot a few
 * pixels still works. What tells the frame from the grid (measured on real
 * screens): the frame's side and top lines are two pixels thick where grid
 * lines are one, and its bottom line is much lighter (~229) than the grid
 * (~140). Conventions match firmware 1.25: left/top are the first pixel
 * inside the frame line, right/bottom are the frame line itself.
 */
export function findPlot(frame) {
  if (frame.width !== SCREEN.width || frame.height !== SCREEN.height) return null;
  const band = [150, 400]; // a middle band any plot covers
  const doubleColumn = (x) =>
    columnCover(frame, x, band[0], band[1]) >= LINE && columnCover(frame, x + 1, band[0], band[1]) >= LINE;
  let leftLine = -1;
  for (let x = 20; x < 120 && leftLine < 0; x += 1) if (doubleColumn(x)) leftLine = x;
  if (leftLine < 0) return null;
  let right = -1;
  for (let x = leftLine + 400; x < frame.width - 10 && right < 0; x += 1) if (doubleColumn(x)) right = x;
  if (right < 0) return null;

  const xs = [leftLine + 3, right - 6];
  let topLine = -1;
  for (let y = 10; y < 140 && topLine < 0; y += 1) {
    if (rowCover(frame, y, xs[0], xs[1]) >= LINE && rowCover(frame, y + 1, xs[0], xs[1]) >= LINE) topLine = y;
  }
  if (topLine < 0) return null;
  const top = topLine + 1;
  let bottom = -1;
  for (let y = top + 200; y < 600 && bottom < 0; y += 1) {
    if (rowCover(frame, y, xs[0], xs[1], true) >= 0.9) bottom = y;
  }
  if (bottom < 0) return null;
  return { left: leftLine + 1, top, right, bottom };
}

/**
 * When the frame cannot be found (manual axis values in use), the plot's
 * likely rectangle from where the yellow trace is drawn: the full-width
 * layout if there is trace right of the side-menu layout's edge.
 */
export function guessPlot(frame) {
  if (frame.width !== SCREEN.width || frame.height !== SCREEN.height) return null;
  let yellowBeyond = 0;
  for (let x = PLOT_WITH_MENU.right + 20; x < PLOT_FULL_WIDTH.right - 5; x += 1) {
    for (let y = PLOT_TOP; y < PLOT_BOTTOM; y += 1) {
      const i = (y * frame.width + x) * 4;
      if (frame.data[i + 2] > 200 && frame.data[i + 1] > 200 && frame.data[i] < 80) {
        yellowBeyond += 1;
        break;
      }
    }
  }
  return { ...(yellowBeyond > 50 ? PLOT_FULL_WIDTH : PLOT_WITH_MENU) };
}

/** Where the dBm labels sit: right-aligned just left of the plot. */
export const leftLabels = (plot) => ({ x0: Math.max(0, plot.left - 41), x1: plot.left - 3, count: 11 });
/** The first text row under the plot, with the frequency labels. */
export const bottomLabelRow = (plot) => plot.bottom + 8;
