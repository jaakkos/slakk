/** Terrain aspect (° clockwise from north) from a DEM grid. */

import { cellAt } from './diagnose.js';

const FLAT_GRAD = 1e-4; // ~rise/run; below this → no aspect

/**
 * Aspect at grid cell: direction the slope faces (downhill), 0=N … 90=E … 180=S … 270=W.
 * Returns NaN on flat / invalid / border-ish cells.
 */
export function aspectAtCell(elevations, width, height, gs, r, c) {
  if (r < 1 || c < 1 || r >= height - 1 || c >= width - 1) return NaN;
  const z = (rr, cc) => {
    const v = elevations[rr * width + cc];
    return Number.isFinite(v) ? v : NaN;
  };
  const zc = z(r, c);
  if (!Number.isFinite(zc)) return NaN;
  const zn = z(r - 1, c); // toward north (smaller row)
  const zs = z(r + 1, c);
  const zw = z(r, c - 1);
  const ze = z(r, c + 1);
  if (![zn, zs, zw, ze].every(Number.isFinite)) return NaN;
  // +row = south, +col = east
  const dz_south = (zs - zn) / (2 * gs);
  const dz_east = (ze - zw) / (2 * gs);
  const dz_north = -dz_south;
  const g = Math.hypot(dz_east, dz_north);
  if (!(g > FLAT_GRAD)) return NaN;
  // Downhill (east, north) = -gradient; compass from north toward east
  let deg = (Math.atan2(-dz_east, -dz_north) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** Sample aspect (° or NaN) along [lat,lon] path using a DEM context. */
export function aspectsAlongPath(pathLatLon, dem) {
  const pts = pathLatLon || [];
  if (!dem?.elevations || !pts.length) return pts.map(() => NaN);
  const { elevations, width, height, gs, bbox } = dem;
  return pts.map(([lat, lon]) => {
    const cell = cellAt(lat, lon, bbox, width, height);
    if (!cell || cell.outside) return NaN;
    return aspectAtCell(elevations, width, height, gs, cell.r, cell.c);
  });
}

const LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Soft sun-aware colors: north cool → south warm. */
const COLORS = [
  '#4a6fa5', // N
  '#6b8cae', // NE
  '#c4a35a', // E
  '#d4893b', // SE
  '#c44300', // S
  '#a85a6a', // SW
  '#7a6a9a', // W
  '#5a6f8a', // NW
];

export function aspectSector(deg) {
  if (!Number.isFinite(deg)) return -1;
  const a = ((deg % 360) + 360) % 360;
  return Math.round(a / 45) % 8;
}

export function aspectLabel(deg) {
  const s = aspectSector(deg);
  return s < 0 ? '—' : LABELS[s];
}

export function aspectColor(deg) {
  const s = aspectSector(deg);
  return s < 0 ? '#b0bec5' : COLORS[s];
}

export function aspectLegendItems() {
  return LABELS.map((label, i) => ({ label, color: COLORS[i] }));
}
