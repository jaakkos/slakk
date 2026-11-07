use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::terrain::TerrainGrid;

pub const DIRECTIONS: [(i32, i32); 16] = [
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (1, -1),
    (-1, 1),
    (-1, -1),
    (2, 1),
    (2, -1),
    (-2, 1),
    (-2, -1),
    (1, 2),
    (1, -2),
    (-1, 2),
    (-1, -2),
];

#[derive(Clone)]
pub struct SearchOptions {
    pub max_uphill_deg: f64,
    pub max_downhill_deg: f64,
    pub corridor_m: f64,
    pub runout: RunoutMode,
    pub runout_cost_short: f64,
    pub runout_cost: f64,
    pub runout_cost_long: f64,
    pub turn_cost_m: f64,
    /// Soft weight on descending grade (default 10): each metre lost ≈ this many cost-metres.
    pub descent_cost: f64,
    /// 0 = off. When set, `limit_z` grades use max_up/down; raw `terrain.z` must stay within pitch_deg.
    pub pitch_deg: f64,
    pub pitch_cost: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RunoutMode {
    Avoid,
    Penalize,
}

pub struct StepTables {
    pub row: Vec<i32>,
    pub table: Vec<f64>, // cells.len() * 16
    pub cells: Vec<usize>,
}

fn validation_spacing(gs: f64) -> f64 {
    (1.0_f64).min(gs / 4.0)
}

fn edge_height(z: &[f32], cells: &[usize], w: usize, rr: f64, cc: f64, i: usize) -> f32 {
    let ri = rr.floor() as i32;
    let ci = cc.floor() as i32;
    let a = (rr - ri as f64) as f32;
    let b = (cc - ci as f64) as f32;
    let at = cells[i] as i32 + ri * w as i32 + ci;
    let at = at as usize;
    z[at] * (1.0 - a) * (1.0 - b)
        + z[at + w] * a * (1.0 - b)
        + z[at + 1] * (1.0 - a) * b
        + z[at + w + 1] * a * b
}

/// Each entry: (dr, dc, length, allowed[cells], pitch_over_fraction[cells] or empty).
pub type EdgeTransition = (i32, i32, f64, Vec<bool>, Vec<f32>);

pub fn edge_options(
    terrain: &TerrainGrid,
    blocked: &[bool],
    cells: &[usize],
    opts: &SearchOptions,
    limit_z: Option<&[f32]>,
) -> Vec<EdgeTransition> {
    let w = terrain.width;
    let flat = blocked;
    let use_pitch = opts.pitch_deg > 0.0 && limit_z.is_some();
    let limit = limit_z.unwrap_or(&terrain.z);
    let mut out = Vec::with_capacity(DIRECTIONS.len());
    for &(dr, dc) in &DIRECTIONS {
        let length = ((dr * dr + dc * dc) as f64).sqrt() * terrain.gs();
        let mut allowed = vec![true; cells.len()];
        for r in dr.min(0)..=dr.max(0) {
            for c in dc.min(0)..=dc.max(0) {
                for (i, &cell) in cells.iter().enumerate() {
                    let idx = (cell as i32 + r * w as i32 + c) as usize;
                    if flat[idx] {
                        allowed[i] = false;
                    }
                }
            }
        }
        let parts = 4usize.max((length / (validation_spacing(terrain.gs()) / 2.0)).ceil() as usize);
        let mut previous: Vec<f32> = cells.iter().map(|&c| limit[c]).collect();
        let mut raw_previous: Vec<f32> = cells.iter().map(|&c| terrain.z[c]).collect();
        let mut over = vec![0.0f32; cells.len()];
        let max_up = opts.max_uphill_deg.to_radians().tan();
        let max_down = opts.max_downhill_deg.to_radians().tan();
        let pitch_tan = opts.pitch_deg.to_radians().tan();
        for p in 1..=parts {
            let fraction = p as f64 / parts as f64;
            let rr = dr as f64 * fraction;
            let cc = dc as f64 * fraction;
            for i in 0..cells.len() {
                if !allowed[i] {
                    continue;
                }
                let height = edge_height(limit, cells, w, rr, cc, i);
                let grade = (height - previous[i]) as f64 / (length / parts as f64);
                if !grade.is_finite() || grade > max_up || grade < -max_down {
                    allowed[i] = false;
                }
                previous[i] = height;
                if use_pitch {
                    let raw_h = edge_height(&terrain.z, cells, w, rr, cc, i);
                    let raw_g = (raw_h - raw_previous[i]) as f64 / (length / parts as f64);
                    if !raw_g.is_finite() || raw_g.abs() > pitch_tan {
                        allowed[i] = false;
                    } else if raw_g > max_up {
                        over[i] += 1.0;
                    }
                    raw_previous[i] = raw_h;
                }
            }
        }
        if use_pitch {
            let inv = 1.0 / parts as f32;
            for v in &mut over {
                *v *= inv;
            }
        } else {
            over.clear();
        }
        out.push((dr, dc, length, allowed, over));
    }
    out
}

pub fn step_costs(
    terrain: &TerrainGrid,
    cells: &[usize],
    transitions: &[EdgeTransition],
    nearest: &[f64],
    runout_class: &[u8],
    opts: &SearchOptions,
    land: Option<&[f64]>,
    extra: Option<&[f64]>,
) -> StepTables {
    let w = terrain.width;
    let n = cells.len();
    let mut table = vec![f64::INFINITY; n * DIRECTIONS.len()];
    let runout_costs = [
        0.0,
        opts.runout_cost_short,
        opts.runout_cost,
        opts.runout_cost_long,
    ];
    for (k, &(dr, dc, length, ref allowed, ref over)) in transitions.iter().enumerate() {
        for i in 0..n {
            if !allowed[i] {
                continue;
            }
            let from = cells[i];
            let to = (from as i32 + dr * w as i32 + dc) as usize;
            let grade = (terrain.z[to] - terrain.z[from]) as f64 / length;
            let mut weight = 1.0
                + 6.0 * (0.0_f64).max(grade - 0.12).powi(2)
                + opts.descent_cost * (0.0_f64).max(-grade)
                + nearest[to] / opts.corridor_m;
            if opts.runout == RunoutMode::Penalize {
                weight += runout_costs[runout_class[to] as usize];
            }
            if let Some(land) = land {
                weight += land[to];
            }
            if !over.is_empty() {
                weight += opts.pitch_cost * over[i] as f64;
            }
            if let Some(extra) = extra {
                weight += extra[to];
            }
            table[i * DIRECTIONS.len() + k] = length * weight;
        }
    }
    let mut row = vec![-1i32; terrain.width * terrain.height];
    for (i, &cell) in cells.iter().enumerate() {
        row[cell] = i as i32;
    }
    StepTables {
        row,
        table,
        cells: cells.to_vec(),
    }
}

#[derive(Copy, Clone)]
struct Node {
    f: f64,
    cost: f64,
    r: i32,
    c: i32,
}

impl Eq for Node {}
impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        self.f == other.f && self.cost == other.cost
    }
}
impl Ord for Node {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .f
            .partial_cmp(&self.f)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                other
                    .cost
                    .partial_cmp(&self.cost)
                    .unwrap_or(Ordering::Equal)
            })
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn simplify(route: &mut Vec<(f64, f64)>) {
    if route.len() <= 2 {
        return;
    }
    let mut keep = vec![true; route.len()];
    for i in 1..route.len() - 1 {
        let v0 = (route[i].0 - route[i - 1].0, route[i].1 - route[i - 1].1);
        let v1 = (route[i + 1].0 - route[i].0, route[i + 1].1 - route[i].1);
        let cross = v0.0 * v1.1 - v0.1 * v1.0;
        let dot = v0.0 * v1.0 + v0.1 * v1.1;
        if cross == 0.0 && dot > 0.0 {
            keep[i] = false;
        }
    }
    let mut out = Vec::new();
    for (i, &k) in keep.iter().enumerate() {
        if k {
            out.push(route[i]);
        }
    }
    *route = out;
}

