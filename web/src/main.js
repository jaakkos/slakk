import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import init, {
  grid_meta,
  decode_hazards,
  landform_classes,
  version as wasmVersion,
} from './pkg/slakk_core.js';
import {
  TOPO,
  NVE,
  lookupPlace,
  fetchTerrain,
  MAX_DEM_SIDE,
  MAX_DEM_CELLS,
} from './terrain.js';
import { buildGpx, downloadText } from './gpx.js';
import { parseGpxTrack, truncateToGoal, trackToFlat } from './gpxParse.js';
import { prepTerrainRasters, dilateBinary, dilateMax, getGpuDevice } from './webgpuPrep.js';
import { PlanWorkerPool } from './workerPool.js';
import { smoothPath } from './smooth.js';
import { buildProfileSeries, renderProfile, ROUTE_COLORS } from './profile.js';
import { aspectsAlongPath, aspectLegendItems } from './aspect.js';
import { classifyPlanError } from './planErrors.js';
import {
  diagnosePoints,
  formatDiagnosis,
  parseFailedLeg,
  diagnoseClosedLeg,
} from './diagnose.js';
import { buildDebugText, corridorClosedHint } from './debugReport.js';
import {
  runoutModesFromForm,
  formatRunoutModes,
  runoutOverlayLayerIds,
  splitRunoutClass,
  planRunoutStrategy,
} from './runoutZones.js';
import {
  steepModesFromForm,
  steepModesList,
  formatSteepModes,
  anySteepActive,
  splitSteepClass,
  STEEP_COST_DEFAULTS,
  STEEP_FORCE_HARD,
} from './steepZones.js';
import {
  restoreSettings,
  resetSettingsToHtmlDefaults,
  bindSettingsAutosave,
  saveSettings,
  applySettingsToDom,
  collectSettingsFromDom,
  clampedNumber,
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
import {
  buildSavedEntry,
  defaultSavedName,
  deleteSavedRoute,
  getSavedRoute,
  listSavedRoutes,
  savedEntryAsShareBlob,
  upsertSavedRoute,
} from './savedRoutes.js';

const DISCLAIMER =
  'UNVERIFIED WINTER PLANNING DRAFT. Bare-ground model only; no snow or forecast assessment.';
const EMPTY_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const statusEl = document.getElementById('status');
const metricsEl = document.getElementById('metrics');
const planBtn = document.getElementById('plan');
const gpxBtn = document.getElementById('downloadGpx');
const shareBtn = document.getElementById('shareLink');
const saveRouteBtn = document.getElementById('saveRoute');
const savedRoutesPanelEl = document.getElementById('savedRoutesPanel');
const savedRoutesCountEl = document.getElementById('savedRoutesCount');
const savedRoutesListEl = document.getElementById('savedRoutesList');
const exportRouteEl = document.getElementById('exportRoute');
const exportRouteFieldEl = document.getElementById('exportRouteField');
const debugPanelEl = document.getElementById('debugPanel');
const debugBodyEl = document.getElementById('debugBody');
const debugSummaryEl = document.getElementById('debugSummary');
const debugDiagnoseBtn = document.getElementById('debugDiagnose');
const debugCopyBtn = document.getElementById('debugCopy');

function setResultActionsEnabled(on) {
  gpxBtn.disabled = !on;
  updateShareEnabled();
  updateSaveEnabled();
}

/** Share works with a candidate or with setup-only (settings + ≥2 waypoints). */
function updateShareEnabled() {
  shareBtn.disabled = !(lastResult || canPlan());
}

/** Save needs at least two waypoints (route geometry optional). */
function updateSaveEnabled() {
  saveRouteBtn.disabled = !(lastResult || canPlan());
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
    'runoutShort',
    'runoutMedium',
    'runoutLong',
    'steep27',
    'steep30',
    'steep35',
    'steep40',
    'steep45',
    'hazardBuf',
    'maxUp',
    'maxTerrain',
    'maxDown',
    'descentCost',
    'pitchDeg',
    'landforms',
    'roughnessCost',
    'keepFirst',
    'gpxGoal',
  ];
  return ids
    .map((id) => `${id}=${document.getElementById(id)?.value ?? ''}`)
    .join('|');
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
  updateHazardLegend();
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
  const layerIds = runoutOverlayLayerIds();
  if (!layerIds.length) {
    nveRunoutLayer.setUrl(EMPTY_GIF);
    return;
  }
  const runout = nveExportUrl(layerIds.join(','));
  nveRunoutLayer.setUrl(runout.url);
  nveRunoutLayer.setBounds(runout.bounds);
}

let nveTimer;
map.on('moveend zoomend', () => {
  clearTimeout(nveTimer);
  nveTimer = setTimeout(refreshNve, 250);
});
refreshNve();

function updateHazardLegend() {
  const el = document.getElementById('legendSteep');
  if (!el) return;
  const modes = steepModesFromForm();
  const active = ['steep27', 'steep30', 'steep35', 'steep40', 'steep45'].filter(
    (k) => modes[k] !== 'ignore',
  );
  el.textContent = active.length
    ? `NVE steep map (${active.length} band${active.length > 1 ? 's' : ''} on)`
    : 'NVE steep map (Off)';
}

document.getElementById('panel')?.addEventListener('change', (e) => {
  const id = e.target?.id;
  if (
    id === 'runoutShort' ||
    id === 'runoutMedium' ||
    id === 'runoutLong' ||
    id === 'steep27' ||
    id === 'steep30' ||
    id === 'steep35' ||
    id === 'steep40' ||
    id === 'steep45'
  ) {
    refreshNve();
    updateHazardLegend();
  }
});
updateHazardLegend();

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
/** Last plan/diagnose snapshot for the Debug panel. */
let lastDebugCtx = null;
/** Hazards from last DEM fetch — Diagnose without a full re-plan. */
let lastHazards = null;

