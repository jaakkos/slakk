use crate::geo::{lonlat_to_mercator, mercator_to_lonlat};

pub const MAX_CELLS: usize = 6_000_000;
pub const MAX_SIDE: usize = 4096;
pub const MAX_SPAN_M: f64 = 25_000.0;
pub const EDGE_CELLS: usize = 3;

pub const RUNOUT_CLASS_SHORT: u8 = 1;
pub const RUNOUT_CLASS_MEDIUM: u8 = 2;
pub const RUNOUT_CLASS_LONG: u8 = 3;

/// NVE bratthet colour bands → class 1..=5 (yellow → dark red).
pub const STEEP_CLASS_COUNT: u8 = 5;
/// Sentinel OR'd in by the web UI for runout-avoid cells merged into the steep raster.
pub const STEEP_CLASS_FORCE_HARD: u8 = 6;

const STEEP_COLORS: &[[u8; 3]] = &[
    [255, 255, 0],   // 1 — ~27–30°
    [255, 170, 0],   // 2 — ~30–35°
    [255, 85, 0],    // 3 — ~35–40°
    [255, 0, 0],     // 4 — ~40–45°
    [115, 0, 0],     // 5 — ≥45°
];
const RUNOUT_SHORT: [u8; 3] = [0, 77, 168];
const RUNOUT_MEDIUM: [u8; 3] = [76, 155, 255];
const RUNOUT_LONG: [u8; 3] = [154, 177, 230];

pub struct TerrainGrid {
    pub width: usize,
    pub height: usize,
    pub resolution: f64,
    pub ground_resolution: f64,
    pub bbox: [f64; 4],
    pub z: Vec<f32>,
    pub slope: Vec<f32>,
    pub invalid: Vec<bool>,
    /// NVE steep class per cell: 0 none, 1..=5 bratthet bands, 6 = force Hard.
    pub steep: Vec<u8>,
    pub runout_class: Vec<u8>,
}

impl TerrainGrid {
    pub fn from_arrays(
        width: usize,
        height: usize,
        resolution: f64,
        ground_resolution: f64,
        bbox: [f64; 4],
        elevations: Vec<f32>,
        steep_u8: &[u8],
        runout_class: Vec<u8>,
    ) -> Result<Self, String> {
        Self::from_arrays_slope(
            width,
            height,
            resolution,
            ground_resolution,
            bbox,
            elevations,
            steep_u8,
            runout_class,
            None,
        )
    }

    pub fn from_arrays_slope(
        width: usize,
        height: usize,
        resolution: f64,
        ground_resolution: f64,
        bbox: [f64; 4],
        elevations: Vec<f32>,
        steep_u8: &[u8],
        runout_class: Vec<u8>,
        slope_in: Option<Vec<f32>>,
    ) -> Result<Self, String> {
        let n = width * height;
        if width == 0 || height == 0 || n > MAX_CELLS || width > MAX_SIDE || height > MAX_SIDE {
            return Err(format!("invalid grid size {width}×{height}"));
        }
        if elevations.len() != n || steep_u8.len() != n || runout_class.len() != n {
            return Err("elevation/steep/runout length must equal width*height".into());
        }
        if resolution <= 0.0 || ground_resolution <= 0.0 {
            return Err("resolution must be positive".into());
        }
        let mut invalid = vec![false; n];
        for (i, &z) in elevations.iter().enumerate() {
            invalid[i] = !z.is_finite() || z < -100.0 || z > 3000.0;
        }
        let slope = match slope_in {
            Some(s) if s.len() == n => s,
            _ => slope_degrees(&elevations, &invalid, width, height, ground_resolution),
        };
        Ok(Self {
            width,
            height,
            resolution,
            ground_resolution,
            bbox,
            z: elevations,
            slope,
            invalid,
            steep: steep_u8.to_vec(),
            runout_class,
        })
    }

    pub fn gs(&self) -> f64 {
        self.ground_resolution
    }

