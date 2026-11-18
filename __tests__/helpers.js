// Shared by the tests: the real screenshot as a frame.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** A real RF Explorer Pro screen (firmware 1.25), 469.886-700.086 MHz,
 *  -16.4 to -118.9 dBm, captured over VNC. */
export function realScreen() {
  const rgb = gunzipSync(readFileSync(new URL('./fixtures/rfepro-1280x800.rgb.gz', import.meta.url)));
  const data = new Uint8Array(1280 * 800 * 4);
  for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
    data[q] = rgb[p + 2];
    data[q + 1] = rgb[p + 1];
    data[q + 2] = rgb[p];
  }
  return { width: 1280, height: 800, data };
}
