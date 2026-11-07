/** Per-point Hard-mask diagnosis on a fetched grid (before / after A*). */

const R = 6378137;

export function lonLatToMercator(lon, lat) {
  const x = R * ((lon * Math.PI) / 180);
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

export function cellAt(lat, lon, bbox, width, height) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const [x, y] = lonLatToMercator(lon, lat);
  if (!(xmax > xmin) || !(ymax > ymin)) return null;
  const col = ((x - xmin) / (xmax - xmin)) * width - 0.5;
  const row = ((ymax - y) / (ymax - ymin)) * height - 0.5;
  const r = Math.round(row);
  const c = Math.round(col);
  if (r < 0 || c < 0 || r >= height || c >= width) {
    return { r, c, outside: true };
  }
  return { r, c, outside: false, i: r * width + c };
}

function distToPolylineM(lat, lon, lineLatLon) {
  if (!lineLatLon?.length) return 0;
  const [x, y] = lonLatToMercator(lon, lat);
  let best = Infinity;
  for (let i = 1; i < lineLatLon.length; i++) {
    const [lat0, lon0] = lineLatLon[i - 1];
    const [lat1, lon1] = lineLatLon[i];
    const [ax, ay] = lonLatToMercator(lon0, lat0);
    const [bx, by] = lonLatToMercator(lon1, lat1);
    const abx = bx - ax;
    const aby = by - ay;
    const ab2 = abx * abx + aby * aby;
    let t = ab2 < 1e-12 ? 0 : ((x - ax) * abx + (y - ay) * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * abx;
    const py = ay + t * aby;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}

/**
 * @returns {{ label: string, lat: number, lon: number, ok: boolean, issues: string[] }[]}
 */
export function diagnosePoints({
  points,
  bbox,
  width,
  height,
  elevations,
  steep,
  runoutClass,
  runoutMode,
  corridorM,
  corridorLatLon,
}) {
  const line =
    corridorLatLon?.length >= 2
      ? corridorLatLon
      : points.map((p) => [p.lat, p.lon]);

  return points.map((p, idx) => {
    const label =
      idx === 0
        ? 'Start'
        : idx === points.length - 1 && points.length > 1
          ? 'End'
          : `Via ${idx}`;
    const issues = [];
    const cell = cellAt(p.lat, p.lon, bbox, width, height);
    if (!cell || cell.outside) {
      issues.push('outside the terrain grid');
      return { label, lat: p.lat, lon: p.lon, ok: false, issues, index: idx };
    }
    const z = elevations[cell.i];
    if (!Number.isFinite(z) || z < -100 || z > 3000) {
      issues.push('missing / invalid elevation');
    }
    if (steep?.[cell.i]) issues.push('on NVE steep (Hard)');
    if (runoutMode === 'avoid' && runoutClass?.[cell.i] > 0) {
      issues.push('on NVE runout (Hard while Runout=avoid)');
    }
    const d = distToPolylineM(p.lat, p.lon, line);
    if (d > corridorM) {
      issues.push(`outside corridor (${d.toFixed(0)} m > ${corridorM} m)`);
    }
    return {
      label,
      lat: p.lat,
      lon: p.lon,
      ok: issues.length === 0,
      issues,
      index: idx,
      elev_m: Number.isFinite(z) ? z : null,
    };
  });
}

export function formatDiagnosis(reports) {
  const blocked = reports.filter((r) => !r.ok);
  if (!blocked.length) {
    return {
      allClear: true,
      summary:
        'Start, vias and end are free of Hard masks — the corridor between them is likely closed by steep/runout/climb limits.',
      blocked,
    };
  }
  const lines = blocked.map(
    (r) => `${r.label}: ${r.issues.join('; ')}`,
  );
  return {
    allClear: false,
    summary: `Blocked planning point(s): ${lines.join(' · ')}`,
    blocked,
  };
}