pub fn search_astar(
    terrain: &TerrainGrid,
    steps: &StepTables,
    start: (usize, usize),
    goal: (usize, usize),
) -> (Option<Vec<(f64, f64)>>, usize, f64) {
    let w = terrain.width;
    let h = terrain.height;
    let n = w * h;
    let mut costs = vec![f64::INFINITY; n];
    let mut previous = vec![-1i32; n];
    let si = start.0 * w + start.1;
    costs[si] = 0.0;
    let mut heap = BinaryHeap::new();
    let h0 = ((start.0 as f64 - goal.0 as f64).hypot(start.1 as f64 - goal.1 as f64)) * terrain.gs();
    heap.push(Node {
        f: h0,
        cost: 0.0,
        r: start.0 as i32,
        c: start.1 as i32,
    });
    let mut visited = 0usize;
    while let Some(Node { cost, r, c, .. }) = heap.pop() {
        let idx = r as usize * w + c as usize;
        if cost > costs[idx] + 1e-9 {
            continue;
        }
        visited += 1;
        if (r as usize, c as usize) == goal {
            break;
        }
        let row = steps.row[idx];
        if row < 0 {
            continue;
        }
        let base = row as usize * DIRECTIONS.len();
        for (k, &(dr, dc)) in DIRECTIONS.iter().enumerate() {
            let edge = steps.table[base + k];
            if !edge.is_finite() {
                continue;
            }
            let nr = r + dr;
            let nc = c + dc;
            if nr < 0 || nc < 0 || nr as usize >= h || nc as usize >= w {
                continue;
            }
            let nidx = nr as usize * w + nc as usize;
            let value = cost + edge;
            if value < costs[nidx] {
                costs[nidx] = value;
                previous[nidx] = (r * w as i32 + c) as i32;
                let heuristic =
                    ((nr as f64 - goal.0 as f64).hypot(nc as f64 - goal.1 as f64)) * terrain.gs();
                heap.push(Node {
                    f: value + heuristic,
                    cost: value,
                    r: nr,
                    c: nc,
                });
            }
        }
    }
    let gi = goal.0 * w + goal.1;
    if !costs[gi].is_finite() {
        return (None, visited, f64::INFINITY);
    }
    let mut route = vec![(goal.0 as f64, goal.1 as f64)];
    let mut at = gi;
    while at != si {
        let prev = previous[at];
        if prev < 0 {
            return (None, visited, f64::INFINITY);
        }
        let pr = (prev as usize) / w;
        let pc = (prev as usize) % w;
        route.push((pr as f64, pc as f64));
        at = prev as usize;
    }
    route.reverse();
    // Caller validates then simplifies — chords from simplify can exceed edge grades.
    (Some(route), visited, costs[gi])
}

