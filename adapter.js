// RF Explorer Pro (RF Venue), as a SoundBase spectrum analyzer.
//
// The RF Explorer Pro offers no data interface to other software: its one
// remote interface is VNC, which shows its screen. So this plugin watches the
// screen over VNC (read-only: it never clicks or types) and turns what the
// Pro draws into the live trace:
//
//   - driver/axes.js reads the axis labels, so the frequency range and dBm
//     scale come from the Pro itself, with nothing typed in;
//   - driver/trace.js reads the yellow real-time trace, one point per column
//     of the plot (911 points across whatever span the Pro shows);
//   - a change of range on the Pro is noticed and the device reconnects with
//     the new range.
//
// The span, RBW and reference level are set on the Pro. SoundBase can show
// any part of the span the Pro displays; asking for more is clamped to it.

import { AxesUnreadable, readAxes, readFirmware, sameAxes } from './driver/axes.js';
import { columnsOf, findPlot } from './driver/layout.js';
import { SimulatedScreenSource, VncScreenSource } from './driver/sources.js';
import { TraceNotFound, columnHz, extractTrace, resamplePeak } from './driver/trace.js';

// MUST be a deviceTypeId declared in soundbase-plugin.json; a test checks it.
export const PRODUCT = 'plugin:rf-explorer-pro/rfepro';
export const SIMULATED_DEVICE_ID = 'sim:rfepro';

/** Frames without a readable trace or axes before a warning is shown. */
const BAD_FRAMES_BEFORE_WARNING = 3;
/** No new picture for this long while sweeping: the Pro is paused. Slow
 *  sweeps (wide span, narrow RBW) get more time: four sweep times at least. */
const FROZEN_SWEEPS = 4;
const frozenMs = () => Number(process.env.SB_RFEPRO_FROZEN_MS) || 10_000;
/** The layout in driver/layout.js was measured on this firmware. */
const TESTED_FIRMWARE = '1.25';
const simFrameMs = () => Number(process.env.SB_RFEPRO_SIM_FRAME_MS) || 1_400;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MHZ = (hz) => (hz / 1e6).toFixed(3);
const logLine = (level, message) =>
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
const envFlag = (name) => /^(1|true|yes)$/i.test(process.env[name] ?? '');

/**
 * The simulated Pro, when the plugin setting asks for it. Real units are added
 * by IP address: a Pro does not announce itself on the network.
 */
export async function discoverDevices(pluginConfig = {}) {
  if (pluginConfig.simulate === true || envFlag('SB_RFEPRO_MOCK')) {
    return [
      {
        id: SIMULATED_DEVICE_ID,
        name: 'Simulated RF Explorer Pro',
        product: PRODUCT,
        transport: { kind: 'network', host: 'simulated' },
      },
    ];
  }
  return [];
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig = {}) {
  return new RfExplorerProAdapter(device, pluginConfig);
}

/** Manual axis values typed into the controls take precedence over the
 *  screen. The plot rectangle always comes from the screen. */
function withOverrides(screenAxes, controls = {}, plot = null) {
  const pick = (id) => (isNum(controls[id]) ? controls[id] : null);
  const manual = {
    startHz: pick('axisStartMHz') === null ? null : Math.round(pick('axisStartMHz') * 1e6),
    stopHz: pick('axisStopMHz') === null ? null : Math.round(pick('axisStopMHz') * 1e6),
    topDbm: pick('axisTopDbm'),
    bottomDbm: pick('axisBottomDbm'),
  };
  const merged = {};
  for (const k of ['startHz', 'stopHz', 'topDbm', 'bottomDbm']) {
    merged[k] = manual[k] ?? screenAxes?.[k] ?? null;
  }
  if (Object.values(merged).some((v) => v === null)) return null;
  if (!(merged.stopHz > merged.startHz) || !(merged.topDbm > merged.bottomDbm)) return null;
  merged.plot = screenAxes?.plot ?? plot;
  return merged.plot ? merged : null;
}

class RfExplorerProAdapter {
  constructor(device, pluginConfig) {
    this.device = device;
    this.pluginConfig = pluginConfig;
    this.source = null;
    this.screenAxes = null; // what the Pro's labels say
    this.plot = null; // the plot rectangle on the Pro's screen
    this.controls = {};
    this.axes = null; // in force: screen labels plus any manual values
    this.effective = null; // { startHz, stopHz, pointCount, first, last }
    this.sweeping = false;
    this.warnings = new Map();
    this.sweepMs = null;
    this.generation = 0; // bumped on every start/stop, so an old sweep loop never outlives its session
    // assigned by the shell: onFatal, onWarnings
  }

