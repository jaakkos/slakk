#!/usr/bin/env python3
"""Norwegian terrain-based ascent planning. Generates unverified GPX candidates."""
import argparse
import base64
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
# NVE marks terrain from 30 degrees; check a little above that to tolerate model differences.
COVERAGE_SLOPE_DEG, COVERAGE_MIN_CELLS, COVERAGE_MIN_AGREEMENT = 33, 50, 0.5
ROUTE_COLORS = ['#c44300', '#7b3fa0', '#2b59c3', '#2e7d32', '#8d6e00']
DISCLAIMER = ('UNVERIFIED WINTER PLANNING DRAFT. Bare-ground model only; no snow or '
              'forecast assessment. Streams, vegetation, access and turns need field checks. '
              'Mapped or unmodelled avalanche runout may affect the route. '
              'No guarantee of skinning without bootpacking. Ascent only.')


class NoRoute(ValueError):
    pass


def log(message):
    print(message, file=sys.stderr, flush=True)


def download(url, token=None, form=None):
    """Bounded HTTPS download, or a form POST when form is given. Tokens are headers only, never logged."""
    headers = {'User-Agent': 'route-cli/' + VERSION, 'Accept': '*/*'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    for attempt in range(3):
        try:
            body = urlencode(form).encode() if form is not None else None
            with urlopen(Request(url, data=body, headers=headers), timeout=45) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            if len(data) > 64 * 1024 * 1024:
                raise ValueError('Service response exceeds 64 MiB; use a smaller area.')
            return data
        except HTTPError as exc:
            if exc.code in (429, 502, 503, 504) and attempt < 2 and form is None:
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


STRAVA_OAUTH = 'https://www.strava.com/oauth'


def token_file():
    base = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
    return base / 'route-cli' / 'strava-token.json'


def app_credentials():
    client_id, secret = os.environ.get('STRAVA_CLIENT_ID'), os.environ.get('STRAVA_CLIENT_SECRET')
    if not client_id or not secret:
        raise ValueError('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET from your Strava API application settings.')
    return client_id, secret


def save_tokens(response):
    """Keep only what refresh needs; no athlete profile. The file is readable by you alone."""
    try:
        tokens = {k: response[k] for k in ('access_token', 'refresh_token', 'expires_at')}
    except (KeyError, TypeError):
        raise ValueError('Strava returned an unexpected token response.') from None
    if 'scope' in response:
        tokens['scope'] = response['scope']
    path = token_file()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        json.dump(tokens, handle)
    os.chmod(path, 0o600)
    return tokens


def strava_login(args):
    """Authorization-code flow with a one-shot local callback on 127.0.0.1."""
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs, urlparse
    import secrets
    import webbrowser
    client_id, secret = app_credentials()
    state = secrets.token_urlsafe(24)
    redirect = f'http://localhost:{args.port}/exchange'
    url = f'{STRAVA_OAUTH}/authorize?' + urlencode({'client_id': client_id, 'redirect_uri': redirect, 'response_type': 'code',
                                                     'approval_prompt': 'auto', 'scope': args.scope, 'state': state})
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            if urlparse(self.path).path == '/exchange':
                result.update({k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()})
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'route-cli received the Strava response. You can close this tab.')

        def log_message(self, *_):
            pass

    server = HTTPServer(('127.0.0.1', args.port), Callback)
    server.timeout = 1
    deadline = time.monotonic() + args.timeout
    print('Open this URL to authorize route-cli (read-only):\n' + url, file=sys.stderr)
    if not args.no_browser:
        webbrowser.open(url)
    with server:
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if not result:
        raise ValueError('No response from Strava before the timeout.')
    if not secrets.compare_digest(result.get('state', ''), state):
        raise ValueError('OAuth state mismatch; ignoring the response.')
    if 'error' in result or 'code' not in result:
        raise ValueError(f"Strava authorization was not granted ({result.get('error', 'no code')}).")
    granted = set(result.get('scope', '').split(','))
    if not granted & {'activity:read', 'activity:read_all'}:
        raise ValueError('Strava did not grant activity read access; tick it on the authorization page.')
    response = json.loads(download(f'{STRAVA_OAUTH}/token', form={'client_id': client_id, 'client_secret': secret,
                                                               'code': result['code'], 'grant_type': 'authorization_code'}))
    save_tokens(response)
    print(f'Saved Strava tokens to {token_file()} (readable only by you). Revoke access any time in Strava settings.', file=sys.stderr)


