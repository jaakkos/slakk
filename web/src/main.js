import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import init, {
  grid_meta,
  decode_hazards,
  landform_classes,
  version as wasmVersion,
} from './pkg/slakk_core.js';
import { TOPO, NVE, lookupPlace, fetchTerrain } from './terrain.js';
import { buildGpx, downloadText } from './gpx.js';
import { parseGpxTrack, truncateToGoal, trackToFlat } from './gpxParse.js';
import { prepTerrainRasters, getGpuDevice } from './webgpuPrep.js';
import { PlanWorkerPool } from './workerPool.js';
import { smoothPath } from './smooth.js';
import { buildProfileSeries, renderProfile, ROUTE_COLORS } from './profile.js';
import { aspectsAlongPath, aspectLegendItems } from './aspect.js';
import { classifyPlanError } from './planErrors.js';
import { diagnosePoints, formatDiagnosis } from './diagnose.js';
import {
  restoreSettings,
  resetSettingsToHtmlDefaults,
  bindSettingsAutosave,
  saveSettings,
  applySettingsToDom,
  collectSettingsFromDom,
} from './settingsStore.js';
import {
  buildShareBlob,
  encodeSharePayload,
  decodeSharePayload,
  sharePayloadFromLocation,
  buildShareUrl,
  stripShareHash,
  sharedResultFromBlob,
} from './share.js';

const DISCLAIMER =
  'UNVERIFIED WINTER PLANNING DRAFT. Bare-ground model only; no snow or forecast assessment.';
const EMPTY_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const statusEl = document.getElementById('status');
const metricsEl = document.getElementById('metrics');
const planBtn = document.getElementById('plan');
const gpxBtn = document.getElementById('downloadGpx');
const shareBtn = document.getElementById('shareLink');
const exportRouteEl = document.getElementById('exportRoute');
const exportRouteFieldEl = document.getElementById('exportRouteField');

function setResultActionsEnabled(on) {
  gpxBtn.disabled = !on;
  shareBtn.disabled = !on;
}
const planHintEl = document.getElementById('planHint');
const staleBannerEl = document.getElementById('staleBanner');

let lastPlanFingerprint = null;
let resultStale = false;
let placedArea = false;
/** Index into primary (0) + alternatives for GPX export / map emphasis. */
let selectedExportIndex = 0;

function setStatus(text, { error = false } = {}) {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', error);
}

function settingsFingerprint() {
  const ids = [
    'corridor',
    'resolution',
    'hierarchical',
    'alternatives',
    'runout',
    'steepBuf',
    'runoutBuf',
    'maxUp',
    'maxDown',
    'descentCost',
    'pitchDeg',
    'landforms',
    'roughnessCost',
    'roughnessThr',
    'keepFirst',
    'gpxGoal',
  ];
  return ids.map((id) => `${id}=${document.getElementById(id).value}`).join('|');
}

function markResultFresh() {
  lastPlanFingerprint = settingsFingerprint();
  resultStale = false;
  staleBannerEl.hidden = true;
}

function markResultStaleIfNeeded() {
  if (!lastResult || lastPlanFingerprint == null) return;
  if (settingsFingerprint() === lastPlanFingerprint) {
    resultStale = false;
    staleBannerEl.hidden = true;
    return;
  }
  resultStale = true;
  staleBannerEl.hidden = false;
}

function updateChecklist() {
  const hasPoints = canPlan();
  const hasResult = !!lastResult && !resultStale;
  const stepPlace = document.getElementById('stepPlace');
  const stepPoints = document.getElementById('stepPoints');
  const stepPlan = document.getElementById('stepPlan');
  stepPlace.classList.toggle('done', placedArea || hasPoints);
  stepPlace.classList.toggle('current', !placedArea && !hasPoints);
  stepPoints.classList.toggle('done', hasPoints);
  stepPoints.classList.toggle('current', (placedArea || hasPoints) && !hasPoints);
  stepPlan.classList.toggle('done', hasResult);
  stepPlan.classList.toggle(
    'current',
    hasPoints && !hasResult && wasmReady && !planBusy,
  );
}

document.getElementById('panel').addEventListener('click', (e) => {
  const btn = e.target.closest('.info-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const field = btn.closest('.field');
  const help = field?.querySelector('.field-help');
  if (!help) return;
  const opening = help.hidden;
  document.querySelectorAll('#panel .field-help').forEach((el) => {
    el.hidden = true;
  });
  document.querySelectorAll('#panel .info-btn').forEach((el) => {
    el.setAttribute('aria-expanded', 'false');
  });
  if (opening) {
    help.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
});

const SECTIONS_KEY = 'slakk.panelSections';

function sectionNodes() {
  return [...document.querySelectorAll('#panel .panel-section[data-section]')];
}

function saveSectionState() {
  const state = {};
  for (const el of sectionNodes()) {
    state[el.dataset.section] = el.open;
  }
  localStorage.setItem(SECTIONS_KEY, JSON.stringify(state));
}

function restoreSectionState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SECTIONS_KEY) || 'null');
  } catch {
    saved = null;
  }
  for (const el of sectionNodes()) {
    if (saved && Object.prototype.hasOwnProperty.call(saved, el.dataset.section)) {
      el.open = !!saved[el.dataset.section];
    }
  }
}

function setAllSections(open) {
  for (const el of sectionNodes()) el.open = open;
  saveSectionState();
}

function collapseParamsForResults() {
  for (const el of sectionNodes()) {
    if (el.dataset.section !== 'start') el.open = false;
  }
  saveSectionState();
}

restoreSectionState();
for (const el of sectionNodes()) {
  el.addEventListener('toggle', saveSectionState);
}
document.getElementById('expandAllSections').onclick = () => setAllSections(true);
document.getElementById('collapseAllSections').onclick = () => setAllSections(false);

const settingsRestore = restoreSettings();
if (settingsRestore.restored) {
  // Rewrite storage in the current schema (drops unknown keys, clamps values).
  saveSettings();
}
bindSettingsAutosave({ root: document.getElementById('panel') });
document.getElementById('resetSettings').onclick = () => {
  if (!window.confirm('Reset all planner settings to built-in defaults?')) return;
  resetSettingsToHtmlDefaults();
  saveSettings();
  markResultStaleIfNeeded();
  updatePlanEnabled();
  setStatus('Settings reset to defaults (saved).');
};

const PANEL_WIDTH_KEY = 'slakk.panelWidth';
const PANEL_HEIGHT_KEY = 'slakk.panelHeight';
const panelEl = document.getElementById('panel');
const panelResizeEl = document.getElementById('panelResize');
const mainEl = document.querySelector('main');

