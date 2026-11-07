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
const RUNOUT_NAMES = { 0: 'none', 1: 'short', 2: 'medium', 3: 'long' };
const STEEP_NAMES = {
  1: '27–30°',
  2: '30–35°',
  3: '35–40°',
  4: '40–45°',
  5: '≥45°',
};

function runoutModeForClass(runoutModes, runoutMode, cls) {
  if (runoutModes && typeof runoutModes === 'object') {
    if (cls === 1) return runoutModes.short;
    if (cls === 2) return runoutModes.medium;
    if (cls === 3) return runoutModes.long;
    return 'ignore';
  }
  // Legacy single mode: any class > 0 follows global avoid/penalize.
  return runoutMode === 'avoid' ? 'avoid' : runoutMode === 'penalize' ? 'penalize' : 'ignore';
}

function steepModeForClass(steepModes, steepMode, cls) {
  if (steepModes && typeof steepModes === 'object') {
    if (cls === 1) return steepModes.steep27;
    if (cls === 2) return steepModes.steep30;
    if (cls === 3) return steepModes.steep35;
    if (cls === 4) return steepModes.steep40;
    if (cls === 5) return steepModes.steep45;
    if (cls >= 6) return 'avoid';
    return 'ignore';
  }
  // Legacy single Off/Block.
  if (cls >= 1 && steepMode === 'avoid') return 'avoid';
  if (cls >= 1 && steepMode === 'penalize') return 'penalize';
  return 'ignore';
}