def stored_access_token():
    path = token_file()
    if not path.exists():
        return None
    tokens = json.loads(path.read_text())
    if tokens.get('expires_at', 0) < time.time() + 120:
        client_id, secret = app_credentials()
        log('Refreshing the Strava access token…')
        response = json.loads(download(f'{STRAVA_OAUTH}/token', form={'client_id': client_id, 'client_secret': secret,
                                                                   'refresh_token': tokens['refresh_token'], 'grant_type': 'refresh_token'}))
        tokens = save_tokens(response)
    return tokens['access_token']


def fetch_strava(args):
    if args.output.exists():
        raise ValueError('Output already exists; choose another file.')
    token = os.environ.get(args.token_env) or stored_access_token()
    if not token:
        raise ValueError(f'Run "route-cli strava-login" first, or set {args.token_env} to a Strava access token. '
                         'Do not pass the token as a command argument.')
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
        verify_cache(cache, grid)
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
    grid['files'] = {name: {'sha256': hashlib.sha256((cache / name).read_bytes()).hexdigest(),
                            'bytes': (cache / name).stat().st_size} for name in requests}
    grid['created_by'] = 'route-cli/' + VERSION
    # Commit the cache manifest only after all files are usable.
    terrain = Terrain(cache, grid)
    manifest.write_text(json.dumps(grid, indent=2))
    return terrain


def verify_cache(cache, grid):
    """Refuse a cache whose files changed after download. Older caches have no checksums and are flagged."""
    if 'files' not in grid:
        log('Warning: this cache predates checksums, so its files cannot be verified. Use a new --cache to get checksums.')
        grid['verified'] = False
        return
    for name, expected in grid['files'].items():
        if hashlib.sha256((cache / name).read_bytes()).hexdigest() != expected['sha256']:
            raise ValueError(f'{cache / name} does not match its checksum in manifest.json. Refusing a modified or corrupt cache; use a new --cache.')
    grid['verified'] = True


def hazard_coverage(terrain):
    """Cross-check NVE steepness against the DEM: steep DEM terrain with no NVE marking suggests missing coverage."""
    steep_dem = terrain.slope >= COVERAGE_SLOPE_DEG
    steep_dem &= ~dilate(terrain.invalid, 2)
    cells = int(steep_dem.sum())
    near_nve = dilate(terrain.steep, max(1, math.ceil(20 / terrain.gs)))
    agreement = float(near_nve[steep_dem].mean()) if cells else None
    result = {'dem_cells_over_%d_deg' % COVERAGE_SLOPE_DEG: cells,
              'fraction_near_nve_steep': None if agreement is None else round(agreement, 3)}
    if cells >= COVERAGE_MIN_CELLS and agreement < COVERAGE_MIN_AGREEMENT:
        raise ValueError(f'NVE steepness marks only {agreement:.0%} of the {cells} DEM cells steeper than '
                         f'{COVERAGE_SLOPE_DEG}°. The hazard layer may be missing or unmapped here; refusing to treat it as clear.')
    return result


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
    if args.turn_cost_m > 0:
        return search_turns(terrain, transitions, nearest, runout, args, start, goal, extra)
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
            value = cost + length * edge_weight(terrain, nearest, runout, args, extra, r, c, nr, nc, length)
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
    return simplify(np.asarray(route[::-1], float)), visited, float(costs[goal])


def edge_weight(terrain, nearest, runout, args, extra, r, c, nr, nc, length):
    grade = float(terrain.z[nr, nc] - terrain.z[r, c]) / length
    weight = 1 + 6 * max(0, grade-.12)**2 + 10 * max(0, -grade) + nearest[nr, nc] / args.corridor_m
    if args.runout == 'penalize' and runout[nr, nc]:
        weight += args.runout_cost
    if extra is not None:
        weight += extra[nr, nc]
    return weight


