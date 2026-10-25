#!/usr/bin/env python3
"""Norwegian terrain-based ascent planning. Generates unverified GPX candidates."""
import argparse
import hashlib
import heapq
import io
import json
import math
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

if sys.version_info < (3, 11):
    sys.exit('route-cli needs Python 3.11 or later.')

import numpy as np
from PIL import Image, ImageDraw, ImageFont

VERSION = '0.2.0'

R = 6378137.0
DTM = 'https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage'
NVE = 'https://gis3.nve.no/arcgis/rest/services/wmts/Bratthet_med_utlop_2024/MapServer/export'
TOPO = 'https://wms.geonorge.no/skwms1/wms.topo'
STEEP_COLORS = {(255, 255, 0), (255, 170, 0), (255, 85, 0), (255, 0, 0), (115, 0, 0)}
RUNOUT_COLORS = {(0, 77, 168), (76, 155, 255), (154, 177, 230)}
ALTERNATIVE_BAND_M = 50
DISCLAIMER = ('UNVERIFIED WINTER PLANNING DRAFT. Bare-ground model only; no snow or '
              'forecast assessment. Streams, vegetation, access and turns need field checks. '
              'Mapped or unmodelled avalanche runout may affect the route. '
              'No guarantee of skinning without bootpacking. Ascent only.')


class NoRoute(ValueError):
    pass


def log(message):
    print(message, file=sys.stderr, flush=True)


def download(url, token=None):
    """Bounded HTTPS download. Tokens are headers only, never persisted or logged."""
    headers = {'User-Agent': 'route-cli/' + VERSION, 'Accept': '*/*'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=45) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            if len(data) > 64 * 1024 * 1024:
                raise ValueError('Service response exceeds 64 MiB; use a smaller area.')
            return data
        except HTTPError as exc:
            if exc.code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            if exc.code in (401, 403):
                raise ValueError(f'HTTP {exc.code}: access denied. Check token expiry and scopes.') from None
            raise ValueError(f'Service returned HTTP {exc.code}.') from None
        except (URLError, TimeoutError, OSError) as exc:
            raise ValueError(f'Download failed: {type(exc).__name__}. Check connectivity or use a cached area with --offline.') from None


def read_gpx(path):
    if path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError('GPX exceeds 50 MiB.')
    root = ET.parse(path).getroot()
    segments = [s for s in root.findall('.//{*}trkseg') if s.findall('{*}trkpt')]
    if segments:
        if len(segments) != 1:
            raise ValueError('Use a GPX with one continuous track segment; split disconnected tracks first.')
        nodes = segments[0].findall('{*}trkpt')
    else:
        routes = root.findall('.//{*}rte')
        if len(routes) != 1:
            raise ValueError('Expected one track segment or one GPX route.')
        nodes = routes[0].findall('{*}rtept')
    points = []
    for node in nodes:
        ele = node.find('{*}ele')
        points.append([float(node.attrib['lon']), float(node.attrib['lat']),
                       float(ele.text) if ele is not None else float('nan')])
    a = np.array(points, dtype=float)
    if len(a) < 2 or len(a) > 100000:
        raise ValueError('Expected 2–100,000 GPX points.')
    if not np.isfinite(a[:, :2]).all() or np.any(abs(a[:, 0]) > 180) or np.any(abs(a[:, 1]) > 80):
        raise ValueError('Invalid coordinates or location outside supported Mercator latitude range.')
    return a


def mercator(lonlat):
    return np.column_stack([R * np.radians(lonlat[:, 0]),
                            R * np.log(np.tan(np.pi / 4 + np.radians(lonlat[:, 1]) / 2))])


def longitude_latitude(xy):
    return np.column_stack([np.degrees(xy[:, 0] / R),
                            np.degrees(2 * np.arctan(np.exp(xy[:, 1] / R)) - np.pi / 2)])


def cumulative(q, scale=1):
    return np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(q, axis=0), axis=1) * scale)]


def resample(q, spacing, scale):
    distance = cumulative(q, scale)
    keep = np.r_[True, np.diff(distance) > 1e-8]
    if distance[-1] < 1e-6:
        raise ValueError('Track has no horizontal extent.')
    positions = np.r_[np.arange(0, distance[-1], spacing), distance[-1]]
    return positions, np.column_stack([np.interp(positions, distance[keep], q[keep, i]) for i in range(2)])


def write_gpx(path, lonlat, elevations, name, description):
    ns = 'http://www.topografix.com/GPX/1/1'
    ET.register_namespace('', ns)
    root = ET.Element('{' + ns + '}gpx', version='1.1', creator='route-cli/' + VERSION)
    metadata = ET.SubElement(root, 'metadata')
    ET.SubElement(metadata, 'name').text = name
    ET.SubElement(metadata, 'desc').text = description
    track = ET.SubElement(root, 'trk')
    ET.SubElement(track, 'name').text = name
    ET.SubElement(track, 'desc').text = description
    segment = ET.SubElement(track, 'trkseg')
    for (lon, lat), elevation in zip(lonlat, elevations):
        node = ET.SubElement(segment, 'trkpt', lat=f'{lat:.7f}', lon=f'{lon:.7f}')
        if np.isfinite(elevation):
            ET.SubElement(node, 'ele').text = f'{elevation:.2f}'
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding='utf-8', xml_declaration=True)