function isStackedLayout() {
  return window.matchMedia('(max-width: 800px)').matches;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function applyPanelSize() {
  const stacked = isStackedLayout();
  panelResizeEl.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
  if (stacked) {
    const raw = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
    const mainH = mainEl.getBoundingClientRect().height || window.innerHeight * 0.8;
    const fallback = Math.round(mainH * 0.4);
    const max = Math.round(mainH * 0.65);
    const h = clamp(Number.isFinite(raw) && raw > 0 ? raw : fallback, 160, Math.max(160, max));
    document.documentElement.style.setProperty('--panel-height', `${h}px`);
    panelEl.style.flexBasis = `${h}px`;
    panelEl.style.height = `${h}px`;
    panelEl.style.maxHeight = `${max}px`;
    panelEl.style.width = '';
    if (Number.isFinite(raw) && raw > max) {
      localStorage.setItem(PANEL_HEIGHT_KEY, String(h));
    }
  } else {
    const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    const fallback = Math.round(clamp(window.innerWidth * 0.3, 280, 440));
    const max = Math.round(window.innerWidth * 0.7);
    const w = clamp(Number.isFinite(raw) && raw > 0 ? raw : fallback, 240, max);
    document.documentElement.style.setProperty('--panel-width', `${w}px`);
    panelEl.style.flexBasis = `${w}px`;
    panelEl.style.width = `${w}px`;
    panelEl.style.height = '';
    panelEl.style.maxHeight = '';
  }
}

function refreshMapSize() {
  requestAnimationFrame(() => map.invalidateSize({ animate: false }));
}

function bindPanelResize() {
  applyPanelSize();
  let dragging = false;

  const onMove = (clientX, clientY) => {
    if (!dragging) return;
    const rect = mainEl.getBoundingClientRect();
    if (isStackedLayout()) {
      const h = clamp(clientY - rect.top, 160, rect.height * 0.65);
      document.documentElement.style.setProperty('--panel-height', `${h}px`);
      panelEl.style.flexBasis = `${h}px`;
      panelEl.style.height = `${h}px`;
      panelEl.style.maxHeight = `${Math.round(rect.height * 0.65)}px`;
      localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(h)));
    } else {
      const w = clamp(clientX - rect.left, 240, rect.width * 0.7);
      document.documentElement.style.setProperty('--panel-width', `${w}px`);
      panelEl.style.flexBasis = `${w}px`;
      panelEl.style.width = `${w}px`;
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(w)));
    }
    refreshMapSize();
  };

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-resizing-panel');
    refreshMapSize();
  };

  panelResizeEl.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    document.body.classList.add('is-resizing-panel');
    panelResizeEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  panelResizeEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    onMove(e.clientX, e.clientY);
  });
  panelResizeEl.addEventListener('pointerup', stopDrag);
  panelResizeEl.addEventListener('pointercancel', stopDrag);
  panelResizeEl.addEventListener('lostpointercapture', stopDrag);

  panelResizeEl.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 16;
    const stacked = isStackedLayout();
    if (stacked) {
      const cur = panelEl.getBoundingClientRect().height;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const maxH = mainEl.getBoundingClientRect().height * 0.65;
        const next = clamp(
          cur + (e.key === 'ArrowUp' ? -step : step),
          160,
          maxH,
        );
        document.documentElement.style.setProperty('--panel-height', `${next}px`);
        panelEl.style.flexBasis = `${next}px`;
        panelEl.style.height = `${next}px`;
        panelEl.style.maxHeight = `${Math.round(maxH)}px`;
        localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(next)));
        refreshMapSize();
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = panelEl.getBoundingClientRect().width;
      const next = clamp(
        cur + (e.key === 'ArrowLeft' ? -step : step),
        240,
        mainEl.getBoundingClientRect().width * 0.7,
      );
      document.documentElement.style.setProperty('--panel-width', `${next}px`);
      panelEl.style.flexBasis = `${next}px`;
      panelEl.style.width = `${next}px`;
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(next)));
      refreshMapSize();
    }
  });

  window.addEventListener('resize', () => {
    applyPanelSize();
    refreshMapSize();
  });
}

const map = L.map('map', { zoomControl: true }).setView([69.65, 18.95], 11);
bindPanelResize();

const topoLayer = L.tileLayer.wms(TOPO, {
  layers: 'topo',
  format: 'image/png',
  transparent: false,
  version: '1.3.0',
  attribution: 'Kartverket',
  maxZoom: 18,
  crossOrigin: true,
}).addTo(map);

function makeNveOverlay() {
  return L.imageOverlay(EMPTY_GIF, [[0, 0], [0, 0]], {
    opacity: 0.55,
    interactive: false,
  });
}

const nveSteepLayer = makeNveOverlay().addTo(map);
const nveRunoutLayer = makeNveOverlay().addTo(map);
const landformLayer = L.imageOverlay(EMPTY_GIF, [[0, 0], [0, 0]], {
  opacity: 0.65,
  interactive: false,
  className: 'landform-overlay',
});

function nveExportUrl(layerIds) {
  const b = map.getBounds();
  const sw = L.CRS.EPSG3857.project(b.getSouthWest());
  const ne = L.CRS.EPSG3857.project(b.getNorthEast());
  const size = map.getSize();
  const w = Math.min(2048, Math.max(256, size.x));
  const h = Math.min(2048, Math.max(256, size.y));
  return {
    url:
      NVE +
      '?' +
      new URLSearchParams({
        bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
        bboxSR: '3857',
        imageSR: '3857',
        size: `${w},${h}`,
        f: 'image',
        format: 'png32',
        transparent: 'true',
        layers: `show:${layerIds}`,
      }),
    bounds: b,
  };
}

function refreshNve() {
  const steep = nveExportUrl('1');
  nveSteepLayer.setUrl(steep.url);
  nveSteepLayer.setBounds(steep.bounds);
  const runout = nveExportUrl('2,3,4');
  nveRunoutLayer.setUrl(runout.url);
  nveRunoutLayer.setBounds(runout.bounds);
}

let nveTimer;
map.on('moveend zoomend', () => {
  clearTimeout(nveTimer);
  nveTimer = setTimeout(refreshNve, 250);
});
refreshNve();

/** Clicked planning points (start/vias/end). */
const points = [];
/** Optional recorded track used as corridor (+ keep_first). */
let recordedTrack = null;

const markers = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const profilePanelEl = document.getElementById('profilePanel');
const profileHostEl = document.getElementById('profileHost');
const planErrorEl = document.getElementById('planError');
const errorLayer = L.layerGroup().addTo(map);
let profileCtl = null;
let profileMarker = null;
let profileSeries = null;
let lastDiagnosis = null;

function clearPlanError() {
  planErrorEl.hidden = true;
  planErrorEl.replaceChildren();
  errorLayer.clearLayers();
}

function referenceLatLngs() {
  if (recordedTrack?.length >= 2) {
    return recordedTrack.map((p) => [p.lat, p.lon]);
  }
  if (points.length >= 2) {
    return points.map((p) => [p.lat, p.lon]);
  }
  return [];
}