def simplify(route):
    # Remove only exactly collinear vertices; never shortcut across masked terrain.
    if len(route) > 2:
        v = np.diff(route, axis=0)
        bends = v[:-1,0]*v[1:,1] - v[:-1,1]*v[1:,0]
        route = route[np.r_[True, (bends != 0) | ((v[:-1]*v[1:]).sum(axis=1) <= 0), True]]
    return route


def search_turns(terrain, transitions, nearest, runout, args, start, goal, extra=None):
    """A* over (cell, heading) states. Each heading change costs turn_cost_m * (angle/180)^2,
    so a sharp reversal costs the full amount and a gradual bend over several edges much less."""
    headings = [math.atan2(dr, dc) for dr, dc, _, _ in transitions]
    turn = np.array([[args.turn_cost_m * (abs((a - b + math.pi) % (2*math.pi) - math.pi) / math.pi)**2
                      for b in headings] for a in headings])
    costs, previous = {}, {}  # sparse: only states the search reaches
    heap = [(math.hypot(start[0]-goal[0], start[1]-goal[1])*terrain.gs, 0., start[0], start[1], -1)]
    visited, end = 0, None
    while heap:
        _, cost, r, c, d = heapq.heappop(heap)
        if d >= 0 and cost > costs[r, c, d]:
            continue
        visited += 1
        if (r, c) == goal:
            end = (r, c, d)
            break
        for k, (dr, dc, length, allowed) in enumerate(transitions):
            if not allowed[r, c]:
                continue
            nr, nc = r + dr, c + dc
            value = cost + length * edge_weight(terrain, nearest, runout, args, extra, r, c, nr, nc, length)
            if d >= 0:
                value += turn[d, k]
            if value < costs.get((nr, nc, k), math.inf):
                costs[nr, nc, k] = value
                previous[nr, nc, k] = (r, c, d)
                heuristic = math.hypot(nr-goal[0], nc-goal[1]) * terrain.gs
                heapq.heappush(heap, (value + heuristic, value, nr, nc, k))
    if end is None:
        return None, visited, math.inf
    if end[2] < 0:
        return np.asarray([start], float), visited, 0.
    route, state = [], end
    while state[2] >= 0:
        route.append(state[:2])
        state = previous[state]
    route.append(state[:2])
    return simplify(np.asarray(route[::-1], float)), visited, float(costs[end])


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


def kick_turns(dense, gs):
    """Approximate count of sharp direction reversals: heading over the previous vs next 15 m differs by more than 90 degrees."""
    if len(dense) < 7:
        return 0
    before, after = dense[3:-3] - dense[:-6], dense[6:] - dense[3:-3]
    cosine = (before * after).sum(axis=1) / np.maximum(np.linalg.norm(before, axis=1) * np.linalg.norm(after, axis=1), 1e-12)
    sharp = cosine < 0
    return int(np.count_nonzero(sharp[1:] & ~sharp[:-1]) + (1 if sharp.size and sharp[0] else 0))


def metrics(terrain, q):
    positions, dense = resample(q, 5, terrain.gs)
    height = terrain.sample(dense)
    ij = np.rint(dense).astype(int)
    weights = np.diff(positions)
    stats = {'distance_m': round(float(positions[-1]), 1),
             'ascent_m': round(float(np.maximum(np.diff(height), 0).sum()), 1),
             'nve_steep_m': round(float(weights @ terrain.steep[ij[:-1,0],ij[:-1,1]]), 1),
             'nve_runout_m': round(float(weights @ terrain.runout[ij[:-1,0],ij[:-1,1]]), 1),
             'kick_turns_approx': kick_turns(dense, terrain.gs)}
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
    # Draw alternatives first so the best candidate stays on top.
    for q, color in [(original, '#087f8c'), *reversed(list(zip(candidate, ROUTE_COLORS)))]:
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


