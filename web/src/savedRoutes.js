/**
 * Local saved drafts / candidates in localStorage.
 * Lets you stash waypoints (+ optional planned path) and start a new draft
 * without losing earlier work.
 */

import { sanitizeSettingsMap } from './settingsStore.js';
import { smoothPath } from './smooth.js';

export const SAVED_ROUTES_KEY = 'slakk.savedRoutes';
export const SAVED_ROUTES_VERSION = 1;
export const MAX_SAVED_ROUTES = 25;
/** Soft cap per entry JSON; above this we re-smooth the path harder once. */
export const SAVED_SOFT_MAX_CHARS = 400_000;

function roundCoord(n, digits = 6) {
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}

function roundElev(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

function roundAspect(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const a = ((v % 360) + 360) % 360;
  return Math.round(a);
}

export function sanitizeSavedPoints(pts) {
  if (!Array.isArray(pts)) return [];
  const out = [];
  for (const p of pts) {
    let lat;
    let lon;
    if (Array.isArray(p) && p.length >= 2) {
      lat = Number(p[0]);
      lon = Number(p[1]);
    } else if (p && typeof p === 'object') {
      lat = Number(p.lat);
      lon = Number(p.lon ?? p.lng);
    } else continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    out.push([roundCoord(lat), roundCoord(lon)]);
  }
  return out;
}

function sanitizeSavedRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const path = sanitizeSavedPoints(route.path || route.path_latlon);
  if (path.length < 2) return null;
  const elevRaw = route.elev || route.elevations_m || [];
  const elev = path.map((_, i) => roundElev(Number(elevRaw[i])));
  const aspRaw = route.asp || route.aspects_deg || [];
  const asp = path.map((_, i) => roundAspect(aspRaw[i]));
  const label =
    typeof route.label === 'string' && route.label.trim()
      ? route.label.trim().slice(0, 40)
      : 'Route 1';
  const out = { label, path, elev };
  if (asp.some((a) => a != null)) out.asp = asp;
  return out;
}

function sanitizeSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const out = {};
  if (Number.isFinite(Number(summary.distance_m))) {
    out.distance_m = Math.round(Number(summary.distance_m));
  }
  if (Number.isFinite(Number(summary.ascent_m))) {
    out.ascent_m = Math.round(Number(summary.ascent_m));
  }
  if (Number.isFinite(Number(summary.descent_m))) {
    out.descent_m = Math.round(Number(summary.descent_m));
  }
  return Object.keys(out).length ? out : null;
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultSavedName(points, place = '') {
  const placeName = String(place || '').trim().slice(0, 40);
  if (placeName) return placeName;
  const pts = sanitizeSavedPoints(points);
  if (pts.length >= 2) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    return `${a[0].toFixed(3)},${a[1].toFixed(3)} → ${b[0].toFixed(3)},${b[1].toFixed(3)}`;
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `Draft ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Build a normalized saved entry (not yet written).
 * @returns {{ id: string, v: number, name: string, savedAt: string, pts: number[][], set: object, route: object|null, summary: object|null }}
 */
export function buildSavedEntry({
  id = null,
  name,
  points,
  settings = {},
  pathLatLon = null,
  elevationsM = null,
  aspectsDeg = null,
  label = 'Route 1',
  smoothM = 8,
  summary = null,
  savedAt = null,
} = {}) {
  const pts = sanitizeSavedPoints(
    (points || []).map((p) => (Array.isArray(p) ? p : [p.lat, p.lon])),
  );
  if (pts.length < 2) {
    throw new Error('Need at least two waypoints to save.');
  }
  let route = null;
  if (Array.isArray(pathLatLon) && pathLatLon.length >= 2) {
    const sm = smoothPath(pathLatLon, elevationsM || [], Number(smoothM) || 0, {
      aspects_deg: aspectsDeg || undefined,
    });
    route = sanitizeSavedRoute({
      label,
      path: sm.path_latlon,
      elev: sm.elevations_m,
      asp: sm.aspects_deg,
    });
  }
  const entry = {
    id: id || newId(),
    v: SAVED_ROUTES_VERSION,
    name: String(name || defaultSavedName(pts)).trim().slice(0, 60) || defaultSavedName(pts),
    savedAt: savedAt || new Date().toISOString(),
    pts,
    set: sanitizeSettingsMap(settings),
    route,
    summary: sanitizeSummary(summary),
  };

  let json = JSON.stringify(entry);
  if (entry.route && json.length > SAVED_SOFT_MAX_CHARS) {
    const harder = smoothPath(entry.route.path, entry.route.elev, 25, {
      aspects_deg: entry.route.asp || undefined,
    });
    entry.route = sanitizeSavedRoute({
      label: entry.route.label,
      path: harder.path_latlon,
      elev: harder.elevations_m,
      asp: harder.aspects_deg,
    });
    json = JSON.stringify(entry);
  }
  if (json.length > SAVED_SOFT_MAX_CHARS * 2) {
    throw new Error(
      'Saved route is too large for local storage. Raise Smooth GPX m, then try again.',
    );
  }
  return entry;
}

function readStore(storage) {
  try {
    const raw = storage.getItem(SAVED_ROUTES_KEY);
    if (!raw) return { v: SAVED_ROUTES_VERSION, items: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { v: SAVED_ROUTES_VERSION, items: [] };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return { v: Number(parsed.v) || SAVED_ROUTES_VERSION, items };
  } catch {
    return { v: SAVED_ROUTES_VERSION, items: [] };
  }
}

function writeStore(storage, store) {
  storage.setItem(
    SAVED_ROUTES_KEY,
    JSON.stringify({ v: SAVED_ROUTES_VERSION, items: store.items }),
  );
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pts = sanitizeSavedPoints(raw.pts);
  if (pts.length < 2) return null;
  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim().slice(0, 60)
      : defaultSavedName(pts);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    v: Number(raw.v) || SAVED_ROUTES_VERSION,
    name,
    savedAt:
      typeof raw.savedAt === 'string' && raw.savedAt
        ? raw.savedAt
        : new Date().toISOString(),
    pts,
    set: sanitizeSettingsMap(raw.set || {}),
    route: sanitizeSavedRoute(raw.route),
    summary: sanitizeSummary(raw.summary),
  };
}

export function listSavedRoutes(storage = localStorage) {
  const store = readStore(storage);
  return store.items
    .map(normalizeEntry)
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

export function getSavedRoute(id, storage = localStorage) {
  return listSavedRoutes(storage).find((e) => e.id === id) || null;
}

/** Upsert by id; newest first; capped at MAX_SAVED_ROUTES. */
export function upsertSavedRoute(entry, storage = localStorage) {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw new Error('Invalid saved route.');
  const store = readStore(storage);
  const items = store.items
    .map(normalizeEntry)
    .filter(Boolean)
    .filter((e) => e.id !== normalized.id);
  items.unshift(normalized);
  store.items = items.slice(0, MAX_SAVED_ROUTES);
  writeStore(storage, store);
  return normalized;
}

export function deleteSavedRoute(id, storage = localStorage) {
  const store = readStore(storage);
  const before = store.items.length;
  store.items = store.items.filter((e) => e?.id !== id);
  writeStore(storage, store);
  return store.items.length < before;
}

/** Shape compatible with sharedResultFromBlob / share restore. */
export function savedEntryAsShareBlob(entry) {
  const e = normalizeEntry(entry);
  if (!e) throw new Error('Invalid saved route.');
  return {
    v: 1,
    pts: e.pts,
    set: e.set,
    route: e.route,
    fail: null,
  };
}