function drawErrorMap(info) {
  errorLayer.clearLayers();
  if (!info?.map) return;
  const latlngs = referenceLatLngs();
  const corridorM = Number(document.getElementById('corridor').value) || 600;

  if (info.map.reference && latlngs.length >= 2) {
    L.polyline(latlngs, {
      color: '#8a1c00',
      weight: 3,
      opacity: 0.85,
      dashArray: '8 6',
    })
      .bindTooltip('Reference line (search tries near this)', { sticky: true })
      .addTo(errorLayer);
  }

  if (info.map.corridor && latlngs.length >= 2) {
    // Sample corridor radius along the reference so scale is visible on the map.
    const step = Math.max(1, Math.floor(latlngs.length / 8));
    for (let i = 0; i < latlngs.length; i += step) {
      L.circle(latlngs[i], {
        radius: corridorM,
        color: '#c97a6a',
        weight: 1,
        opacity: 0.55,
        fillColor: '#c97a6a',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(errorLayer);
    }
    L.circle(latlngs[latlngs.length - 1], {
      radius: corridorM,
      color: '#c97a6a',
      weight: 1,
      opacity: 0.55,
      fillColor: '#c97a6a',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(errorLayer);
  }

  if (info.map.endpoints && points.length) {
    const reports = info.diagnosis?.blocked
      ? info.diagnosis.blocked
      : [];
    const blockedIdx = new Set(reports.map((r) => r.index));
    const tipFor = (i, fallback) => {
      const r = reports.find((x) => x.index === i);
      if (r) return `${r.label} blocked: ${r.issues.join('; ')}`;
      if (info.kind === 'start_masked' && i === 0) return 'Start blocked (Hard mask)';
      if (info.kind === 'end_masked' && i === points.length - 1) {
        return 'End blocked (Hard mask)';
      }
      return fallback;
    };
    points.forEach((p, i) => {
      const blocked = blockedIdx.has(i) ||
        (info.kind === 'start_masked' && i === 0) ||
        (info.kind === 'end_masked' && i === points.length - 1);
      const label =
        i === 0 ? 'Start' : i === points.length - 1 ? 'End' : `Via ${i}`;
      L.circleMarker([p.lat, p.lon], {
        radius: blocked ? 12 : 8,
        color: blocked ? '#8a1c00' : '#5a6f78',
        weight: blocked ? 3 : 2,
        fillColor: blocked ? '#ff6a4a' : '#ffe0d6',
        fillOpacity: 0.95,
      })
        .bindTooltip(tipFor(i, label), {
          permanent: true,
          direction: 'top',
          offset: [0, -10],
          className: blocked ? 'error-point-tip' : undefined,
        })
        .addTo(errorLayer);
    });
  }

  if (latlngs.length) {
    map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
  }
}

function focusPlanFix(fix) {
  if (fix.section) {
    const section = document.querySelector(
      `#panel .panel-section[data-section="${fix.section}"]`,
    );
    if (section) {
      section.open = true;
      saveSectionState();
      section.scrollIntoView({ block: 'nearest' });
    }
  }
  if (fix.fieldId) {
    const field = document.getElementById(fix.fieldId);
    if (field) {
      field.focus();
      field.classList.add('field-flash');
      setTimeout(() => field.classList.remove('field-flash'), 1200);
    }
  }
}

function showPlanError(raw, extras = {}) {
  const diagnosis = extras.diagnosis || lastDiagnosis;
  const info = classifyPlanError(raw, { ...extras, diagnosis });
  clearPlanError();
  lastDiagnosis = diagnosis;
  metricsEl.hidden = true;
  planErrorEl.hidden = false;

  const title = document.createElement('h3');
  title.textContent = info.title;
  const summary = document.createElement('p');
  summary.className = 'plan-error-summary';
  summary.textContent = info.summary;
  const detail = document.createElement('p');
  detail.className = 'plan-error-detail';
  detail.textContent = info.detail;
  planErrorEl.append(title, summary, detail);

  if (diagnosis?.blocked?.length) {
    const list = document.createElement('ul');
    list.className = 'plan-error-points';
    for (const r of diagnosis.blocked) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${r.label}</strong> — ${r.issues.join('; ')}`;
      list.appendChild(li);
    }
    planErrorEl.appendChild(list);
  } else if (diagnosis?.allClear) {
    const meta = document.createElement('p');
    meta.className = 'plan-error-meta';
    meta.textContent = diagnosis.summary;
    planErrorEl.appendChild(meta);
  }

  if (info.nodes != null) {
    const meta = document.createElement('p');
    meta.className = 'plan-error-meta';
    meta.textContent = `Search explored ${info.nodes.toLocaleString()} nodes before giving up.`;
    planErrorEl.appendChild(meta);
  }

  if (info.fixes?.length) {
    const list = document.createElement('ul');
    list.className = 'plan-error-fixes';
    const head = document.createElement('li');
    head.innerHTML = '<strong>Try one of these</strong>';
    list.appendChild(head);
    for (const fix of info.fixes) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = fix.label;
      btn.onclick = () => focusPlanFix(fix);
      li.appendChild(btn);
      list.appendChild(li);
    }
    planErrorEl.appendChild(list);
  }

  const note = document.createElement('p');
  note.className = 'plan-error-map-note';
  if (info.kind === 'terrain_fetch') {
    note.textContent =
      'This failed while loading terrain, before point-by-point routing. Shrink the grid (coarser Resolution / smaller Corridor), then Plan again.';
  } else if (diagnosis?.blocked?.length) {
    note.textContent =
      'Map: bright red markers are the blocked points (tooltips list the Hard mask). Peach circles = Corridor radius.';
  } else {
    note.textContent = info.map.corridor
      ? `Map: dashed reference + peach circles = Corridor ${document.getElementById('corridor').value} m. Enable NVE steep/runout layers to see masks between points.`
      : 'Map: endpoints highlighted.';
  }
  planErrorEl.appendChild(note);

  drawErrorMap({ ...info, diagnosis });
  collapseParamsForResults();
  planErrorEl.scrollIntoView({ block: 'nearest' });
  setStatus(`Error: ${info.title} — ${info.summary}`, { error: true });
}

function clearProfile() {
  profileCtl?.destroy?.();
  profileCtl = null;
  profileSeries = null;
  if (profileMarker) {
    map.removeLayer(profileMarker);
    profileMarker = null;
  }
  profilePanelEl.hidden = true;
  refreshMapSize();
}

function routeCount(result) {
  if (!result?.path_latlon?.length) return 0;
  return 1 + (result.alternatives?.length || 0);
}

function routeLabel(index) {
  return index === 0 ? 'Route 1' : `Alt ${index + 1}`;
}

function routePayload(result, index) {
  if (!result) return null;
  if (index <= 0) {
    return {
      path_latlon: result.path_latlon,
      elevations_m: result.elevations_m,
      distance_m: result.distance_m,
      cost: result.cost,
      label: result._shareLabel || routeLabel(0),
    };
  }
  const alt = result.alternatives?.[index - 1];
  if (!alt) return null;
  return {
    path_latlon: alt.path_latlon,
    elevations_m: alt.elevations_m,
    distance_m: alt.distance_m,
    cost: alt.cost,
    label: routeLabel(index),
  };
}

function syncExportRouteSelect(result) {
  const n = routeCount(result);
  if (n <= 1) {
    exportRouteFieldEl.hidden = true;
    exportRouteEl.replaceChildren();
    selectedExportIndex = 0;
    return;
  }
  selectedExportIndex = Math.max(0, Math.min(selectedExportIndex, n - 1));
  exportRouteEl.replaceChildren();
  for (let i = 0; i < n; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    const payload = routePayload(result, i);
    const km = payload?.distance_m != null ? ` · ${(payload.distance_m / 1000).toFixed(2)} km` : '';
    opt.textContent = `${routeLabel(i)}${km}`;
    if (i === selectedExportIndex) opt.selected = true;
    exportRouteEl.appendChild(opt);
  }
  exportRouteFieldEl.hidden = false;
}

function setExportRoute(index, { redraw = true } = {}) {
  if (!lastResult) return;
  const n = routeCount(lastResult);
  const next = Math.max(0, Math.min(Number(index) || 0, Math.max(0, n - 1)));
  if (next === selectedExportIndex && redraw) {
    markProfileSelection();
    return;
  }
  selectedExportIndex = next;
  if (exportRouteEl.value !== String(next)) exportRouteEl.value = String(next);
  if (redraw && lastResult) {
    drawRoute(lastResult, { fit: false });
    markProfileSelection();
  }
}

function markProfileSelection() {
  profileHostEl.querySelectorAll('.profile-stat-row').forEach((row) => {
    row.classList.toggle('is-selected', Number(row.dataset.routeIndex) === selectedExportIndex);
  });
}

function pathWithAspect(pathLatLon, elevationsM) {
  const aspectsRaw = lastDem ? aspectsAlongPath(pathLatLon, lastDem) : null;
  const sm = smoothPath(pathLatLon, elevationsM, smoothToleranceM(), {
    aspects_deg: aspectsRaw || undefined,
  });
  return sm;
}

function showProfile(result) {
  clearProfile();
  if (!result?.path_latlon?.length || !result?.elevations_m?.length) return;

  const primary = pathWithAspect(result.path_latlon, result.elevations_m);
  const tracks = [
    {
      series: buildProfileSeries(
        primary.path_latlon,
        primary.elevations_m,
        primary.aspects_deg,
      ),
      label: routeLabel(0),
      color: ROUTE_COLORS[0],
      gradeColored: true,
    },
  ];
  (result.alternatives || []).forEach((a, i) => {
    if (!a?.path_latlon?.length || !a?.elevations_m?.length) return;
    const sm = pathWithAspect(a.path_latlon, a.elevations_m);
    tracks.push({
      series: buildProfileSeries(sm.path_latlon, sm.elevations_m, sm.aspects_deg),
      label: routeLabel(i + 1),
      color: ROUTE_COLORS[(i + 1) % ROUTE_COLORS.length],
      gradeColored: true,
    });
  });

  profileSeries = tracks[0].series;
  const maxUp = Number(result.options?.max_uphill_deg ?? document.getElementById('maxUp').value) || 15;
  updateProfileLegend(tracks);
  profilePanelEl.hidden = false;
  profileCtl = renderProfile(profileHostEl, tracks, {
    maxUphillDeg: maxUp,
    onHover(_i, info) {
      const path = info?.path;
      const idx = _i;
      if (idx == null || !path?.[idx]) {
        if (profileMarker) profileMarker.setOpacity(0);
        return;
      }
      const [lat, lon] = path[idx];
      const stroke = info?.color || '#162b32';
      if (!profileMarker) {
        profileMarker = L.circleMarker([lat, lon], {
          radius: 8,
          color: stroke,
          weight: 2,
          fillColor: '#fff',
          fillOpacity: 1,
        }).addTo(map);
      } else {
        profileMarker.setLatLng([lat, lon]);
        profileMarker.setStyle({ color: stroke });
        profileMarker.setOpacity(1);
      }
    },
  });
  profileHostEl.querySelectorAll('.profile-stat-row').forEach((row) => {
    const pick = () => setExportRoute(Number(row.dataset.routeIndex));
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        pick();
      }
    });
  });
  markProfileSelection();
  refreshMapSize();
}

function updateProfileLegend(tracks) {
  const legend = profilePanelEl.querySelector('.profile-legend');
  if (!legend) return;
  const grade = `
    <i class="swatch" style="background:#2e7d32"></i>gentle
    <i class="swatch" style="background:#c47a00"></i>steep
    <i class="swatch" style="background:#c44300"></i>over max uphill
    <i class="swatch" style="background:#2b59c3"></i>down
  `;
  const hasAspect = tracks?.some((t) => t.series?.hasAspect);
  const aspect = hasAspect
    ? `<span class="profile-legend-sep" aria-hidden="true">·</span>aspect ${aspectLegendItems()
        .map((it) => `<i class="swatch" style="background:${it.color}" title="${it.label}"></i>${it.label}`)
        .join(' ')}`
    : '';
  if (!tracks || tracks.length <= 1) {
    legend.innerHTML = `${grade}${aspect}`;
    return;
  }
  const routes = tracks
    .map((t) => `<i class="swatch" style="background:${t.color}"></i>${t.label}`)
    .join('');
  legend.innerHTML = `${routes}<span class="profile-legend-sep" aria-hidden="true">·</span>${grade}${aspect}`;
}

L.control
  .layers(
    { Topo: topoLayer },
    {
      'NVE steep': nveSteepLayer,
      'NVE runout': nveRunoutLayer,
      'Ridges & gullies': landformLayer,
      'Planning points': markers,
      'Recorded GPX': trackLayer,
      'Candidate route': routeLayer,
    },
    { collapsed: true, position: 'topright' },
  )
  .addTo(map);

const Legend = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <strong>Map key</strong>
      <div><span class="swatch" style="background:#c44300"></span>Candidate route</div>
      <div><span class="swatch" style="background:#6d1b1b"></span>NVE steep (Hard)</div>
      <div><span class="swatch" style="background:#2b6cd8"></span>NVE runout</div>
      <div><span class="swatch" style="background:#e69600"></span>Ridge (Soft)</div>
      <div><span class="swatch" style="background:#8228be"></span>Gully (Soft)</div>
      <div><span class="swatch" style="background:#2e7d32"></span>Start · <span class="swatch" style="background:#c44300"></span>End</div>
    `;
    L.DomEvent.disableClickPropagation(div);
    return div;
  },
});
map.addControl(new Legend());

function mercatorBounds(bbox) {
  const sw = L.CRS.EPSG3857.unproject(L.point(bbox[0], bbox[1]));
  const ne = L.CRS.EPSG3857.unproject(L.point(bbox[2], bbox[3]));
  return L.latLngBounds(sw, ne);
}

function landformDataUrl(classes, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  const data = img.data;
  for (let i = 0; i < width * height; i++) {
    const c = classes[i];
    const o = i * 4;
    if (c === 1) {
      data[o] = 230;
      data[o + 1] = 150;
      data[o + 2] = 0;
      data[o + 3] = 120;
    } else if (c === 2) {
      data[o] = 130;
      data[o + 1] = 40;
      data[o + 2] = 190;
      data[o + 3] = 120;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function clearLandformOverlay() {
  landformLayer.setUrl(EMPTY_GIF);
  landformLayer.setBounds([[0, 0], [0, 0]]);
  if (map.hasLayer(landformLayer)) map.removeLayer(landformLayer);
}

function updateLandformOverlay(elevations, width, height, gs, bbox) {
  const raw = landform_classes(width, height, gs, elevations);
  const classes = raw instanceof Int8Array ? raw : new Int8Array(raw);
  landformLayer.setUrl(landformDataUrl(classes, width, height));
  landformLayer.setBounds(mercatorBounds(bbox));
}
let lastResult = null;
/** Last DEM used for planning — samples terrain aspect for the elevation profile. */
let lastDem = null;
let wasmReady = false;
let planBusy = false;

function canPlan() {
  if (recordedTrack && recordedTrack.length >= 2) return true;
  return points.length >= 2;
}

function updatePlanEnabled() {
  const ready = canPlan();
  planBtn.disabled = planBusy || !wasmReady || !ready;
  if (!wasmReady) {
    planHintEl.textContent = 'Loading planner engine…';
  } else if (planBusy) {
    planHintEl.textContent = 'Planning in progress — status updates below.';
  } else if (!ready) {
    planHintEl.textContent =
      'Next: click the map for start → end (or upload a GPX), then Plan route.';
  } else if (resultStale) {
    planHintEl.textContent =
      'Settings changed — Plan again so the route matches the controls.';
  } else if (lastResult) {
    planHintEl.textContent =
      'Candidate ready. Change a Hard/Soft control and Plan again to compare.';
  } else {
    planHintEl.textContent =
      'Ready. Plan uses Hard limits to block cells and Soft costs to pick among legal lines.';
  }
  updateChecklist();
}

function pointLabel(i) {
  if (i === 0) return 'S';
  if (i === points.length - 1 && points.length > 1) return 'E';
  return String(i);
}

function removePoint(index) {
  if (index < 0 || index >= points.length) return;
  if (recordedTrack) {
    setStatus('Clear the uploaded GPX (Clear) before editing map points.');
    return;
  }
  points.splice(index, 1);
  routeLayer.clearLayers();
  lastResult = null;
  syncExportRouteSelect(null);
  clearProfile();
  clearPlanError();
  setResultActionsEnabled(false);
  metricsEl.hidden = true;
  redrawPoints();
  setStatus(
    points.length
      ? `${points.length} point(s). Click Plan when ready.`
      : 'No points. Click the map to add start → vias → end.',
  );
}

function redrawPointList() {
  const list = document.getElementById('pointList');
  const empty = document.getElementById('pointListEmpty');
  list.replaceChildren();
  points.forEach((p, i) => {
    const label = pointLabel(i);
    const li = document.createElement('li');
    const lab = document.createElement('span');
    lab.className =
      'pt-label' + (label === 'S' ? ' start' : label === 'E' ? ' end' : '');
    lab.textContent = label;
    const coords = document.createElement('span');
    coords.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.title = `Remove point ${label}`;
    rm.disabled = !!recordedTrack;
    rm.onclick = () => removePoint(i);
    li.append(lab, coords, rm);
    list.appendChild(li);
  });
  empty.hidden = points.length > 0;
}

function redrawPoints() {
  markers.clearLayers();
  points.forEach((p, i) => {
    const label = pointLabel(i);
    L.circleMarker([p.lat, p.lon], {
      radius: 7,
      color: '#162b32',
      fillColor: i === 0 ? '#2e7d32' : i === points.length - 1 ? '#c44300' : '#2b59c3',
      fillOpacity: 1,
      weight: 2,
    })
      .bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -8] })
      .addTo(markers);
  });
  redrawPointList();
  updatePlanEnabled();
}

function redrawTrack() {
  trackLayer.clearLayers();
  if (!recordedTrack || recordedTrack.length < 2) return;
  const latlngs = recordedTrack.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color: '#2b59c3', weight: 3, opacity: 0.55, dashArray: '6 4' }).addTo(
    trackLayer,
  );
}

map.on('click', (e) => {
  if (recordedTrack) {
    setStatus('Clear the uploaded GPX (Clear) before clicking map points, or plan the GPX as-is.');
    return;
  }
  points.push({ lat: e.latlng.lat, lon: e.latlng.lng });
  redrawPoints();
  setStatus(`${points.length} point(s). Click Plan when ready.`);
});

map.on('contextmenu', (e) => {
  e.originalEvent.preventDefault();
  if (recordedTrack) return;
  points.pop();
  redrawPoints();
});

document.getElementById('clearPts').onclick = () => {
  points.length = 0;
  recordedTrack = null;
  lastResult = null;
  lastDem = null;
  syncExportRouteSelect(null);
  lastPlanFingerprint = null;
  resultStale = false;
  staleBannerEl.hidden = true;
  document.getElementById('gpxFile').value = '';
  routeLayer.clearLayers();
  trackLayer.clearLayers();
  clearLandformOverlay();
  clearProfile();
  clearPlanError();
  lastDiagnosis = null;
  setResultActionsEnabled(false);
  metricsEl.hidden = true;
  redrawPoints();
  setStatus('Cleared.');
  updatePlanEnabled();
};

document.getElementById('goPlace').onclick = async () => {
  const name = document.getElementById('place').value.trim();
  if (!name) return;
  try {
    setStatus(`Looking up ${name}…`);
    const p = await lookupPlace(name);
    map.setView([p.lat, p.lon], 12);
    placedArea = true;
    setStatus(`Centered on ${p.name}. Next: click start → end on the map.`);
    updatePlanEnabled();
  } catch (err) {
    const msg = String(err.message || err);
    setStatus(
      msg === 'Failed to fetch'
        ? `Place lookup failed (network). Try Go again. (${msg})`
        : msg,
      { error: true },
    );
  }
};

document.getElementById('panel').addEventListener('change', (e) => {
  if (e.target.closest('.field') || e.target.matches('input, select')) {
    markResultStaleIfNeeded();
    updatePlanEnabled();
  }
});
document.getElementById('panel').addEventListener('input', (e) => {
  if (e.target.matches('input[type="number"], input[type="text"]')) {
    markResultStaleIfNeeded();
    updatePlanEnabled();
  }
});

document.getElementById('gpxFile').onchange = async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    let track = parseGpxTrack(text);
    const goal = document.getElementById('gpxGoal').value;
    track = truncateToGoal(track, goal);
    recordedTrack = track;
    points.length = 0;
    points.push(track[0], track[track.length - 1]);
    redrawPoints();
    redrawTrack();
    map.fitBounds(L.latLngBounds(track.map((p) => [p.lat, p.lon])).pad(0.15));
    setStatus(
      `Loaded GPX: ${track.length} points to ${goal} (${track[0].lat.toFixed(4)},${track[0].lon.toFixed(4)} → ${track.at(-1).lat.toFixed(4)},${track.at(-1).lon.toFixed(4)}).`,
    );
    updatePlanEnabled();
  } catch (err) {
    setStatus('GPX error: ' + (err.message || err), { error: true });
  }
};