  // -------------------------------------------------------------- warnings
  setWarning(id, severity, message) {
    const prev = this.warnings.get(id);
    if (prev && prev.message === message && prev.severity === severity) return;
    this.warnings.set(id, { id, severity, message });
    this.onWarnings?.([...this.warnings.values()]);
  }

  clearWarning(id) {
    if (this.warnings.delete(id)) this.onWarnings?.([...this.warnings.values()]);
  }

  // ------------------------------------------------------------------ open
  async open() {
    if (this.device.id === SIMULATED_DEVICE_ID) {
      this.source = new SimulatedScreenSource({ frameMs: simFrameMs() });
    } else {
      const config = this.device.config ?? {};
      const host = String(config.host ?? '').trim();
      if (!host) throw new Error('Set the IP address of the RF Explorer Pro.');
      this.source = new VncScreenSource({
        host,
        port: Number(config.port) || 5900,
        password: config.password ?? '',
      });
    }
    let frame;
    try {
      frame = await this.source.open();
    } catch (err) {
      this.source = null;
      throw new Error(
        `Cannot see the RF Explorer Pro's screen at ${this.device.config?.host ?? 'simulated'}: ${err.message}. ` +
          'Check that it is on, connected to this network, and that its IP address is right.'
      );
    }
    this.source.onClose = (err) => {
      if (this.source) this.onFatal?.(err);
    };
    this.firmware = readFirmware(frame);
    if (this.firmware && this.firmware !== TESTED_FIRMWARE) {
      logLine('warn', `firmware ${this.firmware}: the screen layout was measured on ${TESTED_FIRMWARE}`);
    }

    this.plot = findPlot(frame);
    try {
      this.screenAxes = readAxes(frame);
    } catch (err) {
      if (!(err instanceof AxesUnreadable)) throw err;
      this.screenAxes = null;
      logLine('warn', `axis labels unreadable at open: ${err.message}`);
    }
    this.axes = withOverrides(this.screenAxes, this.controls, this.plot);
    if (this.axes) {
      logLine('info', `${this.source.address}: ${MHZ(this.axes.startHz)}-${MHZ(this.axes.stopHz)} MHz, ` +
        `${this.axes.topDbm} to ${this.axes.bottomDbm} dBm`);
      this.clearWarning('axes');
    } else {
      this.setWarning('axes', 'critical', unreadableMessage());
    }

    const lo = this.axes?.startHz ?? 100_000;
    const hi = this.axes?.stopHz ?? 6_100_000_000;
    return {
      capabilities: {
        minFrequencyHz: lo,
        maxFrequencyHz: hi,
        controls: [
          {
            id: 'detector', type: 'dropdown', label: 'Screen detector', default: 'peak',
            choices: [{ id: 'peak', label: 'Peak' }, { id: 'center', label: 'Center of line' }],
            help:
              'How each column of the Pro\'s plot becomes one point. **Peak** takes the top of the ' +
              'yellow line: no signal is ever missed, and on noise it reads a few dB above the ' +
              'Pro\'s markers. **Center of line** is closer to the markers on noise but can take ' +
              'about 2 dB off peaks.',
          },
          ...['axisStartMHz', 'axisStopMHz', 'axisTopDbm', 'axisBottomDbm'].map((id) => ({
            id,
            type: 'number',
            label: {
              axisStartMHz: 'Pro start (manual)', axisStopMHz: 'Pro stop (manual)',
              axisTopDbm: 'Pro top level (manual)', axisBottomDbm: 'Pro bottom level (manual)',
            }[id],
            unit: id.endsWith('MHz') ? 'MHz' : 'dBm',
            default: null,
            help:
              'Leave empty: the plugin reads it from the Pro\'s screen. Fill it in only if the ' +
              'plugin says it cannot read the axis labels, with the number shown on the Pro.',
          })),
        ],
      },
      identity: {
        manufacturer: 'RF Explorer',
        model: 'RF Explorer Pro',
        firmware: this.firmware ?? 'unknown',
      },
    };
  }

