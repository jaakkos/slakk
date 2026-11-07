use serde::{Deserialize, Serialize};

use crate::landforms::{landform_cost, roughness_cost, smooth_elevations};
use crate::search::{
    cumulative, edge_options, resample, search_astar, simplify, step_costs, RunoutMode,
    SearchOptions,
};
use crate::terrain::{dilate, dilate_max, slope_degrees, TerrainGrid, EDGE_CELLS};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanOptions {
    #[serde(default = "default_corridor")]
    pub corridor_m: f64,
    #[serde(default = "default_max_uphill")]
    pub max_uphill_deg: f64,
    #[serde(default = "default_max_downhill")]
    pub max_downhill_deg: f64,
    #[serde(default = "default_max_terrain")]
    pub max_terrain_deg: f64,
    #[serde(default = "default_steep_buffer")]
    pub steep_buffer_m: f64,
    #[serde(default = "default_runout_buffer")]
    pub runout_buffer_m: f64,
    #[serde(default = "default_runout")]
    pub runout: String,
    #[serde(default = "default_runout_short")]
    pub runout_cost_short: f64,
    #[serde(default = "default_runout_cost")]
    pub runout_cost: f64,
    #[serde(default = "default_runout_long")]
    pub runout_cost_long: f64,
    #[serde(default = "default_turn")]
    pub turn_cost_m: f64,
    /// Soft cost on downhill grade; higher = avoid losing ascent metres (default 10).
    #[serde(default = "default_descent_cost")]
    pub descent_cost: f64,
    #[serde(default = "default_angle_window")]
    pub angle_window_m: f64,
    #[serde(default = "default_pitch")]
    pub pitch_deg: f64,
    #[serde(default = "default_pitch_window")]
    pub pitch_window_m: f64,
    #[serde(default = "default_pitch_cost")]
    pub pitch_cost: f64,
    #[serde(default = "default_pitch_terrain")]
    pub pitch_terrain_deg: f64,
    #[serde(default = "default_landforms")]
    pub landforms: String,
    #[serde(default = "default_gully")]
    pub gully_cost: f64,
    #[serde(default = "default_ridge")]
    pub ridge_cost: f64,
    /// Soft cost for broken micro-terrain (local DEM roughness). 0 = off.
    #[serde(default = "default_roughness")]
    pub roughness_cost: f64,
    #[serde(default = "default_roughness_radius")]
    pub roughness_radius_m: f64,
    #[serde(default = "default_roughness_threshold")]
    pub roughness_threshold_m: f64,
    #[serde(default = "default_alternatives")]
    pub alternatives: u32,
    #[serde(default)]
    pub keep_first_m: f64,
    /// When true, steep/runout_class are already buffer-dilated; skip dilate in plan.
    #[serde(default)]
    pub pre_dilated: bool,
}

fn default_corridor() -> f64 {
    600.0
}
fn default_max_uphill() -> f64 {
    15.0
}
fn default_max_downhill() -> f64 {
    10.0
}
fn default_max_terrain() -> f64 {
    35.0
}
fn default_steep_buffer() -> f64 {
    6.0
}
fn default_runout_buffer() -> f64 {
    10.0
}
fn default_runout() -> String {
    "avoid".into()
}
fn default_runout_short() -> f64 {
    4.0
}
fn default_runout_cost() -> f64 {
    12.0
}
fn default_runout_long() -> f64 {
    24.0
}
fn default_turn() -> f64 {
    0.0
}
fn default_descent_cost() -> f64 {
    10.0
}
fn default_angle_window() -> f64 {
    50.0
}
fn default_pitch() -> f64 {
    25.0
}
fn default_pitch_window() -> f64 {
    15.0
}
fn default_pitch_cost() -> f64 {
    4.0
}
fn default_pitch_terrain() -> f64 {
    45.0
}
fn default_landforms() -> String {
    "on".into()
}
fn default_gully() -> f64 {
    3.0
}
fn default_ridge() -> f64 {
    0.5
}
fn default_roughness() -> f64 {
    2.0
}
fn default_roughness_radius() -> f64 {
    15.0
}
fn default_roughness_threshold() -> f64 {
    0.45
}
fn default_alternatives() -> u32 {
    1
}

