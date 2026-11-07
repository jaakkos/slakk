/** Classify plan failures into a clear title, explanation, and fix hints. */

/**
 * @typedef {{ id: string, label: string, section?: string, fieldId?: string }} PlanFix
 * @typedef {{
 *   kind: string,
 *   title: string,
 *   summary: string,
 *   detail: string,
 *   fixes: PlanFix[],
 *   map: { corridor: boolean, endpoints: boolean, reference: boolean },
 *   nodes?: number,
 * }} PlanErrorInfo
 */

export function classifyPlanError(raw, extras = {}) {
  const msg = String(raw || '').trim();
  const diagnosis = extras.diagnosis || null;
  const nodes = (() => {
    const m = msg.match(/after\s+(\d+)\s+nodes/i);
    return m ? Number(m[1]) : undefined;
  })();

  if (/DataView|truncated|DEM decode|not a GeoTIFF|too large for a reliable|Terrain grid .+ too large/i.test(msg)) {
    return {
      kind: 'terrain_fetch',
      title: 'Terrain download / decode failed',
      summary:
        'The elevation grid could not be loaded. This is usually a grid that is too large for the browser DEM service — not a specific via point.',
      detail: msg,
      fixes: [
        {
          id: 'res',
          label: 'Increase Resolution m (try 8–10)',
          section: 'search',
          fieldId: 'resolution',
        },
        {
          id: 'corridor',
          label: 'Reduce Corridor m',
          section: 'search',
          fieldId: 'corridor',
        },
        {
          id: 'points',
          label: 'Use fewer / closer points (shorter span)',
          section: 'start',
        },
        {
          id: 'hier',
          label: 'Keep Hierarchical on',
          section: 'search',
          fieldId: 'hierarchical',
        },
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/Blocked planning point/i.test(msg) || extras.pointBlocked) {
    const blocked = diagnosis?.blocked || [];
    return {
      kind: 'point_blocked',
      title: blocked.length === 1 ? `${blocked[0].label} is blocked` : 'Planning points are blocked',
      summary:
        diagnosis?.summary ||
        'One or more start/via/end points sit in a Hard mask, so search cannot begin.',
      detail: msg,
      fixes: [
        {
          id: 'move',
          label: 'Move or Remove the highlighted point(s)',
          section: 'start',
        },
        {
          id: 'runout',
          label: 'Set Runout to penalize (if on runout)',
          section: 'hazards',
          fieldId: 'runout',
        },
        {
          id: 'buffers',
          label: 'Lower Steep / Runout buffers',
          section: 'hazards',
          fieldId: 'steepBuf',
        },
        {
          id: 'corridor',
          label: 'Widen Corridor m (if outside corridor)',
          section: 'search',
          fieldId: 'corridor',
        },
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/no feasible path/i.test(msg)) {
    const toGoal = /to the goal/i.test(msg);
    const toWp = msg.match(/to waypoint\s+(\d+)/i);
    const target = toWp
      ? `waypoint ${toWp[1]}`
      : toGoal
        ? 'the end point'
        : 'the next stop';
    const pointNote = diagnosis
      ? diagnosis.allClear
        ? ' Start/vias/end themselves look free — the Hard masks close the space between them.'
        : ` ${diagnosis.summary}`
      : '';
    return {
      kind: 'no_path',
      title: 'No route found',
      summary: `The search could not reach ${target} under the current Hard limits.${pointNote}`,
      detail: msg,
      nodes,
      fixes: [
        {
          id: 'corridor',
          label: 'Widen Corridor m',
          section: 'search',
          fieldId: 'corridor',
        },
        {
          id: 'uphill',
          label: 'Raise Max uphill °',
          section: 'climb',
          fieldId: 'maxUp',
        },
        {
          id: 'pitch',
          label: 'Raise Pitch ° (or set 0 for strict)',
          section: 'climb',
          fieldId: 'pitchDeg',
        },
        {
          id: 'runout',
          label: 'Set Runout to penalize',
          section: 'hazards',
          fieldId: 'runout',
        },
        {
          id: 'buffers',
          label: 'Lower Steep / Runout buffers',
          section: 'hazards',
          fieldId: 'steepBuf',
        },
        {
          id: 'downhill',
          label: 'Raise Max downhill °',
          section: 'climb',
          fieldId: 'maxDown',
        },
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/start is masked/i.test(msg)) {
    return {
      kind: 'start_masked',
      title: 'Start is blocked',
      summary:
        'The start cell sits in a Hard mask (steep, runout-avoid, outside corridor, or missing elevation).',
      detail: msg,
      fixes: [
        { id: 'move', label: 'Move the start point on the map', section: 'start' },
        {
          id: 'runout',
          label: 'Set Runout to penalize',
          section: 'hazards',
          fieldId: 'runout',
        },
        {
          id: 'buffers',
          label: 'Lower Steep / Runout buffers',
          section: 'hazards',
          fieldId: 'steepBuf',
        },
        {
          id: 'corridor',
          label: 'Widen Corridor m',
          section: 'search',
          fieldId: 'corridor',
        },
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/destination is masked/i.test(msg)) {
    return {
      kind: 'end_masked',
      title: 'End is blocked',
      summary:
        'The end cell sits in a Hard mask (steep, runout-avoid, outside corridor, or missing elevation).',
      detail: msg,
      fixes: [
        { id: 'move', label: 'Move the end point on the map', section: 'start' },
        {
          id: 'runout',
          label: 'Set Runout to penalize',
          section: 'hazards',
          fieldId: 'runout',
        },
        {
          id: 'buffers',
          label: 'Lower Steep / Runout buffers',
          section: 'hazards',
          fieldId: 'steepBuf',
        },
        {
          id: 'corridor',
          label: 'Widen Corridor m',
          section: 'search',
          fieldId: 'corridor',
        },
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/waypoint .*masked/i.test(msg)) {
    return {
      kind: 'via_masked',
      title: 'A via point is blocked',
      summary: 'One of the intermediate points lies in a Hard mask.',
      detail: msg,
      fixes: [
        { id: 'move', label: 'Remove or move the via (Points list)', section: 'start' },
        {
          id: 'buffers',
          label: 'Lower Steep / Runout buffers',
          section: 'hazards',
          fieldId: 'steepBuf',
        },
        {
          id: 'corridor',
          label: 'Widen Corridor m',
          section: 'search',
          fieldId: 'corridor',
        },
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/dense validation|exceeding the slope/i.test(msg)) {
    return {
      kind: 'validation',
      title: 'Route failed final slope check',
      summary:
        'A path was found on the grid but dense validation still saw climbs steeper than allowed.',
      detail: msg,
      fixes: [
        {
          id: 'uphill',
          label: 'Raise Max uphill °',
          section: 'climb',
          fieldId: 'maxUp',
        },
        {
          id: 'pitch',
          label: 'Enable / raise Pitch °',
          section: 'climb',
          fieldId: 'pitchDeg',
        },
        {
          id: 'res',
          label: 'Use a finer Resolution m',
          section: 'search',
          fieldId: 'resolution',
        },
      ],
      map: { corridor: false, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/outside the area|cache covers|left the grid/i.test(msg)) {
    return {
      kind: 'bounds',
      title: 'Point outside the terrain grid',
      summary: 'A planning point falls outside the downloaded DEM window.',
      detail: msg,
      fixes: [
        { id: 'move', label: 'Move points closer together', section: 'start' },
        {
          id: 'corridor',
          label: 'Check Corridor m (larger area = bigger grid)',
          section: 'search',
          fieldId: 'corridor',
        },
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  return {
    kind: 'generic',
    title: 'Planning failed',
    summary: diagnosis?.summary || msg || 'Unknown error.',
    detail: msg,
    fixes: [
      {
        id: 'corridor',
        label: 'Widen Corridor m',
        section: 'search',
        fieldId: 'corridor',
      },
      {
        id: 'uphill',
        label: 'Raise Max uphill °',
        section: 'climb',
        fieldId: 'maxUp',
      },
      {
        id: 'runout',
        label: 'Set Runout to penalize',
        section: 'hazards',
        fieldId: 'runout',
      },
    ],
    map: { corridor: true, endpoints: true, reference: true },
    diagnosis,
  };
}
