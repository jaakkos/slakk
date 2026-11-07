//! Ridge/gully labels from topographic position (matches Python `landforms`).

use crate::terrain::TerrainGrid;

const UNKNOWN: i8 = -1;
const OTHER: i8 = 0;
const RIDGE: i8 = 1;
const GULLY: i8 = 2;

const RADII_M: [f64; 2] = [15.0, 60.0];
const RELIEF_M: [f64; 2] = [1.0, 3.0];

fn window_sum(a: &[f64], width: usize, height: usize, radius: usize) -> Vec<f64> {
    let k = 2 * radius + 1;
    let pw = width + 2 * radius + 1;
    let ph = height + 2 * radius + 1;
    let mut pad = vec![0.0; pw * ph];
    for r in 0..height {
        for c in 0..width {
            pad[(r + radius + 1) * pw + (c + radius + 1)] = a[r * width + c];
        }
    }
    // inclusive prefix sums
    let mut s = vec![0.0; pw * ph];
    for r in 1..ph {
        let mut row = 0.0;
        for c in 1..pw {
            row += pad[r * pw + c];
            s[r * pw + c] = s[(r - 1) * pw + c] + row;
        }
    }
    let mut out = vec![0.0; width * height];
    for r in 0..height {
        for c in 0..width {
            let r0 = r;
            let c0 = c;
            let r1 = r + k;
            let c1 = c + k;
            out[r * width + c] = s[r1 * pw + c1] - s[r0 * pw + c1] - s[r1 * pw + c0] + s[r0 * pw + c0];
        }
    }
    out
}

/// Per-cell landform class: -1 unknown, 0 other, 1 ridge, 2 gully.
pub fn landform_classes(terrain: &TerrainGrid) -> Vec<i8> {
    let w = terrain.width;
    let h = terrain.height;
    let n = w * h;
    let mut valid = vec![0.0; n];
    let mut z = vec![0.0; n];
    for i in 0..n {
        if !terrain.invalid[i] {
            valid[i] = 1.0;
            z[i] = terrain.z[i] as f64;
        }
    }
    let mut ridge = vec![false; n];
    let mut gully = vec![false; n];
    let mut known: Vec<bool> = terrain.invalid.iter().map(|&inv| !inv).collect();
    for (&radius_m, &relief) in RADII_M.iter().zip(RELIEF_M.iter()) {
        let radius = 1usize.max((radius_m / terrain.gs()).round() as usize);
        let count = window_sum(&valid, w, h, radius);
        let zsum = window_sum(&z, w, h, radius);
        let expected = ((2 * radius + 1) * (2 * radius + 1)) as f64;
        for i in 0..n {
            if (count[i] - expected).abs() > 0.5 {
                known[i] = false;
            }
            let mean = zsum[i] / count[i].max(1.0);
            let tpi = z[i] - mean;
            if tpi > relief {
                ridge[i] = true;
            }
            if tpi < -relief {
                gully[i] = true;
            }
        }
    }
    let mut out = vec![OTHER; n];
    for i in 0..n {
        out[i] = if !known[i] {
            UNKNOWN
        } else if gully[i] {
            GULLY
        } else if ridge[i] {
            RIDGE
        } else {
            OTHER
        };
    }
    out
}

/// Added per-metre cost: gullies get `gully_cost`, everything not a ridge gets `ridge_cost`.
pub fn landform_cost(terrain: &TerrainGrid, gully_cost: f64, ridge_cost: f64) -> Vec<f64> {
    let classes = landform_classes(terrain);
    classes
        .iter()
        .map(|&c| {
            let mut v = 0.0;
            if c == GULLY {
                v += gully_cost;
            }
            if c != RIDGE {
                v += ridge_cost;
            }
            v
        })
        .collect()
}

/// Local elevation stddev in a short window — proxy for broken “micro-terrain” that is
/// hard to skin through. Returns metres of stddev (0 where unknown / flat).
pub fn roughness_m(terrain: &TerrainGrid, radius_m: f64) -> Vec<f64> {
    let w = terrain.width;
    let h = terrain.height;
    let n = w * h;
    let radius = 1usize.max((radius_m / terrain.gs()).round() as usize);
    let mut valid = vec![0.0; n];
    let mut z = vec![0.0; n];
    let mut z2 = vec![0.0; n];
    for i in 0..n {
        if !terrain.invalid[i] {
            let v = terrain.z[i] as f64;
            valid[i] = 1.0;
            z[i] = v;
            z2[i] = v * v;
        }
    }
    let count = window_sum(&valid, w, h, radius);
    let zsum = window_sum(&z, w, h, radius);
    let z2sum = window_sum(&z2, w, h, radius);
    let expected = ((2 * radius + 1) * (2 * radius + 1)) as f64;
    let mut out = vec![0.0; n];
    for i in 0..n {
        if terrain.invalid[i] || (count[i] - expected).abs() > 0.5 || count[i] < 4.0 {
            continue;
        }
        let mean = zsum[i] / count[i];
        let var = (z2sum[i] / count[i] - mean * mean).max(0.0);
        out[i] = var.sqrt();
    }
    out
}

/// Soft per-metre cost for cells rougher than `threshold_m` stddev.
/// Scales up to `2 * roughness_cost` for very broken ground.
pub fn roughness_cost(
    terrain: &TerrainGrid,
    cost: f64,
    radius_m: f64,
    threshold_m: f64,
) -> Vec<f64> {
    if cost <= 0.0 || threshold_m <= 0.0 {
        return vec![0.0; terrain.width * terrain.height];
    }
    let rough = roughness_m(terrain, radius_m);
    rough
        .iter()
        .map(|&s| {
            if s <= threshold_m {
                0.0
            } else {
                let t = ((s - threshold_m) / threshold_m).clamp(0.0, 2.0);
                cost * t
            }
        })
        .collect()
}

/// Square-window mean of elevations (NaN where invalid), for pitch smoothing.
pub fn smooth_elevations(terrain: &TerrainGrid, window_m: f64) -> (Vec<f32>, f64) {
    let radius = 1usize.max((window_m / 2.0 / terrain.gs()).round() as usize);
    let w = terrain.width;
    let h = terrain.height;
    let n = w * h;
    let mut valid = vec![0.0; n];
    let mut z = vec![0.0; n];
    for i in 0..n {
        if !terrain.invalid[i] {
            valid[i] = 1.0;
            z[i] = terrain.z[i] as f64;
        }
    }
    let count = window_sum(&valid, w, h, radius);
    let zsum = window_sum(&z, w, h, radius);
    let mut out = vec![f32::NAN; n];
    for i in 0..n {
        if terrain.invalid[i] || count[i] < 1.0 {
            continue;
        }
        out[i] = (zsum[i] / count[i]) as f32;
    }
    let window_m_out = (2 * radius + 1) as f64 * terrain.gs();
    (out, window_m_out)
}
