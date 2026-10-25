# route-cli

A small Python CLI for **unverified winter-ascent route planning in Norway**.
It can import a Strava activity, read a local GPX, download terrain/map layers,
search for a gentler ascent, and export a candidate GPX plus a comparison map
and machine-readable report. No Codex, browser automation, or LLM is required.

## Tools used in the original analysis

| Task | Actual tool or source |
|---|---|
| Get the original GPX | Strava website → **Export GPX**, controlled through Codex's `cua_repl` browser tool |
| Terrain elevations | Kartverket [DTM ImageServer](https://hoydedata.no/arcgis/rest/services/DTM/ImageServer), `exportImage`, float32 GeoTIFF |
| Slope/runout shading | NVE [Bratthet_med_utlop_2024](https://gis3.nve.no/arcgis/rest/services/wmts/Bratthet_med_utlop_2024/MapServer), `export`, PNG |
| Topographic background | Kartverket [Topografisk Norgeskart WMS](https://wms.geonorge.no/skwms1/wms.topo?service=WMS&request=GetCapabilities), `GetMap` |
| Data downloads | `curl`; RTK was a shell-output wrapper, not part of the algorithm |
| GPX parsing and output | Python standard library `xml.etree.ElementTree` |
| Elevation, slope and distance calculations | NumPy |
| Route search | A* over a raster grid, using Python `heapq` |
| Raster reading and map export | Pillow |
| Interactive comparison | D3.js 7.9.0 and HTML/SVG; Sharp rendered a static preview |

The CLI keeps the core dependencies to **NumPy + Pillow**. Its HTTP client is
Python's `urllib`, and its argument parser is `argparse`. The interactive D3
view is not required or included; the CLI exports a static comparison PNG.

## Setup

Use Python 3.11 or later. In this directory:

```sh
python3 -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps -e .
route-cli --help
```

`requirements.lock` pins the exact NumPy and Pillow versions, with hashes, for
every platform. `pyproject.toml` holds the allowed version ranges. After changing
those ranges, regenerate the lock with
[uv](https://docs.astral.sh/uv/) and commit both files:

```sh
uv pip compile pyproject.toml --universal --python-version 3.11 --generate-hashes -o requirements.lock
```

`route-cli` and `python route_cli.py` are the same program; examples below use
the command. `route-cli optimize --help` lists every option with its default.

The `.gitignore` excludes `temp/`, terrain caches and virtual environments, so
private tracks and downloaded map data stay out of version control.

## Start with a GPX

```sh
route-cli optimize walk.gpx \
  --out result \
  --cache terrain-cache \
  --goal highest \
  --max-uphill-deg 15 \
  --corridor-m 600
```

The default excludes both NVE steep-slope pixels and runout pixels. If there
is no path meeting the constraints, it emits a `report.json` with
`status: no_feasible_route`, returns exit code **3**, and creates **no GPX**.
It does not silently loosen the limits.

For the same type of exploratory search as the earlier analysis:

```sh
route-cli optimize walk.gpx \
  --out eastern-draft \
  --cache terrain-cache \
  --keep-first-m 2400 \
  --side east \
  --max-uphill-deg 15 \
  --runout penalize
```

`--runout penalize` explicitly permits a candidate to cross mapped runout at
an increased search cost. **That cost is not a quantitative avalanche-risk
model.** Inspect `nve_runout_m` in the report. Every successful output is still
an unverified planning candidate.

The preserved approach is included in final constraint checks. If that section
or a connector violates a hard constraint, the CLI declines to emit a GPX.
Preserving a recorded track does not exempt it from winter-terrain checks.

## Mandatory waypoints

Add `--via LAT,LON` (decimal degrees) to force the candidate through a point,
such as a known stream crossing or bridge. Repeat it for more points; they are
visited in the order given. The candidate passes through each exact point.

```sh
route-cli optimize walk.gpx --out via-draft --cache terrain-cache \
  --via 61.23456,7.65432 --via 61.24010,7.66120
```

A waypoint is never skipped or moved. If it lies in masked terrain or outside
the corridor, or a leg to it has no feasible path, the run ends with exit code
**3** and a report naming the waypoint or leg.

## Exclusion areas

Draw areas to keep out of, such as a gorge, a farm or a known bad stream bank,
in any GeoJSON editor (for example [geojson.io](https://geojson.io)) and save
them as Polygon or MultiPolygon features. Pass each file with `--avoid`:

```sh
route-cli optimize walk.gpx --out draft --cache terrain-cache \
  --avoid gorge.geojson --avoid farmland.geojson
```

Every grid cell an area touches is excluded, plus one cell of margin. Holes in
polygons are ignored, so they stay excluded. Areas apply to the whole
candidate, including a preserved approach. If an area covers an endpoint,
waypoint or the only way through, the run ends with exit code **3**; nothing
is relaxed. `report.json` records each file's SHA-256 under `avoid_sha256`.
To keep a known stream crossing, combine an exclusion area along the stream
with a `--via` point at the crossing.

## Alternatives

`--alternatives N` (2–5) searches again after each candidate, adding a cost to
cells within 50 m of earlier candidates, so later searches look for a
different line. Every alternative meets exactly the same hard constraints and
gets the same full validation. One that runs more than 90% within 50 m of an
earlier candidate is discarded. The best-cost candidate is still
`candidate-DRAFT.gpx`; alternatives are `candidate-2-DRAFT.gpx` and so on.

`report.json` lists each alternative's distance, ascent, 50 m gradients, NVE
steep and runout distance, and `shared_with_earlier` (the fraction close to an
earlier candidate). The search `cost` of an alternative includes the added
diversity cost, so compare the metrics, not the cost. A lower-cost route can
have a steeper maximum gradient than an alternative; that is the tradeoff to
read. Fewer than N-1 alternatives can be found; `search.alternative_notes`
says why.

## Kick turns and zigzags

On slopes steeper than `--max-uphill-deg`, the plain search can climb with a
long series of one-cell zigzags. They satisfy the gradient limit on paper but
are not skiable. Every report now includes `kick_turns_approx`, an approximate
count of places where the heading over the previous 15 m and the next 15 m
differs by more than 90°.

`--turn-cost-m` makes the search track heading. Each change of direction costs
`turn-cost-m × (angle / 180°)²` metres of travel, so a full reversal costs the
whole amount and a gradual bend over several cells much less. On a synthetic
25° slope with a 15° limit, a value of 120 replaced 128 micro-zigzags with 8
switchbacks and long traverses, for about 15% more distance. The search is
several times slower with it on. A turn at a `--via` waypoint is not charged.
It does not model whether a given kick turn is practical in real terrain.

## Interactive map

Add `--html` to also write `map.html`, a single self-contained file that opens
in any browser without network access. It shows the Kartverket background, an
NVE steep/runout overlay you can toggle, exclusion areas, and every route. A
table compares distance, ascent, maximum 50 m angle and the distance over the
`--max-uphill-deg` limit, in NVE steep terrain and in NVE runout. Click a row
for its elevation profile, with bands marking those sections; moving over the
profile marks the point on the map. Over-limit sections are also drawn red on
the map.

The page embeds your recorded track, so treat it as private like the GPX
files. The 50 m angle is an average over the next 50 m, a different
measure from the per-edge limit used in the search.

## Plan without a recorded track

Give `--start` and `--end` instead of a GPX. The corridor then follows straight
lines from start through each `--via` point to the end, so `--corridor-m` must
be wide enough to contain a sensible route; a larger corridor means a larger
download and slower search.

```sh
route-cli optimize --start 61.2100,7.6000 --end 61.2350,7.6400 \
  --via 61.2200,7.6250 --out coord-draft --cache area-cache --corridor-m 1200
```

This writes `candidate-DRAFT.gpx`, `comparison.png` (teal is the straight
reference line, not a route) and `report.json` with `"mode": "coordinates"` and
`reference_line` metrics in place of `original`. There is no
`recorded-ascent.gpx`. `--goal` and `--keep-first-m` need a recorded GPX, and a
GPX cannot be combined with `--start`/`--end`.

## Optional: import from Strava

The earlier analysis used the website's GPX export. This CLI instead uses the
official [activity-streams API](https://developers.strava.com/docs/reference/#api-Streams-getActivityStreams)
and reconstructs a GPX from `latlng` and `altitude`. It is **not** a byte-for-byte
download of the original device file; timestamps and fitness telemetry are
not included.

You need your own Strava OAuth access token in `STRAVA_ACCESS_TOKEN`. Supply
it through your shell environment or secret manager; do not put it in command
arguments or commit it to a file. The CLI does not perform the OAuth login,
register an application, or refresh tokens. See
[Strava authentication](https://developers.strava.com/docs/authentication/).
Use `activity:read` for Everyone/Followers activities, or `activity:read_all`
where needed for Only Me activities/privacy-zone data.

Once the environment variable is set:

```sh
route-cli fetch-strava 1234567890 -o activity.gpx
route-cli optimize activity.gpx \
  --out draft --cache terrain-cache --runout penalize
```

Strava import is read-only. The token is sent in an Authorization header and
is not saved in the GPX, cache, or report. HTTP 401/403 and rate-limit failures
produce an error rather than prompting for credentials.

## Outputs

- `candidate-DRAFT.gpx`: ascent candidate, exact input start and selected goal,
  terrain-model elevations, no timestamps.
- `recorded-ascent.gpx`: original ascent geometry with the same elevation model.
- `comparison.png`: teal recorded route, orange candidate, Kartverket background.
- `map.html`: interactive map and profiles, only with `--html`.
- `candidate-2-DRAFT.gpx` …: alternatives, only with `--alternatives`.
- `report.json`: settings, provenance, cache metadata, search outcome and metrics.
  Since 0.2.0 it also records `mode` (`gpx` or `coordinates`), the `start`,
  `end`, `via` and `avoid` options, `avoid_sha256`, and `search.waypoints`.

Output directories must be empty, so a failed run cannot leave an older GPX
looking like a new result. The original input is never modified.

## Useful options

| Option | Default | Meaning |
|---|---:|---|
| `--goal highest\|last` | `highest` | End at the highest GPX elevation or the final point (GPX only) |
| `--start`, `--end` | — | `LAT,LON`; plan without a GPX |
| `--via` | — | `LAT,LON`; mandatory waypoint, repeatable, visited in order |
| `--avoid` | — | GeoJSON polygon file to exclude, repeatable |
| `--alternatives N` | `1` | Also search for up to N-1 distinct alternatives |
| `--html` | off | Also write the interactive `map.html` |
| `--turn-cost-m` | `0` | Cost of a full reversal in metres; 0 is off |
| `--keep-first-m` | `0` | Follow the original approach for this distance |
| `--corridor-m` | `600` | Search distance around the original ascent |
| `--resolution-m` | `6` | Approximate ground cell size for a **new** cache |
| `--side any\|east\|west` | `any` | Constrain the route relative to the nearest original-route sample |
| `--side-tolerance-m` | `20` | Small allowance across that directional boundary |
| `--max-uphill-deg` | `15` | Along-route angle limit, checked within search edges |
| `--max-downhill-deg` | `10` | Limit small descending sections during the ascent |
| `--max-terrain-deg` | `35` | Additional terrain-model slope exclusion |
| `--steep-buffer-m` | `6` | Buffer around NVE steep-slope pixels |
| `--runout-buffer-m` | `10` | Buffer around modelled runout pixels |
| `--runout avoid\|penalize` | `avoid` | Exclude runout or explicitly allow it with a cost |
| `--runout-cost` | `12` | Added distance-cost multiplier when runout is permitted |
| `--offline` | off | Require an existing terrain cache; make no downloads |

Angles are **degrees**, not percentage gradients. The terrain slope and the
angle along a traverse are different quantities. None of these defaults is
an avalanche-safety threshold.

## Cache and reproducibility

Each `--cache` directory represents one area and grid. It contains `dem.tiff`,
`hazards.png`, `topo.png`, and `manifest.json`. The manifest records the extent,
resolution, retrieval time and request URLs. An existing cache controls the
resolution; select a new cache directory to change grid resolution or area.

```sh
route-cli optimize walk.gpx \
  --out second-draft --cache terrain-cache --offline \
  --keep-first-m 2400 --side east --runout penalize
```

No credentials are needed for the public Norwegian map downloads. The request
contains the surrounding map bounding box. Offline runs reuse those files.
Public service availability and formats can change. Unknown NVE palette
colours, invalid images, absent elevation coverage and inconsistent raster
registration are rejected.

New caches (0.2.0 and later) store each file's SHA-256 and size in
`manifest.json`, plus the `created_by` version. Every run re-checks them and
refuses a cache whose files changed. Older caches still work but print a
warning and are reported with `"verified": false`; use a new `--cache`
directory to get checksums.

**Hazard coverage check.** NVE marks terrain from 30°. Each run counts DEM
cells steeper than 33° and how many lie within 20 m of an NVE steep marking,
and records both under `hazard_coverage` in `report.json`. If there are at
least 50 such cells and fewer than half are near a marking, the NVE layer may
be missing or unmapped there, and the run stops with exit code **2** instead
of treating the area as clear. These thresholds are a first estimate and have
not yet been checked against real tracks.

## Algorithm and scope

The search uses a 16-neighbour raster graph. Its cost combines distance,
steepness, small descents, departure from the recorded corridor and optional
runout penalties. A* uses a straight-line admissible heuristic. Edge profiles
are sampled at quarter steps; rectangular cell checks prevent cutting corners
through excluded areas. Only exactly collinear points are removed after search.
The complete route is then checked at 1 m spacing or finer, including the
preserved approach and the joins to the exact endpoints. Sampling more densely
does **not** increase the underlying terrain-data resolution.

This stricter validation can produce a different route from the exploratory
scripts used earlier. It is a best-cost path in this particular bounded model,
not a proof of the globally easiest, safest, or physically skiable route.

This version targets local Norwegian map-service coverage, one continuous GPX
segment, routes spanning no more than 25 km, and grids up to 1.5 million cells.
It uses a constant local scale correction with Web Mercator. It does not model
trees, snow cover, stream banks, ice, turn practicality, land access or a
travel-date avalanche forecast. NVE transparent pixels can mean unmarked or
unmapped terrain. Absence of a marking is not safety clearance.

For broader geographic support, the main replacement point is `get_terrain()`:
provide a registered elevation grid, a suitable topographic background, and
locally appropriate hazard masks. Do not reuse Norwegian map palettes as a
global hazard model. More precise projections and explicit water/cliff/access
barriers would be useful additions before treating the tool as more than an
exploratory planner. No ski-descent route is generated.

## Checks

```sh
python -m unittest -v test_route_cli.py
```

The tests exercise exact endpoints, steep barriers, non-jumpable elevation
steps, hazard validation of the preserved approach, unknown map colours,
disconnected GPX segments, Strava coordinate conversion with a mocked API,
mandatory waypoints (exact pass-through, masked or unreachable waypoints), and
coordinate-only planning, GeoJSON exclusion areas, distinct alternatives, the self-contained HTML map, cache checksums, the
hazard coverage check, and turn costs.
The optimizer was also run end-to-end on the downloaded activity and cached
Kartverket/NVE data. Live Strava API authentication was not tested; the original
GPX download used the browser.

Exit codes: `0` success, `2` input/provider error, `3` no feasible route.

Map attribution: Kartverket, CC BY 4.0; NVE, NLOD. Review
[Varsom's avalanche-terrain guidance](https://www.varsom.no/en/avalanches/about-avalanches/avalanche-terrain/)
and its [map limitations](https://varsom.no/snoskred/snoskredskolen/skredterreng/bratthet-og-utlopsomradekart/)
when interpreting outputs.
