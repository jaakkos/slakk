/** Kartverket / NVE fetch helpers (same endpoints as the Python CLI). */

import { fromArrayBuffer } from 'geotiff';
import { cacheKey, getCached, setCached } from './terrainCache.js';

export const DTM =
  'https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage';
export const NVE =
  'https://gis3.nve.no/arcgis/rest/services/wmts/Bratthet_med_utlop_2024/MapServer/export';
export const TOPO = 'https://wms.geonorge.no/skwms1/wms.topo';
export const STEDSNAVN = 'https://ws.geonorge.no/stedsnavn/v1/sted';

/**
 * Per-request tile cap. Kartverket F32 GeoTIFFs often truncate above ~90–100k
 * cells in the browser; keep each HTTP request well under that.
 */
export const MAX_TILE_SIDE = 256;
export const MAX_TILE_CELLS = 65_536; // 256²

/** Assembled grid cap (after tiling). Bound by Wasm / memory, not Kartverket. */
export const MAX_DEM_SIDE = 2500;
export const MAX_DEM_CELLS = 2_500_000;

/** @deprecated alias — single-request limit is the tile size */
export const MAX_REQUEST_SIDE = MAX_TILE_SIDE;
export const MAX_REQUEST_CELLS = MAX_TILE_CELLS;

const TILE_CONCURRENCY = 3;

function qs(params) {
  return new URLSearchParams(params).toString();
}

async function fetchJson(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last || new Error('fetch failed');
}

export async function lookupPlace(name) {
  const url =
    STEDSNAVN +
    '?' +
    qs({
      sok: name,
      treffPerSide: '10',
      side: '1',
      utkoordsys: '4326',
    });
  const data = await fetchJson(url);
  const places = data.navn || [];
  if (!places.length) throw new Error(`No place found for “${name}”`);
  const prefer = new Set(['By', 'Tettsted', 'BygdelagSomSted', 'Grend', 'Tettbebyggelse']);
  const ranked = [...places].sort((a, b) => {
    const ta = prefer.has(a.navneobjekttype) ? 0 : 1;
    const tb = prefer.has(b.navneobjekttype) ? 0 : 1;
    return ta - tb;
  });
  for (const p of ranked) {
    const rep = p.representasjonspunkt || {};
    const lat = Number(rep.nord);
    const lon = Number(rep['øst'] ?? rep.ost);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const names = (p.stedsnavn || []).map((n) => n['skrivemåte'] || n.skrivemate).filter(Boolean);
    return { lat, lon, name: names[0] || name };
  }
  throw new Error('Place has no coordinates');
}

