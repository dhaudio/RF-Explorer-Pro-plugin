// Where screens come from: a real RF Explorer Pro over VNC, or the simulator.
// Both hand out frames in the same form and say when the plot has changed.

import { createHash } from 'node:crypto';
import { RfbClient, RfbError } from './rfb.js';
import { PLOT_BOTTOM, PLOT_LEFT, PLOT_TOP, SCREEN } from './layout.js';
import { renderScreen, simulatedSpectrum } from './simulated-screen.js';

/** Least time between two screen requests: the Pro is a tablet, and the plot
 *  is never redrawn faster than this anyway. */
const MIN_REQUEST_INTERVAL_MS = 200;
/** On connecting: the picture counts as complete after this long with no update. */
const SETTLE_QUIET_MS = 300;
const SETTLE_MAX_MS = 2_000;

export class VncScreenSource {
  constructor({ host, port = 5900, password = '' }) {
    this.client = new RfbClient({ host, port, password });
    this.onClose = null;
    this.lastRequest = 0;
  }

  get address() {
    return this.client.address;
  }

  async open() {
    this.client.onClose = (err) => this.onClose?.(err);
    await this.client.connect();
    const { width, height } = this.client;
    if (width !== SCREEN.width || height !== SCREEN.height) {
      this.client.close();
      throw new RfbError(
        `the screen at ${this.address} is ${width}x${height}; an RF Explorer Pro's is ` +
          `${SCREEN.width}x${SCREEN.height}. Is this the right IP address?`
      );
    }
    const got = await this.client.update({ incremental: false, timeoutMs: 8_000 });
    if (!got) throw new RfbError(`the VNC server at ${this.address} sent no picture`);
    // Some servers deliver a full screen across several updates. Keep taking
    // them until the picture settles, so nothing is read off a half screen.
    const settleBy = Date.now() + SETTLE_MAX_MS;
    while (Date.now() < settleBy) {
      const more = await this.client.update({ incremental: true, timeoutMs: SETTLE_QUIET_MS });
      if (this.client.closed) throw new RfbError(`the VNC connection to ${this.address} was lost`);
      if (!more) break;
    }
    return this.client.frame();
  }

  /** A fingerprint of the plot area (as wide as it can be), to tell a new
   *  sweep from other screen changes. */
  plotHash() {
    const { data, width } = this.client.frame();
    const h = createHash('sha1');
    for (let y = PLOT_TOP; y <= PLOT_BOTTOM; y += 1) {
      h.update(data.subarray((y * width + PLOT_LEFT) * 4, (y + 1) * width * 4));
    }
    return h.digest('hex');
  }

  /**
   * Wait for the plot to change; true if it did within timeoutMs.
   * Asks for incremental updates of the whole screen: some VNC servers never
   * answer a request for a part of it.
   */
  async next(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    this.lastHash ??= this.plotHash();
    for (;;) {
      const pause = this.lastRequest + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      const left = deadline - Date.now();
      if (left <= 0) return false;
      this.lastRequest = Date.now();
      await this.client.update({ incremental: true, timeoutMs: left });
      if (this.client.closed) throw new RfbError(`the VNC connection to ${this.address} was lost`);
      const h = this.plotHash();
      if (h !== this.lastHash) {
        this.lastHash = h;
        return true;
      }
    }
  }

  /** Fetch the current picture of the region now, changed or not. */
  async refresh() {
    await this.client.update({ incremental: false, timeoutMs: 3_000 });
    if (this.client.closed) throw new RfbError(`the VNC connection to ${this.address} was lost`);
  }

  frame() {
    return this.client.frame();
  }

  close() {
    this.client.onClose = null;
    this.client.close();
  }
}

export const SIMULATED_AXES = { startHz: 469_843_000, stopHz: 900_043_000, topDbm: -16.4, bottomDbm: -118.9 };

export class SimulatedScreenSource {
  constructor({ frameMs = 1_400, axes = SIMULATED_AXES } = {}) {
    this.frameMs = frameMs;
    this.axes = { ...axes };
    this.data = new Uint8Array(SCREEN.width * SCREEN.height * 4);
    this.t = 0;
    this.tick = 0;
    this.waiters = new Set();
    this.onClose = null;
  }

  get address() {
    return 'simulated';
  }

  draw() {
    renderScreen(this.axes, simulatedSpectrum(this.axes, this.t), this.data);
  }

  async open() {
    this.draw();
    this.timer = setInterval(() => {
      this.t += this.frameMs / 1000;
      this.draw();
      this.tick += 1;
      for (const w of this.waiters) w();
    }, this.frameMs);
    this.timer.unref?.();
    return this.frame();
  }

  /** Change what the simulated Pro shows, as a user would on its screen. */
  setAxes(axes) {
    this.axes = { ...this.axes, ...axes };
  }

  async refresh() {}

  async next(timeoutMs) {
    const before = this.tick;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.tick !== before);
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  frame() {
    return { width: SCREEN.width, height: SCREEN.height, data: this.data };
  }

  close() {
    clearInterval(this.timer);
    for (const w of this.waiters) w();
  }
}