    /// lon/lat → fractional row, col
    pub fn rc(&self, lon: f64, lat: f64) -> (f64, f64) {
        let (x, y) = lonlat_to_mercator(lon, lat);
        let row = (self.bbox[3] - y) / self.resolution - 0.5;
        let col = (x - self.bbox[0]) / self.resolution - 0.5;
        (row, col)
    }

    pub fn lonlat(&self, row: f64, col: f64) -> (f64, f64) {
        let x = self.bbox[0] + (col + 0.5) * self.resolution;
        let y = self.bbox[3] - (row + 0.5) * self.resolution;
        mercator_to_lonlat(x, y)
    }

    pub fn sample(&self, row: f64, col: f64) -> Result<f32, String> {
        if !(row.is_finite() && col.is_finite())
            || row < 0.0
            || col < 0.0
            || row >= (self.height as f64) - 1.0
            || col >= (self.width as f64) - 1.0
        {
            return Err("point outside usable terrain".into());
        }
        let r0 = row.floor() as usize;
        let c0 = col.floor() as usize;
        let dr = (row - r0 as f64) as f32;
        let dc = (col - c0 as f64) as f32;
        let z = |r: usize, c: usize| self.z[r * self.width + c];
        let vals = [z(r0, c0), z(r0 + 1, c0), z(r0, c0 + 1), z(r0 + 1, c0 + 1)];
        for v in vals {
            if !v.is_finite() || v < -100.0 || v > 3000.0 {
                return Err("missing elevation along track".into());
            }
        }
        Ok(vals[0] * (1.0 - dr) * (1.0 - dc)
            + vals[1] * dr * (1.0 - dc)
            + vals[2] * (1.0 - dr) * dc
            + vals[3] * dr * dc)
    }

    pub fn idx(&self, r: usize, c: usize) -> usize {
        r * self.width + c
    }
}

pub fn slope_degrees(
    z: &[f32],
    invalid: &[bool],
    width: usize,
    height: usize,
    gs: f64,
) -> Vec<f32> {
    // NumPy np.gradient with spacing gs, then arctan(hypot(dzdy, dzdx)) in degrees.
    let mut out = vec![0.0f32; width * height];
    let gs = gs as f32;
    for r in 0..height {
        for c in 0..width {
            let i = r * width + c;
            let zsafe = |rr: usize, cc: usize| {
                let j = rr * width + cc;
                if invalid[j] {
                    0.0
                } else {
                    z[j]
                }
            };
            let dzdy = if r == 0 {
                (zsafe(1, c) - zsafe(0, c)) / gs
            } else if r == height - 1 {
                (zsafe(height - 1, c) - zsafe(height - 2, c)) / gs
            } else {
                (zsafe(r + 1, c) - zsafe(r - 1, c)) / (2.0 * gs)
            };
            let dzdx = if c == 0 {
                (zsafe(r, 1) - zsafe(r, 0)) / gs
            } else if c == width - 1 {
                (zsafe(r, width - 1) - zsafe(r, width - 2)) / gs
            } else {
                (zsafe(r, c + 1) - zsafe(r, c - 1)) / (2.0 * gs)
            };
            out[i] = (dzdy.hypot(dzdx)).atan().to_degrees();
        }
    }
    out
}

pub fn dilate(mask: &[bool], width: usize, height: usize, radius: usize) -> Vec<bool> {
    let mut result = mask.to_vec();
    for _ in 0..radius {
        let prev = result.clone();
        for r in 0..height {
            for c in 0..width {
                let mut any = false;
                for dr in -1i32..=1 {
                    for dc in -1i32..=1 {
                        let rr = r as i32 + dr;
                        let cc = c as i32 + dc;
                        if rr >= 0
                            && cc >= 0
                            && (rr as usize) < height
                            && (cc as usize) < width
                            && prev[rr as usize * width + cc as usize]
                        {
                            any = true;
                        }
                    }
                }
                result[r * width + c] = any;
            }
        }
    }
    result
}