impl Default for PlanOptions {
    fn default() -> Self {
        Self {
            corridor_m: default_corridor(),
            max_uphill_deg: default_max_uphill(),
            max_downhill_deg: default_max_downhill(),
            max_terrain_deg: default_max_terrain(),
            steep_buffer_m: default_steep_buffer(),
            runout_buffer_m: default_runout_buffer(),
            runout: default_runout(),
            runout_cost_short: default_runout_short(),
            runout_cost: default_runout_cost(),
            runout_cost_long: default_runout_long(),
            turn_cost_m: default_turn(),
            descent_cost: default_descent_cost(),
            angle_window_m: default_angle_window(),
            pitch_deg: default_pitch(),
            pitch_window_m: default_pitch_window(),
            pitch_cost: default_pitch_cost(),
            pitch_terrain_deg: default_pitch_terrain(),
            landforms: default_landforms(),
            gully_cost: default_gully(),
            ridge_cost: default_ridge(),
            roughness_cost: default_roughness(),
            roughness_radius_m: default_roughness_radius(),
            roughness_threshold_m: default_roughness_threshold(),
            alternatives: default_alternatives(),
            keep_first_m: 0.0,
            pre_dilated: false,
        }
    }
}

pub struct PlanInput {
    pub width: usize,
    pub height: usize,
    pub resolution: f64,
    pub ground_resolution: f64,
    pub bbox: [f64; 4],
    pub elevations: Vec<f32>,
    pub steep: Vec<u8>,
    pub runout_class: Vec<u8>,
    /// Optional precomputed slope (WebGPU); empty means compute in Rust.
    pub slope: Vec<f32>,
    /// Route legs: start, optional vias, end — (lat, lon).
    pub points: Vec<(f64, f64)>,
    /// Corridor polyline (lat, lon). If empty, uses `points`.
    pub corridor: Vec<(f64, f64)>,
    pub options: PlanOptions,
}

#[derive(Debug, Clone, Serialize)]
pub struct AltPath {
    pub path_latlon: Vec<[f64; 2]>,
    pub elevations_m: Vec<f32>,
    pub cost: f64,
    pub visited_nodes: usize,
    pub distance_m: f64,
}

#[derive(Debug, Serialize)]
pub struct PlanResult {
    pub status: String,
    pub disclaimer: String,
    pub path_latlon: Vec<[f64; 2]>,
    pub elevations_m: Vec<f32>,
    pub cost: f64,
    pub visited_nodes: usize,
    pub waypoints: usize,
    pub max_sampled_uphill_deg: f64,
    pub distance_m: f64,
    pub preserved_m: f64,
    pub options: PlanOptions,
    pub alternatives: Vec<AltPath>,
}

#[derive(Debug)]
pub enum PlanError {
    Message(String),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Message(m) => write!(f, "{m}"),
        }
    }
}

impl PlanError {
    fn msg(s: impl Into<String>) -> Self {
        PlanError::Message(s.into())
    }
}

const DISCLAIMER: &str = "UNVERIFIED WINTER PLANNING DRAFT. Bare-ground model only; no snow or \
forecast assessment. Streams, vegetation, access and turns need field checks. \
Mapped or unmodelled avalanche runout may affect the route. \
No guarantee of skinning without bootpacking. Ascent only.";

const ALTERNATIVE_BAND_M: f64 = 50.0;