const pool = new PlanWorkerPool(2);
let gpuLabel = 'cpu';

async function runWorkerPlan(payload) {
  planBusy = true;
  updatePlanEnabled();
  try {
    const elevations = payload.elevations.slice();
    const transfer = [elevations.buffer];
    const msg = {
      type: 'plan',
      ...payload,
      elevations,
    };
    if (payload.slope) {
      const slope = payload.slope.slice();
      msg.slope = slope;
      transfer.push(slope.buffer);
    }
    if (payload.steep) {
      const steep = payload.steep.slice();
      msg.steep = steep;
      transfer.push(steep.buffer);
    }
    if (payload.runoutClass) {
      const runoutClass = payload.runoutClass.slice();
      msg.runoutClass = runoutClass;
      transfer.push(runoutClass.buffer);
    }
    if (payload.rgba) {
      const rgba = payload.rgba.slice();
      msg.rgba = rgba;
      transfer.push(rgba.buffer);
    }
    return await pool.plan(msg, transfer, setStatus);
  } finally {
    planBusy = false;
    updatePlanEnabled();
  }
}

async function applyIncomingShare() {
  const payload = sharePayloadFromLocation();
  if (!payload) return false;
  try {
    const blob = await decodeSharePayload(payload);
    applySettingsToDom(blob.set);
    saveSettings();
    recordedTrack = null;
    document.getElementById('gpxFile').value = '';
    points.length = 0;
    for (const [lat, lon] of blob.pts) points.push({ lat, lon });
    redrawPoints();
    redrawTrack();
    selectedExportIndex = 0;
    lastResult = sharedResultFromBlob(blob, DISCLAIMER);
    // Attach a friendly label for export/share via synthetic single route.
    lastResult._shareLabel = blob.route.label;
    markResultFresh();
    clearPlanError();
    collapseParamsForResults();
    syncExportRouteSelect(lastResult);
    drawRoute(lastResult);
    showProfile(lastResult);
    showMetrics(lastResult);
    setResultActionsEnabled(true);
    placedArea = true;
    updateChecklist();
    updatePlanEnabled();
    stripShareHash();
    const { up, down } = elevGainLoss(lastResult.elevations_m);
    setStatus(
      `Opened shared candidate (${blob.route.label}): ${lastResult.distance_m.toFixed(0)} m · ascent ${up.toFixed(0)} m · descent ${down.toFixed(0)} m. ` +
        `Settings and waypoints restored. Plan again to recompute on current DEM (re-plan uses point-to-point corridor unless you upload a GPX). ` +
        `\n${lastResult.disclaimer}`,
    );
    return true;
  } catch (err) {
    stripShareHash();
    setStatus('Could not open share link: ' + (err.message || err), { error: true });
    return false;
  }
}