pub fn dilate_max(values: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    let mut result = values.to_vec();
    for _ in 0..radius {
        let prev = result.clone();
        for r in 0..height {
            for c in 0..width {
                let mut m = 0u8;
                for dr in -1i32..=1 {
                    for dc in -1i32..=1 {
                        let rr = r as i32 + dr;
                        let cc = c as i32 + dc;
                        if rr >= 0 && cc >= 0 && (rr as usize) < height && (cc as usize) < width {
                            m = m.max(prev[rr as usize * width + cc as usize]);
                        }
                    }
                }
                result[r * width + c] = m;
            }
        }
    }
    result
}

/// Decode NVE RGBA into steep mask and runout class. Fails on unknown opaque colours.
pub fn decode_hazards_rgba(rgba: &[u8], width: usize, height: usize) -> Result<(Vec<u8>, Vec<u8>), String> {
    let n = width * height;
    if rgba.len() != n * 4 {
        return Err("RGBA length mismatch".into());
    }
    let mut steep = vec![0u8; n];
    let mut runout = vec![0u8; n];
    for i in 0..n {
        let o = i * 4;
        let r = rgba[o];
        let g = rgba[o + 1];
        let b = rgba[o + 2];
        let a = rgba[o + 3];
        if a == 0 {
            continue;
        }
        let rgb = [r, g, b];
        let mut known = false;
        for (idx, color) in STEEP_COLORS.iter().enumerate() {
            if rgb == *color {
                steep[i] = (idx + 1) as u8;
                known = true;
                break;
            }
        }
        let level = if rgb == RUNOUT_SHORT {
            RUNOUT_CLASS_SHORT
        } else if rgb == RUNOUT_MEDIUM {
            RUNOUT_CLASS_MEDIUM
        } else if rgb == RUNOUT_LONG {
            RUNOUT_CLASS_LONG
        } else {
            0
        };
        if level > 0 {
            if runout[i] < level {
                runout[i] = level;
            }
            known = true;
        }
        if !known {
            return Err(
                "NVE image contains unknown colours. Review the provider palette; refusing to ignore them."
                    .into(),
            );
        }
    }
    Ok((steep, runout))
}