  // ----------------------------------------------------------- applyConfig
  async applyConfig(cfg = {}) {
    // the range may have been changed on the Pro since open(): look again
    if (this.source && !this.sweeping) {
      await this.source.refresh();
      const frame = this.source.frame();
      let now = null;
      try {
        now = readAxes(frame);
      } catch (err) {
        if (!(err instanceof AxesUnreadable)) throw err;
      }
      const plotNow = now?.plot ?? findPlot(frame);
      if (now && !this.screenAxes && this.adoptAxes(now)) {
        // unreadable at open, readable now: take them, no reconnect needed
      }
      const changed =
        (now && !sameAxes(now, this.screenAxes)) ||
        (plotNow && this.plot && plotNow.right !== this.plot.right);
      if (changed) {
        const err = changeError(now, plotNow);
        this.onFatal?.(err);
        throw err;
      }
      if (!this.plot && plotNow) this.plot = plotNow;
    }
    this.controls = { ...(cfg.controls ?? {}) };
    this.detector = this.controls.detector === 'center' ? 'center' : 'peak';
    this.axes = withOverrides(this.screenAxes, this.controls, this.plot);
    if (!this.axes) {
      this.setWarning('axes', 'critical', unreadableMessage());
      throw new Error(unreadableMessage());
    }
    this.clearWarning('axes');
    const ax = this.axes;
    const COLUMNS = columnsOf(ax.plot);
    const step = (ax.stopHz - ax.startHz) / (COLUMNS - 1);

    // the part of the Pro's span asked for, snapped to whole plot columns
    const wantStart = isNum(cfg.startHz) ? cfg.startHz : ax.startHz;
    const wantStop = isNum(cfg.stopHz) ? cfg.stopHz : ax.stopHz;
    let first = Math.ceil((Math.max(wantStart, ax.startHz) - ax.startHz) / step - 1e-6);
    let last = Math.floor((Math.min(wantStop, ax.stopHz) - ax.startHz) / step + 1e-6);
    first = Math.min(Math.max(first, 0), COLUMNS - 2);
    last = Math.min(Math.max(last, first + 1), COLUMNS - 1);
    const columns = last - first + 1;

    let points = columns;
    if (isNum(cfg.pointCount)) points = Math.round(cfg.pointCount);
    else if (isNum(cfg.stepHz) && cfg.stepHz > 0) points = Math.round((wantStop - wantStart) / cfg.stepHz) + 1;
    points = Math.min(Math.max(points, 2), columns); // never more points than the screen has

    this.effective = {
      startHz: Math.round(columnHz(ax, first)),
      stopHz: Math.round(columnHz(ax, last)),
      pointCount: points,
      first,
      last,
    };
    return {
      startHz: this.effective.startHz,
      stopHz: this.effective.stopHz,
      pointCount: points,
      controls: { ...this.controls, detector: this.detector },
      resolved: { sweepTimeMs: Math.round(this.sweepMs ?? 1_500) },
    };
  }