pub fn cumulative(q: &[(f64, f64)], scale: f64) -> Vec<f64> {
    let mut out = vec![0.0];
    for i in 1..q.len() {
        let d = (q[i].0 - q[i - 1].0).hypot(q[i].1 - q[i - 1].1) * scale;
        out.push(out[i - 1] + d);
    }
    out
}

pub fn resample(q: &[(f64, f64)], spacing: f64, scale: f64) -> Result<(Vec<f64>, Vec<(f64, f64)>), String> {
    let distance = cumulative(q, scale);
    if *distance.last().unwrap_or(&0.0) < 1e-6 {
        return Err("Track has no horizontal extent.".into());
    }
    let mut keep = vec![true; q.len()];
    for i in 1..distance.len() {
        if distance[i] - distance[i - 1] <= 1e-8 {
            keep[i] = false;
        }
    }
    let mut d_keep = Vec::new();
    let mut q_keep = Vec::new();
    for i in 0..q.len() {
        if keep[i] {
            d_keep.push(distance[i]);
            q_keep.push(q[i]);
        }
    }
    let end = *d_keep.last().unwrap();
    let mut positions = Vec::new();
    let mut t = 0.0;
    while t < end {
        positions.push(t);
        t += spacing;
    }
    positions.push(end);
    let mut samples = Vec::with_capacity(positions.len());
    for &p in &positions {
        let mut j = 0;
        while j + 1 < d_keep.len() && d_keep[j + 1] < p {
            j += 1;
        }
        if j + 1 >= d_keep.len() {
            samples.push(q_keep[q_keep.len() - 1]);
            continue;
        }
        let t0 = d_keep[j];
        let t1 = d_keep[j + 1];
        let f = if (t1 - t0).abs() < 1e-15 {
            0.0
        } else {
            (p - t0) / (t1 - t0)
        };
        samples.push((
            q_keep[j].0 + f * (q_keep[j + 1].0 - q_keep[j].0),
            q_keep[j].1 + f * (q_keep[j + 1].1 - q_keep[j].1),
        ));
    }
    Ok((positions, samples))
}
