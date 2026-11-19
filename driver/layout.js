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

/** dBm labels, left of the plot, one per horizontal grid line. */
export const LEFT_LABELS = { x0: 14, x1: 52, count: 11 };
/** Frequency labels, on the first text row under the plot. */
export const BOTTOM_LABEL_ROW = 503;

export function pixel(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]]; // R, G, B
}

export function luminance(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3;
}

/** A pixel of the plot's frame: light grey, or the yellow edge line drawn over it. */
function isFrame(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  const b = frame.data[i];
  const g = frame.data[i + 1];
  const r = frame.data[i + 2];
  const grey = Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && r > 100;
  const yellow = r > 200 && g > 200 && b < 80;
  return grey || yellow;
}

/**
 * The plot rectangle on this frame, or null if there is no analyzer plot.
 * The right edge is the first column, left to right, that is frame-coloured
 * over nearly the whole plot height.
 */
export function findPlot(frame) {
  if (frame.width !== SCREEN.width || frame.height !== SCREEN.height) return null;
  const y0 = PLOT_TOP + 2;
  const y1 = PLOT_BOTTOM - 1;
  const need = 0.9 * (y1 - y0);
  const leftEdge = (x) => {
    let n = 0;
    for (let y = y0; y < y1; y += 1) if (isFrame(frame, x, y)) n += 1;
    return n >= need;
  };
  if (!leftEdge(PLOT_LEFT - 1)) return null; // no frame where the plot starts
  for (let x = PLOT_LEFT + 400; x < frame.width - 10; x += 1) {
    if (leftEdge(x)) return { left: PLOT_LEFT, top: PLOT_TOP, right: x, bottom: PLOT_BOTTOM };
  }
  return null;
}