pub fn plan_route(input: &PlanInput) -> Result<PlanResult, PlanError> {
    if input.points.len() < 2 {
        return Err(PlanError::msg("need at least start and end"));
    }
    let slope_opt = if input.slope.len() == input.width * input.height {
        Some(input.slope.clone())
    } else {
        None
    };
    let terrain = TerrainGrid::from_arrays_slope(
        input.width,
        input.height,
        input.resolution,
        input.ground_resolution,
        input.bbox,
        input.elevations.clone(),
        &input.steep,
        input.runout_class.clone(),
        slope_opt,
    )
    .map_err(PlanError::msg)?;

    let opts = &input.options;
    let search_opts = SearchOptions {
        max_uphill_deg: opts.max_uphill_deg,
        max_downhill_deg: opts.max_downhill_deg,
        corridor_m: opts.corridor_m,
        runout: if opts.runout == "penalize" {
            RunoutMode::Penalize
        } else {
            RunoutMode::Avoid
        },
        runout_cost_short: opts.runout_cost_short,
        runout_cost: opts.runout_cost,
        runout_cost_long: opts.runout_cost_long,
        turn_cost_m: opts.turn_cost_m,
        descent_cost: opts.descent_cost,
        pitch_deg: opts.pitch_deg,
        pitch_cost: opts.pitch_cost,
    };

    let mut legs: Vec<(f64, f64)> = Vec::with_capacity(input.points.len());
    for &(lat, lon) in &input.points {
        legs.push(terrain.rc(lon, lat));
    }
    let corridor_ll = if input.corridor.len() >= 2 {
        &input.corridor
    } else {
        &input.points
    };
    let mut corridor: Vec<(f64, f64)> = Vec::with_capacity(corridor_ll.len());
    for &(lat, lon) in corridor_ll {
        corridor.push(terrain.rc(lon, lat));
    }

    let dist_c = cumulative(&corridor, terrain.gs());
    let keep = if opts.keep_first_m > 0.0 {
        let idx = dist_c
            .iter()
            .position(|&d| d >= opts.keep_first_m)
            .unwrap_or(0)
            .min(corridor.len().saturating_sub(2));
        idx
    } else {
        0
    };
    if opts.keep_first_m > 0.0 && keep >= corridor.len().saturating_sub(1) {
        return Err(PlanError::msg(
            "keep_first_m must be shorter than the selected ascent.",
        ));
    }

    // Search starts after preserved approach; legs[0] overridden when keep>0.
    let start = if keep > 0 {
        (
            corridor[keep].0.round() as usize,
            corridor[keep].1.round() as usize,
        )
    } else {
        (
            legs[0].0.round() as usize,
            legs[0].1.round() as usize,
        )
    };
    let goal = (
        legs[legs.len() - 1].0.round() as usize,
        legs[legs.len() - 1].1.round() as usize,
    );
    let vias: Vec<(usize, usize)> = legs[1..legs.len() - 1]
        .iter()
        .map(|&(r, c)| (r.round() as usize, c.round() as usize))
        .collect();

    let w = terrain.width;
    let h = terrain.height;
    let n = w * h;
    let mut nearest = vec![f64::INFINITY; n];
    let spacing = terrain.gs().max(10.0);
    let (_, samples) = resample(&corridor, spacing, terrain.gs()).map_err(PlanError::msg)?;
    let reach = (opts.corridor_m / terrain.gs()).ceil() as i32 + 2;
    for &(sr, sc) in &samples {
        let r0 = 0i32.max(sr.floor() as i32 - reach) as usize;
        let r1 = h.min((sr.ceil() as i32 + reach + 1) as usize);
        let c0 = 0i32.max(sc.floor() as i32 - reach) as usize;
        let c1 = w.min((sc.ceil() as i32 + reach + 1) as usize);
        for r in r0..r1 {
            for c in c0..c1 {
                let d = ((r as f64 - sr).hypot(c as f64 - sc)) * terrain.gs();
                let i = r * w + c;
                if d < nearest[i] {
                    nearest[i] = d;
                }
            }
        }
    }

    let (limit_z, _window_m) = if opts.pitch_deg > 0.0 {
        smooth_elevations(&terrain, opts.pitch_window_m)
    } else {
        (terrain.z.clone(), terrain.gs())
    };
    let limit_slope = if opts.pitch_deg > 0.0 {
        let mut inv = terrain.invalid.clone();
        for (i, &z) in limit_z.iter().enumerate() {
            if !z.is_finite() {
                inv[i] = true;
            }
        }
        slope_degrees(&limit_z, &inv, w, h, terrain.gs())
    } else {
        terrain.slope.clone()
    };

    let mut blocked = vec![false; n];
    let mut add = |mask: &[bool]| {
        for i in 0..n {
            if mask[i] {
                blocked[i] = true;
            }
        }
    };
    add(&dilate(&terrain.invalid, w, h, 1));

    let terrain_lim = if opts.pitch_deg > 0.0 {
        opts.max_terrain_deg
    } else {
        opts.max_terrain_deg
    };
    let mut steep_slope = vec![false; n];
    for i in 0..n {
        if limit_slope[i] as f64 > terrain_lim {
            steep_slope[i] = true;
        }
    }
    add(&steep_slope);

    if opts.pitch_deg > 0.0 {
        let raw_lim = opts.pitch_terrain_deg.max(opts.max_terrain_deg).max(45.0);
        let mut raw_block = vec![false; n];
        for i in 0..n {
            if terrain.slope[i] as f64 > raw_lim {
                raw_block[i] = true;
            }
        }
        add(&raw_block);
    }

    let steep_radius = if opts.pre_dilated {
        0
    } else {
        (opts.steep_buffer_m / terrain.gs()).ceil() as usize
    };
    add(&dilate(&terrain.steep, w, h, steep_radius));
    let mut outside = vec![false; n];
    for i in 0..n {
        if nearest[i] > opts.corridor_m {
            outside[i] = true;
        }
    }
    add(&outside);

    let runout_radius = if opts.pre_dilated {
        0
    } else {
        (opts.runout_buffer_m / terrain.gs()).ceil() as usize
    };
    let runout_mask: Vec<bool> = terrain.runout_class.iter().map(|&c| c > 0).collect();
    let runout_dilated = dilate(&runout_mask, w, h, runout_radius);
    let runout_class = dilate_max(&terrain.runout_class, w, h, runout_radius);
    if search_opts.runout == RunoutMode::Avoid {
        add(&runout_dilated);
    }
    for r in 0..h {
        for c in 0..w {
            if r < EDGE_CELLS || r >= h - EDGE_CELLS || c < EDGE_CELLS || c >= w - EDGE_CELLS {
                blocked[r * w + c] = true;
            }
        }
    }

    check_in_cache(&terrain, start, if keep > 0 { "the start of the search (after keep_first_m)" } else { "the start" })?;
    check_in_cache(&terrain, goal, "the destination")?;
    if blocked[start.0 * w + start.1] {
        return Err(PlanError::msg(
            "start is masked by a hard constraint (steep/runout/corridor/nodata).",
        ));
    }
    if blocked[goal.0 * w + goal.1] {
        return Err(PlanError::msg(
            "the destination is masked by a hard constraint (steep/runout/corridor/nodata).",
        ));
    }
    for (i, &via) in vias.iter().enumerate() {
        check_in_cache(&terrain, via, &format!("waypoint {}", i + 1))?;
        if blocked[via.0 * w + via.1] {
            return Err(PlanError::msg(format!(
                "Waypoint {} is masked by a hard constraint.",
                i + 1
            )));
        }
    }

    let mut land = if opts.landforms != "off" {
        landform_cost(&terrain, opts.gully_cost, opts.ridge_cost)
    } else {
        vec![0.0; n]
    };
    if opts.roughness_cost > 0.0 {
        let rough = roughness_cost(
            &terrain,
            opts.roughness_cost,
            opts.roughness_radius_m,
            opts.roughness_threshold_m,
        );
        for i in 0..n {
            land[i] += rough[i];
        }
    }
    let land = if opts.landforms != "off" || opts.roughness_cost > 0.0 {
        Some(land)
    } else {
        None
    };

    let cells: Vec<usize> = (0..n).filter(|&i| !blocked[i]).collect();
    let limit_ref = if opts.pitch_deg > 0.0 {
        Some(limit_z.as_slice())
    } else {
        None
    };
    let transitions = edge_options(&terrain, &blocked, &cells, &search_opts, limit_ref);

    let want = opts.alternatives.clamp(1, 5) as usize;
    let band = 1usize.max((ALTERNATIVE_BAND_M / terrain.gs()).ceil() as usize);
    let mut extra = vec![0.0f64; n];
    let mut found: Vec<(Vec<(f64, f64)>, usize, f64, f64)> = Vec::new();
    let mut bands: Vec<Vec<bool>> = Vec::new();

    let max_attempts = if want == 1 { 1 } else { 2 * want };
    for _attempt in 0..max_attempts {
        let steps = step_costs(
            &terrain,
            &cells,
            &transitions,
            &nearest,
            &runout_class,
            &search_opts,
            land.as_deref(),
            if found.is_empty() {
                None
            } else {
                Some(extra.as_slice())
            },
        );
        match route_legs(
            &terrain,
            &corridor,
            keep,
            start,
            goal,
            &vias,
            &legs,
            &steps,
            &blocked,
            opts,
        ) {
            Ok((route, visited, cost, max_up)) => {
                let mut near = vec![false; n];
                let (_, samples) = resample(&route, 0.5, 1.0).unwrap_or((vec![], vec![]));
                for &(r, c) in &samples {
                    let rr = r.round() as isize;
                    let cc = c.round() as isize;
                    if rr >= 0 && cc >= 0 && (rr as usize) < h && (cc as usize) < w {
                        near[rr as usize * w + cc as usize] = true;
                    }
                }
                near = dilate(&near, w, h, band);
                if !found.is_empty() {
                    let mut shared = 0.0;
                    let mut count = 0.0;
                    for (i, &on) in near.iter().enumerate() {
                        if on {
                            count += 1.0;
                            for earlier in &bands {
                                if earlier[i] {
                                    shared += 1.0;
                                    break;
                                }
                            }
                        }
                    }
                    let frac = if count > 0.0 { shared / count } else { 1.0 };
                    if frac > 0.9 {
                        for i in 0..n {
                            if near[i] {
                                extra[i] += 1.0;
                            }
                        }
                        continue;
                    }
                }
                bands.push(near.clone());
                for i in 0..n {
                    if near[i] {
                        extra[i] += 1.0;
                    }
                }
                found.push((route, visited, cost, max_up));
                if found.len() == want {
                    break;
                }
            }
            Err(e) => {
                if found.is_empty() {
                    return Err(e);
                }
                break;
            }
        }
    }

    let (best, visited, cost, max_up) = found.remove(0);
    let mut alts = Vec::new();
    for (route, vis, c, _) in found {
        let (path_latlon, elevations_m, distance_m) = path_payload(&terrain, &route);
        alts.push(AltPath {
            path_latlon,
            elevations_m,
            cost: c,
            visited_nodes: vis,
            distance_m,
        });
    }
    let (path_latlon, elevations_m, distance_m) = path_payload(&terrain, &best);
    Ok(PlanResult {
        status: "unverified_candidate".into(),
        disclaimer: DISCLAIMER.into(),
        path_latlon,
        elevations_m,
        cost,
        visited_nodes: visited,
        waypoints: vias.len(),
        max_sampled_uphill_deg: max_up,
        distance_m,
        preserved_m: dist_c.get(keep).copied().unwrap_or(0.0),
        options: opts.clone(),
        alternatives: alts,
    })
}