async function boot() {
  try {
    await init();
    const gpu = await getGpuDevice();
    gpuLabel = gpu ? 'webgpu' : 'cpu';
    const ver = await pool.init();
    wasmReady = true;
    const shared = await applyIncomingShare();
    if (!shared) {
      setStatus(
        `Wasm ${ver || wasmVersion()} + ${pool.size} workers; raster prep=${gpuLabel}` +
          (settingsRestore.restored ? `; restored ${settingsRestore.applied} saved setting(s)` : '') +
          `. ${DISCLAIMER}`,
      );
    }
    updatePlanEnabled();
  } catch (err) {
    setStatus('Failed to load Wasm: ' + (err.message || err), { error: true });
  }
}

function optionsFromForm() {
  return {
    corridor_m: Number(document.getElementById('corridor').value),
    runout: document.getElementById('runout').value,
    steep_buffer_m: Number(document.getElementById('steepBuf').value),
    runout_buffer_m: Number(document.getElementById('runoutBuf').value),
    max_uphill_deg: Number(document.getElementById('maxUp').value),
    max_downhill_deg: Number(document.getElementById('maxDown').value),
    max_terrain_deg: 35,
    runout_cost_short: 4,
    runout_cost: 12,
    runout_cost_long: 24,
    turn_cost_m: 0,
    descent_cost: Number(document.getElementById('descentCost').value),
    angle_window_m: 50,
    pitch_deg: Number(document.getElementById('pitchDeg').value),
    pitch_window_m: 15,
    pitch_cost: 4,
    pitch_terrain_deg: 45,
    landforms: document.getElementById('landforms').value,
    gully_cost: 3,
    ridge_cost: 0.5,
    roughness_cost: Number(document.getElementById('roughnessCost').value),
    roughness_radius_m: 15,
    roughness_threshold_m: Number(document.getElementById('roughnessThr').value),
    alternatives: Number(document.getElementById('alternatives').value),
    keep_first_m: Number(document.getElementById('keepFirst').value),
  };
}

