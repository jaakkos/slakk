/**
 * Versioned share links: settings + waypoints + optional candidate path in the URL hash.
 * Format: #s=<base64url(gzip|raw JSON)>
 *
 * Route geometry is optional — setup-only links (failed plans) restore controls + points
 * so someone else can debug / Plan again.
 */

import { sanitizeSettingsMap, collectSettingsFromDom } from './settingsStore.js';
import { smoothPath } from './smooth.js';

export const SHARE_VERSION = 1;
/** Soft cap for encoded hash payload; above this we re-smooth harder once. */
export const SHARE_SOFT_MAX_CHARS = 120_000;

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

function sanitizePoints(pts) {
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

function sanitizeRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const path = sanitizePoints(route.path || route.path_latlon);
  if (path.length < 2) return null;
  const elevRaw = route.elev || route.elevations_m || [];
  const elev = path.map((_, i) => roundElev(Number(elevRaw[i])));
  const label = typeof route.label === 'string' && route.label.trim()
    ? route.label.trim().slice(0, 40)
    : 'Route 1';
  return { label, path, elev };
}

/** Compact failure snapshot for setup-only share links (optional). */
export function sanitizeFailInfo(fail) {
  if (!fail || typeof fail !== 'object') return null;
  const out = {};
  if (typeof fail.kind === 'string' && fail.kind) out.kind = fail.kind.slice(0, 40);
  if (typeof fail.title === 'string' && fail.title) out.title = fail.title.slice(0, 80);
  if (typeof fail.summary === 'string' && fail.summary) {
    out.summary = fail.summary.slice(0, 400);
  }
  if (typeof fail.detail === 'string' && fail.detail) {
    out.detail = fail.detail.slice(0, 500);
  }
  if (typeof fail.label === 'string' && fail.label) out.label = fail.label.slice(0, 40);
  if (Number.isFinite(Number(fail.nodes))) out.nodes = Number(fail.nodes);
  return Object.keys(out).length ? out : null;
}

/**
 * Build a shareable blob object (not yet encoded).
 * Pass a path for a candidate share; omit path (or pass empty) for setup-only.
 */
export function buildShareBlob({
  points,
  settings = collectSettingsFromDom(),
  pathLatLon,
  elevationsM,
  label = 'Route 1',
  smoothM = 8,
  fail = null,
} = {}) {
  const pts = sanitizePoints(
    (points || []).map((p) => (Array.isArray(p) ? p : [p.lat, p.lon])),
  );
  if (pts.length < 2) {
    throw new Error('Need at least two waypoints to share.');
  }
  const hasPath = Array.isArray(pathLatLon) && pathLatLon.length >= 2;
  let route = null;
  let meta = { smooth_m: 0, kept: 0, raw: 0 };
  if (hasPath) {
    const sm = smoothPath(pathLatLon, elevationsM || [], Number(smoothM) || 0);
    route = sanitizeRoute({
      label,
      path: sm.path_latlon,
      elev: sm.elevations_m,
    });
    if (!route) {
      throw new Error('Shared route needs a path with at least two points.');
    }
    meta = { smooth_m: sm.tolerance_m, kept: sm.kept, raw: sm.raw };
  }
  const failInfo = sanitizeFailInfo(fail);
  return {
    v: SHARE_VERSION,
    pts,
    set: sanitizeSettingsMap(settings),
    route,
    fail: failInfo,
    _meta: meta,
  };
}

