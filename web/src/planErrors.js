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

  if (/DataView|truncated|DEM decode|not a GeoTIFF|too large for a reliable|Terrain grid .+ too large|tile was truncated/i.test(msg)) {
    return {
      kind: 'terrain_fetch',
      title: 'Terrain download / decode failed',
      summary:
        'Elevation or hazard tiles could not be loaded. Large areas are fetched in batches automatically — this is usually a network/provider glitch or an extreme grid size.',
      detail: msg,
      fixes: [
        {
          id: 'retry',
          label: 'Plan again (retry download)',
          section: 'search',
        },
        {
          id: 'res',
          label: 'Increase Cell size m a little',
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
      ],
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis: null,
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
          label: 'Set that runout zone to Prefer around',
          section: 'hazards',
          fieldId: 'runoutLong',
        },
        {
          id: 'steep',
          label: 'Set NVE steep bands to Off (angles already limit steep ground)',
          section: 'hazards',
          fieldId: 'steep45',
        },
        {
          id: 'buffers',
          label: 'Lower Cushion around blocks m',
          section: 'hazards',
          fieldId: 'hazardBuf',
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
    const closedLeg = extras.closedLeg || null;
    const leg = extras.failedLeg || null;
    const legName = leg
      ? `${leg.fromLabel} → ${leg.toLabel}`
      : /to the goal/i.test(msg)
        ? 'last leg → End'
        : (() => {
            const m = msg.match(/to waypoint\s+(\d+)/i);
            return m ? `leg ending at Via ${m[1]}` : 'a route leg';
          })();
    const climbDeg = Number(extras.options?.max_uphill_deg);
    const terrainDeg = Number(extras.options?.max_terrain_deg);
    const pitchDeg = Number(extras.options?.pitch_deg);
    const climbVeryLow = Number.isFinite(climbDeg) && climbDeg < 8;
    const climbAlreadyHigh = Number.isFinite(climbDeg) && climbDeg >= 20;
    const pitchOff = Number.isFinite(pitchDeg) && pitchDeg <= 0;
    const terrainTight =
      Number.isFinite(terrainDeg) && terrainDeg <= 40 && climbAlreadyHigh;
    const terrainAlreadyLoose = Number.isFinite(terrainDeg) && terrainDeg >= 50;
    const topReason = closedLeg?.reasons?.[0]?.id;

    let title = `No route on ${legName}`;
    let summary;
    if (closedLeg?.summary) {
      summary = closedLeg.summary;
    } else if (diagnosis && !diagnosis.allClear) {
      summary = `Could not finish ${legName}. ${diagnosis.summary}`;
    } else if (climbVeryLow) {
      summary = `Could not finish ${legName}: Skin track max is only ${climbDeg}° — that Hard limit usually blocks any real ascent.`;
    } else if (pitchOff && climbAlreadyHigh) {
      summary = `Could not finish ${legName}: Kick-turn max is off (0°) with Skin track max ${climbDeg}° — every grid step must stay under Skin track max (no kick-turns).`;
    } else if (terrainTight) {
      summary = `Could not finish ${legName}: Ground slope max ${terrainDeg}° is likely sealing steep hillside cells between the points.`;
    } else {
      summary = `Could not finish ${legName}: start/vias/end look free, but Hard masks (ground slope / runout Block / NVE steep map Block) close the space between them.`;
    }

    const fixes = [];
    if (topReason === 'nve_steep') {
      fixes.push({
        id: 'steep',
        label: 'Set NVE steep bands to Off (Skin track / Ground slope already limit steep ground)',
        section: 'hazards',
        fieldId: 'steep45',
      });
      fixes.push({
        id: 'buffers',
        label: 'Lower Cushion around blocks m (if a buffer is sealing a narrow gap)',
        section: 'hazards',
        fieldId: 'hazardBuf',
      });
      fixes.push({
        id: 'via',
        label: `Add a via around the NVE steep map band on ${legName}`,
        section: 'start',
      });
    }
    if (topReason === 'fall_line') {
      fixes.push({
        id: 'terrain',
        label: `Raise Ground slope max ° (now ${terrainDeg}°)`,
        section: 'climb',
        fieldId: 'maxTerrain',
      });
    }
    if (pitchOff) {
      fixes.push({
        id: 'pitch',
        label: 'Set Kick-turn max ° > 0 (try 30–35; 0 often finds no alpine route)',
        section: 'climb',
        fieldId: 'pitchDeg',
      });
    }
    if (climbVeryLow || !climbAlreadyHigh) {
      fixes.push({
        id: 'uphill',
        label: climbVeryLow
          ? `Raise Skin track max ° (now ${climbDeg}° — try ~12–15° for skinning)`
          : 'Raise Skin track max °',
        section: 'climb',
        fieldId: 'maxUp',
      });
    }
    if (terrainTight && topReason !== 'fall_line') {
      fixes.push({
        id: 'terrain',
        label: `Raise Ground slope max ° (now ${terrainDeg}° — try 45–50 on alpine faces)`,
        section: 'climb',
        fieldId: 'maxTerrain',
      });
    }
    if (!pitchOff) {
      fixes.push({
        id: 'pitch',
        label: 'Raise Kick-turn max ° (or 0 = none)',
        section: 'climb',
        fieldId: 'pitchDeg',
      });
    }
    fixes.push(
      {
        id: 'corridor',
        label: 'Widen Corridor m',
        section: 'search',
        fieldId: 'corridor',
      },
      {
        id: 'via',
        label: topReason === 'nve_steep'
          ? 'Move Via points off / around the red NVE steep layer'
          : 'Add a via around the closed band',
        section: 'start',
      },
      {
        id: 'runout',
        label: 'Set blocked runout zone to Prefer around',
        section: 'hazards',
        fieldId: 'runoutLong',
      },
      {
        id: 'buffers',
        label: 'Lower Cushion around blocks m',
        section: 'hazards',
        fieldId: 'hazardBuf',
      },
      {
        id: 'downhill',
        label: 'Raise Allowed drop max ° (allow steeper dips on the climb)',
        section: 'climb',
        fieldId: 'maxDown',
      },
    );
    // Deduplicate by id keeping first (more specific) entry.
    const seen = new Set();
    const uniq = [];
    for (const f of fixes) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      uniq.push(f);
    }
    if (!uniq.some((f) => f.id === 'uphill')) {
      uniq.push({
        id: 'uphill',
        label: 'Raise Skin track max °',
        section: 'climb',
        fieldId: 'maxUp',
      });
    }
    if (!uniq.some((f) => f.id === 'terrain') && !terrainAlreadyLoose) {
      uniq.push({
        id: 'terrain',
        label: 'Raise Ground slope max °',
        section: 'climb',
        fieldId: 'maxTerrain',
      });
    }
    return {
      kind: 'no_path',
      title,
      summary,
      detail: msg,
      nodes,
      closedLeg,
      failedLeg: leg,
      fixes: uniq,
      map: { corridor: true, endpoints: true, reference: true },
      diagnosis,
    };
  }

  if (/start is masked/i.test(msg)) {
    return {
      kind: 'start_masked',
      title: 'Start is blocked',
      summary:
        'The start cell sits in a Hard mask (NVE steep map Block, runout Block, outside corridor, or missing elevation).',
      detail: msg,
      fixes: [
        { id: 'move', label: 'Move the start point on the map', section: 'start' },
        {
          id: 'steep',
          label: 'Set NVE steep bands to Off',
          section: 'hazards',
          fieldId: 'steep45',
        },
        {
          id: 'runout',
          label: 'Set blocked runout zone to Prefer around',
          section: 'hazards',
          fieldId: 'runoutLong',
        },
        {
          id: 'buffers',
          label: 'Lower Cushion around blocks m',
          section: 'hazards',
          fieldId: 'hazardBuf',
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
        'The end cell sits in a Hard mask (NVE steep map Block, runout Block, outside corridor, or missing elevation).',
      detail: msg,
      fixes: [
        { id: 'move', label: 'Move the end point on the map', section: 'start' },
        {
          id: 'steep',
          label: 'Set NVE steep bands to Off',
          section: 'hazards',
          fieldId: 'steep45',
        },
        {
          id: 'runout',
          label: 'Set blocked runout zone to Prefer around',
          section: 'hazards',
          fieldId: 'runoutLong',
        },
        {
          id: 'buffers',
          label: 'Lower Cushion around blocks m',
          section: 'hazards',
          fieldId: 'hazardBuf',
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
          id: 'steep',
          label: 'Set NVE steep bands to Off',
          section: 'hazards',
          fieldId: 'steep45',
        },
        {
          id: 'buffers',
          label: 'Lower Cushion around blocks m',
          section: 'hazards',
          fieldId: 'hazardBuf',
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
          label: 'Raise Skin track max °',
          section: 'climb',
          fieldId: 'maxUp',
        },
        {
          id: 'pitch',
          label: 'Enable / raise Kick-turn max °',
          section: 'climb',
          fieldId: 'pitchDeg',
        },
        {
          id: 'res',
          label: 'Use a finer Cell size m',
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
        label: 'Raise Skin track max °',
        section: 'climb',
        fieldId: 'maxUp',
      },
      {
        id: 'runout',
        label: 'Set blocked runout zone to Prefer around',
        section: 'hazards',
        fieldId: 'runoutLong',
      },
      {
        id: 'steep',
        label: 'Set NVE steep bands to Off',
        section: 'hazards',
        fieldId: 'steep45',
      },
    ],
    map: { corridor: true, endpoints: true, reference: true },
    diagnosis,
  };
}