function planningFlats() {
  if (recordedTrack && recordedTrack.length >= 2) {
    const corridor = trackToFlat(recordedTrack);
    const pts = new Float64Array(4);
    pts[0] = recordedTrack[0].lat;
    pts[1] = recordedTrack[0].lon;
    pts[2] = recordedTrack.at(-1).lat;
    pts[3] = recordedTrack.at(-1).lon;
    return { pointsLatLon: pts, corridorLatLon: corridor };
  }
  const flat = new Float64Array(points.length * 2);
  points.forEach((p, i) => {
    flat[i * 2] = p.lat;
    flat[i * 2 + 1] = p.lon;
  });
  return { pointsLatLon: flat, corridorLatLon: new Float64Array(0) };
}

async function planOnce(resolution_m, corridor_m, opts, label) {
  const { pointsLatLon, corridorLatLon } = planningFlats();
  const metaPoints =
    corridorLatLon.length >= 4 ? corridorLatLon : pointsLatLon;
  setStatus(`${label}: sizing ${resolution_m} m grid…`);
  const meta = grid_meta(metaPoints, resolution_m, corridor_m);
  const bbox = Array.from(meta.bbox);
  const width = meta.width;
  const height = meta.height;
  const gs = meta.groundResolution;
  setStatus(
    `${label}: grid ${width}×${height} @ ${gs.toFixed(2)} m. Fetching…`,
  );
  const terrain = await fetchTerrain({ bbox, width, height }, setStatus);
  lastDem = {
    elevations: terrain.elevations,
    width,
    height,
    gs,
    bbox,
  };

  setStatus(`${label}: decoding hazards…`);
  const decoded = decode_hazards(terrain.rgba, width, height);
  const bytes = new Uint8Array(decoded);
  const n = width * height;
  const steep0 = bytes.subarray(0, n);
  const run0 = bytes.subarray(n, n * 2);

  const steepCells = Math.ceil((opts.steep_buffer_m || 0) / gs);
  const runoutCells = Math.ceil((opts.runout_buffer_m || 0) / gs);
  setStatus(`${label}: raster prep (${gpuLabel})…`);
  const prep = await prepTerrainRasters(
    terrain.elevations,
    steep0,
    run0,
    width,
    height,
    gs,
    steepCells,
    runoutCells,
  );
  gpuLabel = prep.backend;

  const planPts =
    recordedTrack?.length >= 2
      ? [recordedTrack[0], recordedTrack.at(-1)]
      : points.slice();
  const corridorPts =
    corridorLatLon.length >= 4
      ? Array.from({ length: corridorLatLon.length / 2 }, (_, i) => [
          corridorLatLon[i * 2],
          corridorLatLon[i * 2 + 1],
        ])
      : planPts.map((p) => [p.lat, p.lon]);

  const reports = diagnosePoints({
    points: planPts,
    bbox,
    width,
    height,
    elevations: terrain.elevations,
    steep: prep.steep,
    runoutClass: prep.runoutClass,
    runoutMode: opts.runout,
    corridorM: corridor_m,
    corridorLatLon: corridorPts,
  });
  const diagnosis = formatDiagnosis(reports);
  lastDiagnosis = diagnosis;
  if (!diagnosis.allClear) {
    const err = new Error(diagnosis.summary);
    err.diagnosis = diagnosis;
    err.pointBlocked = true;
    throw err;
  }

  if (opts.landforms !== 'off') {
    try {
      setStatus(`${label}: landform overlay…`);
      updateLandformOverlay(terrain.elevations, width, height, gs, bbox);
    } catch (err) {
      console.warn('landform overlay failed', err);
      clearLandformOverlay();
    }
  } else {
    clearLandformOverlay();
  }

  try {
    return await runWorkerPlan({
      width,
      height,
      resolution: meta.resolution,
      groundResolution: gs,
      bbox,
      elevations: terrain.elevations,
      slope: prep.slope,
      steep: prep.steep,
      runoutClass: prep.runoutClass,
      pointsLatLon,
      corridorLatLon,
      options: { ...opts, corridor_m, pre_dilated: true, steep_buffer_m: 0, runout_buffer_m: 0 },
    });
  } catch (err) {
    err.diagnosis = diagnosis;
    throw err;
  }
}

