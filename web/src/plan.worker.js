import init, { plan, decode_hazards, version } from './pkg/slakk_core.js';

let ready = null;

async function ensure() {
  if (!ready) {
    ready = init().then(() => version());
  }
  return ready;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const v = await ensure();
      self.postMessage({ type: 'ready', version: v });
      return;
    }
    if (msg.type === 'plan') {
      await ensure();
      const {
        width,
        height,
        resolution,
        groundResolution,
        bbox,
        elevations,
        rgba,
        slope,
        steep: steepIn,
        runoutClass: runoutIn,
        pointsLatLon,
        corridorLatLon,
        options,
      } = msg;
      let steep;
      let runout;
      if (steepIn && runoutIn) {
        steep = steepIn;
        runout = runoutIn;
      } else {
        self.postMessage({ type: 'progress', text: 'Decoding NVE palette…' });
        const decoded = decode_hazards(rgba, width, height);
        const bytes = new Uint8Array(decoded);
        const n = width * height;
        steep = bytes.subarray(0, n);
        runout = bytes.subarray(n, n * 2);
      }
      self.postMessage({ type: 'progress', text: 'Searching (Wasm A*)…' });
      const result = plan(
        width,
        height,
        resolution,
        groundResolution,
        bbox[0],
        bbox[1],
        bbox[2],
        bbox[3],
        elevations,
        steep,
        runout,
        slope || new Float32Array(0),
        pointsLatLon,
        corridorLatLon || new Float64Array(0),
        JSON.stringify(options),
      );
      self.postMessage({ type: 'done', result });
      return;
    }
  } catch (err) {
    const text = err?.message || String(err);
    self.postMessage({ type: 'error', error: text });
  }
};
