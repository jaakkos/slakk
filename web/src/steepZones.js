/**
 * NVE Bratthet steep colour bands (Varsom layer 1):
 * 1 yellow ~27–30°, 2 orange ~30–35°, 3 orange-red ~35–40°,
 * 4 red ~40–45°, 5 dark red ≥45°.
 *
 * Per-band mode: avoid (Hard/Block) | penalize (Soft/Prefer around) | ignore (Off).
 */

export const STEEP_CLASS = {
  band27: 1,
  band30: 2,
  band35: 3,
  band40: 4,
  band45: 5,
};
/** OR'd into the steep raster for runout-avoid cells when mixed with Soft runout. */
export const STEEP_FORCE_HARD = 6;

export const STEEP_BANDS = [
  { id: 'steep27', class: 1, label: '27–30°', swatch: '#ffff00' },
  { id: 'steep30', class: 2, label: '30–35°', swatch: '#ffaa00' },
  { id: 'steep35', class: 3, label: '35–40°', swatch: '#ff5500' },
  { id: 'steep40', class: 4, label: '40–45°', swatch: '#ff0000' },
  { id: 'steep45', class: 5, label: '≥45°', swatch: '#730000' },
];

export const STEEP_MODE_VALUES = ['avoid', 'penalize', 'ignore'];

/** Built-in Soft weights when Prefer around (milder yellow cheaper). */
export const STEEP_COST_DEFAULTS = [4, 8, 12, 16, 24];

/** @typedef {'avoid'|'penalize'|'ignore'} SteepBandMode */
/** @typedef {{ steep27: SteepBandMode, steep30: SteepBandMode, steep35: SteepBandMode, steep40: SteepBandMode, steep45: SteepBandMode }} SteepModes */

function readMode(id, fallback = 'ignore', root = document) {
  const el = root.getElementById?.(id) || document.getElementById(id);
  const v = el?.value;
  return STEEP_MODE_VALUES.includes(v) ? v : fallback;
}

/** Read per-band mode selects from the panel. Default Off (ignore). */
export function steepModesFromForm(root = document) {
  return {
    steep27: readMode('steep27', 'ignore', root),
    steep30: readMode('steep30', 'ignore', root),
    steep35: readMode('steep35', 'ignore', root),
    steep40: readMode('steep40', 'ignore', root),
    steep45: readMode('steep45', 'ignore', root),
  };
}

/** Ordered modes array for Wasm (index 0 = class 1). */
export function steepModesList(modes = steepModesFromForm()) {
  return [
    modes.steep27,
    modes.steep30,
    modes.steep35,
    modes.steep40,
    modes.steep45,
  ];
}

export function modeForSteepClass(modes, cls) {
  if (cls === 1) return modes.steep27;
  if (cls === 2) return modes.steep30;
  if (cls === 3) return modes.steep35;
  if (cls === 4) return modes.steep40;
  if (cls === 5) return modes.steep45;
  if (cls >= STEEP_FORCE_HARD) return 'avoid';
  return 'ignore';
}

/** Compact label, e.g. "27:off 30:prefer 45:block". */
export function formatSteepModes(modes) {
  const label = (m) =>
    m === 'penalize' ? 'prefer' : m === 'avoid' ? 'block' : m === 'ignore' ? 'off' : m;
  return STEEP_BANDS.map((b) => {
    const key = b.id;
    return `${b.label.replace('°', '')}:${label(modes[key])}`;
  }).join(' ');
}

export function anySteepActive(modes = steepModesFromForm()) {
  return steepModesList(modes).some((m) => m !== 'ignore');
}

export function anySteepAvoid(modes = steepModesFromForm()) {
  return steepModesList(modes).some((m) => m === 'avoid');
}

/**
 * Split raw steep classes into avoid mask, soft-cost classes, and active classes.
 * @param {Uint8Array|ArrayLike<number>} steepClass
 * @param {SteepModes} modes
 */
export function splitSteepClass(steepClass, modes) {
  const n = steepClass.length;
  const avoidMask = new Uint8Array(n);
  const costClass = new Uint8Array(n);
  const activeClass = new Uint8Array(n);
  let hasAvoid = false;
  let hasPenalize = false;
  for (let i = 0; i < n; i++) {
    const c = steepClass[i] | 0;
    if (c < 1 || c > 5) continue;
    const mode = modeForSteepClass(modes, c);
    if (mode === 'avoid') {
      avoidMask[i] = 1;
      activeClass[i] = c;
      hasAvoid = true;
    } else if (mode === 'penalize') {
      costClass[i] = c;
      activeClass[i] = c;
      hasPenalize = true;
    }
  }
  return { avoidMask, costClass, activeClass, hasAvoid, hasPenalize };
}