document.getElementById('plan').onclick = async () => {
  if (!canPlan() || planBusy) return;
  setResultActionsEnabled(false);
  routeLayer.clearLayers();
  clearProfile();
  clearPlanError();
  metricsEl.hidden = true;
  try {
    const opts = optionsFromForm();
    const fine = Number(document.getElementById('resolution').value);
    const hierarchical = document.getElementById('hierarchical').value === 'on';
    let result;
    if (hierarchical && fine < 10) {
      const coarse = await planOnce(10, opts.corridor_m, { ...opts, alternatives: 1 }, 'Coarse');
      setStatus(
        `Coarse done (${coarse.distance_m.toFixed(0)} m). Refining at ${fine} m…`,
      );
      // Tighten corridor around coarse path for refine
      const refineCorridor = opts.corridor_m;
      // Replace corridor with coarse path for next sizing... use coarse path as corridor
      const saved = recordedTrack;
      const savedPts = points.slice();
      recordedTrack = (coarse.path_latlon || []).map(([lat, lon]) => ({ lat, lon }));
      points.length = 0;
      if (recordedTrack.length >= 2) {
        points.push(recordedTrack[0], recordedTrack.at(-1));
      }
      try {
        result = await planOnce(
          fine,
          Math.min(refineCorridor, 400),
          opts,
          'Refine',
        );
      } finally {
        recordedTrack = saved;
        points.length = 0;
        points.push(...savedPts);
        redrawPoints();
        redrawTrack();
      }
    } else {
      result = await planOnce(fine, opts.corridor_m, opts, 'Search');
    }
    lastResult = result;
    selectedExportIndex = 0;
    markResultFresh();
    clearPlanError();
    collapseParamsForResults();
    syncExportRouteSelect(result);
    drawRoute(result);
    showProfile(result);
    showMetrics(result);
    setResultActionsEnabled(true);
    document.getElementById('metrics')?.scrollIntoView({ block: 'nearest' });
    const { up, down } = elevGainLoss(result.elevations_m);
    setStatus(
      `Done. ${result.distance_m.toFixed(0)} m · ascent ${up.toFixed(0)} m · descent ${down.toFixed(0)} m · cost ${result.cost.toFixed(1)}` +
        (result.alternatives?.length ? ` · ${result.alternatives.length} alternative(s)` : '') +
        `\n${result.disclaimer}`,
    );
  } catch (err) {
    clearProfile();
    lastResult = null;
    syncExportRouteSelect(null);
    setResultActionsEnabled(false);
    showPlanError(err.message || err, {
      diagnosis: err.diagnosis || lastDiagnosis,
      pointBlocked: !!err.pointBlocked,
    });
  } finally {
    planBusy = false;
    updatePlanEnabled();
  }
};

function smoothToleranceM() {
  const v = Number(document.getElementById('smoothM').value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function displayPath(pathLatLon, elevationsM) {
  return smoothPath(pathLatLon, elevationsM, smoothToleranceM());
}

function drawRoute(result, { fit = true } = {}) {
  routeLayer.clearLayers();
  if (!result) return;
  const tol = smoothToleranceM();
  const primarySmooth = displayPath(result.path_latlon, result.elevations_m);
  const paths = [
    primarySmooth.path_latlon,
    ...(result.alternatives || []).map((a) =>
      displayPath(a.path_latlon, a.elevations_m).path_latlon,
    ),
  ];
  const sel = Math.max(0, Math.min(selectedExportIndex, paths.length - 1));
  // Faint raw line under smoothed primary so search zigzags stay inspectable.
  if (tol > 0 && result.path_latlon?.length) {
    L.polyline(
      result.path_latlon.map(([lat, lon]) => [lat, lon]),
      { color: ROUTE_COLORS[0], weight: 2, opacity: 0.25, dashArray: '2 4', interactive: false },
    ).addTo(routeLayer);
  }
  // Draw non-selected first, selected last so it stays on top / easiest to click.
  const order = paths.map((_, i) => i).sort((a, b) => (a === sel ? 1 : b === sel ? -1 : a - b));
  order.forEach((i) => {
    const pts = paths[i];
    if (!pts?.length) return;
    const latlngs = pts.map(([lat, lon]) => [lat, lon]);
    const selected = i === sel;
    const line = L.polyline(latlngs, {
      color: ROUTE_COLORS[i % ROUTE_COLORS.length],
      weight: selected ? 6 : i === 0 ? 4 : 3,
      opacity: selected ? 1 : i === 0 ? 0.75 : 0.55,
      interactive: true,
    }).addTo(routeLayer);
    line.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      setExportRoute(i);
    });
    if (selected) {
      line.bindTooltip(`${routeLabel(i)} · export`, { sticky: true, opacity: 0.9 });
    }
  });
  if (fit) {
    const focus = paths[sel] || primarySmooth.path_latlon || [];
    if (focus.length) {
      map.fitBounds(L.latLngBounds(focus.map(([lat, lon]) => [lat, lon])).pad(0.15));
    }
  }
}

