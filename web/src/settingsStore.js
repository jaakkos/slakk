/**
 * Persist planner form settings in localStorage with forward-compatible schema.
 *
 * Rules:
 * - Only keys in SETTINGS_SCHEMA are written / applied.
 * - Unknown keys in storage are ignored (old or future extras).
 * - Invalid / out-of-range values are skipped → HTML defaults stay.
 * - Missing keys (new settings after an update) keep HTML defaults.
 * - Storage version can bump; migrate() upgrades older blobs before apply.
 */

export const SETTINGS_KEY = 'slakk.settings';
/** Bump when a breaking reshape of the blob is needed (not for adding keys). */
export const SETTINGS_VERSION = 1;

/**
 * @typedef {{ type: 'number', min?: number, max?: number }
 *   | { type: 'enum', values: string[] }
 *   | { type: 'string', maxLen?: number }} SettingSpec
 */

/** @type {Record<string, SettingSpec>} */
export const SETTINGS_SCHEMA = {
  place: { type: 'string', maxLen: 120 },
  gpxGoal: { type: 'enum', values: ['highest', 'last'] },
  keepFirst: { type: 'number', min: 0, max: 5000 },
  corridor: { type: 'number', min: 20, max: 3000 },
  resolution: { type: 'number', min: 1, max: 30 },
  hierarchical: { type: 'enum', values: ['on', 'off'] },
  alternatives: { type: 'number', min: 1, max: 5 },
  maxUp: { type: 'number', min: 1, max: 44 },
  maxDown: { type: 'number', min: 1, max: 44 },
  pitchDeg: { type: 'number', min: 0, max: 44 },
  descentCost: { type: 'number', min: 0, max: 50 },
  runout: { type: 'enum', values: ['avoid', 'penalize'] },
  landforms: { type: 'enum', values: ['on', 'off'] },
  steepBuf: { type: 'number', min: 0, max: 100 },
  runoutBuf: { type: 'number', min: 0, max: 200 },
  roughnessCost: { type: 'number', min: 0, max: 20 },
  roughnessThr: { type: 'number', min: 0.1, max: 3 },
  smoothM: { type: 'number', min: 0, max: 50 },
};

export function sanitizeValue(spec, raw) {
  if (raw == null) return null;
  if (spec.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return null;
    let v = n;
    if (spec.min != null && v < spec.min) v = spec.min;
    if (spec.max != null && v > spec.max) v = spec.max;
    return v;
  }
  if (spec.type === 'enum') {
    const s = String(raw);
    return spec.values.includes(s) ? s : null;
  }
  if (spec.type === 'string') {
    let s = String(raw).trim();
    if (spec.maxLen != null && s.length > spec.maxLen) s = s.slice(0, spec.maxLen);
    return s;
  }
  return null;
}

/** Keep only known keys with valid values (for share links / migrations). */
export function sanitizeSettingsMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const spec = SETTINGS_SCHEMA[id];
    if (!spec) continue;
    const cleaned = sanitizeValue(spec, value);
    if (cleaned != null) out[id] = cleaned;
  }
  return out;
}

/** Upgrade older storage shapes to the current version. */
export function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // Pre-version: plain map of id → value
  if (!('v' in parsed) && !('settings' in parsed)) {
    return { v: 1, settings: { ...parsed } };
  }

  let v = Number(parsed.v) || 1;
  let settings =
    parsed.settings && typeof parsed.settings === 'object' ? { ...parsed.settings } : {};

  // Future: if (v < 2) { ...; v = 2; }
  // Unknown newer version: still return settings map; apply() only uses known keys.
  if (v > SETTINGS_VERSION) {
    // Keep going — newer writers may have added keys we ignore safely.
  }

  return { v: Math.min(v, SETTINGS_VERSION), settings };
}

export function readStoredSettings() {
  let raw;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function collectSettingsFromDom(root = document) {
  const out = {};
  for (const [id, spec] of Object.entries(SETTINGS_SCHEMA)) {
    const el = root.getElementById?.(id) || document.getElementById(id);
    if (!el) continue;
    const cleaned = sanitizeValue(spec, el.value);
    if (cleaned != null) out[id] = cleaned;
  }
  return out;
}

export function applySettingsToDom(settings, root = document) {
  if (!settings || typeof settings !== 'object') return { applied: 0, skipped: 0 };
  let applied = 0;
  let skipped = 0;
  for (const [id, raw] of Object.entries(settings)) {
    const spec = SETTINGS_SCHEMA[id];
    if (!spec) {
      skipped += 1;
      continue;
    }
    const el = root.getElementById?.(id) || document.getElementById(id);
    if (!el) {
      skipped += 1;
      continue;
    }
    const cleaned = sanitizeValue(spec, raw);
    if (cleaned == null) {
      skipped += 1;
      continue;
    }
    el.value = String(cleaned);
    applied += 1;
  }
  return { applied, skipped };
}

export function saveSettings(settings = collectSettingsFromDom()) {
  const payload = {
    v: SETTINGS_VERSION,
    settings,
    updatedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Restore from storage; returns how many fields were applied. */
export function restoreSettings() {
  const blob = readStoredSettings();
  if (!blob?.settings) return { applied: 0, skipped: 0, restored: false };
  const result = applySettingsToDom(blob.settings);
  return { ...result, restored: result.applied > 0 };
}

/** Clear persisted settings and reset form fields to their HTML default attributes. */
export function resetSettingsToHtmlDefaults() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* ignore */
  }
  for (const id of Object.keys(SETTINGS_SCHEMA)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.tagName === 'SELECT') {
      const def = [...el.options].find((o) => o.defaultSelected) || el.options[0];
      if (def) el.value = def.value;
    } else if (el.defaultValue != null) {
      el.value = el.defaultValue;
    }
  }
}

export function bindSettingsAutosave({
  root = document.getElementById('panel'),
  debounceMs = 250,
  onSave = null,
} = {}) {
  if (!root) return () => {};
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const ok = saveSettings();
      onSave?.(ok);
    }, debounceMs);
  };
  const onChange = (e) => {
    const t = e.target;
    if (!t || !t.id) return;
    if (!SETTINGS_SCHEMA[t.id]) return;
    schedule();
  };
  root.addEventListener('change', onChange);
  root.addEventListener('input', onChange);
  return () => {
    clearTimeout(timer);
    root.removeEventListener('change', onChange);
    root.removeEventListener('input', onChange);
  };
}