def fetch_strava(args):
    if args.output.exists():
        raise ValueError('Output already exists; choose another file.')
    token = os.environ.get(args.token_env)
    if not token:
        raise ValueError(f'Set {args.token_env} to a Strava access token. Do not pass the token as a command argument.')
    url = f'https://www.strava.com/api/v3/activities/{args.activity_id}/streams?'
    streams = json.loads(download(url + urlencode({'keys': 'latlng,altitude', 'key_by_type': 'true'}), token))
    latlng = streams.get('latlng', {}).get('data', [])
    elevations = streams.get('altitude', {}).get('data', [])
    if len(latlng) < 2 or len(latlng) != len(elevations):
        raise ValueError('Activity has missing or mismatched location/elevation streams.')
    coords = np.asarray(latlng, dtype=float)
    heights = np.asarray(elevations, dtype=float)
    if coords.shape != (len(heights), 2) or not np.isfinite(coords).all() or not np.isfinite(heights).all():
        raise ValueError('Strava returned invalid streams.')
    if np.any(abs(coords[:, 0]) > 90) or np.any(abs(coords[:, 1]) > 180):
        raise ValueError('Strava returned invalid coordinates.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_gpx(args.output, coords[:, ::-1], heights, f'Strava activity {args.activity_id}',
              f'Location/elevation streams from Strava activity {args.activity_id}. '
              'Reconstructed GPX, not the original device export. No timestamps or fitness telemetry.')
    print(args.output.resolve())


def get_terrain(points, args):
    cache = args.cache
    manifest = cache / 'manifest.json'
    if manifest.exists():
        grid = json.loads(manifest.read_text())
        if grid.get('provider') != 'kartverket-nve-v1':
            raise ValueError('Unsupported terrain-cache format.')
        log(f'Using cached terrain: {grid["ground_resolution"]:.2f} m cells (cache controls resolution).')
        return Terrain(cache, grid)
    if args.offline:
        raise ValueError('No terrain cache. Run once online without --offline.')
    xy = mercator(points[:, :2])
    scale = math.cos(math.radians(float(points[:, 1].mean())))
    if np.ptp(xy, axis=0).max() * scale > 25000:
        raise ValueError('Use a local route spanning at most 25 km; split longer routes first.')
    resolution = args.resolution_m / scale
    margin = (args.corridor_m + 150) / scale
    low = np.floor((xy.min(axis=0) - margin) / resolution) * resolution
    high = np.ceil((xy.max(axis=0) + margin) / resolution) * resolution
    width, height = np.rint((high - low) / resolution).astype(int)
    if width * height > 1_500_000 or max(width, height) > 4096:
        raise ValueError('Requested grid is too large. Increase --resolution-m or reduce --corridor-m.')
    grid = {'provider': 'kartverket-nve-v1', 'bbox': [*low.tolist(), *high.tolist()],
            'width': int(width), 'height': int(height), 'resolution': resolution,
            'scale': scale, 'ground_resolution': resolution * scale,
            'retrieved_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    base = {'bbox': ','.join(map(str, grid['bbox'])), 'bboxSR': 3857, 'imageSR': 3857,
            'size': f'{width},{height}', 'f': 'image'}
    requests = {
        'dem.tiff': DTM + '?' + urlencode(dict(base, format='tiff', pixelType='F32',
            interpolation='RSP_BilinearInterpolation', renderingRule=json.dumps({'rasterFunction': 'None'}))),
        'hazards.png': NVE + '?' + urlencode(dict(base, format='png32', transparent='true', layers='show:1,2,3,4')),
        'topo.png': TOPO + '?' + urlencode({'service': 'WMS', 'request': 'GetMap', 'version': '1.3.0',
            'crs': 'EPSG:3857', 'bbox': base['bbox'], 'layers': 'topo', 'styles': '',
            'width': width, 'height': height, 'format': 'image/png'}),
    }
    cache.mkdir(parents=True, exist_ok=True)
    for name, url in requests.items():
        log(f'Downloading {name} ({width} × {height})…')
        data = download(url)
        try:
            with Image.open(io.BytesIO(data)) as im:
                im.verify()
        except Exception:
            raise ValueError(f'{name}: service returned an invalid image. Check provider availability/coverage.') from None
        (cache / name).write_bytes(data)
    grid['requests'] = requests
    # Commit the cache manifest only after all files are usable.
    terrain = Terrain(cache, grid)
    manifest.write_text(json.dumps(grid, indent=2))
    return terrain