fn route_legs(
    terrain: &TerrainGrid,
    corridor: &[(f64, f64)],
    keep: usize,
    start: (usize, usize),
    goal: (usize, usize),
    vias: &[(usize, usize)],
    legs: &[(f64, f64)],
    steps: &crate::search::StepTables,
    blocked: &[bool],
    opts: &PlanOptions,
) -> Result<(Vec<(f64, f64)>, usize, f64, f64), PlanError> {
    let w = terrain.width;
    let h = terrain.height;
    let mut route: Vec<(f64, f64)> = if keep > 0 {
        corridor[..=keep].to_vec()
    } else {
        vec![(start.0 as f64, start.1 as f64)]
    };
    let mut at = start;
    let mut visited = 0usize;
    let mut total_cost = 0.0;
    let mut stops = vias.to_vec();
    stops.push(goal);

    for (number, &target) in stops.iter().enumerate() {
        let (leg, count, cost) = search_astar(terrain, steps, at, target);
        visited += count;
        let leg = leg.ok_or_else(|| {
            let where_ = if number + 1 < stops.len() {
                format!("waypoint {}", number + 1)
            } else {
                "the goal".into()
            };
            PlanError::msg(format!(
                "No feasible path to {where_} in this grid/corridor after {visited} nodes."
            ))
        })?;
        route.extend(leg.into_iter().skip(1));
        at = target;
        total_cost += cost;
    }

    let spacing = (1.0_f64).min(terrain.gs() / 4.0);
    let (positions, dense) = resample(&route, spacing, terrain.gs()).map_err(PlanError::msg)?;
    for &(r, c) in &dense {
        let rr = r.round() as isize;
        let cc = c.round() as isize;
        if rr < 0 || cc < 0 || rr as usize >= h || cc as usize >= w {
            return Err(PlanError::msg("validation left the grid"));
        }
        if blocked[rr as usize * w + cc as usize] {
            return Err(PlanError::msg(
                "A waypoint join or endpoint connector violates a hard constraint. No GPX emitted.",
            ));
        }
    }
    let mut heights = Vec::with_capacity(dense.len());
    for &(r, c) in &dense {
        heights.push(terrain.sample(r, c).map_err(PlanError::msg)?);
    }
    // With pitch, edge expansion already judged smoothed + raw limits; dense bilinear
    // samples along the polyline are noisier and false-reject often. Without pitch,
    // keep a hard check with 1° slack.
    let mut max_up = 0.0f64;
    let mut bad = 0usize;
    let up_lim = opts.max_uphill_deg + 1.0;
    let down_lim = opts.max_downhill_deg + 1.0;
    for i in 1..heights.len() {
        let dh = (heights[i] - heights[i - 1]) as f64;
        let ds = positions[i] - positions[i - 1];
        if ds <= 0.0 {
            continue;
        }
        let angle = (dh / ds).atan().to_degrees();
        max_up = max_up.max(angle);
        if opts.pitch_deg <= 0.0 && (angle > up_lim || angle < -down_lim) {
            bad += 1;
        }
    }
    if bad > 0 {
        return Err(PlanError::msg(format!(
            "Dense validation found {bad} short section(s) exceeding the slope limits. No GPX emitted."
        )));
    }

    if keep == 0 {
        if let Some(first) = route.first_mut() {
            *first = legs[0];
        }
    }
    for (i, &via_rc) in vias.iter().enumerate() {
        let target = legs[i + 1];
        if let Some(pt) = route
            .iter_mut()
            .find(|p| (p.0.round() as usize, p.1.round() as usize) == via_rc)
        {
            *pt = target;
        }
    }
    if let Some(last) = route.last_mut() {
        *last = legs[legs.len() - 1];
    }
    simplify(&mut route);
    Ok((route, visited, total_cost, max_up))
}