/// Build mercator bbox and grid size for a set of lon/lat points (as [lon,lat]).
pub fn grid_for_points(
    lonlat: &[(f64, f64)],
    resolution_m: f64,
    corridor_m: f64,
) -> Result<(f64, f64, [f64; 4], usize, usize), String> {
    if lonlat.is_empty() {
        return Err("no points".into());
    }
    let mean_lat: f64 = lonlat.iter().map(|(_, lat)| lat).sum::<f64>() / lonlat.len() as f64;
    let scale = mean_lat.to_radians().cos();
    let xy: Vec<(f64, f64)> = lonlat
        .iter()
        .map(|(lon, lat)| lonlat_to_mercator(*lon, *lat))
        .collect();
    let (mut xmin, mut xmax) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut ymin, mut ymax) = (f64::INFINITY, f64::NEG_INFINITY);
    for &(x, y) in &xy {
        xmin = xmin.min(x);
        xmax = xmax.max(x);
        ymin = ymin.min(y);
        ymax = ymax.max(y);
    }
    if (xmax - xmin).max(ymax - ymin) * scale > MAX_SPAN_M {
        return Err(format!(
            "Use a local route spanning at most {} km; split longer routes first.",
            MAX_SPAN_M / 1000.0
        ));
    }
    let resolution = resolution_m / scale;
    let margin = (corridor_m + 150.0) / scale;
    let low_x = ((xmin - margin) / resolution).floor() * resolution;
    let low_y = ((ymin - margin) / resolution).floor() * resolution;
    let high_x = ((xmax + margin) / resolution).ceil() * resolution;
    let high_y = ((ymax + margin) / resolution).ceil() * resolution;
    let width = ((high_x - low_x) / resolution).round() as usize;
    let height = ((high_y - low_y) / resolution).round() as usize;
    if width * height > MAX_CELLS || width.max(height) > MAX_SIDE {
        return Err(format!(
            "Requested grid is too large ({width} × {height} cells; at most {MAX_CELLS} and {MAX_SIDE} per side). Use a coarser resolution or smaller corridor."
        ));
    }
    let ground_resolution = resolution * scale;
    Ok((
        resolution,
        ground_resolution,
        [low_x, low_y, high_x, high_y],
        width,
        height,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dilate_grows_one_cell() {
        let mut m = vec![false; 9];
        m[4] = true;
        let d = dilate(&m, 3, 3, 1);
        assert_eq!(d.iter().filter(|&&v| v).count(), 9);
    }

    #[test]
    fn dilate_max_expands_class_without_collapsing() {
        let mut v = vec![0u8; 9];
        v[4] = 5; // centre class 5
        let d = dilate_max(&v, 3, 3, 1);
        assert_eq!(d.iter().copied().max(), Some(5));
        assert_eq!(d.iter().filter(|&&c| c == 5).count(), 9);
        // A neighbouring class-2 seed must not wipe class 5 when both expand.
        let mut mixed = vec![0u8; 25];
        mixed[12] = 5; // centre
        mixed[0] = 2; // corner
        let d2 = dilate_max(&mixed, 5, 5, 1);
        assert!(d2.contains(&5));
        assert!(d2.contains(&2));
        assert_eq!(d2[12], 5);
    }

    #[test]
    fn decode_hazards_maps_steep_bands_and_rejects_unknown() {
        let w = 3usize;
        let h = 1usize;
        let mut rgba = vec![0u8; w * h * 4];
        // pixel 0: yellow → class 1
        rgba[0..4].copy_from_slice(&[255, 255, 0, 255]);
        // pixel 1: dark red → class 5
        rgba[4..8].copy_from_slice(&[115, 0, 0, 255]);
        // pixel 2: transparent
        rgba[8..12].copy_from_slice(&[0, 0, 0, 0]);
        let (steep, runout) = decode_hazards_rgba(&rgba, w, h).expect("palette");
        assert_eq!(steep, vec![1, 5, 0]);
        assert_eq!(runout, vec![0, 0, 0]);

        // All five steep colours
        let colors = [
            [255u8, 255, 0],
            [255, 170, 0],
            [255, 85, 0],
            [255, 0, 0],
            [115, 0, 0],
        ];
        let mut rgba5 = vec![0u8; 5 * 4];
        for (i, c) in colors.iter().enumerate() {
            rgba5[i * 4] = c[0];
            rgba5[i * 4 + 1] = c[1];
            rgba5[i * 4 + 2] = c[2];
            rgba5[i * 4 + 3] = 255;
        }
        let (steep5, _) = decode_hazards_rgba(&rgba5, 5, 1).unwrap();
        assert_eq!(steep5, vec![1, 2, 3, 4, 5]);

        // Unknown opaque colour
        let bad = [1u8, 2, 3, 255];
        let err = decode_hazards_rgba(&bad, 1, 1).unwrap_err();
        assert!(err.contains("unknown colours"));
    }

    #[test]
    fn decode_hazards_maps_runout_blues() {
        let mut rgba = vec![0u8; 12];
        rgba[0..4].copy_from_slice(&[0, 77, 168, 255]); // short
        rgba[4..8].copy_from_slice(&[76, 155, 255, 255]); // medium
        rgba[8..12].copy_from_slice(&[154, 177, 230, 255]); // long
        let (steep, runout) = decode_hazards_rgba(&rgba, 3, 1).unwrap();
        assert_eq!(steep, vec![0, 0, 0]);
        assert_eq!(runout, vec![1, 2, 3]);
    }
}