class Terrain:
    def __init__(self, cache, grid):
        self.cache, self.grid = cache, grid
        self.bbox = np.asarray(grid['bbox'], dtype=float)
        self.res, self.gs = float(grid['resolution']), float(grid['ground_resolution'])
        if self.res <= 0 or self.gs <= 0 or not np.isfinite(self.bbox).all():
            raise ValueError('Invalid cache grid metadata.')
        with Image.open(cache / 'dem.tiff') as im:
            if im.mode != 'F':
                raise ValueError('Expected floating-point elevation TIFF, not a rendered height image.')
            self.z = np.array(im, dtype=float)
            # Validate spatial registration if GeoTIFF tags are available.
            pixel, tie = im.tag_v2.get(33550), im.tag_v2.get(33922)
            if pixel and not np.allclose(pixel[:2], [self.res, self.res], rtol=1e-5):
                raise ValueError('DEM resolution disagrees with cache manifest.')
            if tie and not np.allclose(tie[3:5], [self.bbox[0], self.bbox[3]], atol=0.01, rtol=0):
                raise ValueError('DEM origin disagrees with cache manifest.')
        self.h, self.w = self.z.shape
        if [self.w, self.h] != [grid['width'], grid['height']] or self.h * self.w > 1_500_000:
            raise ValueError('Invalid or oversized cached DEM dimensions.')
        if not np.allclose([self.w * self.res, self.h * self.res], self.bbox[2:] - self.bbox[:2]):
            raise ValueError('Cache bounds do not match the raster grid.')
        self.invalid = ~np.isfinite(self.z) | (self.z < -100) | (self.z > 3000)
        zsafe = np.where(self.invalid, 0, self.z)
        self.slope = np.degrees(np.arctan(np.hypot(*np.gradient(zsafe, self.gs))))
        with Image.open(cache / 'hazards.png') as im:
            rgba = np.asarray(im.convert('RGBA'))
        if rgba.shape[:2] != self.z.shape:
            raise ValueError('NVE raster dimensions do not match DEM.')
        self.steep = np.zeros(self.z.shape, bool)
        self.runout = np.zeros(self.z.shape, bool)
        known = rgba[:, :, 3] == 0
        for palette, mask in [(STEEP_COLORS, self.steep), (RUNOUT_COLORS, self.runout)]:
            for color in palette:
                pixels = (rgba[:, :, :3] == color).all(axis=2) & (rgba[:, :, 3] > 0)
                mask |= pixels
                known |= pixels
        if not known.all():
            raise ValueError('NVE image contains unknown colours. Review the provider palette; refusing to ignore them.')
        with Image.open(cache / 'topo.png') as im:
            if not math.isclose(im.width/im.height, self.w/self.h, rel_tol=0.001):
                raise ValueError('Topographic image aspect ratio does not match terrain bounds.')

    def rc(self, lonlat):
        xy = mercator(lonlat)
        return np.column_stack([(self.bbox[3] - xy[:, 1]) / self.res - .5,
                                (xy[:, 0] - self.bbox[0]) / self.res - .5])

    def lonlat(self, rc):
        return longitude_latitude(np.column_stack([self.bbox[0] + (rc[:, 1] + .5) * self.res,
                                                   self.bbox[3] - (rc[:, 0] + .5) * self.res]))

    def sample(self, q):
        if not np.isfinite(q).all() or np.any(q < 0) or np.any(q[:, 0] >= self.h - 1) or np.any(q[:, 1] >= self.w - 1):
            raise ValueError('Track extends outside usable cached terrain. Use a new cache for this area.')
        r0, c0 = np.floor(q).astype(int).T
        dr, dc = (q - np.floor(q)).T
        values = [self.z[r0, c0], self.z[r0 + 1, c0], self.z[r0, c0 + 1], self.z[r0 + 1, c0 + 1]]
        if any(np.any(~np.isfinite(v) | (v < -100) | (v > 3000)) for v in values):
            raise ValueError('Missing elevation coverage along the track.')
        return values[0]*(1-dr)*(1-dc)+values[1]*dr*(1-dc)+values[2]*(1-dr)*dc+values[3]*dr*dc


def read_areas(path):
    """Outer rings of GeoJSON Polygon/MultiPolygon features as [lon, lat] arrays. Holes are ignored, so they stay excluded."""
    data = json.loads(path.read_text())
    features = data.get('features', [data]) if data.get('type') == 'FeatureCollection' else [data]
    rings = []
    for feature in features:
        geometry = feature.get('geometry', feature) if feature.get('type') == 'Feature' else feature
        kind = (geometry or {}).get('type')
        if kind == 'Polygon':
            polygons = [geometry['coordinates']]
        elif kind == 'MultiPolygon':
            polygons = geometry['coordinates']
        else:
            raise ValueError(f'{path}: only Polygon and MultiPolygon areas are supported, not {kind}.')
        for polygon in polygons:
            ring = np.asarray(polygon[0], dtype=float)
            if ring.ndim != 2 or len(ring) < 4 or not np.isfinite(ring[:, :2]).all() or np.any(abs(ring[:, 1]) > 80):
                raise ValueError(f'{path}: invalid polygon ring.')
            rings.append(ring[:, :2])
    if not rings:
        raise ValueError(f'{path}: no areas found.')
    return rings