  // ------------------------------------------------------------- sweeping
  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    const generation = ++this.generation;
    const source = this.source;
    const current = () => this.sweeping && this.generation === generation && this.source === source;
    (async () => {
      let lastChange = Date.now();
      let badAxes = 0;
      let badTrace = 0;
      let pendingAxes = null;
      let pendingPlot = null;
      while (current()) {
        let changed;
        try {
          changed = await source.next(2_000);
        } catch (err) {
          if (current()) this.onFatal?.(err);
          return;
        }
        if (!current()) return;
        const now = Date.now();
        if (!changed) {
          if (now - lastChange > Math.max(frozenMs(), FROZEN_SWEEPS * (this.sweepMs ?? 0))) {
            this.setWarning('frozen', 'critical',
              'The RF Explorer Pro\'s screen has not changed for a while, so the trace is not live. ' +
              'Press LIVE on the Pro if it is on Hold or replaying, and keep it on the analyzer screen.');
          }
          continue;
        }
        this.sweepMs = this.sweepMs === null ? now - lastChange : 0.8 * this.sweepMs + 0.2 * (now - lastChange);
        lastChange = now;
        this.clearWarning('frozen');
        const frame = source.frame();

        // the range on the Pro: has it changed?
        let seen = null;
        try {
          seen = readAxes(frame);
          badAxes = 0;
          this.clearWarning('screen');
        } catch (err) {
          if (!(err instanceof AxesUnreadable)) throw err;
          badAxes += 1;
          if (badAxes >= BAD_FRAMES_BEFORE_WARNING && !this.axesFullyManual()) {
            this.setWarning('screen', 'warning',
              'The RF Explorer Pro is not showing its analyzer screen, so the trace is paused. ' +
              'Close any menu or dialog on the Pro.');
          }
        }
        const plotNow = seen?.plot ?? findPlot(frame);
        if (!seen && plotNow && this.plot && plotNow.right !== this.plot.right) {
          // the side menu was shown or hidden: the plot has another width
          if (pendingPlot === plotNow.right) {
            this.onFatal?.(changeError(null, plotNow));
            return;
          }
          pendingPlot = plotNow.right;
          continue;
        }
        pendingPlot = null;
        if (seen && !this.screenAxes && this.adoptAxes(seen)) {
          // the labels were unreadable until now: take them without reconnecting
          this.clearWarning('axes');
        }
        if (seen && !sameAxes(seen, this.screenAxes)) {
          // two frames in a row, so a label caught mid-redraw is not taken for a change
          if (pendingAxes && sameAxes(seen, pendingAxes)) {
            this.screenAxes = seen;
            if (!this.axesFullyManual()) {
              logLine('info', `range changed on the Pro: ${MHZ(seen.startHz)}-${MHZ(seen.stopHz)} MHz`);
              this.onFatal?.(changeError(seen, seen.plot));
              return;
            }
          }
          pendingAxes = seen;
          continue;
        }
        pendingAxes = null;
        if (!seen && !this.axesFullyManual()) continue;

        let amps;
        try {
          amps = extractTrace(frame, this.axes, { detector: this.detector });
          badTrace = 0;
          this.clearWarning('trace');
        } catch (err) {
          if (!(err instanceof TraceNotFound)) throw err;
          badTrace += 1;
          if (badTrace >= BAD_FRAMES_BEFORE_WARNING) {
            this.setWarning('trace', 'warning',
              `The yellow real-time trace cannot be found on the Pro's screen (${err.message}). ` +
              'Keep the real-time trace visible on the Pro.');
          }
          continue;
        }
        const eff = this.effective;
        const part = amps.slice(eff.first, eff.last + 1);
        onTrace(resamplePeak(part, eff.pointCount));
      }
    })().catch((err) => {
      if (current()) this.onFatal?.(err);
    });
  }

  /**
   * Take axes read for the first time since open(). Allowed only when the
   * plot has the width it had at open (so the point count the shell knows
   * stays right); otherwise the device has to reopen.
   */
  adoptAxes(axes) {
    if (this.plot && axes.plot.right !== this.plot.right) return false;
    this.screenAxes = axes;
    this.plot = axes.plot;
    logLine('info', `axis labels read: ${MHZ(axes.startHz)}-${MHZ(axes.stopHz)} MHz, ` +
      `${axes.topDbm} to ${axes.bottomDbm} dBm`);
    return true;
  }

  axesFullyManual() {
    const c = this.controls;
    return ['axisStartMHz', 'axisStopMHz', 'axisTopDbm', 'axisBottomDbm'].every((id) => isNum(c[id]));
  }

  async stopSweep() {
    this.sweeping = false;
    this.generation += 1;
  }

  async close() {
    this.sweeping = false;
    this.generation += 1;
    const source = this.source;
    this.source = null;
    source?.close();
  }
}

/** The error that makes SoundBase reopen the device after the Pro's screen changed. */
function changeError(axes, plot) {
  const what = axes
    ? `now shows ${MHZ(axes.startHz)}-${MHZ(axes.stopHz)} MHz`
    : 'shows its plot at another width (side menu shown or hidden)';
  const points = plot ? `, ${columnsOf(plot)} points` : '';
  return new Error(`The RF Explorer Pro ${what}${points}. Reconnecting to use it.`);
}

function unreadableMessage() {
  return (
    'The plugin cannot read the frequency and level labels on the RF Explorer Pro\'s screen. ' +
    'Put the Pro on its spectrum analyzer screen (LIVE, no menu open). If it still fails, type ' +
    'the four axis values shown on the Pro into the "manual" controls.'
  );
}

// Exported for the tests.
export const _internals = { withOverrides };
