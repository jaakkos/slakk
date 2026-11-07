/** Elevation profile SVG from planned path + elevations (supports overlays). */

import { aspectColor, aspectLabel } from './aspect.js';

const M_PER_DEG_LAT = 111320;

export const ROUTE_COLORS = ['#c44300', '#7b3fa0', '#2b59c3', '#2e7d32', '#8d6e00'];

function metresBetween(a, b) {
  const lat0 = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const mx = M_PER_DEG_LAT * Math.cos(lat0);
  const dLat = (b[0] - a[0]) * M_PER_DEG_LAT;
  const dLon = (b[1] - a[1]) * mx;
  return Math.hypot(dLat, dLon);
}

/** Build cumulative distance (m) and elevation series from path. */
export function buildProfileSeries(pathLatLon, elevationsM, aspectsDeg = null) {
  const pts = pathLatLon || [];
  const elev = elevationsM || [];
  const aspects = aspectsDeg || [];
  const dist = [0];
  const z = [];
  const aspect = [];
  for (let i = 0; i < pts.length; i++) {
    z.push(Number.isFinite(elev[i]) ? elev[i] : NaN);
    aspect.push(Number.isFinite(aspects[i]) ? aspects[i] : NaN);
    if (i > 0) dist.push(dist[i - 1] + metresBetween(pts[i - 1], pts[i]));
  }
  let up = 0;
  let down = 0;
  for (let i = 1; i < z.length; i++) {
    if (!Number.isFinite(z[i]) || !Number.isFinite(z[i - 1])) continue;
    const d = z[i] - z[i - 1];
    if (d > 0) up += d;
    else down -= d;
  }
  const finite = z.filter((v) => Number.isFinite(v));
  return {
    dist,
    z,
    aspect,
    path: pts,
    total_m: dist[dist.length - 1] || 0,
    ascent_m: up,
    descent_m: down,
    z_min: finite.length ? Math.min(...finite) : 0,
    z_max: finite.length ? Math.max(...finite) : 0,
    hasAspect: aspect.some((a) => Number.isFinite(a)),
  };
}

function gradeDeg(dz, dd) {
  if (!(dd > 1e-6) || !Number.isFinite(dz)) return 0;
  return (Math.atan2(dz, dd) * 180) / Math.PI;
}

function indexAtDist(series, d) {
  const arr = series.dist;
  if (!arr.length) return -1;
  if (d <= arr[0]) return 0;
  if (d >= arr[arr.length - 1]) return arr.length - 1;
  let lo = 0;
  let hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= d) lo = mid;
    else hi = mid;
  }
  return d - arr[lo] < arr[hi] - d ? lo : hi;
}

/**
 * Render interactive elevation profile into `host`.
 * `tracks` is one series or an array of { series, label?, color?, gradeColored? }.
 * @returns {{ setHoverFromDist: (d:number|null)=>void, destroy: ()=>void }}
 */
