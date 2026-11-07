/** Parse a recorded GPX track/route into [{lat,lon,ele?}, ...]. */

export function parseGpxTrack(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid GPX XML');
  }
  const trkpts = [...doc.querySelectorAll('trkseg trkpt')];
  if (trkpts.length >= 2) {
    // Prefer first continuous segment
    const segs = [...doc.querySelectorAll('trkseg')];
    if (segs.length > 1) {
      throw new Error('GPX has multiple track segments; export one continuous ascent.');
    }
    return trkpts.map(readPt);
  }
  const rte = [...doc.querySelectorAll('rtept')];
  if (rte.length >= 2) return rte.map(readPt);
  const wpt = [...doc.querySelectorAll('wpt')];
  if (wpt.length >= 2) return wpt.map(readPt);
  throw new Error('GPX needs a track, route, or at least two waypoints.');
}

function readPt(el) {
  const lat = Number(el.getAttribute('lat'));
  const lon = Number(el.getAttribute('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('GPX point missing lat/lon');
  }
  const eleEl = el.querySelector('ele');
  const ele = eleEl ? Number(eleEl.textContent) : NaN;
  return { lat, lon, ele };
}

/** Truncate track to goal: 'last' or 'highest' (needs elevations). */
export function truncateToGoal(track, goal) {
  if (goal === 'last' || track.length < 2) return track;
  let best = 0;
  let bestEle = -Infinity;
  for (let i = 0; i < track.length; i++) {
    const e = track[i].ele;
    if (Number.isFinite(e) && e > bestEle) {
      bestEle = e;
      best = i;
    }
  }
  if (best === 0) {
    throw new Error('Highest point is the start; use goal=last or a track with elevations.');
  }
  if (!Number.isFinite(bestEle)) {
    throw new Error('goal=highest needs elevations on every GPX point.');
  }
  return track.slice(0, best + 1);
}

export function trackToFlat(track) {
  const flat = new Float64Array(track.length * 2);
  track.forEach((p, i) => {
    flat[i * 2] = p.lat;
    flat[i * 2 + 1] = p.lon;
  });
  return flat;
}
