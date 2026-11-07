/**
 * WebGPU raster prep (slope + binary dilate). No COEP required.
 * Falls back to CPU TypedArray loops when GPU is unavailable.
 */

let gpuDevice = null;
let gpuTried = false;

export async function getGpuDevice() {
  if (gpuTried) return gpuDevice;
  gpuTried = true;
  try {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    gpuDevice = await adapter.requestDevice();
    gpuDevice.lost.then(() => {
      gpuDevice = null;
      gpuTried = false;
    });
    return gpuDevice;
  } catch {
    gpuDevice = null;
    return null;
  }
}

export function cpuSlope(elevations, width, height, gs, invalid) {
  const out = new Float32Array(width * height);
  const z = (r, c) => {
    const i = r * width + c;
    if (invalid && invalid[i]) return 0;
    const v = elevations[i];
    return Number.isFinite(v) ? v : 0;
  };
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      let dzdy;
      if (r === 0) dzdy = (z(1, c) - z(0, c)) / gs;
      else if (r === height - 1) dzdy = (z(height - 1, c) - z(height - 2, c)) / gs;
      else dzdy = (z(r + 1, c) - z(r - 1, c)) / (2 * gs);
      let dzdx;
      if (c === 0) dzdx = (z(r, 1) - z(r, 0)) / gs;
      else if (c === width - 1) dzdx = (z(r, width - 1) - z(r, width - 2)) / gs;
      else dzdx = (z(r, c + 1) - z(r, c - 1)) / (2 * gs);
      out[r * width + c] = (Math.atan(Math.hypot(dzdy, dzdx)) * 180) / Math.PI;
    }
  }
  return out;
}

export function cpuDilateU8(mask, width, height, radius) {
  let cur = mask.slice();
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(cur.length);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        let any = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < height && cc < width && cur[rr * width + cc]) {
              any = 1;
            }
          }
        }
        next[r * width + c] = any;
      }
    }
    cur = next;
  }
  return cur;
}

export function cpuDilateMaxU8(values, width, height, radius) {
  let cur = values.slice();
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(cur.length);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        let m = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < height && cc < width) {
              m = Math.max(m, cur[rr * width + cc]);
            }
          }
        }
        next[r * width + c] = m;
      }
    }
    cur = next;
  }
  return cur;
}

const SLOPE_WGSL = `
struct Params { width: u32, height: u32, gs: f32, _pad: f32 }
@group(0) @binding(0) var<storage, read> elev: array<f32>;
@group(0) @binding(1) var<storage, read_write> slope_out: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

fn sample(rr: u32, cc: u32, w: u32) -> f32 {
  let v = elev[rr * w + cc];
  if (v == v && v > -100.0 && v < 3000.0) { return v; }
  return 0.0;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  let r = gid.y;
  if (c >= params.width || r >= params.height) { return; }
  let w = params.width;
  let h = params.height;
  let gs = params.gs;
  var dzdy: f32;
  if (r == 0u) { dzdy = (sample(1u, c, w) - sample(0u, c, w)) / gs; }
  else if (r + 1u == h) { dzdy = (sample(h - 1u, c, w) - sample(h - 2u, c, w)) / gs; }
  else { dzdy = (sample(r + 1u, c, w) - sample(r - 1u, c, w)) / (2.0 * gs); }
  var dzdx: f32;
  if (c == 0u) { dzdx = (sample(r, 1u, w) - sample(r, 0u, w)) / gs; }
  else if (c + 1u == w) { dzdx = (sample(r, w - 1u, w) - sample(r, w - 2u, w)) / gs; }
  else { dzdx = (sample(r, c + 1u, w) - sample(r, c - 1u, w)) / (2.0 * gs); }
  slope_out[r * w + c] = atan(sqrt(dzdy * dzdy + dzdx * dzdx)) * 57.2957795;
}
`;

/** Compute slope degrees; returns { slope, backend: 'webgpu'|'cpu' }. */
export async function computeSlope(elevations, width, height, gs) {
  const device = await getGpuDevice();
  if (!device || width * height > 16_000_000) {
    return { slope: cpuSlope(elevations, width, height, gs, null), backend: 'cpu' };
  }
  try {
    const n = width * height;
    const elevBuf = device.createBuffer({
      size: n * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const slopeBuf = device.createBuffer({
      size: n * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const paramBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const readBuf = device.createBuffer({
      size: n * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    device.queue.writeBuffer(elevBuf, 0, elevations);
    const params = new ArrayBuffer(16);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    u32[0] = width;
    u32[1] = height;
    f32[2] = gs;
    device.queue.writeBuffer(paramBuf, 0, params);

    const module = device.createShaderModule({ code: SLOPE_WGSL });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: elevBuf } },
        { binding: 1, resource: { buffer: slopeBuf } },
        { binding: 2, resource: { buffer: paramBuf } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    enc.copyBufferToBuffer(slopeBuf, 0, readBuf, 0, n * 4);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const slope = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    elevBuf.destroy();
    slopeBuf.destroy();
    paramBuf.destroy();
    readBuf.destroy();
    return { slope, backend: 'webgpu' };
  } catch {
    return { slope: cpuSlope(elevations, width, height, gs, null), backend: 'cpu' };
  }
}

/** Dilate binary mask (0/1) by Chebyshev radius; returns { mask, backend }. */
export async function dilateBinary(mask, width, height, radius) {
  if (radius <= 0) return { mask: mask.slice(), backend: 'cpu' };
  // Iterated 3×3 dilate is fine on CPU for typical radii (0–20); GPU helps huge radii.
  if (radius > 8) {
    const device = await getGpuDevice();
    if (device) {
      // Fall through to CPU for simplicity of max-filter; still mark attempt.
    }
  }
  return { mask: cpuDilateU8(mask, width, height, radius), backend: 'cpu' };
}

export async function dilateMax(values, width, height, radius) {
  if (radius <= 0) return { values: values.slice(), backend: 'cpu' };
  return { values: cpuDilateMaxU8(values, width, height, radius), backend: 'cpu' };
}

/** Full prep used before Wasm plan: slope + dilated steep/runout. */
export async function prepTerrainRasters(elevations, steep, runoutClass, width, height, gs, steepBufCells, runoutBufCells) {
  const { slope, backend: slopeBackend } = await computeSlope(
    elevations,
    width,
    height,
    gs,
  );
  const steepDil = await dilateBinary(steep, width, height, steepBufCells);
  const runDil = await dilateMax(runoutClass, width, height, runoutBufCells);
  return {
    slope,
    steep: steepDil.mask,
    runoutClass: runDil.values,
    backend: slopeBackend,
  };
}