function updateDebugPanel(ctx, { open = false, isError = false } = {}) {
  lastDebugCtx = ctx;
  debugBodyEl.textContent = buildDebugText(ctx);
  debugPanelEl.classList.toggle('is-error', !!isError);
  if (ctx?.error) {
    debugSummaryEl.textContent = ctx.error.title || 'error';
  } else if (ctx?.diagnosis && !ctx.diagnosis.allClear) {
    debugSummaryEl.textContent = `${ctx.diagnosis.blocked?.length || 0} blocked point(s)`;
  } else if (ctx?.result) {
    debugSummaryEl.textContent = `ok · ${Math.round(ctx.result.distance_m || 0)} m · ${ctx.result.visited_nodes ?? '—'} nodes`;
  } else if (ctx?.diagnosis?.allClear) {
    debugSummaryEl.textContent = 'points OK';
  } else {
    debugSummaryEl.textContent = ctx ? 'updated' : 'no data yet';
  }
  if (open) debugPanelEl.open = true;
}

function resultDebugSlice(result) {
  if (!result) return null;
  const series = buildProfileSeries(result.path_latlon, result.elevations_m);
  return {
    status: result.status || 'ok',
    shared: !!result.shared,
    distance_m: result.distance_m,
    cost: result.cost,
    visited_nodes: result.visited_nodes,
    max_sampled_uphill_deg: result.max_sampled_uphill_deg,
    waypoints: result.waypoints,
    path_points: result.path_latlon?.length,
    alternatives: result.alternatives?.length || 0,
    ascent_m: series.ascent_m,
    descent_m: series.descent_m,
  };
}

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

  const failedLeg = info.failedLeg;
  if (failedLeg && points[failedLeg.fromIdx] && points[failedLeg.toIdx]) {
    const a = points[failedLeg.fromIdx];
    const b = points[failedLeg.toIdx];
    L.polyline(
      [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ],
      { color: '#c44300', weight: 6, opacity: 0.95 },
    )
      .bindTooltip(
        `Failed leg: ${failedLeg.fromLabel} → ${failedLeg.toLabel}` +
          (info.closedLeg?.blocked_pct != null
            ? ` (${info.closedLeg.blocked_pct}% Hard-blocked on straight line)`
            : ''),
        { permanent: true, direction: 'center' },
      )
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

function buildClosedLegFromError(raw, opts = optionsFromForm()) {
  const planPts = currentPlanPoints();
  const failedLeg = parseFailedLeg(String(raw || ''), planPts);
  if (!failedLeg || !lastDem || !lastHazards) return { failedLeg, closedLeg: null };
  const from = planPts[failedLeg.fromIdx];
  const to = planPts[failedLeg.toIdx];
  const closedLeg = diagnoseClosedLeg({
    from,
    to,
    fromLabel: failedLeg.fromLabel,
    toLabel: failedLeg.toLabel,
    bbox: lastDem.bbox,
    width: lastDem.width,
    height: lastDem.height,
    elevations: lastDem.elevations,
    steep: lastHazards.steep,
    steepModes: lastHazards.steepModes || steepModesFromForm(),
    runoutClass: lastHazards.runoutActive || lastHazards.runoutClass,
    runoutModes: lastHazards.runoutModes || opts.runout_modes,
    slope: lastHazards.slope,
    maxTerrainDeg: opts.max_terrain_deg,
  });
  return { failedLeg, closedLeg };
}

function showPlanError(raw, extras = {}) {
  const opts = extras.options || optionsFromForm();
  const { failedLeg, closedLeg } =
    extras.closedLeg || extras.failedLeg
      ? { failedLeg: extras.failedLeg || null, closedLeg: extras.closedLeg || null }
      : buildClosedLegFromError(raw, opts);
  const info = classifyPlanError(raw, {
    ...extras,
    options: opts,
    failedLeg,
    closedLeg,
  });
  // Terrain failures must not inherit a previous "points OK" diagnosis.
  const diagnosis =
    info.kind === 'terrain_fetch'
      ? null
      : extras.diagnosis || lastDiagnosis;
  clearPlanError();
  lastDiagnosis = diagnosis;
  metricsEl.hidden = true;
  planErrorEl.hidden = false;

  const title = document.createElement('h3');
  title.textContent = info.title;
  const summary = document.createElement('p');
  summary.className = 'plan-error-summary';
  summary.textContent = info.summary;
  planErrorEl.append(title, summary);

  if (closedLeg?.reasons?.length) {
    const list = document.createElement('ul');
    list.className = 'plan-error-points';
    const head = document.createElement('li');
    head.innerHTML = `<strong>Why ${closedLeg.fromLabel} → ${closedLeg.toLabel} is closed</strong>`;
    list.appendChild(head);
    for (const r of closedLeg.reasons) {
      const li = document.createElement('li');
      li.textContent = `${r.label}: ${r.pct}% of straight-line samples (${r.count})`;
      list.appendChild(li);
    }
    planErrorEl.appendChild(list);
  }

  const detail = document.createElement('p');
  detail.className = 'plan-error-detail';
  detail.textContent = info.detail;
  planErrorEl.appendChild(detail);

  if (diagnosis?.blocked?.length) {
    const list = document.createElement('ul');
    list.className = 'plan-error-points';
    for (const r of diagnosis.blocked) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${r.label}</strong> — ${r.issues.join('; ')}`;
      list.appendChild(li);
    }
    planErrorEl.appendChild(list);
  } else if (diagnosis?.allClear && !closedLeg) {
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
  } else if (closedLeg) {
    const steepNote = anySteepActive(steepModesFromForm())
      ? 'NVE steep bands are on — turn on the red layer to inspect Block / Prefer around.'
      : 'Ground slope / runout Block likely seal the stretch — turn on NVE layers to inspect.';
    note.textContent =
      `Map: thick orange line = failed leg (${closedLeg.fromLabel} → ${closedLeg.toLabel}). ` +
      steepNote;
  } else {
    note.textContent = info.map.corridor
      ? `Map: dashed reference + peach circles = Corridor ${document.getElementById('corridor').value} m. Enable NVE steep/runout layers to see masks between points.`
      : 'Map: endpoints highlighted.';
  }
  planErrorEl.appendChild(note);

  drawErrorMap({ ...info, diagnosis, failedLeg, closedLeg });
  planErrorEl.scrollIntoView({ block: 'nearest' });
  setStatus(`Error: ${info.title} — ${info.summary}`, { error: true });

  const terrainFail = info.kind === 'terrain_fetch';
  const hint = terrainFail
    ? 'Terrain failed before routing. Large grids are tiled automatically — retry Plan, or shrink Corridor / raise Resolution if it keeps failing.'
    : closedLeg?.summary || corridorClosedHint(diagnosis, opts);
  updateDebugPanel(
    {
      at: new Date().toISOString(),
      phase: 'error',
      label: extras.label || lastDebugCtx?.label,
      options: { ...collectSettingsFromDom(), ...opts },
      grid: extras.grid || (terrainFail ? null : lastDebugCtx?.grid) || null,
      // Don't keep a previous "points OK" diagnosis when DEM never loaded for this attempt.
      points: terrainFail
        ? currentPlanPoints().map((p, idx, arr) => ({
            label:
              idx === 0
                ? 'Start'
                : idx === arr.length - 1
                  ? 'End'
                  : `Via ${idx}`,
            lat: p.lat,
            lon: p.lon,
            ok: true,
            issues: [],
            index: idx,
          }))
        : extras.pointReports || lastDebugCtx?.points || [],
      diagnosis: terrainFail ? null : diagnosis,
      closedLeg: closedLeg || null,
      error: {
        kind: info.kind,
        title: info.title,
        summary: info.summary,
        detail: info.detail,
        nodes: info.nodes,
        fixes: info.fixes,
      },
      result: null,
      hint,
    },
    { open: true, isError: true },
  );
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
      aspects_deg: result.aspects_deg,
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
    aspects_deg: alt.aspects_deg,
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

/** Terrain aspect along a path: prefer cached samples, else sample lastDem. */
function aspectsForPath(pathLatLon, cached = null) {
  if (cached?.length === pathLatLon?.length) return cached;
  if (!lastDem || !pathLatLon?.length) return cached || null;
  return aspectsAlongPath(pathLatLon, lastDem);
}

function pathWithAspect(pathLatLon, elevationsM, cachedAspects = null) {
  const aspectsRaw = aspectsForPath(pathLatLon, cachedAspects);
  const sm = smoothPath(pathLatLon, elevationsM, smoothToleranceM(), {
    aspects_deg: aspectsRaw || undefined,
  });
  return sm;
}

function showProfile(result) {
  clearProfile();
  if (!result?.path_latlon?.length || !result?.elevations_m?.length) return;

  // Cache DEM samples on the result so share / resize / smooth keep aspect without re-fetch.
  if (!result.aspects_deg && lastDem) {
    result.aspects_deg = aspectsAlongPath(result.path_latlon, lastDem);
  }
  (result.alternatives || []).forEach((a) => {
    if (a && !a.aspects_deg && lastDem && a.path_latlon?.length) {
      a.aspects_deg = aspectsAlongPath(a.path_latlon, lastDem);
    }
  });

  const primary = pathWithAspect(
    result.path_latlon,
    result.elevations_m,
    result.aspects_deg,
  );
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
    const sm = pathWithAspect(a.path_latlon, a.elevations_m, a.aspects_deg);
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
      'GPX track': trackLayer,
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
      <div><span class="swatch" style="background:#6d1b1b"></span><span id="legendSteep">NVE steep map (Off)</span></div>
      <div><span class="swatch" style="background:#004d98"></span>Runout short</div>
      <div><span class="swatch" style="background:#4c9bff"></span>Runout medium</div>
      <div><span class="swatch" style="background:#9ab1e6"></span>Runout long</div>
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
  updateShareEnabled();
  updateSaveEnabled();
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
    setStatus('Clear the uploaded GPX (New draft) before editing map points.');
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

function clearCurrentDraft({ statusMessage = 'New draft — map start → end when ready. Saved routes kept.' } = {}) {
  points.length = 0;
  recordedTrack = null;
  lastResult = null;
  lastDem = null;
  lastHazards = null;
  lastDebugCtx = null;
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
  updateDebugPanel(null);
  setResultActionsEnabled(false);
  metricsEl.hidden = true;
  redrawPoints();
  setStatus(statusMessage);
  updatePlanEnabled();
}

document.getElementById('clearPts').onclick = () => {
  clearCurrentDraft();
};

function formatSavedWhen(iso) {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatSavedSummary(entry) {
  const bits = [];
  if (entry.summary?.distance_m != null) {
    bits.push(`${(entry.summary.distance_m / 1000).toFixed(2)} km`);
  }
  if (entry.summary?.ascent_m != null) bits.push(`${entry.summary.ascent_m} m↑`);
  if (!bits.length) bits.push(`${entry.pts.length} pts`);
  if (entry.route) bits.push('path');
  const when = formatSavedWhen(entry.savedAt);
  if (when) bits.push(when);
  return bits.join(' · ');
}

function refreshSavedRoutesList() {
  const items = listSavedRoutes();
  savedRoutesCountEl.textContent = String(items.length);
  savedRoutesListEl.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'saved-routes-empty';
    empty.textContent = 'No saved drafts yet. Plan or place waypoints, then Save.';
    savedRoutesListEl.appendChild(empty);
    return;
  }
  for (const entry of items) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'saved-routes-meta';
    const title = document.createElement('strong');
    title.textContent = entry.name;
    title.title = entry.name;
    const sub = document.createElement('span');
    sub.textContent = formatSavedSummary(entry);
    meta.append(title, sub);
    const actions = document.createElement('div');
    actions.className = 'saved-routes-actions';
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = 'Load';
    loadBtn.title = 'Replace the current draft with this saved one';
    loadBtn.onclick = () => loadSavedRoute(entry.id);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Delete';
    delBtn.title = 'Remove from this browser';
    delBtn.onclick = () => {
      if (!window.confirm(`Delete saved “${entry.name}”?`)) return;
      deleteSavedRoute(entry.id);
      refreshSavedRoutesList();
      setStatus(`Deleted saved “${entry.name}”.`);
    };
    actions.append(loadBtn, delBtn);
    li.append(meta, actions);
    savedRoutesListEl.appendChild(li);
  }
}

function saveCurrentDraft() {
  if (!(lastResult || canPlan())) {
    setStatus('Need at least two waypoints to save.', { error: true });
    return;
  }
  const place = document.getElementById('place')?.value || '';
  const suggested = defaultSavedName(points, place);
  const name = window.prompt('Name for this saved draft:', suggested);
  if (name == null) return;
  try {
    const settings = collectSettingsFromDom();
    let pathLatLon = null;
    let elevationsM = null;
    let aspectsDeg = null;
    let label = 'Route 1';
    let summary = null;
    if (lastResult) {
      const chosen =
        routePayload(lastResult, selectedExportIndex) || routePayload(lastResult, 0);
      if (chosen?.path_latlon?.length) {
        if (!chosen.aspects_deg && lastDem) {
          chosen.aspects_deg = aspectsAlongPath(chosen.path_latlon, lastDem);
        }
        pathLatLon = chosen.path_latlon;
        elevationsM = chosen.elevations_m;
        aspectsDeg = chosen.aspects_deg;
        label = chosen.label || routeLabel(selectedExportIndex);
        const series = buildProfileSeries(pathLatLon, elevationsM);
        summary = {
          distance_m: series.total_m,
          ascent_m: series.ascent_m,
          descent_m: series.descent_m,
        };
      }
    }
    const entry = buildSavedEntry({
      name: name.trim() || suggested,
      points,
      settings,
      pathLatLon,
      elevationsM,
      aspectsDeg,
      label,
      smoothM: smoothToleranceM() || 8,
      summary,
    });
    upsertSavedRoute(entry);
    refreshSavedRoutesList();
    savedRoutesPanelEl.open = true;
    setStatus(
      `Saved “${entry.name}” locally${entry.route ? ' (with path)' : ' (waypoints only)'}. ` +
        `Click New draft to map another, or keep editing.`,
    );
  } catch (err) {
    setStatus(`Save failed: ${err.message || err}`, { error: true });
  }
}

function loadSavedRoute(id) {
  const entry = getSavedRoute(id);
  if (!entry) {
    setStatus('Saved draft not found.', { error: true });
    refreshSavedRoutesList();
    return;
  }
  try {
    const blob = savedEntryAsShareBlob(entry);
    applySettingsToDom(blob.set);
    refreshNve();
    updateHazardLegend();
    saveSettings();
    recordedTrack = null;
    document.getElementById('gpxFile').value = '';
    points.length = 0;
    for (const [lat, lon] of blob.pts) points.push({ lat, lon });
    redrawPoints();
    redrawTrack();
    if (points.length) {
      const ll = points.map((p) => [p.lat, p.lon]);
      map.fitBounds(L.latLngBounds(ll).pad(0.2));
    }
    selectedExportIndex = 0;
    clearPlanError();
    placedArea = true;
    lastDem = null;
    lastHazards = null;

    if (blob.route) {
      lastResult = sharedResultFromBlob(blob, DISCLAIMER);
      lastResult._shareLabel = blob.route.label || entry.name;
      markResultFresh();
      syncExportRouteSelect(lastResult);
      drawRoute(lastResult);
      showProfile(lastResult);
      showMetrics(lastResult);
      setResultActionsEnabled(true);
      const { up, down } = elevGainLoss(lastResult.elevations_m);
      setStatus(
        `Loaded “${entry.name}”: ${lastResult.distance_m.toFixed(0)} m · ascent ${up.toFixed(0)} m · descent ${down.toFixed(0)} m. ` +
          `Plan again to recompute on current DEM.`,
      );
    } else {
      lastResult = null;
      syncExportRouteSelect(null);
      routeLayer.clearLayers();
      clearProfile();
      metricsEl.hidden = true;
      setResultActionsEnabled(false);
      lastPlanFingerprint = null;
      resultStale = false;
      staleBannerEl.hidden = true;
      setStatus(
        `Loaded “${entry.name}” (${blob.pts.length} waypoints, no path). Click Plan to search.`,
      );
    }
    updatePlanEnabled();
  } catch (err) {
    setStatus(`Load failed: ${err.message || err}`, { error: true });
  }
}

saveRouteBtn.onclick = () => saveCurrentDraft();

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
    refreshNve();
    updateHazardLegend();
    saveSettings();
    recordedTrack = null;
    document.getElementById('gpxFile').value = '';
    points.length = 0;
    for (const [lat, lon] of blob.pts) points.push({ lat, lon });
    redrawPoints();
    redrawTrack();
    if (points.length) {
      const ll = points.map((p) => [p.lat, p.lon]);
      map.fitBounds(L.latLngBounds(ll).pad(0.2));
    }
    selectedExportIndex = 0;
    clearPlanError();
    placedArea = true;

    if (blob.route) {
      lastResult = sharedResultFromBlob(blob, DISCLAIMER);
      lastResult._shareLabel = blob.route.label;
      markResultFresh();
      syncExportRouteSelect(lastResult);
      drawRoute(lastResult);
      showProfile(lastResult);
      showMetrics(lastResult);
      setResultActionsEnabled(true);
      const { up, down } = elevGainLoss(lastResult.elevations_m);
      setStatus(
        `Opened shared candidate (${blob.route.label}): ${lastResult.distance_m.toFixed(0)} m · ascent ${up.toFixed(0)} m · descent ${down.toFixed(0)} m. ` +
          `Settings and waypoints restored. Plan again to recompute on current DEM (re-plan uses point-to-point corridor unless you upload a GPX). ` +
          `\n${lastResult.disclaimer}`,
      );
    } else {
      lastResult = null;
      syncExportRouteSelect(null);
      routeLayer.clearLayers();
      clearProfile();
      metricsEl.hidden = true;
      setResultActionsEnabled(false);
      lastPlanFingerprint = null;
      resultStale = false;
      staleBannerEl.hidden = true;
      if (blob.fail?.detail || blob.fail?.summary) {
        showPlanError(blob.fail.detail || blob.fail.summary, {
          label: blob.fail.label || 'Shared setup',
          options: optionsFromForm(),
          diagnosis: {
            allClear: true,
            summary: 'Opened from a share link (no route). Loading terrain to explain the closed leg…',
            blocked: [],
          },
        });
        setStatus(
          `Opened shared setup (${blob.pts.length} waypoints). Explaining last failure — then you can Plan again.`,
        );
        // Load DEM + sample the failed leg so the error panel names the Hard mask.
        queueMicrotask(() => {
          explainSharedFailure(blob.fail).catch((err) => {
            console.warn('explainSharedFailure', err);
          });
        });
      } else {
        setStatus(
          `Opened shared setup (${blob.pts.length} waypoints, no route). Settings restored. ` +
            `Click Plan to search (point-to-point corridor unless you upload a GPX).`,
        );
      }
    }

    updateChecklist();
    updatePlanEnabled();
    stripShareHash();
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
    refreshSavedRoutesList();
    const shared = await applyIncomingShare();
    if (!shared) {
      const nSaved = listSavedRoutes().length;
      setStatus(
        `Wasm ${ver || wasmVersion()} + ${pool.size} workers; raster prep=${gpuLabel}` +
          (settingsRestore.restored ? `; restored ${settingsRestore.applied} saved setting(s)` : '') +
          (nSaved ? `; ${nSaved} saved draft(s)` : '') +
          `. ${DISCLAIMER}`,
      );
    }
    updatePlanEnabled();
  } catch (err) {
    setStatus('Failed to load Wasm: ' + (err.message || err), { error: true });
  }
}

/**
 * Dilate + split NVE steep bands and runout into Hard Block / Soft Prefer for Wasm.
 * Steep bands default Off — Skin track / Ground slope remain the angle Hard gates.
 */
async function prepHazardsWithRunoutModes(
  elevations,
  steep0,
  runRaw,
  width,
  height,
  gs,
  steepBufM,
  runoutBufM,
  modes = runoutModesFromForm(),
  steepModes = steepModesFromForm(),
) {
  const steepOn = anySteepActive(steepModes);
  const steepCells = steepOn ? Math.ceil((steepBufM || 0) / gs) : 0;
  const runoutCells = Math.ceil((runoutBufM || 0) / gs);
  const steepSplit = splitSteepClass(steep0, steepModes);
  const split = splitRunoutClass(runRaw, modes);
  const strategy = planRunoutStrategy(modes);
  const runForPrep =
    strategy.classSource === 'cost' ? split.costClass : split.activeClass;
  const { slope, backend, runoutClass } = await prepTerrainRasters(
    elevations,
    // Binary dilate unused when we pass class via dilateMax below; keep API happy.
    new Uint8Array(steep0.length),
    runForPrep,
    width,
    height,
    gs,
    0,
    runoutCells,
  );
  const steepDil = await dilateMax(steepSplit.activeClass, width, height, steepCells);
  let steepForPlan = steepDil.values.slice();
  if (strategy.mergeAvoidIntoSteep) {
    const avoidDil = await dilateBinary(split.avoidMask, width, height, runoutCells);
    for (let i = 0; i < steepForPlan.length; i++) {
      if (avoidDil.mask[i]) steepForPlan[i] = STEEP_FORCE_HARD;
    }
  }
  const activeDil = await dilateMax(split.activeClass, width, height, runoutCells);
  const steepRaw =
    steep0 instanceof Uint8Array ? steep0.slice() : new Uint8Array(steep0);
  return {
    slope,
    steep: steepDil.values,
    steepRaw,
    steepForPlan,
    steepModes,
    runoutClass,
    runoutActive: activeDil.values,
    runoutRaw: runRaw instanceof Uint8Array ? runRaw : new Uint8Array(runRaw),
    runoutModes: modes,
    runout: strategy.runout,
    backend,
  };
}

/** Built-in Soft weights when runout is Prefer around (Short < Medium < Long). */
const RUNOUT_COST_DEFAULTS = { short: 4, medium: 12, long: 24 };
const BUMP_THRESHOLD_DEFAULT = 0.45;

function optionsFromForm() {
  const modes = runoutModesFromForm();
  const strategy = planRunoutStrategy(modes);
  const steepModes = steepModesFromForm();
  const cushion = clampedNumber('hazardBuf', 10);
  return {
    corridor_m: clampedNumber('corridor', 600),
    runout: strategy.runout,
    runout_modes: modes,
    steep_modes: steepModesList(steepModes),
    steep_costs: STEEP_COST_DEFAULTS.slice(),
    steep_buffer_m: anySteepActive(steepModes) ? cushion : 0,
    runout_buffer_m: cushion,
    max_uphill_deg: clampedNumber('maxUp', 15),
    max_downhill_deg: clampedNumber('maxDown', 10),
    max_terrain_deg: clampedNumber('maxTerrain', 35),
    runout_cost_short: RUNOUT_COST_DEFAULTS.short,
    runout_cost: RUNOUT_COST_DEFAULTS.medium,
    runout_cost_long: RUNOUT_COST_DEFAULTS.long,
    turn_cost_m: 0,
    descent_cost: clampedNumber('descentCost', 10),
    angle_window_m: 50,
    pitch_deg: clampedNumber('pitchDeg', 0),
    pitch_window_m: 15,
    pitch_cost: 4,
    // Match CLI: unsmoothed cliff cut-off is at least 45°, or Ground slope max if higher.
    pitch_terrain_deg: Math.max(45, clampedNumber('maxTerrain', 35)),
    landforms: document.getElementById('landforms').value,
    gully_cost: 3,
    ridge_cost: 0.5,
    roughness_cost: clampedNumber('roughnessCost', 2),
    roughness_radius_m: 15,
    roughness_threshold_m: BUMP_THRESHOLD_DEFAULT,
    alternatives: clampedNumber('alternatives', 1),
    keep_first_m: clampedNumber('keepFirst', 0),
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

/** Raise cell size until the DEM grid fits Wasm/browser caps. */
function fitGridMeta(metaPoints, preferredRes, corridor_m) {
  let res = Math.max(1, Number(preferredRes) || 4);
  let meta = grid_meta(metaPoints, res, corridor_m);
  const fits = (m) =>
    m.width <= MAX_DEM_SIDE &&
    m.height <= MAX_DEM_SIDE &&
    m.width * m.height <= MAX_DEM_CELLS;
  if (fits(meta)) return { meta, resolution_m: res, bumped: false };
  for (let i = 0; i < 48; i++) {
    res = Math.max(res + 1, Math.ceil(res * 1.2));
    meta = grid_meta(metaPoints, res, corridor_m);
    if (fits(meta)) return { meta, resolution_m: res, bumped: true };
  }
  return { meta, resolution_m: res, bumped: true };
}

function currentPlanPoints() {
  if (recordedTrack?.length >= 2) {
    return [recordedTrack[0], recordedTrack.at(-1)];
  }
  return points.slice();
}

async function planOnce(resolution_m, corridor_m, opts, label) {
  const { pointsLatLon, corridorLatLon } = planningFlats();
  const metaPoints =
    corridorLatLon.length >= 4 ? corridorLatLon : pointsLatLon;
  setStatus(`${label}: sizing ${resolution_m} m grid…`);
  let meta;
  let usedRes = resolution_m;
  try {
    const fitted = fitGridMeta(metaPoints, resolution_m, corridor_m);
    meta = fitted.meta;
    usedRes = fitted.resolution_m;
    if (fitted.bumped) {
      setStatus(
        `${label}: Cell size ${resolution_m} m too fine for this span — using ${usedRes} m so DEM fits…`,
      );
    }
  } catch (err) {
    err.label = label;
    throw err;
  }
  const bbox = Array.from(meta.bbox);
  const width = meta.width;
  const height = meta.height;
  const gs = meta.groundResolution;
  const gridInfo = {
    width,
    height,
    gs,
    resolution: meta.resolution,
    preferred_resolution_m: resolution_m,
    used_resolution_m: usedRes,
    corridor_m,
    bbox,
  };
  setStatus(
    `${label}: grid ${width}×${height} @ ${gs.toFixed(2)} m. Fetching…`,
  );
  let terrain;
  try {
    terrain = await fetchTerrain({ bbox, width, height }, setStatus);
  } catch (err) {
    err.label = label;
    err.grid = gridInfo;
    err.diagnosis = null;
    throw err;
  }
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
  const runRaw = new Uint8Array(bytes.subarray(n, n * 2));

  setStatus(`${label}: raster prep (${gpuLabel})…`);
  const prep = await prepHazardsWithRunoutModes(
    terrain.elevations,
    steep0,
    runRaw,
    width,
    height,
    gs,
    opts.steep_buffer_m,
    opts.runout_buffer_m,
    opts.runout_modes || runoutModesFromForm(),
    steepModesFromForm(),
  );
  gpuLabel = prep.backend;
  opts.runout = prep.runout;
  lastHazards = {
    steep: prep.steep,
    steepRaw: prep.steepRaw,
    steepForPlan: prep.steepForPlan,
    steepModes: prep.steepModes,
    runoutClass: prep.runoutClass,
    runoutActive: prep.runoutActive,
    runoutRaw: prep.runoutRaw,
    runoutModes: prep.runoutModes,
    slope: prep.slope,
  };

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
    steepModes: prep.steepModes,
    runoutClass: prep.runoutActive,
    runoutModes: prep.runoutModes,
    corridorM: corridor_m,
    corridorLatLon: corridorPts,
    slope: prep.slope,
  });
  const diagnosis = formatDiagnosis(reports);
  lastDiagnosis = diagnosis;
  updateDebugPanel({
    at: new Date().toISOString(),
    phase: 'diagnose',
    label,
    options: { ...collectSettingsFromDom(), ...opts },
    grid: gridInfo,
    points: reports,
    diagnosis,
    error: null,
    result: null,
    hint: diagnosis.allClear
      ? null
      : corridorClosedHint(diagnosis, opts),
  });
  if (!diagnosis.allClear) {
    const err = new Error(diagnosis.summary);
    err.diagnosis = diagnosis;
    err.pointBlocked = true;
    err.pointReports = reports;
    err.grid = gridInfo;
    err.label = label;
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
      steep: prep.steepForPlan,
      runoutClass: prep.runoutClass,
      pointsLatLon,
      corridorLatLon,
      options: { ...opts, corridor_m, pre_dilated: true, steep_buffer_m: 0, runout_buffer_m: 0 },
    });
  } catch (err) {
    err.diagnosis = diagnosis;
    err.pointReports = reports;
    err.grid = gridInfo;
    err.label = label;
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
      // Coarse 10 m grids need short-steep allowance; pitch 0 often finds no alpine path
      // even when the fine pass would. Borrow a temporary pitch floor for the scout only.
      const coarseOpts = { ...opts, alternatives: 1 };
      if (!(opts.pitch_deg > 0)) {
        const floor = Math.min(40, Math.max(30, opts.max_uphill_deg + 10));
        coarseOpts.pitch_deg = floor;
        coarseOpts.pitch_terrain_deg = Math.max(
          opts.pitch_terrain_deg || 45,
          opts.max_terrain_deg || 35,
          45,
        );
        setStatus(
          `Coarse scout: Kick-turn max is 0 — using ${floor}° only for the 10 m pass, then refining at ${fine} m with your settings…`,
        );
      }
      const coarse = await planOnce(10, opts.corridor_m, coarseOpts, 'Coarse');
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
    syncExportRouteSelect(result);
    drawRoute(result);
    showProfile(result);
    showMetrics(result);
    setResultActionsEnabled(true);
    updateDebugPanel(
      {
        ...(lastDebugCtx || {}),
        at: new Date().toISOString(),
        phase: 'ok',
        options: { ...collectSettingsFromDom(), ...opts },
        result: resultDebugSlice(result),
        error: null,
        hint: null,
      },
      { open: false, isError: false },
    );
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
      pointReports: err.pointReports,
      grid: err.grid,
      label: err.label,
      options: optionsFromForm(),
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
      ? 'Almost no elevation given back — Drop penalty / Allowed drop max are doing their job.'
      : series.descent_m > series.ascent_m * 0.25
        ? 'Notable height loss on an ascent — raise Drop penalty or tighten Allowed drop max, then Plan again.'
        : 'Some dips remain; raise Drop penalty if you want flatter continuous climbing.';
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
      Hard: corridor ${opts.corridor_m} m · skin track ≤ ${opts.max_uphill_deg}° · ground ≤ ${opts.max_terrain_deg}° · drop ≤ ${opts.max_downhill_deg}° · kick-turn ≤ ${opts.pitch_deg || 0}° · NVE steep ${formatSteepModes(steepModesFromForm())} · runout ${formatRunoutModes(opts.runout_modes || runoutModesFromForm())} · cushion ${opts.runout_buffer_m ?? clampedNumber('hazardBuf', 10)} m<br/>
      Soft: drop penalty ${opts.descent_cost ?? document.getElementById('descentCost').value} · ridges <em>${opts.landforms}</em> · bump ${opts.roughness_cost ?? document.getElementById('roughnessCost').value} · alt. routes ${opts.alternatives}
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

/** After a setup-only share: fetch DEM and rewrite the error with a clear closed-leg report. */
async function explainSharedFailure(fail) {
  if (!canPlan()) return;
  await diagnoseCurrentPoints({ quietOk: true });
  if (!fail?.detail && !fail?.summary) return;
  showPlanError(fail.detail || fail.summary, {
    label: fail.label || 'Shared setup',
    options: optionsFromForm(),
    diagnosis: lastDiagnosis,
    pointReports: lastDebugCtx?.points,
    grid: lastDebugCtx?.grid,
  });
}

async function diagnoseCurrentPoints({ quietOk = false } = {}) {
  if (!canPlan()) {
    setStatus('Add start and end (or a GPX) before Diagnose.', { error: true });
    return;
  }
  const opts = optionsFromForm();
  const preferred = Number(document.getElementById('resolution').value) || 4;
  try {
    debugDiagnoseBtn.disabled = true;
    setStatus('Diagnose: loading terrain for point checks…');
    // Reuse last DEM when grid settings match; otherwise fetch like Plan.
    let dem = lastDem;
    let hazards = lastHazards;
    const { pointsLatLon, corridorLatLon } = planningFlats();
    const metaPoints = corridorLatLon.length >= 4 ? corridorLatLon : pointsLatLon;
    const fitted = fitGridMeta(metaPoints, preferred, opts.corridor_m);
    const meta = fitted.meta;
    const fine = fitted.resolution_m;
    if (fitted.bumped) {
      setStatus(
        `Diagnose: Cell size ${preferred} m is too fine for this span — using ${fine} m so the DEM fits…`,
      );
    }
    const bbox = Array.from(meta.bbox);
    const width = meta.width;
    const height = meta.height;
    const gs = meta.groundResolution;
    const sameGrid =
      dem &&
      hazards &&
      dem.width === width &&
      dem.height === height &&
      Math.abs(dem.gs - gs) < 1e-6 &&
      dem.bbox?.every((v, i) => Math.abs(v - bbox[i]) < 1e-3);
    if (!sameGrid) {
      const terrain = await fetchTerrain({ bbox, width, height }, setStatus);
      dem = { elevations: terrain.elevations, width, height, gs, bbox };
      lastDem = dem;
      const decoded = decode_hazards(terrain.rgba, width, height);
      const bytes = new Uint8Array(decoded);
      const n = width * height;
      const prep = await prepHazardsWithRunoutModes(
        terrain.elevations,
        bytes.subarray(0, n),
        new Uint8Array(bytes.subarray(n, n * 2)),
        width,
        height,
        gs,
        opts.steep_buffer_m,
        opts.runout_buffer_m,
        opts.runout_modes,
        steepModesFromForm(),
      );
      hazards = {
        steep: prep.steep,
        steepRaw: prep.steepRaw,
        steepForPlan: prep.steepForPlan,
        steepModes: prep.steepModes,
        runoutClass: prep.runoutClass,
        runoutActive: prep.runoutActive,
        runoutRaw: prep.runoutRaw,
        runoutModes: prep.runoutModes,
        slope: prep.slope,
      };
      lastHazards = hazards;
    } else if (hazards?.runoutRaw && hazards?.steepRaw) {
      // Re-apply steep / runout modes on cached rasters (cushion / Block toggles).
      const prep = await prepHazardsWithRunoutModes(
        dem.elevations,
        hazards.steepRaw,
        hazards.runoutRaw,
        dem.width,
        dem.height,
        dem.gs,
        opts.steep_buffer_m,
        opts.runout_buffer_m,
        opts.runout_modes || runoutModesFromForm(),
        steepModesFromForm(),
      );
      hazards = {
        steep: prep.steep,
        steepRaw: prep.steepRaw,
        steepForPlan: prep.steepForPlan,
        steepModes: prep.steepModes,
        runoutClass: prep.runoutClass,
        runoutActive: prep.runoutActive,
        runoutRaw: prep.runoutRaw,
        runoutModes: prep.runoutModes,
        slope: prep.slope,
      };
      lastHazards = hazards;
    }
    const planPts = currentPlanPoints();
    const corridorPts =
      corridorLatLon.length >= 4
        ? Array.from({ length: corridorLatLon.length / 2 }, (_, i) => [
            corridorLatLon[i * 2],
            corridorLatLon[i * 2 + 1],
          ])
        : planPts.map((p) => [p.lat, p.lon]);
    const reports = diagnosePoints({
      points: planPts,
      bbox: dem.bbox,
      width: dem.width,
      height: dem.height,
      elevations: dem.elevations,
      steep: hazards.steep,
      steepModes: hazards.steepModes || steepModesFromForm(),
      runoutClass: hazards.runoutActive || hazards.runoutClass,
      runoutModes: hazards.runoutModes || opts.runout_modes,
      corridorM: opts.corridor_m,
      corridorLatLon: corridorPts,
      slope: hazards.slope,
    });
    const diagnosis = formatDiagnosis(reports);
    lastDiagnosis = diagnosis;
    const blocked = !diagnosis.allClear;
    updateDebugPanel(
      {
        at: new Date().toISOString(),
        phase: 'diagnose',
        label: 'Diagnose',
        options: { ...collectSettingsFromDom(), ...opts },
        grid: {
          width: dem.width,
          height: dem.height,
          gs: dem.gs,
          resolution: meta.resolution,
          corridor_m: opts.corridor_m,
          bbox: dem.bbox,
          diagnose_cell_m: fine,
          preferred_cell_m: preferred,
        },
        points: reports,
        diagnosis,
        error: blocked
          ? {
              kind: 'point_blocked',
              title: 'Planning points are blocked',
              summary: diagnosis.summary,
              detail: diagnosis.summary,
              fixes: [],
            }
          : null,
        result: lastResult ? resultDebugSlice(lastResult) : null,
        hint: corridorClosedHint(diagnosis, opts),
      },
      { open: true, isError: blocked },
    );
    if (blocked) {
      drawErrorMap({
        kind: 'point_blocked',
        map: { corridor: true, endpoints: true, reference: true },
        diagnosis,
      });
      setStatus(`Diagnose: ${diagnosis.summary}`, { error: true });
    } else if (!quietOk) {
      errorLayer.clearLayers();
      const bumpNote = fitted.bumped
        ? ` (checked on ${fine} m cells; preferred ${preferred} m was too fine for this span)`
        : '';
      setStatus(
        `Diagnose: start/vias/end are free of Hard masks${bumpNote}. If Plan still fails, the corridor between them is closed — see Debug hint.`,
      );
    }
  } catch (err) {
    setStatus('Diagnose failed: ' + (err.message || err), { error: true });
    const stubPts = currentPlanPoints().map((p, idx, arr) => {
      const label =
        idx === 0
          ? 'Start'
          : idx === arr.length - 1 && arr.length > 1
            ? 'End'
            : `Via ${idx}`;
      return {
        label,
        lat: p.lat,
        lon: p.lon,
        ok: false,
        issues: ['terrain not loaded — point not checked'],
        index: idx,
      };
    });
    updateDebugPanel(
      {
        at: new Date().toISOString(),
        phase: 'diagnose',
        options: { ...collectSettingsFromDom(), ...optionsFromForm() },
        points: stubPts,
        error: {
          kind: 'terrain_fetch',
          title: 'Diagnose failed',
          summary: String(err.message || err),
          detail: String(err.message || err),
        },
        hint: 'Shrink Cell size m / Corridor, or Diagnose will auto-coarsen next time. Then try again.',
      },
      { open: true, isError: true },
    );
  } finally {
    debugDiagnoseBtn.disabled = false;
  }
}

debugDiagnoseBtn.onclick = () => {
  diagnoseCurrentPoints();
};
debugCopyBtn.onclick = async () => {
  const text = buildDebugText(lastDebugCtx);
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Debug dump copied to clipboard.');
  } catch {
    window.prompt('Copy debug dump:', text);
  }
};

shareBtn.onclick = async () => {
  // Map points, or GPX track ends when planning from an uploaded track.
  const ptsForShare =
    points.length >= 2
      ? points
      : recordedTrack?.length >= 2
        ? [recordedTrack[0], recordedTrack.at(-1)]
        : [];
  if (ptsForShare.length < 2) return;
  try {
    shareBtn.disabled = true;
    const fail =
      lastDebugCtx?.error &&
      (lastDebugCtx.phase === 'error' || lastDebugCtx.phase === 'shared-setup')
        ? {
            ...lastDebugCtx.error,
            label: lastDebugCtx.label,
          }
        : null;
    let blob;
    if (lastResult) {
      const chosen =
        routePayload(lastResult, selectedExportIndex) || routePayload(lastResult, 0);
      if (!chosen?.path_latlon?.length) throw new Error('No route selected to share.');
      if (!chosen.aspects_deg && lastDem) {
        chosen.aspects_deg = aspectsAlongPath(chosen.path_latlon, lastDem);
      }
      blob = buildShareBlob({
        points: ptsForShare,
        settings: collectSettingsFromDom(),
        pathLatLon: chosen.path_latlon,
        elevationsM: chosen.elevations_m,
        aspectsDeg: chosen.aspects_deg,
        label: chosen.label || lastResult._shareLabel || routeLabel(selectedExportIndex),
        smoothM: smoothToleranceM() || 8,
        fail,
      });
    } else {
      blob = buildShareBlob({
        points: ptsForShare,
        settings: collectSettingsFromDom(),
        fail,
      });
    }
    const { payload, warned, kept, raw, hasRoute } = await encodeSharePayload(blob);
    const url = buildShareUrl(payload);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this share link:', url);
    }
    if (hasRoute) {
      setStatus(
        `Share link copied (route + settings; ${kept}/${raw} path pts` +
          (warned ? '; path simplified further for URL size' : '') +
          '). Recipient sees this line + your settings; they can Plan again to recompute.',
      );
    } else {
      setStatus(
        `Share link copied (setup only: ${blob.pts.length} waypoints + settings` +
          (fail ? ' + last error note' : '') +
          '). No route geometry — recipient can Plan to search.',
      );
    }
  } catch (err) {
    setStatus('Share failed: ' + (err.message || err), { error: true });
  } finally {
    updateShareEnabled();
  }
};

boot();