function bytesToBase64Url(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzipBytes(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser cannot decompress share link.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Encode blob to hash payload string (no leading #s=).
 * Retries with stronger RDP if over soft max (route shares only).
 * @returns {{ payload: string, warned: boolean, kept: number, raw: number, hasRoute: boolean }}
 */
export async function encodeSharePayload(blob) {
  const encodeOnce = async (b) => {
    const body = {
      v: b.v,
      pts: b.pts,
      set: b.set,
    };
    if (b.route) body.route = b.route;
    if (b.fail) body.fail = b.fail;
    const json = JSON.stringify(body);
    const rawBytes = new TextEncoder().encode(json);
    const gz = await gzipBytes(rawBytes);
    if (gz && gz.length < rawBytes.length) {
      // Prefix 'g' = gzip; 'u' = uncompressed utf-8
      return 'g' + bytesToBase64Url(gz);
    }
    return 'u' + bytesToBase64Url(rawBytes);
  };

  let payload = await encodeOnce(blob);
  let warned = false;
  let kept = blob._meta?.kept ?? (blob.route?.path?.length || 0);
  let raw = blob._meta?.raw ?? (blob.route?.path?.length || 0);

  if (blob.route && payload.length > SHARE_SOFT_MAX_CHARS) {
    const harder = smoothPath(blob.route.path, blob.route.elev, 25);
    const slim = {
      v: blob.v,
      pts: blob.pts,
      set: blob.set,
      route: sanitizeRoute({
        label: blob.route.label,
        path: harder.path_latlon,
        elev: harder.elevations_m,
      }),
      fail: blob.fail || null,
    };
    if (slim.route) {
      payload = await encodeOnce(slim);
      warned = true;
      kept = harder.kept;
      raw = harder.raw;
    }
  }

  if (payload.length > SHARE_SOFT_MAX_CHARS * 2) {
    throw new Error(
      `Share link is too large (${Math.round(payload.length / 1000)} k chars). ` +
        (blob.route
          ? 'Lower Alt. routes or raise Smooth GPX m, then try again.'
          : 'Simplify settings or remove waypoints, then try again.'),
    );
  }

  return { payload, warned, kept, raw, hasRoute: !!blob.route };
}

export async function decodeSharePayload(payload) {
  if (!payload || typeof payload !== 'string') {
    throw new Error('Empty share payload.');
  }
  const mode = payload[0];
  const body = payload.slice(1);
  if (mode !== 'g' && mode !== 'u') {
    throw new Error('Unrecognized share link format.');
  }
  let bytes = base64UrlToBytes(body);
  if (mode === 'g') bytes = await gunzipBytes(bytes);
  const text = new TextDecoder().decode(bytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Share link JSON is corrupt.');
  }
  return normalizeShareBlob(parsed);
}

export function normalizeShareBlob(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid share data.');
  }
  const v = Number(parsed.v) || 1;
  // Unknown newer version: still try known fields.
  const pts = sanitizePoints(parsed.pts);
  if (pts.length < 2) {
    throw new Error('Share link needs at least two waypoints.');
  }
  const set = sanitizeSettingsMap(parsed.set || {});
  const route = sanitizeRoute(parsed.route);
  const fail = sanitizeFailInfo(parsed.fail);
  return { v, pts, set, route, fail };
}

export function sharePayloadFromLocation(loc = window.location) {
  const hash = loc.hash || '';
  const m = /^#s=([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1] : null;
}

export function buildShareUrl(payload, loc = window.location) {
  const base = `${loc.origin}${loc.pathname}${loc.search}`;
  return `${base}#s=${payload}`;
}

export function stripShareHash(loc = window.location) {
  const url = `${loc.pathname}${loc.search}`;
  try {
    history.replaceState(null, '', url);
  } catch {
    /* ignore */
  }
}

/** Turn a normalized share blob into a minimal plan-result-like object for the UI. */
export function sharedResultFromBlob(blob, disclaimer) {
  if (!blob?.route?.path?.length) {
    throw new Error('Share link has no route geometry.');
  }
  const path = blob.route.path;
  const elev = blob.route.elev.map((z) => (z == null ? NaN : z));
  let distance_m = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const lat0 = ((a[0] + b[0]) / 2) * (Math.PI / 180);
    const mx = 111320 * Math.cos(lat0);
    distance_m += Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * mx);
  }
  return {
    path_latlon: path,
    elevations_m: elev,
    distance_m,
    cost: 0,
    max_sampled_uphill_deg: 0,
    waypoints: blob.pts.length,
    alternatives: [],
    disclaimer:
      disclaimer ||
      'UNVERIFIED shared candidate. Geometry from the link — Plan again to recompute on current DEM.',
    shared: true,
    options: null,
  };
}