def area_mask(terrain, rings):
    """Rasterize exclusion areas; any touched cell is excluded, plus one cell of margin."""
    image = Image.new('1', (terrain.w, terrain.h), 0)
    draw = ImageDraw.Draw(image)
    for ring in rings:
        rc = terrain.rc(ring)
        draw.polygon([(float(c), float(r)) for r, c in rc], fill=1, outline=1)
    mask = dilate(np.array(image, bool), 1)
    if not mask.any():
        log('Warning: no --avoid area overlaps the terrain grid.')
    return mask


def dilate(mask, radius):
    result = mask.copy()
    for _ in range(radius):
        padded = np.pad(result, 1, constant_values=False)
        result = np.logical_or.reduce([padded[i:i+mask.shape[0], j:j+mask.shape[1]] for i in range(3) for j in range(3)])
    return result


def shift(a, dr, dc):
    return np.roll(np.roll(a, -dr, axis=0), -dc, axis=1)


def edge_options(terrain, blocked, args):
    """Precompute traversable edge profiles, including intermediate elevations."""
    dirs = [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1),
            (2,1),(2,-1),(-2,1),(-2,-1),(1,2),(1,-2),(-1,2),(-1,-2)]
    for dr, dc in dirs:
        length = math.hypot(dr, dc) * terrain.gs
        allowed = ~blocked.copy()
        for r in range(min(0, dr), max(0, dr) + 1):
            for c in range(min(0, dc), max(0, dc) + 1):
                allowed &= ~shift(blocked, r, c)
        previous = terrain.z
        for fraction in [.25, .5, .75, 1.]:
            rr, cc = dr * fraction, dc * fraction
            ri, ci = math.floor(rr), math.floor(cc)
            a, b = rr - ri, cc - ci
            height = (shift(terrain.z,ri,ci)*(1-a)*(1-b) + shift(terrain.z,ri+1,ci)*a*(1-b)
                      + shift(terrain.z,ri,ci+1)*(1-a)*b + shift(terrain.z,ri+1,ci+1)*a*b)
            grade = (height - previous) / (length / 4)
            allowed &= np.isfinite(grade) & (grade <= math.tan(math.radians(args.max_uphill_deg)))
            allowed &= grade >= -math.tan(math.radians(args.max_downhill_deg))
            previous = height
        yield dr, dc, length, allowed


def search(terrain, transitions, nearest, runout, args, start, goal, extra=None):
    """A* between two cells; returns the cell path, visited count and cost."""
    costs = np.full(terrain.z.shape, np.inf)
    previous = np.full(terrain.z.shape, -1, np.int32)
    costs[start] = 0
    heap = [(math.hypot(start[0]-goal[0], start[1]-goal[1])*terrain.gs, 0., *start)]
    visited = 0
    while heap:
        _, cost, r, c = heapq.heappop(heap)
        if cost > costs[r, c] + 1e-9:
            continue
        visited += 1
        if (r, c) == goal:
            break
        for dr, dc, length, allowed in transitions:
            if not allowed[r, c]:
                continue
            nr, nc = r + dr, c + dc
            grade = float(terrain.z[nr, nc] - terrain.z[r, c]) / length
            weight = 1 + 6 * max(0, grade-.12)**2 + 10 * max(0, -grade) + nearest[nr, nc] / args.corridor_m
            if args.runout == 'penalize' and runout[nr, nc]:
                weight += args.runout_cost
            if extra is not None:
                weight += extra[nr, nc]
            value = cost + length * weight
            if value < costs[nr, nc]:
                costs[nr, nc] = value
                previous[nr, nc] = r * terrain.w + c
                heuristic = math.hypot(nr-goal[0], nc-goal[1]) * terrain.gs
                heapq.heappush(heap, (value + heuristic, value, nr, nc))
    if not np.isfinite(costs[goal]):
        return None, visited, math.inf
    route, at = [goal], goal
    while at != start:
        at = divmod(int(previous[at]), terrain.w)
        route.append(at)
    route = np.asarray(route[::-1], float)
    # Remove only exactly collinear vertices; never shortcut across masked terrain.
    if len(route) > 2:
        v = np.diff(route, axis=0)
        bends = v[:-1,0]*v[1:,1] - v[:-1,1]*v[1:,0]
        route = route[np.r_[True, (bends != 0) | ((v[:-1]*v[1:]).sum(axis=1) <= 0), True]]
    return route, visited, float(costs[goal])


def solve(terrain, reference, args, waypoints=(), avoid=None):
    """Route from the end of the preserved approach through each waypoint, in order, to the goal."""
    return solve_many(terrain, reference, args, waypoints, avoid, 1)[0]


