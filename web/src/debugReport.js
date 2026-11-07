/** Build a plain-text debug dump for why planning worked / failed. */

export function buildDebugText(ctx) {
  if (!ctx) return 'No debug context yet. Click Plan (or Diagnose) first.';
  const lines = [];
  lines.push('=== slakk debug ===');
  lines.push(`when: ${ctx.at || '—'}`);
  lines.push(`phase: ${ctx.phase || '—'}`);
  if (ctx.label) lines.push(`plan label: ${ctx.label}`);

  lines.push('');
  lines.push('--- settings ---');
  const o = ctx.options || {};
  for (const [k, v] of Object.entries(o)) {
    lines.push(`${k}: ${fmtSetting(v)}`);
  }

  if (ctx.grid) {
    const g = ctx.grid;
    lines.push('');
    lines.push('--- grid ---');
    lines.push(`size: ${g.width}×${g.height} (${(g.width * g.height).toLocaleString()} cells)`);
    lines.push(`ground_resolution_m: ${fmt(g.gs, 2)}`);
    lines.push(`resolution_m: ${fmt(g.resolution, 2)}`);
    lines.push(`corridor_m: ${fmt(g.corridor_m, 0)}`);
    if (g.bbox) lines.push(`bbox_merc: ${g.bbox.map((x) => fmt(x, 1)).join(', ')}`);
  }

  const reports = ctx.points || [];
  lines.push('');
  lines.push(`--- points (${reports.length}) ---`);
  if (!reports.length) {
    lines.push('(none)');
  } else {
    for (const r of reports) {
      const flag = r.ok ? 'OK' : 'BLOCKED';
      lines.push(
        `${r.label} [${flag}] ${fmt(r.lat, 6)},${fmt(r.lon, 6)}` +
          (r.cell && !r.cell.outside
            ? `  cell r${r.cell.r}/c${r.cell.c}`
            : r.cell?.outside
              ? '  (outside grid)'
              : ''),
      );
      lines.push(
        `  elev=${r.elev_m == null ? '—' : `${fmt(r.elev_m, 1)} m`}` +
          `  slope=${r.slope_deg == null ? '—' : `${fmt(r.slope_deg, 1)}°`}` +
          `  steep=${r.steep ? 'yes' : 'no'}` +
          `  runout=${r.runout ?? '—'}` +
          `  corridor_dist=${r.corridor_dist_m == null ? '—' : `${fmt(r.corridor_dist_m, 0)} m`}`,
      );
      if (r.issues?.length) lines.push(`  issues: ${r.issues.join('; ')}`);
    }
  }

  if (ctx.diagnosis) {
    lines.push('');
    lines.push('--- diagnosis ---');
    lines.push(ctx.diagnosis.allClear ? 'allClear: true' : 'allClear: false');
    lines.push(ctx.diagnosis.summary || '');
  }

  if (ctx.closedLeg) {
    const leg = ctx.closedLeg;
    lines.push('');
    lines.push('--- closed leg ---');
    lines.push(`${leg.fromLabel} → ${leg.toLabel}`);
    lines.push(leg.summary || '');
    if (leg.reasons?.length) {
      for (const r of leg.reasons) {
        lines.push(`  ${r.label}: ${r.pct}% (${r.count} samples)`);
      }
    }
  }

  if (ctx.error) {
    lines.push('');
    lines.push('--- last error ---');
    lines.push(`kind: ${ctx.error.kind || '—'}`);
    lines.push(`title: ${ctx.error.title || '—'}`);
    lines.push(`summary: ${ctx.error.summary || '—'}`);
    if (ctx.error.nodes != null) lines.push(`nodes_explored: ${ctx.error.nodes}`);
    if (ctx.error.detail) {
      lines.push('detail:');
      lines.push(ctx.error.detail);
    }
    if (ctx.error.fixes?.length) {
      lines.push('suggested fixes:');
      for (const f of ctx.error.fixes) lines.push(`  - ${f.label}`);
    }
  }

  if (ctx.result) {
    const r = ctx.result;
    lines.push('');
    lines.push('--- last result ---');
    lines.push(`status: ${r.status || 'ok'}${r.shared ? ' (from share link)' : ''}`);
    lines.push(`distance_m: ${fmt(r.distance_m, 0)}`);
    lines.push(`cost: ${fmt(r.cost, 1)}`);
    lines.push(`visited_nodes: ${r.visited_nodes ?? '—'}`);
    lines.push(`max_sampled_uphill_deg: ${fmt(r.max_sampled_uphill_deg, 2)}`);
    lines.push(`waypoints: ${r.waypoints ?? '—'}`);
    lines.push(`path_points: ${r.path_points ?? '—'}`);
    lines.push(`alternatives: ${r.alternatives ?? 0}`);
    if (r.ascent_m != null) lines.push(`ascent_m: ${fmt(r.ascent_m, 0)}`);
    if (r.descent_m != null) lines.push(`descent_m: ${fmt(r.descent_m, 0)}`);
  }

  if (ctx.hint) {
    lines.push('');
    lines.push('--- hint ---');
    lines.push(ctx.hint);
  }

  lines.push('');
  lines.push('(unverified planning draft — not a safe route)');
  return lines.join('\n');
}

