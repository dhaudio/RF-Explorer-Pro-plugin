// A small VNC (RFB 3.3 / 3.7 / 3.8) client: just enough to watch a screen.
//
// It asks for 32-bit pixels and raw encoding, keeps a copy of the remote
// framebuffer, and lets the caller ask for (incremental) updates of a region.
// It never sends a key press or a mouse event: watching the RF Explorer Pro
// must not touch it.

import net from 'node:net';
import { vncAuthResponse } from './des.js';

const ENC_RAW = 0;
const ENC_DESKTOP_SIZE = -223;
const ENC_LAST_RECT = -224;

export class RfbError extends Error {}

/** Buffers socket data and hands out exact byte counts. */
class Reader {
  constructor(socket) {
    this.chunks = [];
    this.length = 0;
    this.waiter = null;
    this.error = null;
    socket.on('data', (d) => {
      this.chunks.push(d);
      this.length += d.length;
      this.wake();
    });
    const fail = (err) => {
      this.error = err;
      this.wake();
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new RfbError('connection closed')));
  }

  wake() {
    const w = this.waiter;
    if (w && (this.length >= w.n || this.error)) {
      this.waiter = null;
      w.resolve();
    }
  }

  async read(n) {
    if (this.length < n) {
      if (this.error) throw this.error;
      await new Promise((resolve) => {
        this.waiter = { n, resolve };
      });
      if (this.length < n) throw this.error ?? new RfbError('connection closed');
    }
    const buf = Buffer.concat(this.chunks, this.length);
    this.chunks = buf.length > n ? [buf.subarray(n)] : [];
    this.length = buf.length - n;
    return buf.subarray(0, n);
  }
}

