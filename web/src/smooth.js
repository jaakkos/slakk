/** Display/export path smoothing (does not change the A* search). */

const M_PER_DEG_LAT = 111320;

function metresPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Squared distance from point C to segment AB, in metres² (local equirectangular). */
function dist2PointToSeg(ax, ay, bx, by, cx, cy, mx, my) {
  const abx = (bx - ax) * mx;
  const aby = (by - ay) * my;
  const acx = (cx - ax) * mx;
  const acy = (cy - ay) * my;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-12) return acx * acx + acy * acy;
  let t = (acx * abx + acy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const dx = acx - t * abx;
  const dy = acy - t * aby;
  return dx * dx + dy * dy;
}

/**
 * Ramer–Douglas–Peucker on [lat, lon] pairs.
 * @param {Array<[number, number]>} pts
 * @param {number} toleranceM
 * @returns {number[]} indices kept from original
 */
export function rdpKeepIndices(pts, toleranceM) {
  const n = pts.length;
  if (n <= 2 || !(toleranceM > 0)) return [...Array(n).keys()];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [lat0, lon0] = pts[i0];
    const [lat1, lon1] = pts[i1];
    const midLat = (lat0 + lat1) / 2;
    const mx = metresPerDegLon(midLat);
    const my = M_PER_DEG_LAT;
    let maxD2 = -1;
    let maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [lat, lon] = pts[i];
      const d2 = dist2PointToSeg(lon0, lat0, lon1, lat1, lon, lat, mx, my);
      if (d2 > maxD2) {
        maxD2 = d2;
        maxI = i;
      }
    }
    if (maxI >= 0 && maxD2 > tol2) {
      keep[maxI] = 1;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Smooth a planned path for map/GPX. Metrics should still use the raw result.
 * Elevations (and optional parallel arrays like aspects) are carried from kept vertices.
 */
export function smoothPath(pathLatLon, elevationsM, toleranceM, extras = {}) {
  const pts = pathLatLon || [];
  if (pts.length < 3 || !(toleranceM > 0)) {
    const out = {
      path_latlon: pts,
      elevations_m: elevationsM || [],
      kept: pts.length,
      raw: pts.length,
      tolerance_m: 0,
    };
    if (extras.aspects_deg) out.aspects_deg = extras.aspects_deg.slice();
    return out;
  }
  const idx = rdpKeepIndices(pts, toleranceM);
  const out = {
    path_latlon: idx.map((i) => pts[i]),
    elevations_m: (elevationsM || []).length
      ? idx.map((i) => elevationsM[i])
      : [],
    kept: idx.length,
    raw: pts.length,
    tolerance_m: toleranceM,
  };
  if (extras.aspects_deg?.length) {
    out.aspects_deg = idx.map((i) => extras.aspects_deg[i]);
  }
  return out;
}