/** Decode ArcGIS F32 GeoTIFF into Float32Array (row-major). */
export async function decodeDemTiff(buffer) {
  const src = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
  // Dedicated copy — geotiff DataView reads fail on shared/partial buffers.
  const bytes = new Uint8Array(src.byteLength);
  bytes.set(src);
  if (
    bytes.length < 8 ||
    (!(bytes[0] === 0x49 && bytes[1] === 0x49) && !(bytes[0] === 0x4d && bytes[1] === 0x4d))
  ) {
    const head = new TextDecoder().decode(bytes.slice(0, 120));
    throw new Error(
      `DEM download was not a GeoTIFF (${bytes.length} bytes). Often a single tile is still too large — report this. Head: ${head.slice(0, 80)}`,
    );
  }
  try {
    const tiff = await fromArrayBuffer(bytes.buffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const rasters = await image.readRasters();
    const band = rasters[0];
    const elev = band instanceof Float32Array ? band : Float32Array.from(band);
    if (elev.length < width * height) {
      throw new Error(
        `DEM raster incomplete (${elev.length} samples for ${width}×${height}).`,
      );
    }
    return { width, height, elevations: elev.subarray(0, width * height) };
  } catch (err) {
    const msg = String(err?.message || err);
    if (/DataView|offset|bounds|out of range|EOF|truncated/i.test(msg)) {
      throw new Error(
        `DEM decode failed (${msg}). A tile was truncated — try again, or reduce Corridor / raise Cell size m.`,
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
}

/** Cap for the *assembled* grid (tiling handles Kartverket request size). */
export function assertDemRequestSize(width, height) {
  if (width > MAX_DEM_SIDE || height > MAX_DEM_SIDE || width * height > MAX_DEM_CELLS) {
    throw new Error(
      `Terrain grid ${width}×${height} is too large even when tiled (max ~${MAX_DEM_SIDE} per side / ${MAX_DEM_CELLS} cells). Increase Cell size m or reduce Corridor m / route span.`,
    );
  }
}

function fitsOneRequest(width, height) {
  return (
    width <= MAX_TILE_SIDE &&
    height <= MAX_TILE_SIDE &&
    width * height <= MAX_TILE_CELLS
  );
}

/** Draw PNG into canvas and return Uint8ClampedArray RGBA. */
export async function decodePngRgba(buffer, expectW, expectH) {
  const blob = new Blob([buffer], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  if (bmp.width !== expectW || bmp.height !== expectH) {
    bmp.close();
    throw new Error(
      `Hazard image ${bmp.width}×${bmp.height} does not match DEM ${expectW}×${expectH}`,
    );
  }
  const canvas = new OffscreenCanvas(expectW, expectH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, expectW, expectH);
  return data;
}

export function demUrl(bbox, width, height) {
  const base = {
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${width},${height}`,
    f: 'image',
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    renderingRule: JSON.stringify({ rasterFunction: 'None' }),
  };
  return DTM + '?' + qs(base);
}

export function hazardsUrl(bbox, width, height) {
  const base = {
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${width},${height}`,
    f: 'image',
    format: 'png32',
    transparent: 'true',
    layers: 'show:1,2,3,4',
  };
  return NVE + '?' + qs(base);
}

/**
 * Split a cell grid into tiles aligned to integer cells.
 * Row 0 = north (ymax), matching Kartverket / our cellAt convention.
 */
export function planTerrainTiles(bbox, width, height) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const dx = (xmax - xmin) / width;
  const dy = (ymax - ymin) / height;
  const tileW = MAX_TILE_SIDE;
  const tileH = MAX_TILE_SIDE;
  const tiles = [];
  for (let r0 = 0; r0 < height; r0 += tileH) {
    for (let c0 = 0; c0 < width; c0 += tileW) {
      const tw = Math.min(tileW, width - c0);
      const th = Math.min(tileH, height - r0);
      const tileXmin = xmin + c0 * dx;
      const tileXmax = xmin + (c0 + tw) * dx;
      const tileYmax = ymax - r0 * dy;
      const tileYmin = ymax - (r0 + th) * dy;
      tiles.push({
        c0,
        r0,
        tw,
        th,
        bbox: [tileXmin, tileYmin, tileXmax, tileYmax],
      });
    }
  }
  return tiles;
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function fetchOneDemTile(tile) {
  const res = await fetch(demUrl(tile.bbox, tile.tw, tile.th));
  if (!res.ok) throw new Error(`DEM HTTP ${res.status} for tile ${tile.tw}×${tile.th}`);
  const dem = await decodeDemTiff(await res.arrayBuffer());
  if (dem.width !== tile.tw || dem.height !== tile.th) {
    throw new Error(
      `DEM tile size ${dem.width}×${dem.height} ≠ requested ${tile.tw}×${tile.th}`,
    );
  }
  return dem.elevations;
}

async function fetchOneHazardTile(tile) {
  const res = await fetch(hazardsUrl(tile.bbox, tile.tw, tile.th));
  if (!res.ok) throw new Error(`NVE HTTP ${res.status} for tile ${tile.tw}×${tile.th}`);
  return decodePngRgba(await res.arrayBuffer(), tile.tw, tile.th);
}

function pasteElev(dest, destW, tileElev, tile) {
  for (let r = 0; r < tile.th; r++) {
    const srcOff = r * tile.tw;
    const dstOff = (tile.r0 + r) * destW + tile.c0;
    dest.set(tileElev.subarray(srcOff, srcOff + tile.tw), dstOff);
  }
}

function pasteRgba(dest, destW, tileRgba, tile) {
  for (let r = 0; r < tile.th; r++) {
    const srcOff = r * tile.tw * 4;
    const dstOff = ((tile.r0 + r) * destW + tile.c0) * 4;
    dest.set(tileRgba.subarray(srcOff, srcOff + tile.tw * 4), dstOff);
  }
}

async function fetchTerrainTiled(bbox, width, height, onProgress) {
  const tiles = planTerrainTiles(bbox, width, height);
  const elev = new Float32Array(width * height);
  const rgba = new Uint8Array(width * height * 4);
  onProgress?.(
    `Downloading terrain in ${tiles.length} tile(s) (≤${MAX_TILE_SIDE}² each)…`,
  );

  let done = 0;
  await mapPool(tiles, TILE_CONCURRENCY, async (tile) => {
    const [tileElev, tileRgba] = await Promise.all([
      fetchOneDemTile(tile),
      fetchOneHazardTile(tile),
    ]);
    pasteElev(elev, width, tileElev, tile);
    pasteRgba(rgba, width, tileRgba, tile);
    done += 1;
    onProgress?.(`Terrain tiles ${done}/${tiles.length}…`);
  });

  return { elevations: elev, rgba };
}

async function fetchTerrainSingle(bbox, width, height, onProgress) {
  onProgress?.('Downloading DEM…');
  const demRes = await fetch(demUrl(bbox, width, height));
  if (!demRes.ok) throw new Error(`DEM HTTP ${demRes.status}`);
  const demBuf = await demRes.arrayBuffer();
  onProgress?.(`Decoding DEM (${(demBuf.byteLength / 1e6).toFixed(1)} MB)…`);
  const dem = await decodeDemTiff(demBuf);
  if (dem.width !== width || dem.height !== height) {
    throw new Error(`DEM size ${dem.width}×${dem.height} ≠ requested ${width}×${height}`);
  }
  onProgress?.('Downloading NVE hazards…');
  const hazRes = await fetch(hazardsUrl(bbox, width, height));
  if (!hazRes.ok) throw new Error(`NVE HTTP ${hazRes.status}`);
  const hazBuf = await hazRes.arrayBuffer();
  onProgress?.('Decoding hazards…');
  const rgba = await decodePngRgba(hazBuf, width, height);
  return {
    elevations: dem.elevations,
    rgba: new Uint8Array(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)),
  };
}

export async function fetchTerrain(meta, onProgress) {
  const { bbox, width, height } = meta;
  assertDemRequestSize(width, height);
  const key = cacheKey(bbox, width, height);
  const hit = await getCached(key);
  if (hit?.elevations && hit?.rgba) {
    const elev = new Float32Array(hit.elevations);
    const rgba = new Uint8Array(hit.rgba);
    if (elev.length === width * height && rgba.length === width * height * 4) {
      onProgress?.('Using IndexedDB terrain cache…');
      return { elevations: elev, rgba };
    }
    onProgress?.('Terrain cache size mismatch — re-downloading…');
  }

  const out = fitsOneRequest(width, height)
    ? await fetchTerrainSingle(bbox, width, height, onProgress)
    : await fetchTerrainTiled(bbox, width, height, onProgress);

  await setCached(key, {
    elevations: Array.from(out.elevations),
    rgba: Array.from(out.rgba),
  });
  return out;
}