export class RfbClient {
  constructor({ host, port = 5900, password = '', timeoutMs = 8_000 } = {}) {
    this.host = host;
    this.port = port;
    this.password = password ?? '';
    this.timeoutMs = timeoutMs;
    this.width = 0;
    this.height = 0;
    this.data = null; // B, G, R, X per pixel
    this.updates = 0; // completed FramebufferUpdate messages
    this.closed = false;
    this.onClose = null; // (err) => void, when the connection dies unprompted
    this.waiters = new Set();
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  async connect() {
    const socket = net.connect({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    this.socket = socket;
    const reader = new Reader(socket);
    this.reader = reader;
    const timer = setTimeout(
      () => socket.destroy(new RfbError(`no answer from the VNC server at ${this.address}`)),
      this.timeoutMs
    );
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      await this.handshake(reader);
    } catch (err) {
      socket.destroy();
      throw err instanceof RfbError ? err : new RfbError(`cannot reach the VNC server at ${this.address}: ${err.code ?? err.message}`);
    } finally {
      clearTimeout(timer);
    }
    socket.on('close', () => {
      const wasOpen = !this.closed;
      this.closed = true;
      for (const w of this.waiters) w();
      if (wasOpen) this.onClose?.(new RfbError(`the VNC connection to ${this.address} was lost`));
    });
    this.loop().catch(() => socket.destroy());
  }

  async handshake(r) {
    const version = (await r.read(12)).toString('latin1');
    const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
    if (!m) throw new RfbError(`${this.address} is not a VNC server`);
    const minor = Number(m[1]) > 3 ? 8 : Math.min(Number(m[2]), 8);
    const use = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
    this.socket.write(`RFB 003.00${use}\n`);

    let security;
    if (use === 3) {
      security = (await r.read(4)).readUInt32BE(0);
      if (security === 0) throw new RfbError(await this.reason(r));
    } else {
      const n = (await r.read(1))[0];
      if (n === 0) throw new RfbError(await this.reason(r));
      const types = [...(await r.read(n))];
      security = types.includes(1) ? 1 : types.includes(2) ? 2 : null;
      if (security === null) {
        throw new RfbError(`the VNC server offers no security type this plugin supports (${types.join(', ')})`);
      }
      this.socket.write(Buffer.from([security]));
    }
    if (security === 2) {
      if (!this.password) {
        throw new RfbError('the VNC server asks for a password: type it in the device settings');
      }
      const challenge = await r.read(16);
      this.socket.write(vncAuthResponse(challenge, this.password));
    }
    if (security === 2 || use === 8) {
      const result = (await r.read(4)).readUInt32BE(0);
      if (result !== 0) {
        const why = use === 8 ? await this.reason(r) : 'authentication failed';
        throw new RfbError(security === 2 ? `VNC password rejected: ${why}` : `VNC refused the connection: ${why}`);
      }
    }

    this.socket.write(Buffer.from([1])); // ClientInit: shared, so other viewers stay connected
    const init = await r.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    const nameLength = init.readUInt32BE(20);
    this.name = (await r.read(nameLength)).toString('utf8');
    this.data = new Uint8Array(this.width * this.height * 4);

    // 32 bits per pixel, little-endian, true colour, red at bit 16: B, G, R, X in memory
    const pf = Buffer.alloc(20);
    pf[0] = 0; // SetPixelFormat
    pf[4] = 32;
    pf[5] = 24;
    pf[6] = 0;
    pf[7] = 1;
    pf.writeUInt16BE(255, 8);
    pf.writeUInt16BE(255, 10);
    pf.writeUInt16BE(255, 12);
    pf[14] = 16;
    pf[15] = 8;
    pf[16] = 0;
    const encodings = [ENC_RAW, ENC_DESKTOP_SIZE, ENC_LAST_RECT];
    const se = Buffer.alloc(4 + 4 * encodings.length);
    se[0] = 2; // SetEncodings
    se.writeUInt16BE(encodings.length, 2);
    encodings.forEach((e, i) => se.writeInt32BE(e, 4 + 4 * i));
    this.socket.write(Buffer.concat([pf, se]));
  }

  async reason(r) {
    const n = (await r.read(4)).readUInt32BE(0);
    return (await r.read(n)).toString('utf8');
  }

  async loop() {
    const r = this.reader;
    for (;;) {
      const type = (await r.read(1))[0];
      if (type === 0) {
        const head = await r.read(3);
        const rects = head.readUInt16BE(1);
        for (let i = 0; i < rects; i += 1) {
          const h = await r.read(12);
          const x = h.readUInt16BE(0);
          const y = h.readUInt16BE(2);
          const w = h.readUInt16BE(4);
          const ht = h.readUInt16BE(6);
          const enc = h.readInt32BE(8);
          if (enc === ENC_RAW) {
            const px = await r.read(w * ht * 4);
            for (let row = 0; row < ht; row += 1) {
              this.data.set(px.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.width + x) * 4);
            }
          } else if (enc === ENC_DESKTOP_SIZE) {
            this.width = w;
            this.height = ht;
            this.data = new Uint8Array(w * ht * 4);
          } else if (enc === ENC_LAST_RECT) {
            break;
          } else {
            throw new RfbError(`unexpected VNC encoding ${enc}`);
          }
        }
        this.updates += 1;
        for (const w of this.waiters) w();
      } else if (type === 1) {
        const head = await r.read(5);
        await r.read(head.readUInt16BE(3) * 6); // colour map: unused at 32 bpp
      } else if (type === 2) {
        // bell
      } else if (type === 3) {
        const head = await r.read(7);
        await r.read(head.readUInt32BE(3)); // clipboard text: ignored
      } else {
        throw new RfbError(`unexpected VNC message ${type}`);
      }
    }
  }

  /**
   * Ask for an update of a region and wait for the next one to arrive.
   * Resolves true when an update came in, false after timeoutMs. With
   * incremental, the server answers only once something in the region changes.
   */
  async update({ x = 0, y = 0, w = this.width, h = this.height, incremental = true, timeoutMs = 3_000 } = {}) {
    if (this.closed) throw new RfbError(`the VNC connection to ${this.address} is closed`);
    const before = this.updates;
    const req = Buffer.alloc(10);
    req[0] = 3; // FramebufferUpdateRequest
    req[1] = incremental ? 1 : 0;
    req.writeUInt16BE(x, 2);
    req.writeUInt16BE(y, 4);
    req.writeUInt16BE(Math.min(w, this.width - x), 6);
    req.writeUInt16BE(Math.min(h, this.height - y), 8);
    this.socket.write(req);
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        if (this.updates === before && !this.closed) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.updates !== before);
      };
      timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(done);
    });
  }

  frame() {
    return { width: this.width, height: this.height, data: this.data };
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }
}