def solve_many(terrain, reference, args, waypoints=(), avoid=None, count=1):
    """Best candidate first, then up to count-1 distinct alternatives meeting the same hard constraints.

    Alternatives come from re-searching with an added cost near earlier candidates; the
    first search has no added cost, so it is identical to a single-candidate run."""
    distance = cumulative(reference, terrain.gs)
    keep = int(np.searchsorted(distance, args.keep_first_m))
    if keep >= len(reference) - 1:
        raise ValueError('--keep-first-m must be shorter than the selected ascent.')
    start, goal = tuple(np.rint(reference[keep]).astype(int)), tuple(np.rint(reference[-1]).astype(int))
    rows, cols = np.indices(terrain.z.shape)
    nearest = np.full(terrain.z.shape, np.inf)
    nearest_col = np.zeros(terrain.z.shape)
    _, samples = resample(reference, max(terrain.gs, 10), terrain.gs)
    for r, c in samples:
        dsq = (rows-r)**2 + (cols-c)**2
        closer = dsq < nearest
        nearest[closer] = dsq[closer]
        nearest_col[closer] = c
    nearest = np.sqrt(nearest) * terrain.gs
    blocked = dilate(terrain.invalid, 1) | (terrain.slope > args.max_terrain_deg)
    blocked |= dilate(terrain.steep, math.ceil(args.steep_buffer_m / terrain.gs))
    blocked |= nearest > args.corridor_m
    if args.side == 'east':
        blocked |= cols < nearest_col - args.side_tolerance_m / terrain.gs
    if args.side == 'west':
        blocked |= cols > nearest_col + args.side_tolerance_m / terrain.gs
    if avoid is not None:
        blocked |= avoid
    runout = dilate(terrain.runout, math.ceil(args.runout_buffer_m / terrain.gs))
    if args.runout == 'avoid':
        blocked |= runout
    blocked[:3] = blocked[-3:] = True
    blocked[:, :3] = blocked[:, -3:] = True
    if blocked[start] or blocked[goal]:
        raise NoRoute('A search endpoint is masked by a constraint (or an --avoid area). Inspect it; constraints were not relaxed.')
    stops = [tuple(np.rint(w).astype(int)) for w in waypoints]
    for number, cell in enumerate(stops, 1):
        if blocked[cell]:
            raise NoRoute(f'Waypoint {number} is masked by a constraint or lies outside the corridor. Constraints were not relaxed.')
    transitions = list(edge_options(terrain, blocked, args))
    band = max(1, math.ceil(ALTERNATIVE_BAND_M / terrain.gs))
    extra, found, notes = np.zeros(terrain.z.shape), [], []
    for attempt in range(1 if count == 1 else 2 * count):
        try:
            candidate, info = route_legs(terrain, reference, keep, distance, start, goal, stops, waypoints,
                                         transitions, nearest, runout, blocked, args, extra if found else None)
            if count == 1:
                return [(candidate, info)]
        except NoRoute as exc:
            if not found:
                raise
            notes.append(f'Attempt {attempt + 1}: {exc}')
            break
        cells = np.rint(resample(candidate, .5, 1)[1]).astype(int)
        near = np.zeros(terrain.z.shape, bool)
        near[cells[:, 0], cells[:, 1]] = True
        near = dilate(near, band)
        if found:
            shared = max(float(earlier[cells[:, 0], cells[:, 1]].mean()) for earlier in bands)
            if shared > 0.9:
                notes.append(f'Attempt {attempt + 1}: more than 90% within {ALTERNATIVE_BAND_M} m of an earlier candidate; discarded.')
                extra += near
                continue
            info['shared_with_earlier'] = round(shared, 3)
            bands.append(near)
        else:
            bands = [near]
        found.append((candidate, info))
        extra += near
        if len(found) == count:
            break
    if count > 1:
        found[0][1]['alternative_notes'] = notes
    return found


def route_legs(terrain, reference, keep, distance, start, goal, stops, waypoints, transitions, nearest, runout, blocked, args, extra):
    route, at, visited, total = [start], start, 0, 0.
    for number, (target, exact) in enumerate(zip(stops + [goal], [*waypoints, None]), 1):
        leg, count, cost = search(terrain, transitions, nearest, runout, args, at, target, extra)
        visited += count
        if leg is None:
            where = f'waypoint {number}' if exact is not None else 'the goal'
            raise NoRoute(f'No feasible path to {where} in this grid/corridor after {visited} nodes. Constraints were not relaxed.')
        if exact is not None:
            leg[-1] = exact  # pass through the exact waypoint, not just its cell
        route.extend(leg[1:])
        at, total = target, total + cost
    route = np.asarray(route, float)
    candidate = np.vstack([reference[:keep+1], route, reference[-1]])
    candidate = candidate[np.r_[True, np.linalg.norm(np.diff(candidate,axis=0),axis=1) > 1e-8]]
    # Full candidate validation includes the preserved approach and endpoint connectors.
    positions, dense = resample(candidate, min(1, terrain.gs/4), terrain.gs)
    ij = np.rint(dense).astype(int)
    if blocked[ij[:,0], ij[:,1]].any():
        raise NoRoute('The preserved approach, a waypoint join or an endpoint connector violates a hard constraint. No GPX emitted.')
    heights = terrain.sample(dense)
    angles = np.degrees(np.arctan(np.diff(heights)/np.diff(positions)))
    if angles.max() > args.max_uphill_deg + .15 or angles.min() < -args.max_downhill_deg - .15:
        raise NoRoute('Dense validation found a short section exceeding the slope limits (possibly a connector, waypoint join or preserved approach). No GPX emitted.')
    return candidate, {'visited_nodes': visited, 'cost': total, 'preserved_m': float(distance[keep]), 'waypoints': len(stops),
                       'max_sampled_uphill_deg': float(angles.max()), 'validation_spacing_m': min(1, terrain.gs/4)}


