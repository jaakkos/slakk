/** Kartverket / NVE fetch helpers (same endpoints as the Python CLI). */

import { fromArrayBuffer } from 'geotiff';
import { cacheKey, getCached, setCached } from './terrainCache.js';

export const DTM =
  'https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage';
export const NVE =
  'https://gis3.nve.no/arcgis/rest/services/wmts/Bratthet_med_utlop_2024/MapServer/export';
export const TOPO = 'https://wms.geonorge.no/skwms1/wms.topo';
export const STEDSNAVN = 'https://ws.geonorge.no/stedsnavn/v1/sted';

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

/** Soft cap for browser DEM fetches — larger F32 GeoTIFFs often truncate and throw DataView errors. */
export const MAX_DEM_SIDE = 2500;
export const MAX_DEM_CELLS = 4_000_000;

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
      `DEM download was not a GeoTIFF (${bytes.length} bytes). Often the grid is too large for Kartverket — try coarser Resolution m or a smaller Corridor. Head: ${head.slice(0, 80)}`,
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
        `DEM raster incomplete (${elev.length} samples for ${width}×${height}). Try coarser Resolution m.`,
      );
    }
    return { width, height, elevations: elev.subarray(0, width * height) };
  } catch (err) {
    const msg = String(err?.message || err);
    if (/DataView|offset|bounds|out of range|EOF|truncated/i.test(msg)) {
      throw new Error(
        `DEM decode failed (${msg}). The elevation download is likely truncated because the grid is too large. Use a coarser Resolution m (e.g. 8–10), a smaller Corridor, or fewer / closer points.`,
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
}

export function assertDemRequestSize(width, height) {
  if (width > MAX_DEM_SIDE || height > MAX_DEM_SIDE || width * height > MAX_DEM_CELLS) {
    throw new Error(
      `Terrain grid ${width}×${height} is too large for a reliable browser DEM download (max ~${MAX_DEM_SIDE} per side / ${MAX_DEM_CELLS} cells). Increase Resolution m or reduce Corridor m / route span.`,
    );
  }
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
  const out = {
    elevations: dem.elevations,
    rgba: new Uint8Array(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)),
  };
  await setCached(key, {
    elevations: Array.from(out.elevations),
    rgba: Array.from(out.rgba),
  });
  return out;
}
