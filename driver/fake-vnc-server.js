// A VNC server that shows a given screen, for tests: the plugin connects to it
// exactly as it would to an RF Explorer Pro. RFB 3.8, no authentication,
// raw encoding only (all the plugin asks for).

import net from 'node:net';

/**
 * startFakeVnc({ width, height, frame }) where frame() returns the current
 * screen as B, G, R, X bytes. Call `changed()` after the screen changes.
 */
export async function startFakeVnc({ width = 1280, height = 800, frame, password = null } = {}) {
  let version = 0;
  const clients = new Set();

  const server = net.createServer((socket) => {
    const client = { socket, sent: -1, pending: [] };
    clients.add(client);
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'version';
    socket.write('RFB 003.008\n');

    const sendRegion = ({ x, y, w, h }) => {
      const screen = frame();
      const head = Buffer.alloc(4 + 12);
      head[0] = 0;
      head.writeUInt16BE(1, 2);
      head.writeUInt16BE(x, 4);
      head.writeUInt16BE(y, 6);
      head.writeUInt16BE(w, 8);
      head.writeUInt16BE(h, 10);
      head.writeInt32BE(0, 12);
      const px = Buffer.alloc(w * h * 4);
      for (let r = 0; r < h; r += 1) {
        px.set(screen.subarray(((y + r) * width + x) * 4, ((y + r) * width + x + w) * 4), r * w * 4);
      }
      socket.write(Buffer.concat([head, px]));
      client.sent = version;
    };
    client.flush = () => {
      const waiting = client.pending;
      client.pending = [];
      for (const region of waiting) sendRegion(region);
    };

    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'version') {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          socket.write(Buffer.from(password ? [1, 2] : [1, 1]));
          stage = 'security';
        } else if (stage === 'security') {
          if (buf.length < 1) return;
          const chosen = buf[0];
          buf = buf.subarray(1);
          if (chosen === 2) {
            socket.write(Buffer.alloc(16, 7)); // challenge; the reply is not checked
            stage = 'auth';
          } else {
            socket.write(Buffer.from([0, 0, 0, 0]));
            stage = 'init';
          }
        } else if (stage === 'auth') {
          if (buf.length < 16) return;
          buf = buf.subarray(16);
          socket.write(Buffer.from([0, 0, 0, 0]));
          stage = 'init';
        } else if (stage === 'init') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          const name = Buffer.from('RFETABPRO (fake)');
          const si = Buffer.alloc(24);
          si.writeUInt16BE(width, 0);
          si.writeUInt16BE(height, 2);
          si[4] = 32;
          si[5] = 24;
          si[7] = 1;
          si.writeUInt16BE(255, 8);
          si.writeUInt16BE(255, 10);
          si.writeUInt16BE(255, 12);
          si[14] = 16;
          si[15] = 8;
          si.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([si, name]));
          stage = 'messages';
        } else {
          if (buf.length < 1) return;
          const type = buf[0];
          if (type === 0) {
            if (buf.length < 20) return;
            buf = buf.subarray(20);
          } else if (type === 2) {
            if (buf.length < 4) return;
            const n = buf.readUInt16BE(2);
            if (buf.length < 4 + 4 * n) return;
            buf = buf.subarray(4 + 4 * n);
          } else if (type === 3) {
            if (buf.length < 10) return;
            const region = {
              x: buf.readUInt16BE(2),
              y: buf.readUInt16BE(4),
              w: buf.readUInt16BE(6),
              h: buf.readUInt16BE(8),
            };
            const incremental = buf[1] === 1;
            buf = buf.subarray(10);
            if (!incremental || client.sent !== version) sendRegion(region);
            else client.pending.push(region);
          } else if (type === 4) {
            if (buf.length < 8) return;
            buf = buf.subarray(8);
            client.keys = (client.keys ?? 0) + 1; // the plugin must never send these
          } else if (type === 5) {
            if (buf.length < 6) return;
            buf = buf.subarray(6);
            client.pointer = (client.pointer ?? 0) + 1;
          } else {
            socket.destroy();
            return;
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    host: '127.0.0.1',
    port: server.address().port,
    changed() {
      version += 1;
      for (const c of clients) c.flush();
    },
    inputEvents() {
      let n = 0;
      for (const c of clients) n += (c.keys ?? 0) + (c.pointer ?? 0);
      return n;
    },
    dropClients() {
      for (const c of clients) c.socket.destroy();
    },
    async close() {
      for (const c of clients) c.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