def route_profile(terrain, q, limit, sx, sy):
    """5 m samples with elevation, forward 50 m angle and NVE flags, in map-image pixels."""
    positions, dense = resample(q, 5, terrain.gs)
    height = terrain.sample(dense)
    ij = np.rint(dense).astype(int)
    full = positions <= positions[-1] - 50
    ahead = np.interp(positions + 50, positions, height)
    angle = np.where(full, np.degrees(np.arctan((ahead - height) / 50)), np.nan)
    return {'d': np.round(positions, 1).tolist(), 'z': np.round(height, 1).tolist(),
            'a': [None if not np.isfinite(v) else round(float(v), 2) for v in angle],
            'over': (full & (angle > limit)).astype(int).tolist(),
            'steep': terrain.steep[ij[:, 0], ij[:, 1]].astype(int).tolist(),
            'runout': terrain.runout[ij[:, 0], ij[:, 1]].astype(int).tolist(), 'kicks': kick_turns(dense, terrain.gs),
            'x': np.round((dense[:, 1] + .5) * sx, 1).tolist(), 'y': np.round((dense[:, 0] + .5) * sy, 1).tolist()}


def png_data_url(image, kind='PNG'):
    buffer = io.BytesIO()
    image.save(buffer, kind, optimize=True) if kind == 'PNG' else image.save(buffer, kind, quality=85)
    return f'data:image/{kind.lower()};base64,' + base64.b64encode(buffer.getvalue()).decode()


def write_html(args, terrain, report, baseline, baseline_label, found, output):
    """Self-contained interactive map: no network access, no external scripts."""
    with Image.open(terrain.cache / 'topo.png') as source:
        topo = source.convert('RGB')
    topo.thumbnail((1400, 1800))
    sx, sy = topo.width / terrain.w, topo.height / terrain.h
    hazard = np.zeros((terrain.h, terrain.w, 4), np.uint8)
    hazard[terrain.runout] = [40, 90, 220, 110]
    hazard[terrain.steep] = [220, 30, 30, 140]
    hazard = Image.fromarray(hazard).resize(topo.size, Image.NEAREST)
    routes = [{'label': baseline_label, 'color': '#087f8c', **route_profile(terrain, baseline, args.max_uphill_deg, sx, sy)}]
    for number, (q, _) in enumerate(found, 1):
        label = 'Candidate (best cost)' if number == 1 else f'Alternative {number}'
        routes.append({'label': label, 'color': ROUTE_COLORS[number - 1],
                       **route_profile(terrain, q, args.max_uphill_deg, sx, sy)})
    areas = [[[round(float((c + .5) * sx), 1), round(float((r + .5) * sy), 1)] for r, c in terrain.rc(ring)]
             for areas in getattr(args, 'areas', []) for ring in areas]
    data = {'width': topo.width, 'height': topo.height, 'limit': args.max_uphill_deg, 'routes': routes,
            'areas': areas, 'disclaimer': DISCLAIMER, 'status': report['status']}
    page = (MAP_HTML.replace('__TOPO__', png_data_url(topo, 'JPEG')).replace('__HAZARD__', png_data_url(hazard))
            .replace('__DATA__', json.dumps(data, allow_nan=False).replace('</', '<\\/')))
    output.write_text(page, encoding='utf-8')