function elevGainLoss(elevations) {
  let up = 0;
  let down = 0;
  if (!elevations?.length) return { up, down };
  for (let i = 1; i < elevations.length; i++) {
    const d = elevations[i] - elevations[i - 1];
    if (d > 0) up += d;
    else down -= d;
  }
  return { up, down };
}

function showMetrics(result) {
  metricsEl.hidden = false;
  const opts = result.options || optionsFromForm();
  const alt = (result.alternatives || [])
    .map(
      (a, i) =>
        `Alt ${i + 2}: ${a.distance_m.toFixed(0)} m, cost ${a.cost.toFixed(1)}`,
    )
    .join('<br/>');
  const series = buildProfileSeries(result.path_latlon, result.elevations_m);
  const descentNote =
    series.descent_m < 5
      ? 'Almost no elevation given back — Descent cost / Max downhill are doing their job.'
      : series.descent_m > series.ascent_m * 0.25
        ? 'Notable descent on an “ascent” — raise Descent cost or tighten Max downhill °, then Plan again.'
        : 'Some descent remains; raise Descent cost if you want flatter continuous climbing.';
  const sharedNote = result.shared
    ? '<br/><em>Opened from a share link — geometry from the URL. Plan again to recompute.</em>'
    : '';
  metricsEl.innerHTML = `
    <strong>Candidate</strong> (unverified)${sharedNote}<br/>
    Distance: ${series.total_m.toFixed(0)} m (${(series.total_m / 1000).toFixed(2)} km)<br/>
    Ascent: ${series.ascent_m.toFixed(0)} m · Descent: ${series.descent_m.toFixed(0)} m<br/>
    Elev: ${series.z_min.toFixed(0)}–${series.z_max.toFixed(0)} m<br/>
    ${
      result.shared
        ? ''
        : `Cost: ${result.cost.toFixed(1)} (search score, not difficulty)<br/>Max sampled uphill: ${result.max_sampled_uphill_deg.toFixed(2)}°<br/>`
    }Waypoints: ${result.waypoints}
    ${result.preserved_m ? `<br/>Preserved: ${result.preserved_m.toFixed(0)} m` : ''}
    ${alt ? `<br/>${alt}` : ''}
    <div class="shaped-by">
      <strong>Shaped by these settings</strong><br/>
      Hard: corridor ${opts.corridor_m} m · uphill ≤ ${opts.max_uphill_deg}° · downhill ≤ ${opts.max_downhill_deg}° · pitch ${opts.pitch_deg || 0}° · runout <em>${opts.runout}</em> · steep buf ${document.getElementById('steepBuf').value} m · runout buf ${document.getElementById('runoutBuf').value} m<br/>
      Soft: descent cost ${opts.descent_cost ?? document.getElementById('descentCost').value} · landforms <em>${opts.landforms}</em> · micro-terrain ${opts.roughness_cost ?? document.getElementById('roughnessCost').value} · alternatives ${opts.alternatives}
    </div>
    <div class="readout">${descentNote}</div>
  `;
  const sm = displayPath(result.path_latlon, result.elevations_m);
  if (sm.tolerance_m > 0) {
    metricsEl.innerHTML += `<div class="readout">Display/GPX smooth ${sm.tolerance_m} m: ${sm.raw} → ${sm.kept} points (metrics above are raw).</div>`;
  }
}

document.getElementById('smoothM').addEventListener('change', () => {
  if (!lastResult) return;
  drawRoute(lastResult, { fit: false });
  showMetrics(lastResult);
  if (!profilePanelEl.hidden) showProfile(lastResult);
});
document.getElementById('smoothM').addEventListener('input', () => {
  if (!lastResult) return;
  drawRoute(lastResult, { fit: false });
  if (!profilePanelEl.hidden) showProfile(lastResult);
});

window.addEventListener('resize', () => {
  if (lastResult && !profilePanelEl.hidden) showProfile(lastResult);
});

exportRouteEl.addEventListener('change', () => {
  setExportRoute(Number(exportRouteEl.value));
});

gpxBtn.onclick = () => {
  if (!lastResult) return;
  const chosen = routePayload(lastResult, selectedExportIndex) || routePayload(lastResult, 0);
  if (!chosen?.path_latlon?.length) return;
  const sm = displayPath(chosen.path_latlon, chosen.elevations_m);
  const payload = {
    ...lastResult,
    path_latlon: sm.path_latlon,
    elevations_m: sm.elevations_m,
  };
  const smoothNote =
    sm.tolerance_m > 0
      ? `Export smoothed (RDP ${sm.tolerance_m} m; ${sm.raw}→${sm.kept} pts). Not re-validated against Hard climb limits.`
      : '';
  const trackName = `slakk-${chosen.label.replace(/\s+/g, '')}-DRAFT`;
  const fileName = `slakk-${chosen.label.replace(/\s+/g, '').toLowerCase()}-DRAFT.gpx`;
  downloadText(fileName, buildGpx(payload, { smoothNote, trackName }));
};

shareBtn.onclick = async () => {
  if (!lastResult) return;
  try {
    shareBtn.disabled = true;
    const chosen = routePayload(lastResult, selectedExportIndex) || routePayload(lastResult, 0);
    if (!chosen?.path_latlon?.length) throw new Error('No route selected to share.');
    const blob = buildShareBlob({
      points,
      settings: collectSettingsFromDom(),
      pathLatLon: chosen.path_latlon,
      elevationsM: chosen.elevations_m,
      label: chosen.label || lastResult._shareLabel || routeLabel(selectedExportIndex),
      smoothM: smoothToleranceM() || 8,
    });
    const { payload, warned, kept, raw } = await encodeSharePayload(blob);
    const url = buildShareUrl(payload);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this share link:', url);
    }
    setStatus(
      `Share link copied (${chosen.label || 'route'}; ${kept}/${raw} path pts` +
        (warned ? '; path simplified further for URL size' : '') +
        '). Recipient sees this line + your settings; they can Plan again to recompute.',
    );
  } catch (err) {
    setStatus('Share failed: ' + (err.message || err), { error: true });
  } finally {
    shareBtn.disabled = !lastResult;
  }
};

boot();