def metrics(terrain, q):
    positions, dense = resample(q, 5, terrain.gs)
    height = terrain.sample(dense)
    ij = np.rint(dense).astype(int)
    weights = np.diff(positions)
    stats = {'distance_m': round(float(positions[-1]), 1),
             'ascent_m': round(float(np.maximum(np.diff(height), 0).sum()), 1),
             'nve_steep_m': round(float(weights @ terrain.steep[ij[:-1,0],ij[:-1,1]]), 1),
             'nve_runout_m': round(float(weights @ terrain.runout[ij[:-1,0],ij[:-1,1]]), 1)}
    if positions[-1] >= 50:
        start = positions[positions <= positions[-1] - 50]
        change = np.interp(start+50, positions, height)-np.interp(start, positions, height)
        angles = np.degrees(np.arctan(change/50))
        stats.update(max_50m_deg=round(float(angles.max()), 2), p95_50m_deg=round(float(np.percentile(angles,95)), 2))
    return stats


def draw_map(terrain, original, candidate, output, legend='Teal: recorded | Orange: candidate'):
    with Image.open(terrain.cache / 'topo.png') as source:
        image = source.convert('RGB')
    image.thumbnail((1400, 1800))
    sx, sy = image.width/terrain.w, image.height/terrain.h
    draw = ImageDraw.Draw(image)
    if isinstance(candidate, np.ndarray):
        candidate = [candidate]
    colors = ['#c44300', '#7b3fa0', '#2b59c3', '#2e7d32', '#8d6e00']
    # Draw alternatives first so the best candidate stays on top.
    for q, color in [(original, '#087f8c'), *reversed(list(zip(candidate, colors)))]:
        line = [(float((c+.5)*sx),float((r+.5)*sy)) for r,c in q]
        draw.line(line, fill='white', width=7)
        draw.line(line, fill=color, width=4)
    canvas = Image.new('RGB', (max(520,image.width), image.height+110), 'white')
    canvas.paste(image,((canvas.width-image.width)//2,75))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=16)
    draw.text((10,8),'UNVERIFIED ascent draft',font=font,fill='#162b32')
    draw.text((10,31),legend,font=font,fill='#162b32')
    draw.text((10,image.height+82),'Map: Kartverket CC BY 4.0',font=font,fill='#162b32')
    canvas.save(output)


def optimize(args):
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError('Output directory is not empty; choose a new directory to avoid stale/overwritten GPX files.')
    if any(not math.isfinite(v) for v in vars(args).values() if isinstance(v,float)):
        raise ValueError('Numeric options must be finite.')
    if not 2 <= args.resolution_m <= 30 or not 20 <= args.corridor_m <= 3000:
        raise ValueError('Use resolution 2–30 m and corridor 20–3000 m.')
    if not 0 < args.max_uphill_deg < 45 or not 0 < args.max_downhill_deg < 45 or not 0 < args.max_terrain_deg < 80:
        raise ValueError('Invalid angle limit.')
    if min(args.keep_first_m,args.steep_buffer_m,args.runout_buffer_m,args.runout_cost,args.side_tolerance_m) < 0:
        raise ValueError('Distances, buffers and cost must be nonnegative.')
    if args.input and (args.start or args.end):
        raise ValueError('Give either a recorded GPX or --start and --end, not both.')
    if not args.input and not (args.start and args.end):
        raise ValueError('Give a recorded GPX, or both --start and --end.')
    if not args.input and (args.goal or args.keep_first_m):
        raise ValueError('--goal and --keep-first-m need a recorded GPX.')
    vias = np.array([[lon, lat, np.nan] for lat, lon in args.via or []]).reshape(-1, 3)
    args.areas = [read_areas(path) for path in args.avoid or []]
    if not args.input:
        return plan_between(args, vias)
    args.goal = args.goal or 'highest'
    track = read_gpx(args.input)
    if args.goal == 'highest':
        if not np.isfinite(track[:,2]).all():
            raise ValueError('--goal highest needs elevations at every GPX point; use --goal last for an ascent-only track.')
        stop = int(np.argmax(track[:,2]))
        if stop == 0:
            raise ValueError('Highest point is the start; supply an uphill track or use --goal last.')
    else:
        stop = len(track)-1
    selected = track[:stop+1]
    terrain = get_terrain(np.vstack([selected, vias]), args)
    original = terrain.rc(selected[:,:2])
    terrain.sample(original)
    terrain.sample(terrain.rc(vias[:,:2]))
    report = {'status': 'unverified_candidate', 'disclaimer': DISCLAIMER, 'mode': 'gpx',
              'input_sha256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
              'goal_index_zero_based': stop, 'options': options(args), 'avoid_sha256': {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in args.avoid or []},
              'terrain': terrain.grid, 'original': metrics(terrain, original),
              'limits': ['Norwegian map-service coverage only.', 'NVE transparent pixels may be unmarked or unmapped; they are not safety clearance.',
                         'No snowpack, live forecast, vegetation, water-crossing or land-access model.',
                         'NVE classifications are decoded from a version-specific rendered palette; unknown colours fail closed.',
                         'Constant local Mercator scale approximation; use for local routes only.',
                         '50 m route angles are not terrain slope angles. Exposure distance is not a risk score.']}
    log('Searching the terrain grid…')
    try:
        found = solve_many(terrain, original, args, terrain.rc(vias[:, :2]), avoid_mask(terrain, args), args.alternatives)
    except NoRoute as exc:
        return no_route(args, report, exc)
    args.out.mkdir(parents=True,exist_ok=True)
    write_gpx(args.out/'recorded-ascent.gpx',selected[:,:2],terrain.sample(original),'Recorded ascent','Original ascent geometry; terrain-model elevations. '+DISCLAIMER)
    return write_candidates(args, terrain, report, found, original, 'original', 'Teal: recorded | Orange: candidate')


def options(args):
    text = lambda v: [text(x) for x in v] if isinstance(v, list) else str(v) if isinstance(v, Path) else v
    return {k: text(v) for k, v in vars(args).items() if k not in ('handler', 'areas')}


def avoid_mask(terrain, args):
    rings = [ring for areas in args.areas for ring in areas]
    return area_mask(terrain, rings) if rings else None


def write_candidates(args, terrain, report, found, baseline, baseline_key, legend):
    """Best candidate keeps the original file names; alternatives are numbered from 2."""
    (candidate, search), *others = found
    report.update(candidate=metrics(terrain,candidate), search=search)
    write_gpx(args.out/'candidate-DRAFT.gpx',terrain.lonlat(candidate),terrain.sample(candidate),'UNVERIFIED ascent draft',DISCLAIMER)
    if args.alternatives > 1:
        report['alternatives'] = []
        for number, (q, info) in enumerate(others, 2):
            name = f'candidate-{number}-DRAFT.gpx'
            write_gpx(args.out/name,terrain.lonlat(q),terrain.sample(q),f'UNVERIFIED ascent draft, alternative {number}',DISCLAIMER)
            report['alternatives'].append({'file': name, **metrics(terrain,q), 'search': info})
        if others:
            legend += '\nAlternatives 2-5: purple, blue, green, brown'
        else:
            log('No distinct alternative met the same constraints; see search.alternative_notes.')
    draw_map(terrain,baseline,[q for q,_ in found],args.out/'comparison.png',legend)
    (args.out/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    summary = {'output':str(args.out.resolve()), baseline_key:report[baseline_key], 'candidate':report['candidate']}
    if 'alternatives' in report:
        summary['alternatives'] = [{k:v for k,v in a.items() if k != 'search'} for a in report['alternatives']]
    print(json.dumps(summary,indent=2))
    return 0


def no_route(args, report, exc):
    report.update(status='no_feasible_route', reason=str(exc))
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    log(str(exc))
    return 3


def plan_between(args, vias):
    """Coordinate mode: no recorded track; the corridor follows straight lines through the waypoints."""
    (slat, slon), (elat, elon) = args.start, args.end
    points = np.vstack([[slon, slat, np.nan], vias, [elon, elat, np.nan]])
    terrain = get_terrain(points, args)
    reference = terrain.rc(points[:, :2])
    terrain.sample(reference)
    report = {'status': 'unverified_candidate', 'disclaimer': DISCLAIMER, 'mode': 'coordinates',
              'options': options(args), 'avoid_sha256': {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in args.avoid or []},
              'terrain': terrain.grid, 'reference_line': metrics(terrain, reference),
              'limits': ['Norwegian map-service coverage only.', 'NVE transparent pixels may be unmarked or unmapped; they are not safety clearance.',
                         'No snowpack, live forecast, vegetation, water-crossing or land-access model.',
                         'NVE classifications are decoded from a version-specific rendered palette; unknown colours fail closed.',
                         'Constant local Mercator scale approximation; use for local routes only.',
                         'The corridor follows straight lines between the given points, not a known route.',
                         '50 m route angles are not terrain slope angles. Exposure distance is not a risk score.']}
    log('Searching the terrain grid…')
    try:
        found = solve_many(terrain, np.vstack([reference[0], reference[-1]]), args, reference[1:-1], avoid_mask(terrain, args), args.alternatives)
    except NoRoute as exc:
        return no_route(args, report, exc)
    args.out.mkdir(parents=True,exist_ok=True)
    return write_candidates(args, terrain, report, found, reference, 'reference_line', 'Teal: straight reference line | Orange: candidate')


def latlon(text):
    try:
        lat, lon = (float(v) for v in text.split(','))
    except ValueError:
        raise argparse.ArgumentTypeError('use LAT,LON in decimal degrees, e.g. 61.2345,7.6543') from None
    if not (math.isfinite(lat) and math.isfinite(lon)) or abs(lat) > 80 or abs(lon) > 180:
        raise argparse.ArgumentTypeError('coordinates out of range')
    return (lat, lon)


def parser():
    p = argparse.ArgumentParser(prog='route-cli', description=__doc__,
        epilog='Angles are degrees, not percentages. Exit codes: 0 success, 2 input/provider error, 3 no feasible route.')
    p.add_argument('--version', action='version', version='%(prog)s ' + VERSION)
    sub = p.add_subparsers(dest='command',required=True)
    fetch = sub.add_parser('fetch-strava',help='Reconstruct GPX from your activity streams using an existing API token')
    fetch.add_argument('activity_id',type=int,help='Numeric Strava activity id')
    fetch.add_argument('-o','--output',type=Path,required=True,help='GPX file to create; must not exist')
    fetch.add_argument('--token-env',default='STRAVA_ACCESS_TOKEN',help='Environment variable holding the access token (default: %(default)s)')
    fetch.set_defaults(handler=fetch_strava)
    opt = sub.add_parser('optimize',help='Search Norwegian terrain for an unverified ascent candidate',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    opt.add_argument('input',type=Path,nargs='?',help='Recorded GPX with one continuous track segment or one route; omit when using --start/--end')
    opt.add_argument('--out',type=Path,required=True,help='Output directory; must be new or empty')
    opt.add_argument('--cache',type=Path,required=True,help='Area-specific terrain cache; existing cache controls grid/resolution')
    opt.add_argument('--avoid',type=Path,action='append',metavar='GEOJSON',help='GeoJSON Polygon/MultiPolygon areas to exclude; repeatable')
    opt.add_argument('--alternatives',type=int,default=1,choices=range(1,6),metavar='N',help='Also search for up to N-1 distinct alternatives (1-5) under the same constraints')
    opt.add_argument('--offline',action='store_true',help='Require an existing terrain cache; make no downloads')
    opt.add_argument('--goal',choices=['highest','last'],help='End at the highest GPX elevation or the final point (GPX only; default: highest)')
    opt.add_argument('--start',type=latlon,metavar='LAT,LON',help='Plan without a GPX: exact start point')
    opt.add_argument('--end',type=latlon,metavar='LAT,LON',help='Plan without a GPX: exact destination')
    opt.add_argument('--via',type=latlon,metavar='LAT,LON',action='append',help='Mandatory waypoint, visited in the order given; repeat for more')
    opt.add_argument('--keep-first-m',type=float,default=0,help='Follow the recorded approach for this distance (m)')
    opt.add_argument('--corridor-m',type=float,default=600,help='Search distance around the recorded ascent, or the straight reference line in coordinate mode (m)')
    opt.add_argument('--resolution-m',type=float,default=6,help='Approximate ground cell size for a new cache (m)')
    opt.add_argument('--side',choices=['any','east','west'],default='any',help='Constrain the route relative to the nearest recorded-route sample')
    opt.add_argument('--side-tolerance-m',type=float,default=20,help='Allowance across the --side boundary (m)')
    opt.add_argument('--max-uphill-deg',type=float,default=15,help='Along-route uphill angle limit, checked within search edges')
    opt.add_argument('--max-downhill-deg',type=float,default=10,help='Limit for small descending sections during the ascent')
    opt.add_argument('--max-terrain-deg',type=float,default=35,help='Exclude cells whose terrain-model slope exceeds this')
    opt.add_argument('--steep-buffer-m',type=float,default=6,help='Buffer around NVE steep-slope pixels (m)')
    opt.add_argument('--runout-buffer-m',type=float,default=10,help='Buffer around NVE runout pixels (m)')
    opt.add_argument('--runout',choices=['avoid','penalize'],default='avoid',help='Exclude mapped runout, or explicitly allow it with a cost')
    opt.add_argument('--runout-cost',type=float,default=12,help='Added distance-cost multiplier inside runout with --runout penalize (not a risk score)')
    opt.set_defaults(handler=optimize)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return args.handler(args) or 0
    except (ValueError, OSError, KeyError, ET.ParseError) as exc:
        log(f'Error: {exc}')
        return 2


if __name__ == '__main__':
    sys.exit(main())
