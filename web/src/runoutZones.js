/**
 * NVE Bratthet med utløp runout classes (Varsom):
 * 1 short (dark blue), 2 medium, 3 long (light blue).
 * MapServer overlay layers: 2 / 3 / 4.
 *
 * Per-zone mode: avoid (Hard) | penalize/accept (Soft) | ignore.
 */

export const RUNOUT_CLASS = { short: 1, medium: 2, long: 3 };
export const RUNOUT_LAYER = { short: '2', medium: '3', long: '4' };
export const RUNOUT_MODE_VALUES = ['avoid', 'penalize', 'ignore'];

/** @typedef {'avoid'|'penalize'|'ignore'} RunoutZoneMode */
/** @typedef {{ short: RunoutZoneMode, medium: RunoutZoneMode, long: RunoutZoneMode }} RunoutModes */

function readMode(id, fallback = 'penalize', root = document) {
  const el = root.getElementById?.(id) || document.getElementById(id);
  const v = el?.value;
  return RUNOUT_MODE_VALUES.includes(v) ? v : fallback;
}

/** Read per-zone mode selects from the panel. */
export function runoutModesFromForm(root = document) {
  return {
    short: readMode('runoutShort', 'penalize', root),
    medium: readMode('runoutMedium', 'penalize', root),
    long: readMode('runoutLong', 'penalize', root),
  };
}

/** @deprecated alias — older call sites */
export function runoutZonesFromForm(root = document) {
  const m = runoutModesFromForm(root);
  return {
    short: m.short !== 'ignore',
    medium: m.medium !== 'ignore',
    long: m.long !== 'ignore',
  };
}

/** Mode for class 1/2/3. */
export function modeForClass(modes, cls) {
  if (cls === 1) return modes.short;
  if (cls === 2) return modes.medium;
  if (cls === 3) return modes.long;
  return 'ignore';
}

/** Compact label, e.g. "S:block M:prefer L:off". */
export function formatRunoutModes(modes) {
  const label = (m) =>
    m === 'penalize' ? 'prefer' : m === 'avoid' ? 'block' : m === 'ignore' ? 'off' : m;
  return `S:${label(modes.short)} M:${label(modes.medium)} L:${label(modes.long)}`;
}


/** @deprecated */
export function formatRunoutZones(zonesOrModes) {
  if (zonesOrModes && typeof zonesOrModes.short === 'string') {
    return formatRunoutModes(zonesOrModes);
  }
  const bits = [];
  if (zonesOrModes?.short) bits.push('S');
  if (zonesOrModes?.medium) bits.push('M');
  if (zonesOrModes?.long) bits.push('L');
  return bits.length ? bits.join('+') : 'none';
}

/** NVE exportImage layer ids for the map overlay (avoid + accept; not ignore). */
export function runoutOverlayLayerIds(modes = runoutModesFromForm()) {
  const ids = [];
  if (modes.short !== 'ignore') ids.push(RUNOUT_LAYER.short);
  if (modes.medium !== 'ignore') ids.push(RUNOUT_LAYER.medium);
  if (modes.long !== 'ignore') ids.push(RUNOUT_LAYER.long);
  return ids;
}

/**
 * Split raw runout classes into avoid mask, soft-cost classes, and active classes.
 * @param {Uint8Array|ArrayLike<number>} runoutClass
 * @param {RunoutModes} modes
 */
export function splitRunoutClass(runoutClass, modes) {
  const n = runoutClass.length;
  const avoidMask = new Uint8Array(n);
  const costClass = new Uint8Array(n);
  const activeClass = new Uint8Array(n);
  let hasAvoid = false;
  let hasPenalize = false;
  for (let i = 0; i < n; i++) {
    const c = runoutClass[i] | 0;
    if (c < 1 || c > 3) continue;
    const mode = modeForClass(modes, c);
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

/**
 * What to feed Wasm: soft-cost class raster + runout mode string.
 * When both avoid and accept are used, avoid cells are merged into the steep Hard mask.
 */
export function planRunoutStrategy(modes) {
  const hasAvoid =
    modes.short === 'avoid' || modes.medium === 'avoid' || modes.long === 'avoid';
  const hasPenalize =
    modes.short === 'penalize' ||
    modes.medium === 'penalize' ||
    modes.long === 'penalize';
  if (hasPenalize && hasAvoid) {
    return {
      runout: 'penalize',
      mergeAvoidIntoSteep: true,
      classSource: 'cost',
    };
  }
  if (hasAvoid) {
    return {
      runout: 'avoid',
      mergeAvoidIntoSteep: false,
      classSource: 'active',
    };
  }
  return {
    runout: 'penalize',
    mergeAvoidIntoSteep: false,
    classSource: 'cost',
  };
}

/**
 * Zero out ignored classes; keep avoid+accept (legacy helper).
 * Prefer splitRunoutClass for planning.
 */
export function maskRunoutClass(runoutClass, zonesOrModes) {
  const modes =
    zonesOrModes && typeof zonesOrModes.short === 'string'
      ? zonesOrModes
      : {
          short: zonesOrModes?.short ? 'penalize' : 'ignore',
          medium: zonesOrModes?.medium ? 'penalize' : 'ignore',
          long: zonesOrModes?.long ? 'penalize' : 'ignore',
        };
  const { activeClass } = splitRunoutClass(runoutClass, modes);
  return activeClass;
}
