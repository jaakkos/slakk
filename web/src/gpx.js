const DISCLAIMER =
  'UNVERIFIED WINTER PLANNING DRAFT. Bare-ground model only; no snow or forecast assessment.';

export function buildGpx(result, { smoothNote, trackName } = {}) {
  const pts = result.path_latlon || [];
  const elev = result.elevations_m || [];
  const base = result.disclaimer || DISCLAIMER;
  const desc = smoothNote ? `${base} ${smoothNote}` : base;
  const name = trackName || 'slakk-DRAFT';
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="slakk-web" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${escapeXml(name)}</name>`,
    `    <desc>${escapeXml(desc)}</desc>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${escapeXml(name)}</name>`,
    '    <type>hiking</type>',
    '    <trkseg>',
  ];
  for (let i = 0; i < pts.length; i++) {
    const [lat, lon] = pts[i];
    const el = elev[i];
    const ele =
      Number.isFinite(el) ? `\n        <ele>${el.toFixed(1)}</ele>` : '';
    lines.push(
      `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${ele}\n      </trkpt>`,
    );
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>');
  return lines.join('\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function downloadText(filename, text, mime = 'application/gpx+xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
