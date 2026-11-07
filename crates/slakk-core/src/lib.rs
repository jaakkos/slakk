//! Raster A* ascent planner (Wasm) — plan-between + GPX corridor / pitch / landforms.

mod geo;
mod landforms;
mod plan;
mod search;
mod terrain;

pub use geo::{lonlat_to_mercator, mercator_to_lonlat, R};
pub use plan::{plan_route, PlanError, PlanInput, PlanOptions, PlanResult};
pub use search::DIRECTIONS;
pub use terrain::{
    decode_hazards_rgba, dilate, dilate_max, slope_degrees, TerrainGrid, EDGE_CELLS, MAX_CELLS,
    MAX_SIDE, MAX_SPAN_M, RUNOUT_CLASS_LONG, RUNOUT_CLASS_MEDIUM, RUNOUT_CLASS_SHORT,
};

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {}

fn parse_latlon_pairs(points_latlon: &[f64]) -> Result<Vec<(f64, f64)>, JsValue> {
    if points_latlon.len() < 4 || points_latlon.len() % 2 != 0 {
        return Err(JsValue::from_str(
            "points need at least start and end as [lat,lon] pairs",
        ));
    }
    Ok(points_latlon
        .chunks_exact(2)
        .map(|c| (c[0], c[1]))
        .collect())
}

/// Plan a route. `corridor_latlon` may be empty (corridor follows `points_latlon`).
#[wasm_bindgen]
pub fn plan(
    width: u32,
    height: u32,
    resolution_m: f64,
    ground_resolution_m: f64,
    bbox_xmin: f64,
    bbox_ymin: f64,
    bbox_xmax: f64,
    bbox_ymax: f64,
    elevations: &[f32],
    steep: &[u8],
    runout_class: &[u8],
    slope: &[f32],
    points_latlon: &[f64],
    corridor_latlon: &[f64],
    options_json: &str,
) -> Result<JsValue, JsValue> {
    let opts: PlanOptions = serde_json::from_str(options_json)
        .map_err(|e| JsValue::from_str(&format!("bad options: {e}")))?;
    let points = parse_latlon_pairs(points_latlon)?;
    let corridor = if corridor_latlon.is_empty() {
        vec![]
    } else {
        parse_latlon_pairs(corridor_latlon)?
    };
    let input = PlanInput {
        width: width as usize,
        height: height as usize,
        resolution: resolution_m,
        ground_resolution: ground_resolution_m,
        bbox: [bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax],
        elevations: elevations.to_vec(),
        steep: steep.to_vec(),
        runout_class: runout_class.to_vec(),
        slope: slope.to_vec(),
        points,
        corridor,
        options: opts,
    };
    match plan_route(&input) {
        Ok(result) => to_js(&result),
        Err(e) => Err(JsValue::from_str(&e.to_string())),
    }
}

fn to_js<T: serde::Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("serialize: {e}")))
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub struct GridMeta {
    pub resolution: f64,
    #[wasm_bindgen(js_name = groundResolution)]
    pub ground_resolution: f64,
    pub width: u32,
    pub height: u32,
    bbox_xmin: f64,
    bbox_ymin: f64,
    bbox_xmax: f64,
    bbox_ymax: f64,
}

#[wasm_bindgen]
impl GridMeta {
    #[wasm_bindgen(getter)]
    pub fn bbox(&self) -> Vec<f64> {
        vec![
            self.bbox_xmin,
            self.bbox_ymin,
            self.bbox_xmax,
            self.bbox_ymax,
        ]
    }
}

#[wasm_bindgen]
pub fn grid_meta(
    points_latlon: &[f64],
    resolution_m: f64,
    corridor_m: f64,
) -> Result<GridMeta, JsValue> {
    let pairs = parse_latlon_pairs(points_latlon)?;
    let lonlat: Vec<(f64, f64)> = pairs.iter().map(|&(lat, lon)| (lon, lat)).collect();
    let (resolution, ground_resolution, bbox, width, height) =
        terrain::grid_for_points(&lonlat, resolution_m, corridor_m)
            .map_err(|e| JsValue::from_str(&e))?;
    Ok(GridMeta {
        resolution,
        ground_resolution,
        width: width as u32,
        height: height as u32,
        bbox_xmin: bbox[0],
        bbox_ymin: bbox[1],
        bbox_xmax: bbox[2],
        bbox_ymax: bbox[3],
    })
}

#[wasm_bindgen]
pub fn decode_hazards(rgba: &[u8], width: u32, height: u32) -> Result<JsValue, JsValue> {
    let (steep, runout) = terrain::decode_hazards_rgba(rgba, width as usize, height as usize)
        .map_err(|e| JsValue::from_str(&e))?;
    let mut out = Vec::with_capacity(steep.len() + runout.len());
    out.extend_from_slice(&steep);
    out.extend_from_slice(&runout);
    Ok(JsValue::from(js_sys::Uint8Array::from(out.as_slice())))
}

/// Ridge/gully class per cell: -1 unknown, 0 other, 1 ridge, 2 gully.
#[wasm_bindgen]
pub fn landform_classes(
    width: u32,
    height: u32,
    ground_resolution_m: f64,
    elevations: &[f32],
) -> Result<JsValue, JsValue> {
    let w = width as usize;
    let h = height as usize;
    let n = w * h;
    if elevations.len() != n {
        return Err(JsValue::from_str("elevations length must match width×height"));
    }
    let steep = vec![0u8; n];
    let runout = vec![0u8; n];
    let terrain = TerrainGrid::from_arrays(
        w,
        h,
        ground_resolution_m,
        ground_resolution_m,
        [0.0, 0.0, 1.0, 1.0],
        elevations.to_vec(),
        &steep,
        runout,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    let classes = landforms::landform_classes(&terrain);
    Ok(JsValue::from(js_sys::Int8Array::from(classes.as_slice())))
}