export function renderProfile(host, tracks, {
  maxUphillDeg = 15,
  onHover = null,
  color = ROUTE_COLORS[0],
} = {}) {
  host.replaceChildren();
  host.hidden = false;

  const list = normalizeTracks(tracks, color);
  if (!list.length || !list[0].series.dist.length) {
    host.hidden = true;
    return { setHoverFromDist() {}, destroy() { host.replaceChildren(); } };
  }

  const multi = list.length > 1;
  const wrap = document.createElement('div');
  wrap.className = 'profile-wrap';

  const stats = document.createElement('div');
  stats.className = multi ? 'profile-stats profile-stats-multi' : 'profile-stats';
  if (multi) {
    stats.innerHTML = list
      .map((t, i) => {
        const s = t.series;
        return `<div class="profile-stat-row" data-route-index="${i}" role="button" tabindex="0" title="Select for GPX export">
          <i class="swatch" style="background:${t.color}"></i>
          <span class="profile-stat-label">${escapeHtml(t.label)}</span>
          <span><strong>${(s.total_m / 1000).toFixed(2)} km</strong></span>
          <span><strong>${s.ascent_m.toFixed(0)} m</strong>↑</span>
          <span><strong>${s.descent_m.toFixed(0)} m</strong>↓</span>
          <span>${s.z_min.toFixed(0)}–${s.z_max.toFixed(0)} m</span>
        </div>`;
      })
      .join('');
  } else {
    const s = list[0].series;
    stats.innerHTML = `
      <span><strong>${(s.total_m / 1000).toFixed(2)} km</strong> distance</span>
      <span><strong>${s.ascent_m.toFixed(0)} m</strong> ascent</span>
      <span><strong>${s.descent_m.toFixed(0)} m</strong> descent</span>
      <span><strong>${s.z_min.toFixed(0)}–${s.z_max.toFixed(0)} m</strong> elev</span>
    `;
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'profile-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', multi ? 'Elevation profiles for compared routes' : 'Elevation profile');
  const readout = document.createElement('div');
  readout.className = 'profile-readout';
  readout.textContent = 'Move over the profile to locate a point on the map.';
  wrap.append(stats, svg, readout);
  host.appendChild(wrap);

  const showAspect = list.some((t) => t.series.hasAspect);
  const W = Math.max(320, host.clientWidth || 480);
  // Aspect strip needs its own band — previously ~10px in the axis margin and easy to miss.
  const ASPECT_H = showAspect ? 18 : 0;
  const AXIS_H = 14;
  const ASPECT_GAP = showAspect ? 4 : 0;
  const H = (multi ? 180 : 160) + ASPECT_H + ASPECT_GAP;
  const L = 44;
  const R = 12;
  const T = 10;
  const B = AXIS_H + ASPECT_GAP + ASPECT_H + 2;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const dMax = Math.max(1, ...list.map((t) => t.series.total_m));
  let zMin = Math.min(...list.map((t) => t.series.z_min));
  let zMax = Math.max(...list.map((t) => t.series.z_max));
  if (!(zMax > zMin)) {
    zMin -= 1;
    zMax += 1;
  }
  const pad = Math.max(5, (zMax - zMin) * 0.08);
  zMin -= pad;
  zMax += pad;

  const plotBottom = H - B;
  const axisY = plotBottom + AXIS_H - 2;
  const stripY = showAspect ? H - ASPECT_H - 1 : plotBottom;
  const X = (d) => L + ((W - L - R) * d) / dMax;
  const Y = (z) => T + ((plotBottom - T) * (1 - (z - zMin) / (zMax - zMin)));

  const ns = 'http://www.w3.org/2000/svg';
  const el = (name, attrs, parent) => {
    const node = document.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  };

  for (let t = 0; t <= 4; t++) {
    const z = zMin + ((zMax - zMin) * t) / 4;
    const y = Y(z);
    el('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: 'currentColor', opacity: '0.12' }, svg);
    el('text', {
      x: L - 4,
      y: y + 3,
      'text-anchor': 'end',
      'font-size': '10',
      fill: 'currentColor',
    }, svg).textContent = z.toFixed(0);
  }
  for (let t = 0; t <= 4; t++) {
    const d = (dMax * t) / 4;
    const x = X(d);
    el('line', { x1: x, x2: x, y1: T, y2: plotBottom, stroke: 'currentColor', opacity: '0.08' }, svg);
    el('text', {
      x,
      y: axisY,
      'text-anchor': 'middle',
      'font-size': '10',
      fill: 'currentColor',
    }, svg).textContent = t === 4 ? `${(d / 1000).toFixed(2)} km` : `${(d / 1000).toFixed(1)}`;
  }

  // Aspect strip: own row under the distance labels (terrain faces downhill).
  if (showAspect) {
    const primary = list[0].series;
    el('rect', {
      x: L,
      y: stripY,
      width: W - L - R,
      height: ASPECT_H - 2,
      fill: '#d5dde2',
      opacity: '0.9',
    }, svg);
    el('text', {
      x: L - 4,
      y: stripY + ASPECT_H - 5,
      'text-anchor': 'end',
      'font-size': '9',
      fill: 'currentColor',
      opacity: '0.75',
    }, svg).textContent = 'aspect';
    for (let i = 1; i < primary.dist.length; i++) {
      const a0 = primary.aspect[i - 1];
      const a1 = primary.aspect[i];
      const a = Number.isFinite(a1) ? a1 : a0;
      if (!Number.isFinite(a)) continue;
      const x1 = X(primary.dist[i - 1]);
      const x2 = X(primary.dist[i]);
      if (!(x2 > x1)) continue;
      el('rect', {
        x: x1,
        y: stripY,
        width: Math.max(1, x2 - x1 + 0.5),
        height: ASPECT_H - 2,
        fill: aspectColor(a),
        opacity: '0.95',
      }, svg);
    }
  }

  // Draw alternatives first (under), primary last (on top).
  // Grade-colored segments stay for every track; route-color outline identifies which line.
  for (let ti = list.length - 1; ti >= 0; ti--) {
    const track = list[ti];
    const series = track.series;
    const isPrimary = ti === 0;
    const gradeW = multi ? (isPrimary ? 4.5 : 3.5) : 4;
    const gradeOp = multi ? (isPrimary ? '0.9' : '0.65') : '0.85';

    if (track.gradeColored !== false) {
      for (let i = 1; i < series.dist.length; i++) {
        const dd = series.dist[i] - series.dist[i - 1];
        const dz = series.z[i] - series.z[i - 1];
        if (!Number.isFinite(dz) || !(dd > 0)) continue;
        const g = gradeDeg(dz, dd);
        let stroke = '#2e7d32';
        if (g > maxUphillDeg) stroke = '#c44300';
        else if (g > maxUphillDeg * 0.75) stroke = '#c47a00';
        else if (g < -1) stroke = '#2b59c3';
        el(
          'line',
          {
            x1: X(series.dist[i - 1]),
            y1: Y(series.z[i - 1]),
            x2: X(series.dist[i]),
            y2: Y(series.z[i]),
            stroke,
            'stroke-width': String(gradeW),
            'stroke-linecap': 'round',
            opacity: gradeOp,
          },
          svg,
        );
      }
    }

    const points = series.dist
      .map((d, i) => (Number.isFinite(series.z[i]) ? `${X(d)},${Y(series.z[i])}` : null))
      .filter(Boolean)
      .join(' ');
    el('polyline', {
      points,
      fill: 'none',
      stroke: track.color,
      'stroke-width': multi ? (isPrimary ? '1.75' : '1.5') : '1.5',
      opacity: multi ? (isPrimary ? '0.95' : '0.85') : '0.95',
      'stroke-dasharray': isPrimary || !multi ? 'none' : '5 3',
    }, svg);
  }

  const cursor = el('line', {
    x1: L,
    x2: L,
    y1: T,
    y2: plotBottom,
    stroke: '#162b32',
    'stroke-width': '1',
    'stroke-dasharray': '3 2',
    visibility: 'hidden',
  }, svg);
  const dots = list.map((track) =>
    el('circle', {
      r: multi ? '3.5' : '4',
      fill: track.color,
      stroke: '#fff',
      'stroke-width': '1.5',
      visibility: 'hidden',
    }, svg),
  );

  const hit = el('rect', {
    x: L,
    y: T,
    width: W - L - R,
    height: Math.max(plotBottom - T, H - T - 2),
    fill: 'transparent',
  }, svg);

  function showAt(dRaw, cursorY = null) {
    if (dRaw == null) {
      cursor.setAttribute('visibility', 'hidden');
      dots.forEach((dot) => dot.setAttribute('visibility', 'hidden'));
      readout.textContent = 'Move over the profile to locate a point on the map.';
      onHover?.(null);
      return;
    }
    const d = Math.max(0, Math.min(dMax, dRaw));
    const x = X(d);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.setAttribute('visibility', 'visible');

    let best = null;
    const hits = [];
    for (let ti = 0; ti < list.length; ti++) {
      const series = list[ti].series;
      if (d > series.total_m + 1) {
        dots[ti].setAttribute('visibility', 'hidden');
        continue;
      }
      const i = indexAtDist(series, Math.min(d, series.total_m));
      if (i < 0 || !Number.isFinite(series.z[i])) {
        dots[ti].setAttribute('visibility', 'hidden');
        continue;
      }
      const y = Y(series.z[i]);
      dots[ti].setAttribute('cx', x);
      dots[ti].setAttribute('cy', y);
      dots[ti].setAttribute('visibility', 'visible');
      const hitInfo = {
        trackIndex: ti,
        pointIndex: i,
        dist_m: series.dist[i],
        elev_m: series.z[i],
        label: list[ti].label,
        color: list[ti].color,
        path: series.path,
        y,
      };
      hits.push(hitInfo);
      if (cursorY == null) {
        if (ti === 0) best = hitInfo;
      } else {
        const dy = Math.abs(y - cursorY);
        if (!best || dy < best._dy) best = { ...hitInfo, _dy: dy };
      }
    }
    if (!best && hits.length) best = hits[0];
    if (!best) {
      readout.textContent = 'Move over the profile to locate a point on the map.';
      onHover?.(null);
      return;
    }

    let g = 0;
    const series = list[best.trackIndex].series;
    if (best.pointIndex > 0) {
      g = gradeDeg(
        series.z[best.pointIndex] - series.z[best.pointIndex - 1],
        series.dist[best.pointIndex] - series.dist[best.pointIndex - 1],
      );
    }
    const prefix = multi ? `${best.label}: ` : '';
    const asp = series.aspect?.[best.pointIndex];
    const aspTxt = Number.isFinite(asp)
      ? ` · aspect ${aspectLabel(asp)} (${asp.toFixed(0)}°)`
      : '';
    readout.textContent = `${prefix}${(best.dist_m / 1000).toFixed(2)} km · ${best.elev_m.toFixed(0)} m · grade ${g.toFixed(1)}°${aspTxt}`;
    onHover?.(best.pointIndex, {
      dist_m: best.dist_m,
      elev_m: best.elev_m,
      grade_deg: g,
      aspect_deg: Number.isFinite(asp) ? asp : null,
      aspect_label: Number.isFinite(asp) ? aspectLabel(asp) : null,
      trackIndex: best.trackIndex,
      label: best.label,
      path: best.path,
      color: best.color,
    });
  }

  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    const y = ((ev.clientY - rect.top) / rect.height) * H;
    const d = ((x - L) / (W - L - R)) * dMax;
    showAt(d, y);
  };
  const onLeave = () => showAt(null);
  hit.addEventListener('pointermove', onMove);
  hit.addEventListener('pointerleave', onLeave);

  return {
    setHoverFromDist(d) {
      if (d == null) showAt(null);
      else showAt(d);
    },
    destroy() {
      hit.removeEventListener('pointermove', onMove);
      hit.removeEventListener('pointerleave', onLeave);
      host.replaceChildren();
      host.hidden = true;
    },
  };
}

function normalizeTracks(tracks, fallbackColor) {
  if (!tracks) return [];
  // Single series object (legacy): { dist, z, ... }
  if (Array.isArray(tracks.dist)) {
    return [{
      series: tracks,
      label: 'Route 1',
      color: fallbackColor,
      gradeColored: true,
    }];
  }
  if (!Array.isArray(tracks)) return [];
  return tracks
    .filter((t) => t?.series?.dist?.length)
    .map((t, i) => ({
      series: t.series,
      label: t.label || (i === 0 ? 'Route 1' : `Alt ${i + 1}`),
      color: t.color || ROUTE_COLORS[i % ROUTE_COLORS.length],
      gradeColored: t.gradeColored !== false,
    }));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