export function diagnosePoints({
  points,
  bbox,
  width,
  height,
  elevations,
  steep,
  steepMode = 'ignore',
  steepModes,
  runoutClass,
  runoutMode,
  runoutModes,
  corridorM,
  corridorLatLon,
  slope,
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
      return {
        label,
        lat: p.lat,
        lon: p.lon,
        ok: false,
        issues,
        index: idx,
        cell: cell ? { r: cell.r, c: cell.c, outside: true } : null,
      };
    }
    const z = elevations[cell.i];
    if (!Number.isFinite(z) || z < -100 || z > 3000) {
      issues.push('missing / invalid elevation');
    }
    const steepCls = steep?.[cell.i] | 0;
    const steepZone = steepModeForClass(steepModes, steepMode, steepCls);
    const steepHard = steepZone === 'avoid' && steepCls > 0;
    if (steepHard) {
      const name = STEEP_NAMES[steepCls] || `class ${steepCls}`;
      issues.push(`on NVE steep ${name} (Hard — band set to Block)`);
    }
    const runCls = runoutClass?.[cell.i] ?? 0;
    const zoneMode = runoutModeForClass(runoutModes, runoutMode, runCls);
    if (zoneMode === 'avoid' && runCls > 0) {
      const name = RUNOUT_NAMES[runCls] || String(runCls);
      issues.push(`on NVE ${name} runout (Hard — zone set to Block)`);
    }
    const d = distToPolylineM(p.lat, p.lon, line);
    if (d > corridorM) {
      issues.push(`outside corridor (${d.toFixed(0)} m > ${corridorM} m)`);
    }
    const slopeDeg = slope?.[cell.i];
    return {
      label,
      lat: p.lat,
      lon: p.lon,
      ok: issues.length === 0,
      issues,
      index: idx,
      elev_m: Number.isFinite(z) ? z : null,
      slope_deg: Number.isFinite(slopeDeg) ? slopeDeg : null,
      steep: steepHard,
      steepMapped: steepCls > 0 && steepCls < 6,
      steepClass: steepCls,
      runout_class: runCls,
      runout: RUNOUT_NAMES[runCls] || String(runCls),
      corridor_dist_m: Number.isFinite(d) ? d : null,
      cell: { r: cell.r, c: cell.c, i: cell.i, outside: false },
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

function pointRole(idx, n) {
  if (idx === 0) return 'Start';
  if (idx === n - 1 && n > 1) return 'End';
  return `Via ${idx}`;
}

/**
 * Parse Wasm "No feasible path to waypoint N / the goal" into from→to indices.
 * @returns {{ fromIdx: number, toIdx: number, fromLabel: string, toLabel: string } | null}
 */
export function parseFailedLeg(msg, points) {
  if (!points?.length || points.length < 2) return null;
  const n = points.length;
  const goal = /to the goal/i.test(msg);
  const m = String(msg || '').match(/to waypoint\s+(\d+)/i);
  let fromIdx;
  let toIdx;
  if (goal) {
    fromIdx = n - 2;
    toIdx = n - 1;
  } else if (m) {
    const wp = Number(m[1]); // 1-based stop among vias (then goal is separate)
    if (!Number.isFinite(wp) || wp < 1) return null;
    toIdx = wp; // vias[wp-1] === points[wp]
    fromIdx = wp - 1;
  } else return null;
  if (fromIdx < 0 || toIdx >= n || fromIdx >= toIdx) return null;
  return {
    fromIdx,
    toIdx,
    fromLabel: pointRole(fromIdx, n),
    toLabel: pointRole(toIdx, n),
  };
}

function sampleLatLon(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

/**
 * Sample the straight corridor between two points and count Hard masks.
 * Explains no_path when endpoints themselves are clear.
 */
export function diagnoseClosedLeg({
  from,
  to,
  fromLabel = 'From',
  toLabel = 'To',
  bbox,
  width,
  height,
  elevations,
  steep,
  steepMode = 'ignore',
  steepModes,
  runoutClass,
  runoutModes,
  runoutMode,
  slope,
  maxTerrainDeg = 35,
  samples = 80,
}) {
  if (!from || !to || !bbox || !width || !height) return null;
  const tallies = {
    total: 0,
    open: 0,
    nve_steep: 0,
    fall_line: 0,
    runout_avoid: 0,
    nodata: 0,
    outside: 0,
  };
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = sampleLatLon(from, to, t);
    tallies.total += 1;
    const cell = cellAt(p.lat, p.lon, bbox, width, height);
    if (!cell || cell.outside) {
      tallies.outside += 1;
      continue;
    }
    const z = elevations?.[cell.i];
    if (!Number.isFinite(z) || z < -100 || z > 3000) {
      tallies.nodata += 1;
      continue;
    }
    let hard = false;
    const steepCls = steep?.[cell.i] | 0;
    if (steepModeForClass(steepModes, steepMode, steepCls) === 'avoid' && steepCls > 0) {
      tallies.nve_steep += 1;
      hard = true;
    }
    const slopeDeg = slope?.[cell.i];
    if (Number.isFinite(slopeDeg) && slopeDeg > maxTerrainDeg) {
      tallies.fall_line += 1;
      hard = true;
    }
    const runCls = runoutClass?.[cell.i] ?? 0;
    const zoneMode = runoutModeForClass(runoutModes, runoutMode, runCls);
    if (zoneMode === 'avoid' && runCls > 0) {
      tallies.runout_avoid += 1;
      hard = true;
    }
    if (!hard) tallies.open += 1;
  }

  const reasons = [
    ['nve_steep', tallies.nve_steep, 'NVE steep map Block (Hard)'],
    ['fall_line', tallies.fall_line, `ground slope > ${maxTerrainDeg}° (Hard)`],
    ['runout_avoid', tallies.runout_avoid, 'Runout Block (Hard)'],
    ['nodata', tallies.nodata, 'missing elevation'],
    ['outside', tallies.outside, 'outside terrain grid'],
  ]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);

  const blocked = tallies.total - tallies.open;
  const blockedPct = tallies.total ? Math.round((100 * blocked) / tallies.total) : 0;
  const top = reasons[0];
  const topPct = top && tallies.total ? Math.round((100 * top[1]) / tallies.total) : 0;

  let summary;
  if (blocked === 0) {
    summary =
      `${fromLabel} → ${toLabel}: the straight line looks open on Hard masks — ` +
      `climb/short-steep step limits or a detour outside this line likely close the search.`;
  } else if (top) {
    summary =
      `${fromLabel} → ${toLabel}: ${blockedPct}% of samples on the straight line are Hard-blocked` +
      ` (mainly ${top[2]}, ${topPct}% of samples). Endpoints can still look OK while this band seals the leg.`;
  } else {
    summary = `${fromLabel} → ${toLabel}: corridor samples are Hard-blocked (${blockedPct}%).`;
  }

  return {
    fromLabel,
    toLabel,
    from,
    to,
    tallies,
    reasons: reasons.map(([id, count, label]) => ({
      id,
      count,
      label,
      pct: tallies.total ? Math.round((100 * count) / tallies.total) : 0,
    })),
    blocked_pct: blockedPct,
    summary,
  };
}