MAP_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ascent candidates</title>
<style>
:root{--bg:#fff;--fg:#162b32;--muted:#5b6b70;--line:#d7dee0;--warn:#b00020}
@media (prefers-color-scheme:dark){:root{--bg:#121719;--fg:#e4ecee;--muted:#9aa9ad;--line:#2d383b;--warn:#ff6b7f}}
body{margin:0;font:14px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:17px;margin:0 0 4px}
.warn{color:var(--warn);font-weight:600}
main{display:grid;grid-template-columns:minmax(0,3fr) minmax(300px,2fr);gap:16px;padding:16px}
@media (max-width:900px){main{grid-template-columns:1fr}}
#viewport{overflow:auto;border:1px solid var(--line);max-height:78vh;background:#eee}
#stage{position:relative;transform-origin:0 0}
#stage img,#stage svg{position:absolute;left:0;top:0;width:100%;height:100%}
.tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
button{font:inherit;padding:2px 10px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:right}
td:first-child,th:first-child{text-align:left}
tr.sel{outline:2px solid var(--fg)}
.swatch{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
#profile{width:100%;height:220px;display:block}
#readout{min-height:2.8em;color:var(--muted)}
.key span{margin-right:12px}
</style></head><body>
<header><h1>Ascent candidates <span class="warn">UNVERIFIED</span></h1><div id="disclaimer"></div></header>
<main>
<section>
 <div class="tools">
  <button id="zin">Zoom +</button><button id="zout">Zoom −</button>
  <label><input type="checkbox" id="haz" checked> NVE steep (red) and runout (blue)</label>
 </div>
 <div id="viewport"><div id="stage">
  <img src="__TOPO__" alt="Topographic map, Kartverket"><img id="hazimg" src="__HAZARD__" alt="" style="image-rendering:pixelated">
  <svg id="map"></svg></div></div>
 <div style="color:var(--muted)">Map: Kartverket CC BY 4.0. Hazard layer: NVE, NLOD. Unmarked terrain is not safety clearance.</div>
</section>
<section>
 <table id="table"><thead><tr><th>Route</th><th>km</th><th>Ascent m</th><th>Max 50 m°</th><th>Over limit m</th><th>Steep m</th><th>Runout m</th><th>Kick turns</th></tr></thead><tbody></tbody></table>
 <p style="color:var(--muted)">Click a row to show its elevation profile and violations. Shaded profile bands:
 <span class="key"><span><i class="swatch" style="background:#e53935"></i>50 m angle over limit</span>
 <span><i class="swatch" style="background:#6d1b1b"></i>NVE steep</span><span><i class="swatch" style="background:#2b6cd8"></i>NVE runout</span></span></p>
 <svg id="profile"></svg>
 <div id="readout">Move over the profile to locate a point on the map.</div>
</section>
</main>
<script>
const D = __DATA__;
const NS = 'http://www.w3.org/2000/svg';
const el = (n, a, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
document.getElementById('disclaimer').textContent = D.disclaimer;
const stage = document.getElementById('stage'), map = document.getElementById('map');
map.setAttribute('viewBox', `0 0 ${D.width} ${D.height}`);
let zoom = (document.getElementById('viewport').clientWidth || D.width) / D.width;  // fit width
const setZoom = z => { zoom = Math.max(.2, Math.min(6, z)); stage.style.width = D.width * zoom + 'px'; stage.style.height = D.height * zoom + 'px'; };
setZoom(zoom);
document.getElementById('zin').onclick = () => setZoom(zoom * 1.4);
document.getElementById('zout').onclick = () => setZoom(zoom / 1.4);
document.getElementById('haz').onchange = e => document.getElementById('hazimg').style.display = e.target.checked ? '' : 'none';
for (const a of D.areas) el('polygon', {points: a.map(p => p.join(',')).join(' '), fill: 'rgba(0,0,0,.25)', stroke: '#000', 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke'}, map);
const lines = D.routes.map((r, i) => {
  const pts = r.x.map((x, k) => x + ',' + r.y[k]).join(' ');
  const g = el('g', {}, map);
  el('polyline', {points: pts, fill: 'none', stroke: '#fff', 'stroke-width': 6, 'vector-effect': 'non-scaling-stroke'}, g);
  const line = el('polyline', {points: pts, fill: 'none', stroke: r.color, 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke'}, g);
  r.x.forEach((x, k) => { if (r.over[k] && k + 1 < r.x.length) el('line', {x1: x, y1: r.y[k], x2: r.x[k+1], y2: r.y[k+1], stroke: '#e53935', 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke'}, g); });
  return g;
});
const marker = el('circle', {r: 7, fill: 'none', stroke: '#000', 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden'}, map);
const sum = (r, key) => r.d.slice(1).reduce((s, d, k) => s + (r[key][k] ? d - r.d[k] : 0), 0);
const tbody = document.querySelector('#table tbody');
const rows = D.routes.map((r, i) => {
  const asc = r.z.slice(1).reduce((s, z, k) => s + Math.max(0, z - r.z[k]), 0);
  const maxA = Math.max(...r.a.filter(a => a !== null));
  const tr = tbody.insertRow();
  const cells = [r.label, (r.d[r.d.length-1] / 1000).toFixed(2), asc.toFixed(0), isFinite(maxA) ? maxA.toFixed(1) : '–', sum(r, 'over').toFixed(0), sum(r, 'steep').toFixed(0), sum(r, 'runout').toFixed(0), r.kicks];
  cells.forEach((c, k) => { const td = tr.insertCell(); if (!k) { const s = document.createElement('i'); s.className = 'swatch'; s.style.background = r.color; td.appendChild(s); } td.appendChild(document.createTextNode(c)); });
  tr.style.cursor = 'pointer'; tr.onclick = () => select(i);
  return tr;
});
const prof = document.getElementById('profile'), readout = document.getElementById('readout');
function select(i) {
  rows.forEach((tr, k) => tr.classList.toggle('sel', k === i));
  lines.forEach((g, k) => { g.style.opacity = k === i ? 1 : .45; if (k === i) map.insertBefore(g, marker); });
  const r = D.routes[i], W = prof.clientWidth || 400, H = 220, L = 44, B = 24, T = 8;
  prof.setAttribute('viewBox', `0 0 ${W} ${H}`); prof.innerHTML = '';
  const dmax = r.d[r.d.length-1], zmin = Math.min(...r.z), zmax = Math.max(...r.z) + 1;
  const X = d => L + (W - L - 8) * d / dmax, Y = z => T + (H - T - B) * (1 - (z - zmin) / (zmax - zmin));
  [['over', '#e53935', 0], ['steep', '#6d1b1b', 1], ['runout', '#2b6cd8', 2]].forEach(([key, color, lane]) => r.d.forEach((d, k) => {
    if (r[key][k] && k + 1 < r.d.length) el('rect', {x: X(d), width: Math.max(1, X(r.d[k+1]) - X(d)), y: H - B + 2 + lane * 6 - 22, height: 5, fill: color}, prof);
  }));
  for (let t = 0; t <= 4; t++) { const z = zmin + (zmax - zmin) * t / 4; el('line', {x1: L, x2: W - 8, y1: Y(z), y2: Y(z), stroke: 'currentColor', opacity: .12}, prof); el('text', {x: L - 4, y: Y(z) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor'}, prof).textContent = z.toFixed(0); }
  el('text', {x: W - 8, y: H - 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor'}, prof).textContent = (dmax / 1000).toFixed(2) + ' km';
  el('polyline', {points: r.d.map((d, k) => X(d) + ',' + Y(r.z[k])).join(' '), fill: 'none', stroke: r.color, 'stroke-width': 2}, prof);
  const cursor = el('line', {y1: T, y2: H - B, stroke: 'currentColor', visibility: 'hidden'}, prof);
  prof.onmousemove = e => {
    const box = prof.getBoundingClientRect(), d = (e.clientX - box.left) * W / box.width;
    let k = r.d.findIndex(v => X(v) >= d); if (k < 0) k = r.d.length - 1;
    cursor.setAttribute('x1', X(r.d[k])); cursor.setAttribute('x2', X(r.d[k])); cursor.setAttribute('visibility', 'visible');
    marker.setAttribute('cx', r.x[k]); marker.setAttribute('cy', r.y[k]); marker.setAttribute('visibility', 'visible');
    const flags = [r.over[k] && `over ${D.limit}° limit`, r.steep[k] && 'NVE steep', r.runout[k] && 'NVE runout'].filter(Boolean).join(', ');
    readout.textContent = `${r.label}: ${(r.d[k] / 1000).toFixed(2)} km, ${r.z[k].toFixed(0)} m, next 50 m ${r.a[k] === null ? 'n/a' : r.a[k].toFixed(1) + '°'}${flags ? ' — ' + flags : ''}`;
  };
}
select(D.routes.length > 1 ? 1 : 0);
</script></body></html>
"""


def optimize(args):
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError('Output directory is not empty; choose a new directory to avoid stale/overwritten GPX files.')
    if any(not math.isfinite(v) for v in vars(args).values() if isinstance(v,float)):
        raise ValueError('Numeric options must be finite.')
    if not 2 <= args.resolution_m <= 30 or not 20 <= args.corridor_m <= 3000:
        raise ValueError('Use resolution 2–30 m and corridor 20–3000 m.')
    if not 0 < args.max_uphill_deg < 45 or not 0 < args.max_downhill_deg < 45 or not 0 < args.max_terrain_deg < 80:
        raise ValueError('Invalid angle limit.')
    if min(args.keep_first_m,args.steep_buffer_m,args.runout_buffer_m,args.runout_cost,args.side_tolerance_m,args.turn_cost_m) < 0:
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
    coverage = hazard_coverage(terrain)
    original = terrain.rc(selected[:,:2])
    terrain.sample(original)
    terrain.sample(terrain.rc(vias[:,:2]))
    report = {'status': 'unverified_candidate', 'disclaimer': DISCLAIMER, 'mode': 'gpx',
              'input_sha256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
              'goal_index_zero_based': stop, 'options': options(args), 'avoid_sha256': {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in args.avoid or []},
              'terrain': terrain.grid, 'hazard_coverage': coverage, 'original': metrics(terrain, original),
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
    if args.html:
        write_html(args, terrain, report, baseline, 'Recorded ascent' if baseline_key == 'original' else 'Straight reference line', found, args.out/'map.html')
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
    coverage = hazard_coverage(terrain)
    reference = terrain.rc(points[:, :2])
    terrain.sample(reference)
    report = {'status': 'unverified_candidate', 'disclaimer': DISCLAIMER, 'mode': 'coordinates',
              'options': options(args), 'avoid_sha256': {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in args.avoid or []},
              'terrain': terrain.grid, 'hazard_coverage': coverage, 'reference_line': metrics(terrain, reference),
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
    fetch.add_argument('--token-env',default='STRAVA_ACCESS_TOKEN',help='Environment variable holding an access token; if unset, the token saved by strava-login is used (default: %(default)s)')
    fetch.set_defaults(handler=fetch_strava)
    login = sub.add_parser('strava-login',help='Authorize read-only Strava access once; tokens are stored and refreshed automatically')
    login.add_argument('--scope',default='activity:read_all',choices=['activity:read','activity:read_all'],help='activity:read_all also covers Only Me activities (default: %(default)s)')
    login.add_argument('--port',type=int,default=8723,help='Local callback port on 127.0.0.1 (default: %(default)s)')
    login.add_argument('--timeout',type=float,default=300,help='Seconds to wait for the browser (default: %(default)s)')
    login.add_argument('--no-browser',action='store_true',help='Only print the authorization URL')
    login.set_defaults(handler=strava_login)
    opt = sub.add_parser('optimize',help='Search Norwegian terrain for an unverified ascent candidate',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    opt.add_argument('input',type=Path,nargs='?',help='Recorded GPX with one continuous track segment or one route; omit when using --start/--end')
    opt.add_argument('--out',type=Path,required=True,help='Output directory; must be new or empty')
    opt.add_argument('--cache',type=Path,required=True,help='Area-specific terrain cache; existing cache controls grid/resolution')
    opt.add_argument('--avoid',type=Path,action='append',metavar='GEOJSON',help='GeoJSON Polygon/MultiPolygon areas to exclude; repeatable')
    opt.add_argument('--turn-cost-m',type=float,default=0,help='Search cost of a full reversal, in metres of travel; sharper turns cost more (0 = off; slower when on)')
    opt.add_argument('--alternatives',type=int,default=1,choices=range(1,6),metavar='N',help='Also search for up to N-1 distinct alternatives (1-5) under the same constraints')
    opt.add_argument('--html',action='store_true',help='Also write map.html: interactive map, elevation profiles and highlighted limit violations')
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
