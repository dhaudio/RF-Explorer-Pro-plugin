// Where things are on the RF Explorer Pro's analyzer screen.
//
// Measured on a unit with firmware 1.25 and its 1280x800 screen, in the
// default analyzer layout (plot top left, waterfall below, menu on the right).
// A firmware that moves the plot needs these numbers updated - nothing else.
//
// Frames everywhere in this driver are the VNC framebuffer as received:
// width x height pixels, 4 bytes each, in B, G, R, X order.

export const SCREEN = { width: 1280, height: 800 };

/** The plot's frame lines (inclusive). Left/right are the start/stop
 *  frequencies, top/bottom the top/bottom dBm labels. */
export const PLOT = { left: 55, top: 38, right: 965, bottom: 495 };

/** One trace point per plot column. */
export const COLUMNS = PLOT.right - PLOT.left + 1;

/** The real-time trace is drawn in pure yellow; max-hold (dark red) and the
 *  green fill are deliberately not read. */
export const TRACE_COLORS = [[255, 255, 0]];
export const COLOR_TOLERANCE = 70;

/** Fraction of columns that must contain the trace for a frame to count. */
export const MIN_COVERAGE = 0.6;

/** Masked areas inside the plot: the Pro draws a vertical yellow line on the
 *  last point. [left, top, right, bottom], inclusive. */
export const IGNORE = [[962, 38, 965, 495]];

/** Axis labels. */
export const LABELS = {
  // dBm labels, left of the plot, one per horizontal grid line (11 of them)
  left: { x0: 14, x1: 52, count: 11 },
  // frequency labels, under the plot: start (left), centre, stop (right)
  bottom: { y0: 503, y1: 512, start: [0, 200], centre: [400, 620], stop: [880, 1010] },
};

/** The part of the screen the driver needs: plot plus every axis label. */
export const REGION = { x: 0, y: 28, w: 1010, h: 490 };

export function pixel(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]]; // R, G, B
}

export function luminance(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3;
}