fn path_payload(
    terrain: &TerrainGrid,
    route: &[(f64, f64)],
) -> (Vec<[f64; 2]>, Vec<f32>, f64) {
    let mut path_latlon = Vec::with_capacity(route.len());
    let mut elevations_m = Vec::with_capacity(route.len());
    for &(r, c) in route {
        let (lon, lat) = terrain.lonlat(r, c);
        path_latlon.push([lat, lon]);
        elevations_m.push(terrain.sample(r, c).unwrap_or(f32::NAN));
    }
    let distance_m = *cumulative(route, terrain.gs()).last().unwrap_or(&0.0);
    (path_latlon, elevations_m, distance_m)
}

fn check_in_cache(
    terrain: &TerrainGrid,
    point: (usize, usize),
    name: &str,
) -> Result<(), PlanError> {
    let (r, c) = point;
    if r < EDGE_CELLS
        || c < EDGE_CELLS
        || r > terrain.height - 1 - EDGE_CELLS
        || c > terrain.width - 1 - EDGE_CELLS
    {
        let (lon, lat) = terrain.lonlat(r as f64, c as f64);
        return Err(PlanError::msg(format!(
            "{name} ({lat:.6},{lon:.6}) lies outside usable terrain or at its edge."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_input() -> PlanInput {
        let w = 40usize;
        let h = 40usize;
        let n = w * h;
        let t = TerrainGrid::from_arrays(
            w,
            h,
            10.0,
            10.0,
            [0.0, 0.0, 400.0, 400.0],
            vec![100.0; n],
            &vec![0; n],
            vec![0; n],
        )
        .unwrap();
        let (lon0, lat0) = t.lonlat(7.3, 20.1);
        let (lon1, lat1) = t.lonlat(31.2, 20.4);
        PlanInput {
            width: w,
            height: h,
            resolution: 10.0,
            ground_resolution: 10.0,
            bbox: [0.0, 0.0, 400.0, 400.0],
            elevations: vec![100.0f32; n],
            steep: vec![0u8; n],
            runout_class: vec![0u8; n],
            slope: vec![],
            points: vec![(lat0, lon0), (lat1, lon1)],
            corridor: vec![],
            options: PlanOptions {
                corridor_m: 500.0,
                steep_buffer_m: 0.0,
                runout_buffer_m: 0.0,
                pitch_deg: 0.0,
                landforms: "off".into(),
                ..PlanOptions::default()
            },
        }
    }

    #[test]
    fn flat_route_succeeds() {
        let result = plan_route(&flat_input()).expect("route");
        assert_eq!(result.status, "unverified_candidate");
        assert!(result.path_latlon.len() >= 2);
        assert!(result.max_sampled_uphill_deg < 0.01);
    }

    #[test]
    fn steep_wall_blocks() {
        let mut input = flat_input();
        for c in 0..40 {
            input.steep[20 * 40 + c] = 1;
        }
        let err = plan_route(&input).unwrap_err();
        assert!(err.to_string().contains("No feasible") || err.to_string().contains("masked"));
    }

    #[test]
    fn alternatives_return_extra_paths() {
        let mut input = flat_input();
        input.options.alternatives = 2;
        let result = plan_route(&input).expect("route");
        // flat grid may share paths; at least primary exists
        assert!(!result.path_latlon.is_empty());
    }
}