function fmt(n, digits) {
  if (!Number.isFinite(n)) return '—';
  return Number(n).toFixed(digits);
}

function fmtSetting(v) {
  if (v == null) return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Short human hint when points are OK but search still fails. */
export function corridorClosedHint(diagnosis, options = {}) {
  if (diagnosis && !diagnosis.allClear) {
    return 'Fix the BLOCKED point(s) above (move them, or relax Runout/Corridor), then Plan again.';
  }
  const climb = Number(options.max_uphill_deg);
  const terrain = Number(options.max_terrain_deg);
  const pitch = Number(options.pitch_deg);
  if (Number.isFinite(climb) && climb < 8) {
    return (
      `Skin track max is only ${climb}° — that Hard ceiling blocks almost any real ascent ` +
      `(your vias climb hundreds of metres). Raise Skin track max ° toward ~12–15° (and optionally Kick-turn max °), then Plan again.`
    );
  }
  if (Number.isFinite(pitch) && pitch <= 0 && Number.isFinite(climb) && climb >= 15) {
    return (
      `Kick-turn max is off (0°) with Skin track max ${climb}° — every grid step must stay under Skin track max with no kick-turn allowance. ` +
      `That often finds no route on alpine legs / the coarse 10 m pass. Set Kick-turn max ° to ~30–35, then Plan again.`
    );
  }
  if (Number.isFinite(climb) && climb >= 20 && Number.isFinite(terrain) && terrain <= 40) {
    return (
      `Skin track max (${climb}°) is already generous; Ground slope max ${terrain}° likely Hard-blocks steep hillside cells ` +
      `between the points (DEM slope, not track grade). Raise Ground slope max ° toward 45–50, or add a via around the closed band.`
    );
  }
  const bits = [
    'Start/vias/end look free of Hard masks — the path between them is likely closed.',
    'Common fixes: enable Kick-turn max °, raise Ground slope max °, widen Corridor, set runout Block zones to Prefer around, or add vias around closed bands.',
  ];
  const sm = options.steep_modes;
  if (Array.isArray(sm) && sm.some((m) => m === 'avoid')) {
    bits.push(
      'Some NVE steep bands are Block (Hard) — set them to Off or Prefer around if Skin track / Ground slope already limit steep ground.',
    );
  }
  const modes = options.runout_modes;
  if (modes) {
    const avoided = ['short', 'medium', 'long'].filter((k) => modes[k] === 'avoid');
    if (avoided.length) bits.push(`Runout Block (Hard): ${avoided.join(', ')}.`);
  } else if (options.runout === 'avoid') {
    bits.push('Runout is currently Block (Hard).');
  }
  return bits.join(' ');
}
