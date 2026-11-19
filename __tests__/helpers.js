// Shared by the tests: the real screenshot as a frame.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

function load(name) {
  const rgb = gunzipSync(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  const data = new Uint8Array(1280 * 800 * 4);
  for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
    data[q] = rgb[p + 2];
    data[q + 1] = rgb[p + 1];
    data[q + 2] = rgb[p];
  }
  return { width: 1280, height: 800, data };
}

/** A real RF Explorer Pro screen (firmware 1.25), captured over VNC, with the
 *  side menu shown: 469.886-700.086 MHz, -16.4 to -118.9 dBm, 911 columns. */
export const realScreen = () => load('rfepro-1280x800.rgb.gz');

/** The same unit with the side menu hidden, as used in the field:
 *  469.811-900.011 MHz, -16.4 to -118.9 dBm, 1181 columns. */
export const realScreenWide = () => load('rfepro-1280x800-wide.rgb.gz');
